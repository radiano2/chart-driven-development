// Removing projects (list only, or deleting the folder) and the run chat (plain explanations + questions).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MockAI } from "../src/server/ai/mock.ts";
import { normTrace } from "../src/server/ai/llm.ts";
import { createServer } from "../src/server/index.ts";
import { Workspace } from "../src/server/project.ts";
import type { RunTrace, StackProposal } from "../src/shared/types.ts";

let tmp = "";
let base = "";
let ws: Workspace;
let server: ReturnType<typeof createServer>;

async function call<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json()) as T };
}

async function makeProject(name: string) {
  const c = await call("POST", "/api/projects", { name, idea: "todo app" });
  assert.equal(c.status, 201);
  const stack = (await call<StackProposal>("POST", `/api/projects/${name}/stack`)).data;
  await call("POST", `/api/projects/${name}/generate`, { stack: stack.recommended });
}

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "cdd-manage-"));
  ws = new Workspace(path.join(tmp, "projects"), new MockAI(), { searchRoots: [tmp] });
  server = createServer(ws, "mock");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  ws.closeAll();
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("removing projects", () => {
  it("takes an app-made project off the list by moving it to .removed, losing nothing", async () => {
    await makeProject("keep-me");
    const r = await call("POST", "/api/projects/keep-me/remove", { deleteFolder: false });
    assert.equal(r.status, 200);
    assert.match(r.data.message, /\.removed/);
    assert.equal((await ws.list()).some((p) => p.name === "keep-me"), false);
    assert.equal(existsSync(path.join(tmp, "projects", "keep-me")), false);
    const moved = await readdir(path.join(tmp, "projects", ".removed"));
    assert.equal(moved.length, 1);
    assert.ok(existsSync(path.join(tmp, "projects", ".removed", moved[0], ".chart", "chart.json")));
    assert.equal((await call("GET", "/api/projects/keep-me")).status, 404);
    // The name is free again.
    await makeProject("keep-me");
  });

  it("deletes the folder only with the project's name typed", async () => {
    await makeProject("gone");
    const refused = await call("POST", "/api/projects/gone/remove", { deleteFolder: true, confirm: "nope" });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /Type the project's name/);
    assert.ok(existsSync(path.join(tmp, "projects", "gone")));
    const r = await call("POST", "/api/projects/gone/remove", { deleteFolder: true, confirm: "gone" });
    assert.equal(r.status, 200);
    assert.equal(existsSync(path.join(tmp, "projects", "gone")), false);
  });

  it("forgets an opened folder (kept on disk), or deletes it when asked", async () => {
    for (const [name, del] of [["kept-code", false], ["deleted-code", true]] as const) {
      const dir = path.join(tmp, "elsewhere", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "main.js"), "export function main() {}\n");
      await ws.openFolder(dir, { wait: true });
      const r = await call("POST", `/api/projects/${name}/remove`, { deleteFolder: del, confirm: del ? name : "" });
      assert.equal(r.status, 200);
      assert.equal((await ws.list()).some((p) => p.name === name), false);
      assert.equal(existsSync(dir), !del);
    }
  });

  it("removes a project whose folder is gone", async () => {
    const dir = path.join(tmp, "elsewhere", "vanished");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "main.js"), "export function main() {}\n");
    await ws.openFolder(dir, { wait: true });
    await rm(dir, { recursive: true });
    const r = await call("POST", "/api/projects/vanished/remove", { deleteFolder: false });
    assert.equal(r.status, 200);
    assert.equal((await ws.list()).some((p) => p.name === "vanished"), false);
  });

  it("answers 404 for an unknown project", async () => {
    assert.equal((await call("POST", "/api/projects/nobody/remove", { deleteFolder: false })).status, 404);
  });
});

describe("run chat", () => {
  let trace: RunTrace;
  before(async () => {
    await makeProject("runner");
    trace = (await call<RunTrace>("POST", "/api/projects/runner/run", { level: "root" })).data;
  });

  it("explains the run in plain words: intro, every step, summary", () => {
    assert.ok(trace.intro);
    assert.ok(trace.summary);
    assert.ok(trace.steps.length > 1);
    assert.ok(trace.steps.every((s) => s.explain && s.explain.length > 10));
  });

  it("answers questions about the run", async () => {
    const r = await call<{ answer: string }>("POST", "/api/projects/runner/run/ask", { level: "root", trace, history: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }], question: "why does it go to storage?" });
    assert.equal(r.status, 200);
    assert.match(r.data.answer, /why does it go to storage/);
    assert.equal((await call("POST", "/api/projects/runner/run/ask", { level: "root", question: "x" })).status, 400);
    assert.equal((await call("POST", "/api/projects/runner/run/ask", { level: "root", trace })).status, 400);
    const junk = await call("POST", "/api/projects/runner/run/ask", { level: "root", trace: { scenario: 1, steps: [null, 5, { nodeId: "x" }] }, question: "ok?" });
    assert.equal(junk.status, 200, "junk steps in the trace are dropped, not a crash");
  });

  it("keeps the AI's explanations, and copes without them", () => {
    const chart = { nodes: [], edges: [{ id: "a--b", from: "a", to: "b", data: "x", order: 1 }] };
    const full = normTrace({ scenario: "s", intro: " Hi ", steps: [{ nodeId: "a", data: "1", note: "n", explain: "plain" }], summary: "done" }, chart);
    assert.equal(full.intro, "Hi");
    assert.equal(full.steps[0].explain, "plain");
    assert.equal(full.summary, "done");
    const bare = normTrace({ scenario: "s", steps: [{ nodeId: "a", data: "1", note: "n" }] }, chart);
    assert.equal(bare.intro, undefined);
    assert.equal(bare.steps[0].explain, undefined);
  });
});

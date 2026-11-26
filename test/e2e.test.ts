// End-to-end: the MVP demo ("todo app" → chart → open a module → extend → working code) with the mock AI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MockAI } from "../src/server/ai/mock.ts";
import { createServer } from "../src/server/index.ts";
import { Workspace } from "../src/server/project.ts";
import type { ProjectChart, Recommendation, RunTrace, StackProposal } from "../src/shared/types.ts";

let base = "";
let root = "";
let ws: Workspace;
let server: ReturnType<typeof createServer>;

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cdd-"));
  ws = new Workspace(root, new MockAI());
  server = createServer(ws, "mock");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  ws.closeAll();
  server.close();
  await rm(root, { recursive: true, force: true });
});

describe("todo app demo", () => {
  const P = "/api/projects/todo-app";
  let chart: ProjectChart;

  it("creates a project from a blank prompt and proposes a stack", async () => {
    const created = await call("POST", "/api/projects", { name: "Todo App", idea: "todo app" });
    assert.equal(created.name, "todo-app");
    const stack = await call<StackProposal>("POST", `${P}/stack`);
    assert.ok(stack.recommended.name);
    assert.ok(stack.alternatives.length > 0);
    const gen = await call<{ chart: ProjectChart }>("POST", `${P}/generate`, { stack: stack.recommended });
    chart = gen.chart;
    assert.deepEqual(chart.root.nodes.map((n) => n.id), ["web-ui", "http-api", "todos", "storage"]);
    assert.ok(chart.root.edges.every((e) => e.data && e.order > 0));
  });

  it("wrote real code, committed step by step", async () => {
    const dir = path.join(root, "todo-app");
    assert.match(await readFile(path.join(dir, "src/todos.js"), "utf8"), /export function addTodo/);
    const hist = await call<{ message: string }[]>("GET", `${P}/history`);
    assert.ok(hist.length >= 6, `expected several commits, got ${hist.length}`);
    assert.equal(hist.at(-1)!.message, "Start project: todo app");
  });

  it("the generated todo app actually runs", async () => {
    const dir = path.join(root, "todo-app");
    const port = 40000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, ["src/main.js"], { cwd: dir, env: { ...process.env, PORT: String(port), TODO_FILE: path.join(root, "todos.json") } });
    try {
      let res: Response | null = null;
      for (let i = 0; i < 40 && !res; i++) {
        await sleep(100);
        res = await fetch(`http://127.0.0.1:${port}/api/todos`, { method: "POST", body: JSON.stringify({ title: "Buy milk" }) }).catch(() => null);
      }
      assert.ok(res, "todo server did not start");
      assert.deepEqual(await res!.json(), [{ id: 1, title: "Buy milk", done: false }]);
      const toggled = await (await fetch(`http://127.0.0.1:${port}/api/todos/1`, { method: "PATCH" })).json();
      assert.equal(toggled[0].done, true);
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.match(page, /<h1>Todos<\/h1>/);
    } finally {
      child.kill();
    }
  });

  it("opens a module, recommends before changing, then extends a bubble", async () => {
    const open = await call<{ chart: ProjectChart }>("GET", P);
    const todos = open.chart.root.nodes.find((n) => n.id === "todos")!;
    assert.ok(todos.children!.nodes.length >= 3, "module has an inner chart");

    const rec = await call<Recommendation>("POST", `${P}/recommend`, { level: "todos", bubbleId: "add-todo", request: "set a due date" });
    assert.ok(rec.options.length >= 2);
    const option = rec.options.find((o) => o.id === rec.recommendedOptionId)!;

    const res = await call<{ chart: ProjectChart; files: string[] }>("POST", `${P}/apply`, { level: "todos", bubbleId: "add-todo", request: "set a due date", option });
    const inner = res.chart.root.nodes.find((n) => n.id === "todos")!.children!;
    assert.ok(inner.nodes.some((n) => n.id === "set-a-due-date" && n.symbol === "setADueDate"));
    assert.ok(inner.edges.some((e) => e.from === "add-todo" && e.to === "set-a-due-date"));
    const code = await readFile(path.join(root, "todo-app/src/todos.js"), "utf8");
    assert.match(code, /export function setADueDate/);
    const mod = await import(path.join(root, "todo-app/src/todos.js") + "?v=1");
    assert.equal(typeof mod.setADueDate, "function");
  });

  it("undo restores the code and the chart", async () => {
    const res = await call<{ chart: ProjectChart }>("POST", `${P}/undo`);
    const inner = res.chart.root.nodes.find((n) => n.id === "todos")!.children!;
    assert.ok(!inner.nodes.some((n) => n.id === "set-a-due-date"));
    assert.doesNotMatch(await readFile(path.join(root, "todo-app/src/todos.js"), "utf8"), /setADueDate/);
  });

  it("hand-drawn bubble, then AI writes its code", async () => {
    const added = await call<{ bubble: { id: string; status: string } }>("POST", `${P}/bubbles`, {
      level: "todos",
      bubble: { name: "clearCompleted", description: "Removes all done todos", inputs: [{ name: "todos", type: "Todo[]" }], outputs: [{ name: "todos", type: "Todo[]" }] },
    });
    assert.equal(added.bubble.status, "draft");
    const res = await call<{ chart: ProjectChart }>("POST", `${P}/implement`, { level: "todos", bubbleId: added.bubble.id });
    const b = res.chart.root.nodes.find((n) => n.id === "todos")!.children!.nodes.find((n) => n.id === added.bubble.id)!;
    assert.equal(b.status, "ready");
    assert.match(await readFile(path.join(root, "todo-app/src/todos.js"), "utf8"), /export function clearCompleted\(todos\)/);

    await call("POST", `${P}/edges`, { level: "todos", edge: { from: "toggle-todo", to: added.bubble.id, data: "Todo[]" } });
    const after = await call<{ chart: ProjectChart }>("GET", P);
    assert.ok(after.chart.root.nodes.find((n) => n.id === "todos")!.children!.edges.some((e) => e.to === added.bubble.id));
  });

  it("detects outside edits and updates the chart from them", async () => {
    const file = path.join(root, "todo-app/src/storage.js");
    await sleep(800); // let the app's own writes settle
    await writeFile(file, (await readFile(file, "utf8")) + "\nexport function clearStorage(file) {\n  return saveTodos(file, []);\n}\n");
    const events = await fetch(`${base}${P}/events`);
    const reader = events.body!.getReader();
    let got = "";
    const deadline = Date.now() + 4000;
    while (!got.includes("outside-change") && Date.now() < deadline) {
      const { value } = await Promise.race([reader.read(), sleep(4000).then(() => ({ value: undefined }))]);
      if (value) got += new TextDecoder().decode(value);
    }
    await reader.cancel();
    assert.match(got, /outside-change.*src\/storage\.js/);

    const res = await call<{ chart: ProjectChart }>("POST", `${P}/sync`);
    const storage = res.chart.root.nodes.find((n) => n.id === "storage")!.children!;
    assert.ok(storage.nodes.some((n) => n.symbol === "clearStorage"));
    const open = await call<{ outside: string[] }>("GET", P);
    assert.deepEqual(open.outside, []);
  });

  it("run returns a trace of invented data through the chart", async () => {
    const trace = await call<RunTrace>("POST", `${P}/run`, { level: "root" });
    assert.ok(trace.steps.length >= 4);
    assert.ok(trace.steps.slice(1).every((s) => s.edgeId));
  });

  it("refuses paths outside the project", async () => {
    await assert.rejects(call("GET", `${P}/file?path=../../etc/passwd`), /400/);
    await assert.rejects(call("GET", `/api/projects/..%2F..`), /400|404/);
  });
});

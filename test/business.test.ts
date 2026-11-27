// Opening code on an empty board, choosing what to draw, and the read-only business flow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MockAI } from "../src/server/ai/mock.ts";
import { createServer } from "../src/server/index.ts";
import { Workspace } from "../src/server/project.ts";
import { BUSINESS_LEVEL, businessChart, normBusiness } from "../src/shared/business.ts";
import type { BusinessState, ServerEvent } from "../src/shared/types.ts";

let tmp = "";
let disk = "";

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Me", "-c", "user.email=me@example.com", ...args], { cwd, encoding: "utf8" }).trim();

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
}

const CODE = {
  "package.json": JSON.stringify({ name: "shop", description: "A tiny shop" }),
  "src/cart.js": "export function addToCart(cart, item) { return [...cart, item]; }\n",
  "src/checkout.js": "export function pay(cart) { return { ok: cart.length > 0 }; }\n",
};

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !(await fn())) await new Promise((r) => setTimeout(r, 20));
  assert.ok(await fn(), "timed out");
};

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "cdd-biz-"));
  disk = path.join(tmp, "disk");
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("opening code without drawing", () => {
  it("opens on an empty board and draws nothing until asked", async () => {
    const w = new Workspace(path.join(tmp, "ws-none"), new MockAI());
    const dir = path.join(disk, "none", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "none" });
    assert.equal(r.drawing, false);
    assert.equal(r.chart.undrawn, true);
    assert.equal(r.chart.root.nodes.length, 0);
    const p = w.get(r.name);
    assert.equal(p.drawing, null);
    assert.equal((await p.businessState()).status, "none");
    assert.equal(gitIn(dir, "log", "--pretty=%s"), "Before Chart Driven Development: the existing files", "nothing is committed for an empty board");
    assert.deepEqual((await w.list()).map((x) => x.name), ["shop"], "it's in the list");

    // Later: draw the functional chart from the board.
    await w.redraw(r.name);
    await p.drawing;
    const pc = await p.loadChart();
    assert.ok(pc.root.nodes.length > 0);
    assert.equal(pc.undrawn, undefined);
    await assert.rejects(w.redraw(r.name), /finished/);
    w.closeAll();
  });

  it("won't sweep outside edits into the first chart", async () => {
    const w = new Workspace(path.join(tmp, "ws-dirty"), new MockAI());
    const dir = path.join(disk, "dirty", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "none" });
    await writeFile(path.join(dir, "src/cart.js"), "// edited\n");
    await assert.rejects(w.redraw(r.name), /changed since it was opened/);
    w.closeAll();
  });
});

describe("business flow", () => {
  it("is drawn from the code, kept out of git, and can't be remade while it matches the code", async () => {
    const w = new Workspace(path.join(tmp, "ws-biz"), new MockAI());
    const dir = path.join(disk, "biz", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "business" });
    assert.equal(r.drawing, false, "the functional chart isn't drawn");
    const p = w.get(r.name);
    await p.businessJob;
    const st = await p.businessState();
    assert.equal(st.status, "ready");
    assert.equal(st.stale, false);
    assert.ok(st.flow!.steps.some((s) => s.kind === "action"));
    assert.ok(st.flow!.steps.some((s) => s.kind === "output"));
    assert.ok(st.flow!.steps.some((s) => s.code.includes("src/cart.js")), "steps point at the code");
    assert.ok(existsSync(path.join(dir, ".chart/business.json")));
    assert.equal(gitIn(dir, "status", "--porcelain", "--", ".chart/business.json"), "", "not shown as a change");
    assert.equal(gitIn(dir, "ls-files", ".chart/business.json"), "", "not committed");
    assert.equal((await p.loadChart()).undrawn, true);
    await assert.rejects(p.requestBusiness(), /read-only/);
    w.closeAll();
  });

  it("rebuilds itself when the code changes, and only then", async () => {
    const ai = new MockAI();
    let calls = 0;
    const real = ai.businessFlow.bind(ai);
    ai.businessFlow = async (ctx) => (calls++, real(ctx));
    const w = new Workspace(path.join(tmp, "ws-update"), ai);
    const dir = path.join(disk, "update", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "business" });
    const p = w.get(r.name);
    await p.businessJob;
    const first = (await p.businessState()).flow!;
    assert.equal(calls, 1);
    const events: BusinessState[] = [];
    p.events.on("event", (ev: ServerEvent) => ev.type === "business" && events.push(ev.business));

    // A commit that doesn't touch the code (the chart only) changes nothing.
    await p.acceptOutside();
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(calls, 1);

    // Outside edits count once they're kept (committed).
    await writeFile(path.join(dir, "src/refund.js"), "export function refund(order) { return order; }\n");
    assert.equal((await p.businessState()).stale, false, "uncommitted edits don't count yet");
    await p.acceptOutside();
    await until(() => calls === 2);
    await until(async () => (await p.businessState()).status === "ready");
    const second = (await p.businessState()).flow!;
    assert.notEqual(second.basedOn, first.basedOn);
    assert.ok(second.steps.some((s) => s.code.includes("src/refund.js")));
    assert.ok(events.some((e) => e.status === "updating"), "the board is told it's updating");
    assert.equal((await p.businessState()).stale, false);

    // Undo brings the old code back: the flow follows.
    await p.undo();
    await until(() => calls === 3);
    await until(async () => (await p.businessState()).status === "ready");
    assert.equal((await p.businessState()).flow!.basedOn, first.basedOn);
    w.closeAll();
  });

  it("can be run like a chart", async () => {
    const w = new Workspace(path.join(tmp, "ws-run"), new MockAI());
    const dir = path.join(disk, "run", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "business" });
    const p = w.get(r.name);
    await p.businessJob;
    const flow = (await p.businessState()).flow!;
    const trace = await p.simulateRun(BUSINESS_LEVEL);
    const ids = new Set(flow.steps.map((s) => s.id));
    assert.ok(trace.steps.length > 0);
    assert.ok(trace.steps.every((s) => ids.has(s.nodeId)), "the run follows the flow's steps");
    assert.ok((await p.explainRun(BUSINESS_LEVEL, trace, [], "why?")).length > 0);
    w.closeAll();
  });

  it("reports a failure and can be tried again", async () => {
    const ai = new MockAI();
    let fail = true;
    const real = ai.businessFlow.bind(ai);
    ai.businessFlow = async (ctx) => {
      if (fail) throw new Error("DeepSeek is down");
      return real(ctx);
    };
    const w = new Workspace(path.join(tmp, "ws-bizfail"), ai);
    const dir = path.join(disk, "bizfail", "shop");
    await write(dir, CODE);
    const r = await w.openFolder(dir, { draw: "business" });
    const p = w.get(r.name);
    await p.businessJob;
    const st = await p.businessState();
    assert.equal(st.status, "failed");
    assert.match(st.error ?? "", /DeepSeek is down/);
    assert.equal(st.flow, null);
    fail = false;
    await p.requestBusiness();
    await p.businessJob;
    assert.equal((await p.businessState()).status, "ready");
    w.closeAll();
  });
});

describe("normBusiness", () => {
  it("keeps known kinds, unique ids and arrows between real steps", () => {
    const f = normBusiness({
      summary: "s",
      steps: [
        { id: "Order", name: "Order", kind: "action" },
        { id: "order", name: "Order again", kind: "weird" },
        { name: "" },
        { id: "pay", name: "Pay", kind: "decision" },
      ],
      links: [
        { from: "order", to: "pay", label: "the cart" },
        { from: "pay", to: "nowhere" },
        { from: "pay", to: "pay" },
      ],
    });
    assert.deepEqual(f.steps.map((s) => [s.id, s.kind, s.actor]), [["order", "action", "User"], ["order-2", "process", "App"], ["pay", "decision", "App"]]);
    assert.deepEqual(f.links.map((l) => [l.from, l.to, l.label]), [["order", "pay", "the cart"]]);
    const c = businessChart({ version: 1, ...f, basedOn: "x", updated: "" });
    assert.equal(c.nodes.length, 3);
    assert.equal(c.edges[0].data, "the cart");
  });
});

describe("HTTP API", () => {
  it("opens code empty, makes the business flow on request and refuses to remake it", async () => {
    const w = new Workspace(path.join(tmp, "ws-http"), new MockAI());
    const server = createServer(w, "mock");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json() };
    };
    try {
      const dir = path.join(disk, "http", "shop");
      await write(dir, CODE);
      const opened = await call("POST", "/api/open", { path: dir });
      assert.equal(opened.data.drawing, false, "the page asks first");
      assert.equal(opened.data.chart.undrawn, true);
      const proj = await call("GET", "/api/projects/shop");
      assert.equal(proj.data.business.status, "none");
      const made = await call("POST", "/api/projects/shop/business", {});
      assert.equal(made.status, 200);
      assert.equal(made.data.status, "building");
      await until(async () => (await call("GET", "/api/projects/shop/business")).data.status === "ready");
      const again = await call("POST", "/api/projects/shop/business", {});
      assert.equal(again.status, 409);
      assert.match(again.data.error, /read-only/);
      const run = await call("POST", "/api/projects/shop/run", { level: BUSINESS_LEVEL });
      assert.equal(run.status, 200);
      assert.ok(run.data.steps.length > 0);
      const chart = JSON.parse(await readFile(path.join(dir, ".chart/chart.json"), "utf8"));
      assert.equal(chart.root.nodes.length, 0, "the functional chart is untouched");
    } finally {
      server.close();
      w.closeAll();
    }
  });
});

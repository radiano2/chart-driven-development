// Design: reference images, mockups rendered by a headless browser, applying them, and screenshots of UI bubbles.
// Uses the mock AI. Browser tests are skipped when no Chrome/Chromium can be started (set CDD_CHROME to one).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runTool, stopApp } from "../src/server/agent/tools.ts";
import { normMockup } from "../src/server/ai/llm.ts";
import { decodeImage } from "../src/server/design/design.ts";
import { browserAvailable, checkLocalUrl, closeBrowser } from "../src/server/design/render.ts";
import { cleanColor, normStyle } from "../src/server/design/style.ts";
import { MockAI } from "../src/server/ai/mock.ts";
import { createServer } from "../src/server/index.ts";
import { Workspace } from "../src/server/project.ts";
import { normBubble } from "../src/shared/chart.ts";
import type { DesignState, Mockup, ProjectChart, Screenshot } from "../src/shared/types.ts";

// 1×1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let base = "";
let root = "";
let ws: Workspace;
let server: ReturnType<typeof createServer>;
let hasBrowser = false;

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data as T;
}

const P = "/api/projects/todo";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cdd-design-"));
  ws = new Workspace(root, new MockAI());
  server = createServer(ws, "mock");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const p = await ws.create("todo", "todo app");
  await p.generate((await p.proposeStack()).recommended);
  hasBrowser = await browserAvailable();
  if (!hasBrowser) console.log("# no browser found: skipping rendering tests (set CDD_CHROME)");
});

after(async () => {
  stopApp(path.join(root, "todo"));
  ws.closeAll();
  server.close();
  await closeBrowser();
  await rm(root, { recursive: true, force: true });
});

describe("design helpers", () => {
  it("keeps only safe CSS colors in a style guide", () => {
    assert.equal(cleanColor("#12ab3f"), "#12ab3f");
    assert.equal(cleanColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
    assert.equal(cleanColor("red; } body { display:none"), null);
    const s = normStyle({ summary: "x", colors: [{ name: "Accent Color", value: "#fff" }, { name: "bad", value: "url(javascript:1)" }], fonts: [{ role: "body", family: "Inter; }" }] })!;
    assert.deepEqual(s.colors, [{ name: "accent-color", value: "#fff" }]);
    assert.equal(s.fonts[0].family, "Inter ");
    assert.equal(normStyle({}), null);
  });

  it("checks uploaded images by their bytes", () => {
    assert.equal(decodeImage(PNG).ext, "png");
    assert.throws(() => decodeImage("data:image/png;base64," + Buffer.from("not a png").toString("base64")), /isn't the image type/);
    assert.throws(() => decodeImage("data:text/html;base64,PGgxPg=="), /PNG, JPEG/);
  });

  it("only screenshots the app on this computer", () => {
    assert.ok(checkLocalUrl("http://localhost:3000/"));
    assert.throws(() => checkLocalUrl("https://example.com/"), /this computer/);
    assert.throws(() => checkLocalUrl("file:///etc/passwd"), /this computer/);
  });

  it("keeps gui on bubbles and accepts a mockup only with HTML", () => {
    assert.deepEqual(normBubble({ name: "list", gui: { route: "todos", selector: "#list" } }, "function")!.gui, { route: "/todos", selector: "#list" });
    assert.equal(normBubble({ name: "x", gui: null }, "function")!.gui, undefined);
    assert.throws(() => normMockup({ title: "x", html: "hello" }, new Set()), /mockup HTML/);
    const m = normMockup({ title: "T", html: "<html><body></body></html>", bubbleIds: ["render-todos", "nope"] }, new Set(["render-todos"]));
    assert.deepEqual(m.bubbleIds, ["render-todos"]);
  });

  it("the generated chart marks UI bubbles", async () => {
    const { chart } = await call<{ chart: ProjectChart }>("GET", P);
    const ui = chart.root.nodes.find((n) => n.id === "web-ui")!;
    assert.ok(ui.gui);
    assert.equal(ui.children!.nodes.find((n) => n.id === "render-todos")!.gui!.selector, "#list");
  });
});

describe("design flow", () => {
  it("starts empty", async () => {
    const d = await call<DesignState>("GET", `${P}/design`);
    assert.deepEqual(d, { style: null, references: [], mockups: [], screenshots: {}, appUrl: null });
  });

  it("adds a reference image and updates the style guide from it", async () => {
    const r = await call<{ design: DesignState }>("POST", `${P}/design/references`, { image: PNG, note: "dark and calm" });
    assert.equal(r.design.references.length, 1);
    assert.ok(r.design.style!.mood.includes("dark"));
    const ref = r.design.references[0];
    assert.ok(existsSync(path.join(root, "todo", ref.image)));
    const hist = await call<{ message: string }[]>("GET", `${P}/history`);
    assert.match(hist[0].message, /Add design reference: dark and calm/);
    // served back as an image, and nothing outside the design folder is
    const img = await fetch(`${base}${P}/design/image?path=${encodeURIComponent(ref.image.replace(".chart/design/", ""))}`);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${base}${P}/design/image?path=${encodeURIComponent("../chart.json")}`)).status, 400);
    assert.equal((await fetch(`${base}${P}/design/image?path=${encodeURIComponent("references/../../chart.png")}`)).status, 400);
  });

  it("refuses a fake image", async () => {
    await assert.rejects(call("POST", `${P}/design/references`, { image: "data:image/png;base64,aGVsbG8=" }), /400/);
  });

  it("makes a mockup, renders it to PNG and crops each bubble's region", async (t) => {
    if (!hasBrowser) return t.skip("no browser");
    const m = await call<Mockup>("POST", `${P}/design/mockups`, { request: "a light theme", bubbleIds: ["render-todos"] });
    assert.ok(m.style, "a new look proposes a style");
    const png = await readFile(path.join(root, "todo", m.image));
    assert.ok(png.subarray(1, 4).toString() === "PNG" && png.length > 1000);
    assert.deepEqual(Object.keys(m.crops).sort(), ["on-submit", "render-todos", "web-ui"]);
    for (const c of Object.values(m.crops)) assert.ok(existsSync(path.join(root, "todo", c)));
    const d = await call<DesignState>("GET", `${P}/design`);
    assert.equal(d.mockups[0].id, m.id);
  });

  it("mockups can't reach the network or run scripts", async (t) => {
    if (!hasBrowser) return t.skip("no browser");
    let hits = 0;
    const http = await import("node:http");
    const spy = http.createServer((_q, s) => (hits++, s.end("x")));
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
    const port = (spy.address() as AddressInfo).port;
    const p = ws.get("todo");
    const { Design } = await import("../src/server/design/design.ts");
    const m = await p.exclusive(() =>
      new Design(p).saveMockupUnlocked({
        title: "Spy",
        summary: "",
        request: "",
        bubbleIds: [],
        style: null,
        html: `<html><body><img src="http://127.0.0.1:${port}/a.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css"><script>fetch("http://127.0.0.1:${port}/js")</script><div data-bubble="../evil">x</div></body></html>`,
      }),
    );
    spy.close();
    assert.equal(hits, 0);
    assert.deepEqual(m.crops, {});
  });

  it("applies a mockup: its style becomes the project's and the page is restyled", async (t) => {
    if (!hasBrowser) return t.skip("no browser");
    const d = await call<DesignState>("GET", `${P}/design`);
    const m = d.mockups.find((x) => x.style)!;
    const r = await call<{ files: string[] }>("POST", `${P}/design/apply`, { id: m.id });
    assert.deepEqual(r.files, ["public/index.html"]);
    const page = await readFile(path.join(root, "todo/public/index.html"), "utf8");
    assert.match(page, /--accent: #6d5dfc/);
    const after = await call<DesignState>("GET", `${P}/design`);
    assert.deepEqual(after.style, m.style);
  });

  it("marks and unmarks a bubble as UI", async () => {
    let r = await call<{ chart: ProjectChart }>("POST", `${P}/design/gui`, { level: "todos", bubbleId: "add-todo", gui: { route: "/", selector: "#x" } });
    assert.deepEqual(r.chart.root.nodes.find((n) => n.id === "todos")!.children!.nodes.find((n) => n.id === "add-todo")!.gui, { route: "/", selector: "#x" });
    r = await call<{ chart: ProjectChart }>("POST", `${P}/design/gui`, { level: "todos", bubbleId: "add-todo", gui: null });
    assert.equal(r.chart.root.nodes.find((n) => n.id === "todos")!.children!.nodes.find((n) => n.id === "add-todo")!.gui, undefined);
  });

  it("refuses an app address that isn't on this computer", async () => {
    await assert.rejects(call("POST", `${P}/design/app-url`, { url: "http://example.com" }), /400/);
  });

  it("screenshots a UI bubble on the running app (starting it)", async (t) => {
    if (!hasBrowser) return t.skip("no browser");
    const port = 40000 + Math.floor(Math.random() * 10000);
    process.env.PORT = String(port);
    process.env.TODO_FILE = path.join(root, "todos.json");
    try {
      await call("POST", `${P}/design/app-url`, { url: `http://localhost:${port}` });
      const shot = await call<Screenshot>("POST", `${P}/design/screenshot`, { level: "web-ui", bubbleId: "render-todos" });
      assert.equal(shot.url, `http://localhost:${port}/`);
      assert.equal(shot.cropped, true);
      assert.ok((await readFile(path.join(root, "todo", shot.image))).length > 100);
      const d = await call<DesignState>("GET", `${P}/design`);
      assert.ok(d.screenshots["web-ui/render-todos"]);
      // Screenshots are not versioned, so they never show up as changes.
      const open = await call<{ outside: string[] }>("GET", P);
      assert.deepEqual(open.outside, []);
      // A bubble that isn't UI has no screenshot.
      await assert.rejects(call("POST", `${P}/design/screenshot`, { level: "todos", bubbleId: "add-todo" }), /isn't marked as UI/);
    } finally {
      delete process.env.PORT;
      stopApp(path.join(root, "todo"));
    }
  });

  it("the assistant's design tools work", async (t) => {
    const p = ws.get("todo");
    const ctx = { project: p, approve: async () => false, changed: new Set<string>(), pendingMessage: "x" };
    const info = JSON.parse(await runTool("get_design", {}, ctx));
    assert.ok(info.style && Array.isArray(info.mockups));
    assert.match(await runTool("update_style", { style: { summary: "Paper", colors: [{ name: "background", value: "#fdfcf7" }] } }, ctx), /Paper/);
    // not running → it says so instead of starting the app without asking
    await assert.rejects(runTool("take_screenshot", { bubble_id: "render-todos", level: "web-ui" }, ctx), /isn't running/);
    if (!hasBrowser) return t.skip("no browser");
    const out = await runTool("create_mockup", { title: "Paper", html: '<html><body><ul data-bubble="render-todos"><li>a</li></ul></body></html>', bubble_ids: ["render-todos"] }, ctx);
    assert.match(out, /Regions found for: render-todos/);
  });

  it("undo brings back the previous design", async () => {
    const before = await call<DesignState>("GET", `${P}/design`);
    await call("POST", `${P}/undo`);
    const after = await call<DesignState>("GET", `${P}/design`);
    assert.notDeepEqual(after, before);
  });
});

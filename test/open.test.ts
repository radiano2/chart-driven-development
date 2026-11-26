// Opening existing folders: chart projects, plain codebases (with and without git), safety checks, find and browse.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MockAI } from "../src/server/ai/mock.ts";
import { createServer } from "../src/server/index.ts";
import { scanForProjects, selectSources } from "../src/server/importer.ts";
import { Workspace } from "../src/server/project.ts";
import type { ProjectChart, ServerEvent } from "../src/shared/types.ts";

let tmp = "";
let wsRoot = "";
let disk = "";
let ws: Workspace;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Me", "-c", "user.email=me@example.com", ...args], { cwd, encoding: "utf8" }).trim();

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
}

const CODE = {
  "package.json": JSON.stringify({ name: "notes", description: "A small notes server", scripts: { start: "node src/server.js" } }),
  "README.md": "# Notes\n\nKeep notes in a JSON file.\n",
  "src/server.js": "import { addNote } from './notes/notes.js';\nexport function startServer(port) { return port; }\n",
  "src/notes/notes.js": "export function addNote(list, text) { return [...list, text]; }\nexport function listNotes(list) { return list; }\n",
  "src/storage/store.js": "export const loadNotes = async (file) => [];\n",
  "node_modules/dep/index.js": "module.exports = 1;\n",
};

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "cdd-open-"));
  wsRoot = path.join(tmp, "app", "projects");
  disk = path.join(tmp, "disk");
  await mkdir(disk, { recursive: true });
  ws = new Workspace(wsRoot, new MockAI(), { protectedDirs: [path.join(tmp, "app")], searchRoots: [disk] });
});

after(async () => {
  ws.closeAll();
  await rm(tmp, { recursive: true, force: true });
});

describe("opening a codebase that isn't a git repo", () => {
  let dir = "";
  before(async () => {
    dir = path.join(disk, "notes");
    await write(dir, CODE);
  });

  it("inspects without changing anything", async () => {
    const info = await ws.inspect(dir);
    assert.equal(info.kind, "code");
    assert.equal(info.blocked, null);
    assert.equal(info.git.repo, false);
    assert.equal(info.name, "notes");
    assert.equal(info.files, 5, "node_modules is not counted");
    assert.deepEqual(info.languages, ["JavaScript"]);
    assert.ok(info.plan.some((l) => /git repo/.test(l)));
    assert.equal(existsSync(path.join(dir, ".git")), false);
    assert.equal(existsSync(path.join(dir, ".chart")), false);
  });

  it("starts a repo, draws the chart from the code and lists the project", async () => {
    const r = await ws.openFolder(dir, { wait: true });
    assert.equal(r.name, "notes");
    assert.ok(r.chart.root.nodes.length >= 2);
    const notes = r.chart.root.nodes.find((n) => n.id === "notes");
    assert.ok(notes?.children?.nodes.some((f) => f.symbol === "addNote" && f.file === "src/notes/notes.js"));
    assert.match(await readFile(path.join(dir, ".git/info/exclude"), "utf8"), /node_modules\//);
    const log = gitIn(dir, "log", "--pretty=%s");
    assert.deepEqual(log.split("\n"), ["Draw chart from the existing code", "Before Chart Driven Development: the existing files"]);
    assert.equal(gitIn(dir, "ls-files", "node_modules"), "", "dependencies aren't committed");
    assert.equal(await readFile(path.join(dir, "src/notes/notes.js"), "utf8"), CODE["src/notes/notes.js"], "code unchanged");
    const list = await ws.list();
    const item = list.find((p) => p.name === "notes");
    assert.ok(item?.linked && item.hasChart && item.dir === dir, "temp folders aren't under home, so the full path shows");
  });

  it("works like any project after that, and survives a restart", async () => {
    const p = ws.get("notes");
    assert.match(await p.readSourceFile("src/server.js"), /startServer/);
    const again = new Workspace(wsRoot, new MockAI(), { protectedDirs: [path.join(tmp, "app")] });
    assert.equal(again.get("notes").dir, dir);
    again.closeAll();
  });

  it("opening it again finds the same project", async () => {
    const info = await ws.inspect(dir);
    assert.equal(info.kind, "chart");
    assert.equal(info.known, true);
    const r = await ws.openFolder(dir + path.sep);
    assert.equal(r.name, "notes");
    assert.equal((await ws.list()).filter((p) => p.name.startsWith("notes")).length, 1);
  });

  it("can't undo back to before the chart existed", async () => {
    await assert.rejects(ws.get("notes").undo(), /Nothing to undo/);
    const first = gitIn(dir, "rev-list", "--max-parents=0", "HEAD");
    await assert.rejects(ws.get("notes").restore(first), /before this project had a chart/);
  });
});

describe("opening an existing git repo", () => {
  let dir = "";
  before(async () => {
    dir = path.join(disk, "work", "notes");
    await write(dir, { ...CODE, ".gitignore": "node_modules/\n" });
    gitIn(dir, "init", "-q", "-b", "trunk");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "my own commit");
  });

  it("refuses while there are uncommitted changes", async () => {
    await writeFile(path.join(dir, "src/server.js"), "// work in progress\n");
    const info = await ws.inspect(dir);
    assert.match(info.blocked ?? "", /1 uncommitted change/);
    await assert.rejects(ws.openFolder(dir), /uncommitted/);
    gitIn(dir, "checkout", "--", "src/server.js");
  });

  it("refuses a folder inside a bigger repo", async () => {
    const info = await ws.inspect(path.join(dir, "src"));
    assert.match(info.blocked ?? "", /part of a bigger git repo/);
  });

  it("commits the chart on the user's branch, keeping their history", async () => {
    const info = await ws.inspect(dir);
    assert.equal(info.blocked, null);
    assert.equal(info.git.branch, "trunk");
    assert.equal(info.name, "notes-2", "the name is free");
    const r = await ws.openFolder(dir, { wait: true });
    assert.equal(r.name, "notes-2");
    assert.equal(gitIn(dir, "branch", "--show-current"), "trunk");
    assert.deepEqual(gitIn(dir, "log", "--pretty=%s").split("\n"), ["Draw chart from the existing code", "my own commit"]);
  });

  it("forget removes it from the list and leaves the folder alone", async () => {
    ws.forget("notes-2");
    assert.equal((await ws.list()).some((p) => p.name === "notes-2"), false);
    assert.ok(existsSync(path.join(dir, ".chart/chart.json")));
    assert.throws(() => ws.forget("notes-2"), /projects folder/);
  });
});

describe("folders that can't be opened", () => {
  it("refuses the home folder, a drive, and folders holding the app", async () => {
    assert.match((await ws.inspect(os.homedir())).blocked ?? "", /home folder/);
    assert.match((await ws.inspect(path.parse(tmp).root)).blocked ?? "", /drive/);
    assert.match((await ws.inspect(tmp)).blocked ?? "", /holds Chart Driven Development/);
    await mkdir(path.join(wsRoot, "stray", "x"), { recursive: true });
    assert.match((await ws.inspect(path.join(wsRoot, "stray"))).blocked ?? "", /isn't a project/);
  });

  it("refuses the app's own code", async () => {
    await write(path.join(tmp, "app", "src"), { "index.js": "export function x() {}\n" });
    assert.match((await ws.inspect(path.join(tmp, "app", "src"))).blocked ?? "", /part of Chart Driven Development itself/);
  });

  it("refuses empty folders and missing paths", async () => {
    await mkdir(path.join(disk, "empty"), { recursive: true });
    assert.match((await ws.inspect(path.join(disk, "empty"))).blocked ?? "", /empty/);
    await assert.rejects(ws.inspect(path.join(disk, "nope")), /There's no folder/);
    await assert.rejects(ws.inspect(path.join(disk, "notes", "README.md")), /not a folder/);
  });
});

describe("a Chart Driven Development project copied from elsewhere", () => {
  it("opens without drawing anything new", async () => {
    const dir = path.join(disk, "shared", "todo");
    await write(dir, { ".chart/chart.json": JSON.stringify({ version: 1, name: "todo", idea: "todo app", stack: null, root: { nodes: [{ id: "ui", name: "UI", kind: "module", description: "", inputs: [], outputs: [], status: "ready" }], edges: [] } }) });
    const info = await ws.inspect(dir);
    assert.equal(info.kind, "chart");
    assert.equal(info.blocked, null);
    const r = await ws.openFolder(dir);
    assert.equal(r.chart.idea, "todo app");
    assert.equal(gitIn(dir, "log", "--pretty=%s"), "Before Chart Driven Development: the existing files");
  });
});

describe("drawing step by step", () => {
  /** Mock AI whose steps wait for the test to let them go, so each step can be checked. */
  class GatedAI extends MockAI {
    gates: (() => void)[] = [];
    failModules = false;
    failModule: string | null = null;
    private gate() {
      return new Promise<void>((r) => this.gates.push(r));
    }
    override async chartModules(ctx: Parameters<MockAI["chartModules"]>[0]) {
      await this.gate();
      if (this.failModules) throw new Error("DeepSeek is down");
      return super.chartModules(ctx);
    }
    override async chartModule(ctx: Parameters<MockAI["chartModule"]>[0]) {
      await this.gate();
      if (ctx.module.id === this.failModule) throw new Error("cut off");
      return super.chartModule(ctx);
    }
  }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn(), "timed out");
  };
  const release = async (ai: GatedAI) => {
    await until(() => ai.gates.length > 0);
    ai.gates.shift()!();
  };

  it("shows modules first, then fills in each module, and commits once at the end", async () => {
    const ai = new GatedAI();
    const w = new Workspace(path.join(tmp, "ws-steps"), ai);
    const dir = path.join(disk, "steps", "notes");
    await write(dir, CODE);
    const r = await w.openFolder(dir);
    assert.equal(r.drawing, true);
    assert.equal(r.chart.drawing, true);
    assert.equal(r.chart.root.nodes.length, 0, "an empty board to start");
    const p = w.get(r.name);
    const charts: ProjectChart[] = [];
    let drawn: Extract<ServerEvent, { type: "drawn" }> | null = null;
    p.events.on("event", (ev: ServerEvent) => {
      if (ev.type === "chart") charts.push(structuredClone(ev.chart));
      if (ev.type === "drawn") drawn = ev;
    });

    await release(ai); // modules
    await until(() => charts.some((c) => c.root.nodes.length > 0));
    const first = charts.find((c) => c.root.nodes.length > 0)!;
    assert.ok(first.drawing);
    assert.ok(first.root.nodes.every((m) => !m.children?.nodes.length), "modules arrive before their functions");
    assert.equal(gitIn(dir, "log", "--pretty=%s", "-1"), "Before Chart Driven Development: the existing files", "nothing committed mid-way");

    const count = first.root.nodes.length;
    for (let i = 0; i < count; i++) {
      await release(ai);
      await until(() => charts.at(-1)!.root.nodes.filter((m) => m.children?.nodes.length).length >= i + 1 || !!drawn);
    }
    await until(() => !!drawn);
    const done = drawn as unknown as Extract<ServerEvent, { type: "drawn" }>;
    assert.equal(done.chart.drawing, undefined);
    assert.ok(done.chart.root.nodes.find((m) => m.id === "notes")?.children?.nodes.some((f) => f.symbol === "addNote"));
    assert.equal(gitIn(dir, "log", "--pretty=%s", "-1"), "Draw chart from the existing code");
    assert.equal(gitIn(dir, "status", "--porcelain"), "");
    assert.equal(p.drawing, null);
    w.closeAll();
  });

  it("keeps going when one module can't be drawn", async () => {
    const ai = new GatedAI();
    ai.failModule = "storage";
    const w = new Workspace(path.join(tmp, "ws-partial"), ai);
    const dir = path.join(disk, "partial", "notes");
    await write(dir, CODE);
    const opened = w.openFolder(dir, { wait: true });
    const pump = setInterval(() => ai.gates.shift()?.(), 5);
    const r = await opened.finally(() => clearInterval(pump));
    assert.ok(r.warnings?.some((x) => /Storage|storage/.test(x) && /couldn't be drawn/.test(x)));
    assert.equal(r.chart.root.nodes.find((m) => m.id === "storage")?.children?.nodes.length, 0);
    assert.ok(r.chart.root.nodes.find((m) => m.id === "notes")?.children?.nodes.length);
    w.closeAll();
  });

  it("puts the folder back and leaves the list when drawing fails", async () => {
    const ai = new GatedAI();
    ai.failModules = true;
    const w = new Workspace(path.join(tmp, "ws-fail"), ai);
    const dir = path.join(disk, "failing", "notes");
    await write(dir, CODE);
    const r = await w.openFolder(dir);
    const p = w.get(r.name);
    let failed = "";
    p.events.on("event", (ev: ServerEvent) => {
      if (ev.type === "draw-failed") failed = ev.message;
    });
    await release(ai);
    await until(() => !!failed);
    assert.match(failed, /DeepSeek is down/);
    await until(() => !existsSync(path.join(dir, ".chart")));
    assert.equal((await w.list()).length, 0);
    assert.equal(await readFile(path.join(dir, "src/server.js"), "utf8"), CODE["src/server.js"]);
    // Opening it again starts over.
    ai.failModules = false;
    const pump = setInterval(() => ai.gates.shift()?.(), 5);
    const again = await w.openFolder(dir, { wait: true }).finally(() => clearInterval(pump));
    assert.ok(again.chart.root.nodes.length > 0);
    w.closeAll();
  });
});

describe("moved and damaged folders", () => {
  it("a moved folder takes back its name when opened from its new place", async () => {
    const a = path.join(disk, "moving", "before", "mover");
    await write(a, { "main.py": "def run():\n    pass\n" });
    assert.equal((await ws.openFolder(a, { wait: true })).name, "mover");
    const b = path.join(disk, "moving", "after", "mover");
    await mkdir(path.dirname(b), { recursive: true });
    await (await import("node:fs/promises")).rename(a, b);
    assert.equal((await ws.list()).find((p) => p.name === "mover")?.missing, true);
    const r = await ws.openFolder(b, { wait: true });
    assert.equal(r.name, "mover");
    assert.equal(ws.get("mover").dir, b);
    assert.equal((await ws.list()).filter((p) => p.name.startsWith("mover")).length, 1);
  });

  it("refuses a damaged chart file", async () => {
    const dir = path.join(disk, "damaged");
    await write(dir, { ".chart/chart.json": "{ not json", "a.js": "x" });
    assert.match((await ws.inspect(dir)).blocked ?? "", /damaged/);
  });
});

describe("find it for me", () => {
  before(async () => {
    await write(path.join(disk, "games", "space-shooter"), { "package.json": JSON.stringify({ description: "A canvas space shooter game" }), "main.js": "function loop() {}\n" });
    await write(path.join(disk, "games", "chess-engine"), { "Cargo.toml": "[package]\nname='chess'\n", "src/main.rs": "fn main() {}\n" });
    await write(path.join(disk, ".hidden", "secret-shooter"), { "package.json": "{}" });
    await write(path.join(disk, "games", "node_modules", "shooter-lib"), { "package.json": "{}" });
  });

  it("scans read-only, skipping hidden folders, dependencies and the inside of projects", async () => {
    const scan = await scanForProjects({ roots: [disk] });
    const names = scan.candidates.map((c) => c.name).sort();
    assert.ok(names.includes("space-shooter") && names.includes("chess-engine"));
    assert.ok(!names.includes("secret-shooter") && !names.includes("shooter-lib"));
    assert.ok(!scan.candidates.some((c) => c.path.includes(`${path.sep}src`)), "doesn't look inside a project");
    assert.equal(scan.candidates.find((c) => c.name === "space-shooter")?.description, "A canvas space shooter game");
  });

  it("keeps searching when the root itself is a repo (dotfiles in the home folder)", async () => {
    const home = path.join(tmp, "dotfiles-home");
    await write(home, { ".git/HEAD": "ref: refs/heads/main\n", "code/site/package.json": "{}" });
    const scan = await scanForProjects({ roots: [home] });
    assert.deepEqual(scan.candidates.map((c) => c.name), ["site"]);
  });

  it("ranks the folders that match the description", async () => {
    const r = await ws.find("my space shooter game");
    assert.equal(r.matches[0]?.name, "space-shooter");
    assert.equal(r.matches[0].path, path.join(disk, "games", "space-shooter"));
    assert.ok(r.searched >= 4);
  });

  it("falls back to keyword matching when the AI can't rank", async () => {
    const ai = new MockAI();
    ai.pickProjects = async () => {
      throw new Error("no key");
    };
    const w = new Workspace(wsRoot, ai, { searchRoots: [disk] });
    const r = await w.find("chess");
    assert.equal(r.matches[0]?.name, "chess-engine");
    assert.match(r.note ?? "", /couldn't rank/);
  });

  it("ignores paths the AI makes up", async () => {
    const ai = new MockAI();
    ai.pickProjects = async () => [{ path: "/etc", reason: "made up" }, { path: path.join(disk, "games", "chess-engine"), reason: "ok" }];
    const r = await new Workspace(wsRoot, ai, { searchRoots: [disk] }).find("chess");
    assert.deepEqual(r.matches.map((m) => m.name), ["chess-engine"]);
  });
});

describe("source selection", () => {
  it("reads manifests first, skips lockfiles and dependencies, puts tests last", async () => {
    const dir = path.join(tmp, "sel");
    await write(dir, { "package.json": "{}", "package-lock.json": "{}", "src/a.test.js": "t", "src/index.js": "i", "dist/app.min.js": "x" });
    const r = await selectSources(dir, ["package.json", "package-lock.json", "src/a.test.js", "src/index.js", "dist/app.min.js"]);
    assert.deepEqual(r.files.map((f) => f.path), ["package.json", "src/index.js", "src/a.test.js"]);
    assert.ok(!r.tree.includes("package-lock.json"));
  });
});

describe("HTTP API", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  before(async () => {
    server = createServer(ws, "mock");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };

  it("browses folders and marks projects", async () => {
    const r = await call("GET", `/api/browse?path=${encodeURIComponent(path.join(disk, "games"))}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.dirs.map((d: { name: string; project: boolean }) => [d.name, d.project]), [["chess-engine", true], ["node_modules", false], ["space-shooter", true]]);
    assert.equal(r.data.parent, disk);
  });

  it("inspects, opens and finds", async () => {
    const dir = path.join(disk, "games", "chess-engine");
    const info = await call("POST", "/api/open/inspect", { path: dir });
    assert.equal(info.data.kind, "code");
    const opened = await call("POST", "/api/open", { path: dir });
    assert.equal(opened.status, 200);
    assert.equal(opened.data.name, "chess-engine");
    assert.equal(opened.data.drawing, true, "returns at once; the chart arrives as events");
    let proj = await call("GET", "/api/projects/chess-engine");
    assert.equal(proj.data.dir, dir);
    for (let i = 0; i < 100 && proj.data.drawing; i++) {
      await new Promise((r) => setTimeout(r, 30));
      proj = await call("GET", "/api/projects/chess-engine");
    }
    assert.equal(proj.data.drawing, false);
    assert.ok(proj.data.chart.root.nodes.length > 0);
    assert.equal(proj.data.chart.drawing, undefined);
    const again = await call("POST", "/api/projects/chess-engine/redraw", {});
    assert.equal(again.status, 400, "a finished chart isn't redrawn");
    const found = await call("POST", "/api/find", { description: "chess" });
    assert.equal(found.data.matches[0].name, "chess-engine");
    const forget = await call("POST", "/api/projects/chess-engine/forget", {});
    assert.equal(forget.status, 200);
  });

  it("explains blocked folders", async () => {
    const r = await call("POST", "/api/open", { path: os.homedir() });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /home folder/);
  });
});

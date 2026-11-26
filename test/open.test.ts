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
    const r = await ws.openFolder(dir);
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
    const r = await ws.openFolder(dir);
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
    const proj = await call("GET", "/api/projects/chess-engine");
    assert.equal(proj.data.dir, dir);
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

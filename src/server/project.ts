// A generated project: a normal folder on disk with real code, a git repo, and the chart in .chart/chart.json.
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyOps, filesOf, findBubble, getLevel, normBubble, normEdge, slug } from "../shared/chart.ts";
import type {
  Bubble,
  ChangeSet,
  FileChange,
  HistoryEntry,
  Level,
  ProjectChart,
  ProjectSummary,
  Recommendation,
  RecommendationOption,
  RunTrace,
  ServerEvent,
  Stack,
  StackProposal,
} from "../shared/types.ts";
import type { AI } from "./ai/ai.ts";
import * as git from "./git.ts";

const CHART_FILE = ".chart/chart.json";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Compare path segments the way a case-insensitive filesystem (macOS, Windows) would. */
function fold(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/, "");
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve a project-relative path, refusing anything that escapes the folder (including through symlinks),
 * touches a .git folder (at any depth) or the project's own .chart folder (at the root). Used for every file the app or the AI reads or writes.
 */
export function safePath(root: string, rel: string): string {
  const escape = () => new HttpError(400, `Path escapes project: ${rel}`);
  const clean = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  const relative = path.relative(root, abs);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw escape();
  const segs = relative.split(path.sep).filter(Boolean);
  if (segs.some((s) => fold(s) === ".git") || (segs.length && fold(segs[0]) === ".chart")) {
    throw new HttpError(400, `Reserved path: ${rel}`);
  }
  // Symlinks: the nearest existing ancestor (or the file itself) must really live inside the project.
  const realRoot = realOrNull(root) ?? root;
  let probe = abs;
  while (probe !== root && !lstatOrNull(probe)) probe = path.dirname(probe);
  const real = realOrNull(probe);
  if (!real) throw escape(); // dangling symlink
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw escape();
  if (real !== probe && probe !== root) {
    // Followed a symlink inside the project: re-check the reserved names on the real path.
    const realSegs = path.relative(realRoot, real).split(path.sep).filter(Boolean);
    if (realSegs.some((s) => fold(s) === ".git") || (realSegs.length && fold(realSegs[0]) === ".chart")) throw new HttpError(400, `Reserved path: ${rel}`);
  }
  return abs;
}

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export class Project {
  readonly events = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();
  private watcher: NodeJS.Timeout | null = null;
  private busy = 0;
  private lastOutside = "";

  constructor(readonly dir: string, readonly name: string, private ai: AI) {}

  // ---------- basics ----------

  emit(ev: ServerEvent) {
    this.events.emit("event", ev);
  }

  progress(message: string) {
    this.emit({ type: "progress", message });
  }

  /** Run project operations one at a time; file watching is paused while the app itself writes. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.busy++;
      try {
        return await fn();
      } finally {
        // Let fs events from our own writes settle before watching again.
        setTimeout(() => this.busy--, 600);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async loadChart(): Promise<ProjectChart> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, CHART_FILE), "utf8")) as ProjectChart;
    } catch {
      throw new HttpError(404, `Project "${this.name}" has no chart yet`);
    }
  }

  async saveChart(pc: ProjectChart) {
    await mkdir(path.join(this.dir, ".chart"), { recursive: true });
    await writeFile(path.join(this.dir, CHART_FILE), JSON.stringify(pc, null, 2) + "\n");
    this.emit({ type: "chart", chart: pc });
  }

  async writeFiles(files: FileChange[]): Promise<string[]> {
    const written: string[] = [];
    for (const f of files) {
      const abs = safePath(this.dir, f.path);
      if (f.content === null) {
        await rm(abs, { force: true });
      } else {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, f.content);
      }
      written.push(f.path);
    }
    return written;
  }

  async readFiles(paths: string[]): Promise<FileChange[]> {
    const out: FileChange[] = [];
    for (const p of new Set(paths)) {
      try {
        out.push({ path: p, content: await readFile(safePath(this.dir, p), "utf8") });
      } catch {
        /* missing files are skipped */
      }
    }
    return out;
  }

  async readSourceFile(rel: string): Promise<string> {
    try {
      return await readFile(safePath(this.dir, rel), "utf8");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, `File not found: ${rel}`);
    }
  }

  /** Stage and commit everything. Returns false when there was nothing to commit. */
  async commit(message: string): Promise<boolean> {
    const made = await git.commitAll(this.dir, message);
    this.lastOutside = "";
    return made;
  }

  // ---------- creation ----------

  static async create(dir: string, name: string, idea: string, ai: AI): Promise<Project> {
    if (existsSync(dir)) throw new HttpError(409, `A project named "${name}" already exists`);
    await mkdir(dir, { recursive: true });
    await git.init(dir);
    const p = new Project(dir, name, ai);
    const pc: ProjectChart = { version: 1, name, idea, stack: null, root: { nodes: [], edges: [] } };
    await p.saveChart(pc);
    await p.commit(`Start project: ${idea}`);
    return p;
  }

  proposeStack(): Promise<StackProposal> {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      this.progress("Picking a tech stack…");
      return this.ai.proposeStack(pc.idea);
    });
  }

  /** Draw the module chart and write the code for every module. One commit per step. */
  generate(stack: Stack): Promise<ProjectChart> {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      pc.stack = stack;
      this.progress("Drawing the chart…");
      pc.root = await this.ai.designChart(pc.idea, stack);
      await this.saveChart(pc);
      await this.commit(`Draw chart (${stack.name})`);

      let files: FileChange[] = [];
      this.progress("Writing project scaffolding…");
      const scaffold = await this.ai.writeCode({ chart: pc, module: null, files });
      await this.writeFiles(scaffold);
      files = mergeFiles(files, scaffold);
      await this.commit("Write project scaffolding");

      for (const mod of pc.root.nodes) {
        this.progress(`Writing code for ${mod.name}…`);
        const written = await this.ai.writeCode({ chart: pc, module: mod, files });
        await this.writeFiles(written);
        files = mergeFiles(files, written);
        await this.commit(`Write module ${mod.name}`);
      }
      this.progress("Done");
      return pc;
    });
  }

  // ---------- AI-driven changes ----------

  private async focus(pc: ProjectChart, level: Level, bubbleId: string) {
    const bubble = findBubble(pc, level, bubbleId);
    if (!bubble) throw new HttpError(404, `No bubble "${bubbleId}" in ${level}`);
    const paths = new Set<string>(filesOf(pc, level === "root" ? bubble.id : level));
    if (bubble.file) paths.add(bubble.file);
    return { chart: pc, level, bubble, files: await this.readFiles([...paths]) };
  }

  recommend(level: Level, bubbleId: string, request: string): Promise<Recommendation> {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      this.progress("Thinking about how to proceed…");
      return this.ai.recommend({ ...(await this.focus(pc, level, bubbleId)), request });
    });
  }

  applyChange(level: Level, bubbleId: string, request: string, option: RecommendationOption) {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      this.progress(`Applying: ${option.label}…`);
      const cs = await this.ai.applyChange({ ...(await this.focus(pc, level, bubbleId)), request, option });
      return this.applyChangeSet(pc, cs, `${option.label} — ${request}`);
    });
  }

  implementBubble(level: Level, bubbleId: string) {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      const ctx = await this.focus(pc, level, bubbleId);
      this.progress(`Writing code for ${ctx.bubble.name}…`);
      const cs = await this.ai.implementBubble(ctx);
      return this.applyChangeSet(pc, cs, `Write code for ${ctx.bubble.name}`);
    });
  }

  private async applyChangeSet(pc: ProjectChart, cs: ChangeSet, title: string) {
    const warnings = applyOps(pc, cs.ops);
    await this.writeFiles(cs.files);
    await this.saveChart(pc);
    await this.commit(`${title}\n\n${cs.summary}`);
    this.progress("Done");
    return { chart: pc, summary: cs.summary, files: cs.files.map((f) => f.path), warnings };
  }

  // ---------- hand-drawn edits ----------

  addBubble(level: Level, raw: Partial<Bubble>) {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      const chart = getLevel(pc, level);
      if (!chart) throw new HttpError(404, `No module "${level}"`);
      const b = normBubble({ ...raw, status: "draft" }, level === "root" ? "module" : "function");
      if (!b) throw new HttpError(400, "A bubble needs a name");
      let id = b.id;
      for (let i = 2; chart.nodes.some((n) => n.id === id); i++) id = `${b.id}-${i}`;
      b.id = id;
      if (b.kind === "module" && !b.children) b.children = { nodes: [], edges: [] };
      chart.nodes.push(b);
      await this.saveChart(pc);
      await this.commit(`Draw bubble ${b.name}`);
      return { chart: pc, bubble: b };
    });
  }

  addEdge(level: Level, raw: { from: string; to: string; data?: string }) {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      const chart = getLevel(pc, level);
      if (!chart) throw new HttpError(404, `No module "${level}"`);
      const order = Math.max(0, ...chart.edges.map((e) => e.order)) + 1;
      const e = normEdge({ ...raw, order }, chart.edges.length);
      if (!e) throw new HttpError(400, "An arrow needs from and to");
      applyOps(pc, [{ op: "upsertEdge", parent: level, edge: e }]);
      await this.saveChart(pc);
      await this.commit(`Draw arrow ${e.from} → ${e.to}`);
      return { chart: pc };
    });
  }

  removeBubble(level: Level, id: string) {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      const b = findBubble(pc, level, id);
      if (!b) throw new HttpError(404, `No bubble "${id}"`);
      applyOps(pc, [{ op: "removeNode", parent: level, id }]);
      await this.saveChart(pc);
      await this.commit(`Remove bubble ${b.name} from the chart`);
      return { chart: pc };
    });
  }

  // ---------- run animation ----------

  simulateRun(level: Level): Promise<RunTrace> {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      this.progress("Inventing test data…");
      return this.ai.simulateRun(pc, level);
    });
  }

  // ---------- history ----------

  history(): Promise<HistoryEntry[]> {
    return git.history(this.dir);
  }

  restore(sha: string) {
    return this.exclusive(() => this.restoreUnlocked(sha));
  }

  /** Restore without taking the project lock (for callers that already hold it, like the assistant). */
  async restoreUnlocked(sha: string, pendingMessage = "Save outside edits before restoring") {
    // Keep any uncommitted edits in history before replacing the working tree.
    await this.commit(pendingMessage);
    const entries = await git.history(this.dir, 200);
    const target = entries.find((e) => e.sha.startsWith(sha));
    if (!target) throw new HttpError(404, "Unknown version");
    await git.restore(this.dir, target.sha, `Restore: ${target.message.split("\n")[0]}`);
    const pc = await this.loadChart();
    this.emit({ type: "chart", chart: pc });
    return { chart: pc };
  }

  /** Go back one step: restore the version before the latest commit. */
  async undo() {
    return this.exclusive(() => this.undoUnlocked());
  }

  async undoUnlocked(pendingMessage?: string) {
    if (pendingMessage) await this.commit(pendingMessage);
    const entries = await git.history(this.dir, 2);
    if (entries.length < 2) throw new HttpError(400, "Nothing to undo");
    return this.restoreUnlocked(entries[1].sha);
  }

  // ---------- outside edits ----------

  /**
   * Poll for outside edits while someone is looking at the project. `git status` is cheap, and
   * polling survives files being replaced (editors, git checkouts) where recursive fs.watch does not.
   */
  watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      if (this.busy > 0 || this.events.listenerCount("event") === 0) return;
      this.checkOutside().catch(() => undefined);
    }, 1500);
    this.watcher.unref();
  }

  close() {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** Report files changed outside the app (uncommitted changes, since the app commits everything it does). */
  async checkOutside(force = false): Promise<string[]> {
    if (this.busy > 0 && !force) return [];
    const files = (await git.changedFiles(this.dir)).filter((f) => !f.startsWith(".chart/"));
    const key = files.join("\n");
    if (files.length && (force || key !== this.lastOutside)) this.emit({ type: "outside-change", files });
    this.lastOutside = key;
    return files;
  }

  syncFromCode() {
    return this.exclusive(async () => {
      const pc = await this.loadChart();
      const changed = (await git.changedFiles(this.dir)).filter((f) => !f.startsWith(".chart/"));
      if (!changed.length) return { chart: pc, summary: "No outside changes found.", warnings: [] as string[] };
      this.progress(`Reading ${changed.length} changed file(s)…`);
      const diff = await git.workingDiff(this.dir);
      const cs = await this.ai.syncFromCode({ chart: pc, diff, files: await this.readFiles(changed) });
      const warnings = applyOps(pc, cs.ops);
      await this.saveChart(pc);
      await this.commit(`Update chart from outside edits\n\n${cs.summary}\n\nFiles: ${changed.join(", ")}`);
      this.progress("Done");
      return { chart: pc, summary: cs.summary, warnings };
    });
  }

  /** Keep outside edits without updating the chart. */
  acceptOutside() {
    return this.exclusive(async () => {
      await this.commit("Outside edits (chart not updated)");
      return { ok: true };
    });
  }
}

function mergeFiles(a: FileChange[], b: FileChange[]): FileChange[] {
  const map = new Map(a.map((f) => [f.path, f]));
  for (const f of b) map.set(f.path, f);
  return [...map.values()];
}

/** All projects live as sub-folders of the workspace. */
export class Workspace {
  private open = new Map<string, Project>();

  constructor(readonly root: string, private ai: AI) {}

  async list(): Promise<ProjectSummary[]> {
    await mkdir(this.root, { recursive: true });
    const out: ProjectSummary[] = [];
    for (const d of await readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const pc = JSON.parse(await readFile(path.join(this.root, d.name, CHART_FILE), "utf8")) as ProjectChart;
        out.push({ name: d.name, idea: pc.idea, hasChart: pc.root.nodes.length > 0 });
      } catch {
        /* not a chart project */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(rawName: string, idea: string): Promise<Project> {
    const name = slug(rawName || idea).slice(0, 60);
    if (!idea.trim()) throw new HttpError(400, "Describe the app you want to build");
    const p = await Project.create(path.join(this.root, name), name, idea.trim(), this.ai);
    this.open.set(name, p);
    p.watch();
    return p;
  }

  get(name: string): Project {
    const existing = this.open.get(name);
    if (existing) return existing;
    if (slug(name) !== name) throw new HttpError(400, "Invalid project name");
    const dir = path.join(this.root, name);
    if (!existsSync(path.join(dir, CHART_FILE))) throw new HttpError(404, `No project "${name}"`);
    const p = new Project(dir, name, this.ai);
    this.open.set(name, p);
    p.watch();
    return p;
  }

  closeAll() {
    for (const p of this.open.values()) p.close();
  }
}

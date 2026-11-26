// A generated project: a normal folder on disk with real code, a git repo, and the chart in .chart/chart.json.
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyOps, filesOf, findBubble, getLevel, normBubble, normEdge, slug } from "../shared/chart.ts";
import type {
  Bubble,
  Chart,
  ChangeSet,
  FileChange,
  FindResult,
  FolderInspection,
  FoundProject,
  HistoryEntry,
  Level,
  ProjectChart,
  ProjectSummary,
  Recommendation,
  RecommendationOption,
  RunChatMessage,
  RunTrace,
  ServerEvent,
  Stack,
  StackProposal,
} from "../shared/types.ts";
import type { AI } from "./ai/ai.ts";
import * as git from "./git.ts";
import {
  DEFAULT_EXCLUDES,
  MAX_FILES,
  countFiles,
  displayPath,
  expandPath,
  homeDir,
  keywordScore,
  languagesOf,
  realFolder,
  scanForProjects,
  searchRoots,
  selectSources,
  within,
} from "./importer.ts";

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

  progress(message: string, module?: string) {
    this.emit(module ? { type: "progress", message, module } : { type: "progress", message });
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

  /** The running job that draws this project's chart from its code, if any. */
  drawing: Promise<DrawResult> | null = null;

  /**
   * Draw the chart of the code already in the folder, in the background: modules first, then each module's
   * functions. The chart is saved (and sent as a "chart" event) after every step, so the board fills in as
   * the AI finds things; it's committed once, at the end. Ends with a "drawn" or "draw-failed" event.
   */
  startDrawing(): Promise<DrawResult> {
    if (this.drawing) return this.drawing;
    const job = this.drawFromCode().then(
      (r) => {
        this.emit({ type: "drawn", ...r });
        return r;
      },
      async (e: unknown) => {
        await this.discardUnfinishedChart();
        this.emit({ type: "draw-failed", message: (e as Error).message });
        throw e;
      },
    );
    this.drawing = job.finally(() => (this.drawing = null));
    this.drawing.catch(() => undefined); // failures are reported as events; callers that await still see them
    return this.drawing;
  }

  private drawFromCode(): Promise<DrawResult> {
    return this.exclusive(async () => {
      const folder = path.basename(this.dir);
      const all = await git.listFiles(this.dir);
      const known = new Set(all);
      const { tree, files, omitted } = await selectSources(this.dir, all);
      const pc: ProjectChart = { version: 1, name: this.name, idea: "Reading the code…", stack: null, root: { nodes: [], edges: [] }, drawing: true };
      await this.saveChart(pc);
      this.progress(`Reading ${files.length} file(s) to find the modules…`);
      const top = await this.ai.chartModules({ folder, tree, files, omitted });
      if (!top.root.nodes.length) throw new HttpError(502, "The AI couldn't find any modules in this code. Try again.");
      pc.idea = top.idea || `The existing project in ${folder}`;
      pc.stack = top.stack;
      pc.root = top.root;
      const warnings = dropMissingFiles(pc.root.nodes, known);
      await this.saveChart(pc);

      const mods = pc.root.nodes;
      for (const [i, m] of mods.entries()) {
        this.progress(`Drawing ${m.name} (${i + 1} of ${mods.length})…`, m.id);
        let own = (top.files[m.id] ?? []).map(cleanRel).filter((f) => known.has(f));
        if (!own.length && m.file) {
          const dir = path.posix.dirname(m.file);
          own = dir === "." ? [m.file] : all.filter((f) => f.startsWith(dir + "/"));
        }
        try {
          if (!own.length) throw new Error("no files of its own were found");
          const sel = await selectSources(this.dir, own, 70_000);
          const inner = await this.ai.chartModule({ folder, chart: pc, module: m, files: sel.files });
          warnings.push(...dropMissingFiles(inner.nodes, known));
          m.children = inner;
        } catch (e) {
          if (e instanceof HttpError && e.status === 400) throw e; // e.g. no API key: stop rather than repeat it per module
          warnings.push(`${m.name}: its functions couldn't be drawn (${(e as Error).message}). Select it and ask the AI to fill it in.`);
          m.children = { nodes: [], edges: [] };
        }
        await this.saveChart(pc);
      }
      delete pc.drawing;
      await this.saveChart(pc);
      await this.commit(`Draw chart from the existing code\n\n${top.summary}`);
      this.progress("Done");
      return { chart: pc, summary: top.summary, warnings };
    });
  }

  /** After a failed drawing, remove the half-drawn chart, unless .chart was already in git (then git has the real one). */
  private async discardUnfinishedChart() {
    try {
      if ((await git.git(this.dir, ["ls-files", "--", ".chart"])).trim()) {
        await git.git(this.dir, ["checkout", "--", ".chart"]);
      } else {
        await rm(path.join(this.dir, ".chart"), { recursive: true, force: true });
      }
    } catch {
      /* leave it; the next open shows it as unfinished */
    }
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

  /** Apply AI changes (chart ops + files) and save them as one version. Call while holding the project lock. */
  async applyChangeSet(pc: ProjectChart, cs: ChangeSet, title: string) {
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

  /** Answer a question about a run. Only reads the chart, so it doesn't wait for other work on the project. */
  async explainRun(level: Level, trace: RunTrace, history: RunChatMessage[], question: string): Promise<string> {
    const pc = await this.loadChart();
    // The trace comes back from the browser: keep it small.
    const small: RunTrace = {
      scenario: String(trace.scenario ?? "").slice(0, 300),
      steps: trace.steps.filter((s) => s && typeof s === "object").slice(0, 20).map((s) => ({ nodeId: String(s.nodeId).slice(0, 120), data: String(s.data ?? "").slice(0, 200), note: String(s.note ?? "").slice(0, 300) })),
    };
    return this.ai.explainRun({ chart: pc, level, trace: small, history, question });
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
    // At least 4 hex characters, so a stray "a" can't pick some random version.
    if (!/^[0-9a-f]{4,40}$/i.test(sha.trim())) throw new HttpError(400, "Invalid version id");
    const entries = await git.history(this.dir, 200);
    const target = entries.find((e) => e.sha.startsWith(sha.trim().toLowerCase()));
    if (!target) throw new HttpError(404, "Unknown version");
    // A folder opened from disk has history from before it had a chart; going back there would lose the chart.
    if (!(await git.hasFileAt(this.dir, target.sha, CHART_FILE))) throw new HttpError(400, "That version is from before this project had a chart, so it can't be restored here. Use git directly if you need it.");
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
    if (entries.length < 2 || !(await git.hasFileAt(this.dir, entries[1].sha, CHART_FILE))) throw new HttpError(400, "Nothing to undo");
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

const cleanRel = (f: string) => f.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

/** Bubbles drawn from existing code may name files that don't exist; drop those links rather than point at nothing. */
function dropMissingFiles(nodes: Bubble[], known: Set<string>): string[] {
  const warnings: string[] = [];
  for (const b of nodes) {
    if (b.file) b.file = cleanRel(b.file);
    if (b.file && !known.has(b.file)) {
      warnings.push(`${b.name}: the AI named a file that doesn't exist (${b.file}), so it isn't linked.`);
      delete b.file;
      delete b.symbol;
    }
  }
  return warnings;
}

export interface OpenResult {
  name: string;
  chart: ProjectChart;
  /** The chart is still being drawn; it arrives step by step as project events. */
  drawing: boolean;
  summary?: string;
  warnings?: string[];
}

export interface DrawResult {
  chart: ProjectChart;
  summary: string;
  warnings: string[];
}

function mergeFiles(a: FileChange[], b: FileChange[]): FileChange[] {
  const map = new Map(a.map((f) => [f.path, f]));
  for (const f of b) map.set(f.path, f);
  return [...map.values()];
}

export interface WorkspaceOptions {
  /** Where folders opened from elsewhere are remembered. Default: <root>/.linked-projects.json */
  registry?: string;
  /** Folders that must never be opened as a project, nor any folder that contains them (the app's own code). */
  protectedDirs?: string[];
  /** Where "Find it for me" looks. Default: the home folder (or CDD_SEARCH_ROOTS). */
  searchRoots?: string[];
}

interface LinkedEntry {
  name: string;
  dir: string;
}

/**
 * The app's projects: sub-folders of the workspace, plus folders opened from elsewhere on disk
 * ("linked"), remembered in a small registry file. A linked project works exactly like any other.
 */
export class Workspace {
  private open = new Map<string, Project>();
  private links: LinkedEntry[] | null = null;
  private opening = new Map<string, Promise<OpenResult>>();
  /** The latest drawing job per project name, for callers that wait for it. */
  private jobs = new Map<string, Promise<DrawResult>>();
  readonly registry: string;

  constructor(readonly root: string, readonly ai: AI, readonly options: WorkspaceOptions = {}) {
    this.registry = options.registry ?? path.join(root, ".linked-projects.json");
  }

  private linked(): LinkedEntry[] {
    if (this.links) return this.links;
    try {
      const raw = JSON.parse(readFileSync(this.registry, "utf8")) as { projects?: unknown };
      this.links = (Array.isArray(raw.projects) ? raw.projects : [])
        .filter((e): e is LinkedEntry => !!e && typeof e.name === "string" && typeof e.dir === "string" && slug(e.name) === e.name && path.isAbsolute(e.dir))
        .filter((e, i, all) => all.findIndex((x) => x.name === e.name) === i);
    } catch {
      this.links = [];
    }
    return this.links;
  }

  private saveLinks() {
    mkdirSync(path.dirname(this.registry), { recursive: true });
    const tmp = `${this.registry}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, projects: this.linked() }, null, 2) + "\n");
    renameSync(tmp, this.registry);
  }

  async list(): Promise<ProjectSummary[]> {
    await mkdir(this.root, { recursive: true });
    const out: ProjectSummary[] = [];
    for (const d of await readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      try {
        const pc = JSON.parse(await readFile(path.join(this.root, d.name, CHART_FILE), "utf8")) as ProjectChart;
        out.push({ name: d.name, idea: pc.idea, hasChart: pc.root.nodes.length > 0 });
      } catch {
        /* not a chart project */
      }
    }
    for (const l of this.linked()) {
      if (out.some((p) => p.name === l.name)) continue;
      try {
        const pc = JSON.parse(await readFile(path.join(l.dir, CHART_FILE), "utf8")) as ProjectChart;
        out.push({ name: l.name, idea: pc.idea, hasChart: pc.root.nodes.length > 0, dir: displayPath(l.dir), linked: true });
      } catch {
        out.push({ name: l.name, idea: "", hasChart: false, dir: displayPath(l.dir), linked: true, missing: true });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(rawName: string, idea: string): Promise<Project> {
    const name = slug(rawName || idea).slice(0, 60);
    if (!idea.trim()) throw new HttpError(400, "Describe the app you want to build");
    if (this.linked().some((l) => l.name === name)) throw new HttpError(409, `A project named "${name}" already exists`);
    const p = await Project.create(path.join(this.root, name), name, idea.trim(), this.ai);
    this.open.set(name, p);
    p.watch();
    return p;
  }

  get(name: string): Project {
    const existing = this.open.get(name);
    if (existing) return existing;
    if (slug(name) !== name) throw new HttpError(400, "Invalid project name");
    let dir = path.join(this.root, name);
    if (!existsSync(path.join(dir, CHART_FILE))) {
      const link = this.linked().find((l) => l.name === name);
      if (!link) throw new HttpError(404, `No project "${name}"`);
      if (!existsSync(path.join(link.dir, CHART_FILE))) throw new HttpError(404, `The folder of "${name}" isn't there any more (${displayPath(link.dir)}). It may have moved; open it again from its new place.`);
      dir = link.dir;
    }
    const p = new Project(dir, name, this.ai);
    this.open.set(name, p);
    p.watch();
    return p;
  }

  /** Stop remembering a folder opened from elsewhere. Its files, chart and git history stay as they are. */
  forget(name: string) {
    if (!this.linked().some((l) => l.name === name)) throw new HttpError(400, `"${name}" lives in the app's projects folder; delete its folder there to remove it`);
    return this.remove(name, { deleteFolder: false });
  }

  /**
   * Take a project off the list. By default nothing is lost: a folder opened from elsewhere is just forgotten, and a
   * project the app made is moved to <projects>/.removed/ (move it back to restore it). With `deleteFolder`, the
   * project's folder (code, chart and git history) is deleted from disk for good.
   */
  async remove(name: string, opts: { deleteFolder: boolean }): Promise<{ ok: true; message: string }> {
    if (slug(name) !== name) throw new HttpError(400, "Invalid project name");
    const linkIdx = this.linked().findIndex((l) => l.name === name);
    const own = path.join(this.root, name);
    const isOwn = existsSync(path.join(own, CHART_FILE));
    if (!isOwn && linkIdx < 0) throw new HttpError(404, `No project "${name}"`);
    const dir = isOwn ? own : this.linked()[linkIdx].dir;
    const open = this.open.get(name);
    if (open?.drawing) throw new HttpError(409, "Its chart is still being drawn. Wait for it to finish, then remove it.");

    // Stop watching it first, so nothing polls a folder that's being moved or deleted.
    open?.close();
    let message: string;
    if (opts.deleteFolder) {
      if (existsSync(dir)) {
        const real = realOrNull(dir) ?? dir;
        const guarded = [realOrNull(this.root) ?? this.root, ...(this.options.protectedDirs ?? []).map((d) => realOrNull(d) ?? d)];
        if (path.dirname(real) === real || real === (realOrNull(homeDir()) ?? homeDir()) || guarded.some((g) => within(g, real))) {
          throw new HttpError(400, "That folder can't be deleted from here.");
        }
        await rm(real, { recursive: true, force: true });
      }
      message = `Deleted "${name}" and its folder ${displayPath(dir)}.`;
    } else if (isOwn) {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const trash = path.join(this.root, ".removed");
      await mkdir(trash, { recursive: true });
      let dest = path.join(trash, `${name}-${stamp}`);
      for (let i = 2; existsSync(dest); i++) dest = path.join(trash, `${name}-${stamp}-${i}`);
      await rename(own, dest);
      message = `Removed "${name}" from the list. Its folder was moved to ${displayPath(dest)}; move it back into ${displayPath(this.root)} to restore it.`;
    } else {
      message = `Removed "${name}" from the list. Its folder ${displayPath(dir)} is unchanged.`;
    }
    if (linkIdx >= 0) {
      this.linked().splice(linkIdx, 1);
      this.saveLinks();
    }
    this.open.delete(name);
    this.jobs.delete(name);
    return { ok: true, message };
  }

  /** The project name a folder already has in the app, if any. */
  private nameOf(dir: string): string | null {
    const rel = path.relative(realOrNull(this.root) ?? this.root, dir);
    if (rel && !rel.includes(path.sep) && !rel.startsWith("..") && !path.isAbsolute(rel) && slug(rel) === rel && existsSync(path.join(dir, CHART_FILE))) return rel;
    return this.linked().find((l) => (realOrNull(l.dir) ?? l.dir) === dir)?.name ?? null;
  }

  /** Names being given to folders that are still being opened. */
  private reserved = new Set<string>();

  private freeName(base: string): string {
    const taken = (n: string) => existsSync(path.join(this.root, n)) || this.linked().some((l) => l.name === n) || this.reserved.has(n);
    const s = slug(base).slice(0, 60);
    let name = s;
    for (let i = 2; taken(name); i++) name = `${s}-${i}`;
    return name;
  }

  /** Look at a folder before opening it: what it is, what opening it would do, and whether it can be opened. */
  async inspect(input: string): Promise<FolderInspection> {
    const dir = realFolder(expandPath(input));
    const display = displayPath(dir);
    const known = this.nameOf(dir);
    const hasChart = existsSync(path.join(dir, CHART_FILE));
    const kind: FolderInspection["kind"] = hasChart ? "chart" : "code";
    const result: FolderInspection = {
      path: dir,
      display,
      kind,
      name: known ?? this.freeName(path.basename(dir) || "project"),
      known: !!known,
      git: { repo: false, branch: null, changes: 0 },
      files: 0,
      languages: [],
      blocked: null,
      plan: [],
    };
    const block = (why: string) => ((result.blocked = why), result);
    if (hasChart) {
      try {
        const pc = JSON.parse(readFileSync(path.join(dir, CHART_FILE), "utf8")) as ProjectChart;
        if (!pc || typeof pc !== "object" || !pc.root || !Array.isArray(pc.root.nodes)) throw new Error();
      } catch {
        return block("Its .chart/chart.json is damaged, so it can't be opened. Restore it with git, or delete the .chart folder to draw the chart again from the code.");
      }
    }

    // Never a folder that holds the app itself or all projects: the home folder, a drive, the projects folder.
    const realRoot = realOrNull(this.root) ?? this.root;
    const guarded = [realRoot, ...(this.options.protectedDirs ?? []).map((d) => realOrNull(d) ?? d)];
    if (path.dirname(dir) === dir || dir === (realOrNull(homeDir()) ?? homeDir())) return block("That's a whole drive or your home folder. Pick the project's own folder.");
    if (guarded.some((g) => within(g, dir))) return block("That folder holds Chart Driven Development itself or its projects folder. Pick the project's own folder.");
    if (guarded.slice(1).some((g) => within(dir, g)) && !within(dir, realRoot)) return block("That folder is part of Chart Driven Development itself. Pick one of your own projects.");
    if (within(dir, realRoot) && !known) return block("That's inside the app's projects folder but isn't a project. Open the project's own folder.");

    const top = await git.topLevel(dir);
    if (top) {
      const realTop = realOrNull(top) ?? top;
      if (realTop !== dir) return block(`This folder is part of a bigger git repo (${displayPath(realTop)}). Open that folder instead, so the app's versions can't touch the rest of the repo.`);
      result.git.repo = true;
      result.git.branch = await git.currentBranch(dir);
      const changed = (await git.changedFiles(dir)).filter((f) => !f.startsWith(".chart/"));
      result.git.changes = changed.length;
      const files = await git.listFiles(dir);
      result.files = files.length;
      result.languages = languagesOf(files);
      if (!result.git.branch) return block("The repo isn't on a branch (detached HEAD). Check out a branch first.");
      if (await git.midOperation(dir)) return block("The repo is in the middle of a merge, rebase or cherry-pick. Finish it first.");
      if (kind === "code" && changed.length) {
        return block(`The repo has ${changed.length} uncommitted change${changed.length === 1 ? "" : "s"}. Commit or stash ${changed.length === 1 ? "it" : "them"} first, so your work doesn't get mixed into the app's versions.`);
      }
    } else {
      const counted = await countFiles(dir);
      result.files = counted.files;
      result.languages = languagesOf(counted.paths);
    }
    if (result.files > MAX_FILES) return block(`That folder has more than ${MAX_FILES.toLocaleString("en")} files, which is too big to chart. Open the project's own folder.`);
    if (kind === "code" && !result.languages.length) {
      return block(result.files ? "No source code found in that folder." : "That folder is empty. To start something new, describe it above instead.");
    }

    if (known) result.plan.push(`It's already in your projects as "${known}".`);
    else if (kind === "chart") result.plan.push(`It's a Chart Driven Development project. It's added to your projects as "${result.name}".`);
    if (!result.git.repo) {
      result.plan.push("Starts a git repo in the folder so every change can be undone. Dependencies, build output, logs and .env files are left out (listed in .git/info/exclude, not a new file).");
    }
    if (kind === "code") {
      result.plan.push(`DeepSeek reads the code (the most telling files, up to about 110 KB) and draws the chart. Your code isn't changed.`);
      result.plan.push(`The chart is saved in a .chart folder and committed${result.git.branch ? ` to your branch "${result.git.branch}"` : ""}. Every change the app makes after that is its own commit; history is never rewritten.`);
    } else if (result.git.repo && !known) {
      result.plan.push(`The app commits its changes to your branch "${result.git.branch}", one commit per change.`);
    }
    return result;
  }

  /** Open a folder from disk: link a chart project, or read a plain codebase and draw its chart. */
  /**
   * Open a folder from disk: link a chart project, or start drawing the chart of a plain codebase. By default this
   * returns as soon as the project can be shown (`drawing: true`) and the chart fills in through project events;
   * `wait` returns when the drawing is done instead (the CLI).
   */
  async openFolder(input: string, opts: { wait?: boolean } = {}): Promise<OpenResult> {
    const info = await this.inspect(input);
    if (info.blocked) throw new HttpError(400, info.blocked);
    // Opening the same folder twice at once (double click) shares one import.
    const pending = this.opening.get(info.path);
    if (pending) return pending;
    const job = this.openInspected(info).finally(() => this.opening.delete(info.path));
    this.opening.set(info.path, job);
    const r = await job;
    const drawingJob = this.jobs.get(r.name);
    if (opts.wait && r.drawing && drawingJob) {
      const done = await drawingJob;
      return { name: r.name, drawing: false, ...done };
    }
    return r;
  }

  private async openInspected(info: FolderInspection): Promise<OpenResult> {
    const dir = info.path;
    if (info.known) {
      const p = this.get(info.name);
      return { name: p.name, chart: await p.loadChart(), drawing: !!p.drawing };
    }
    // A remembered folder that isn't there any more and had this name was most likely moved here: let this one take its name.
    const base = slug(path.basename(dir) || "project").slice(0, 60);
    const moved = this.linked().findIndex((l) => l.name === base && !existsSync(path.join(l.dir, CHART_FILE)));
    if (moved >= 0) {
      this.linked().splice(moved, 1);
      this.saveLinks();
      this.open.get(base)?.close();
      this.open.delete(base);
    }
    // Pick the name again and hold it: another folder with the same name may be opening at the same time.
    const name = this.freeName(base);
    this.reserved.add(name);
    try {
      return await this.link({ ...info, name });
    } finally {
      this.reserved.delete(name);
    }
  }

  private async link(info: FolderInspection): Promise<OpenResult> {
    const dir = info.path;
    if (!info.git.repo) {
      await git.init(dir);
      await appendFile(path.join(dir, ".git", "info", "exclude"), `\n# Added by Chart Driven Development\n${DEFAULT_EXCLUDES.join("\n")}\n`);
      await git.commitAll(dir, "Before Chart Driven Development: the existing files");
    }
    const p = new Project(dir, info.name, this.ai);
    if (info.kind === "code") {
      // An empty board to show right away; the drawing job fills it in and commits it at the end.
      await p.saveChart({ version: 1, name: info.name, idea: "Reading the code…", stack: null, root: { nodes: [], edges: [] }, drawing: true });
    }
    this.linked().push({ name: info.name, dir });
    this.saveLinks();
    this.open.set(info.name, p);
    p.watch();
    if (info.kind === "code") {
      // If drawing fails, the half-drawn chart is removed and the folder leaves the list (open it again to retry).
      this.jobs.set(info.name, this.draw(info.name, p));
      return { name: info.name, chart: await p.loadChart(), drawing: true };
    }
    return { name: info.name, chart: await p.loadChart(), drawing: false };
  }

  private unlink(name: string, p: Project) {
    const links = this.linked();
    const i = links.findIndex((l) => l.name === name && l.dir === p.dir);
    if (i >= 0) {
      links.splice(i, 1);
      this.saveLinks();
    }
    if (this.open.get(name) === p) {
      p.close();
      this.open.delete(name);
    }
  }

  private draw(name: string, p: Project): Promise<DrawResult> {
    const job = p.startDrawing();
    job.catch(() => this.unlink(name, p));
    return job;
  }

  /** Draw again a chart whose drawing was cut short (the app stopped in the middle of it). */
  async redraw(name: string): Promise<{ ok: true }> {
    const p = this.get(name);
    if (!p.drawing) {
      if (!(await p.loadChart()).drawing) throw new HttpError(400, "This chart is finished. To change it, select a bubble and ask the AI.");
      // Drawing commits the folder at the end; don't sweep edits made since then into that commit.
      const changed = (await git.changedFiles(p.dir)).filter((f) => !f.startsWith(".chart/"));
      if (changed.length) throw new HttpError(409, `${changed.length} file${changed.length === 1 ? " was" : "s were"} changed since the drawing stopped. Commit or stash ${changed.length === 1 ? "it" : "them"} first, then draw it again.`);
      this.jobs.set(name, this.draw(name, p));
    }
    return { ok: true };
  }

  /** Search the computer (read-only) for project folders that match a description. */
  async find(request: string): Promise<FindResult> {
    const req = request.trim();
    if (!req) throw new HttpError(400, "Describe the project you're looking for");
    const roots = this.options.searchRoots ?? searchRoots();
    const scan = await scanForProjects({ roots });
    const all = scan.candidates;
    const notes: string[] = [];
    if (scan.truncated) notes.push("The search stopped early (lots of folders), so a deeply nested project may have been missed. Use Browse to pick it.");
    // Shortlist for the AI: keyword matches first, then the most recently changed.
    const shortlist = all
      .map((c) => ({ c, score: keywordScore(req, c) }))
      .sort((a, b) => b.score - a.score || b.c.modified.localeCompare(a.c.modified))
      .slice(0, 150)
      .map((x) => x.c);
    let picks: { path: string; reason: string }[] = [];
    if (shortlist.length) {
      try {
        const known = new Set(shortlist.map((c) => c.path));
        picks = (await this.ai.pickProjects({ request: req, candidates: shortlist.map((c) => ({ ...c, path: displayPath(c.path) })) }))
          .map((p) => ({ ...p, path: expandPath(p.path) }))
          .filter((p, i, arr) => known.has(p.path) && arr.findIndex((x) => x.path === p.path) === i)
          .slice(0, 6);
      } catch (e) {
        notes.push(`The AI couldn't rank the folders (${(e as Error).message}), so these are matched by name.`);
        picks = shortlist
          .map((c) => ({ c, score: keywordScore(req, c) }))
          .filter((x) => x.score > 0)
          .slice(0, 6)
          .map((x) => ({ path: x.c.path, reason: "Its name or description matches what you typed." }));
      }
    }
    const byPath = new Map(all.map((c) => [c.path, c]));
    const matches: FoundProject[] = picks.map((p) => {
      const c = byPath.get(p.path)!;
      return { path: c.path, display: displayPath(c.path), name: c.name, description: c.description, reason: p.reason, chart: c.markers.includes(".chart"), modified: c.modified };
    });
    return { matches, searched: all.length, roots: roots.map(displayPath), note: notes.join(" ") || null };
  }

  closeAll() {
    for (const p of this.open.values()) p.close();
  }
}

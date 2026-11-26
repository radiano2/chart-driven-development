// A project's design: style guide, reference images, mockups and screenshots of UI bubbles.
// Lives in .chart/design/ next to the chart, so it is versioned with the code. Screenshots are git-ignored
// (they are re-taken from the running app, and would bloat history).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyOps, findBubble, getLevel } from "../../shared/chart.ts";
import type { Bubble, DesignReference, DesignState, FileChange, Level, Mockup, ProjectChart, Screenshot, StyleGuide } from "../../shared/types.ts";
import type { AI, DesignContext } from "../ai/ai.ts";
import { appOutput, startApp } from "../agent/tools.ts";
import { HttpError, type Project } from "../project.ts";
import { checkLocalUrl, renderHtml, screenshotUrl, waitForUrl } from "./render.ts";
import { normStyle } from "./style.ts";

export const DESIGN_DIR = ".chart/design";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MOCKUPS = 40;

const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  "image/gif": { ext: "gif", magic: (b) => b.subarray(0, 3).toString() === "GIF" },
};
const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Files edited by hand could hold anything: fall back to empty instead of breaking the UI. */
const arr = <T>(v: T[]): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const obj = <T extends object>(v: T): T => (v && typeof v === "object" && !Array.isArray(v) ? v : ({} as T));

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const now = () => new Date().toISOString();

/** Decode an uploaded image (data: URL), checking its type by its bytes. */
export function decodeImage(dataUrl: string): { bytes: Buffer; mime: string; ext: string } {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!m || !IMAGE_TYPES[m[1]]) throw new HttpError(400, "Send a PNG, JPEG, WebP or GIF image");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Images can be up to 8 MB");
  const t = IMAGE_TYPES[m[1]];
  if (!t.magic(bytes)) throw new HttpError(400, "That file isn't the image type it says it is");
  return { bytes, mime: m[1], ext: t.ext };
}

/** Find a bubble anywhere in the chart. */
function locate(pc: ProjectChart, id: string): { level: Level; bubble: Bubble } | null {
  const top = pc.root.nodes.find((n) => n.id === id);
  if (top) return { level: "root", bubble: top };
  for (const m of pc.root.nodes) {
    const f = m.children?.nodes.find((n) => n.id === id);
    if (f) return { level: m.id, bubble: f };
  }
  return null;
}

export class Design {
  constructor(private project: Project, private aiImpl?: AI) {}

  private get ai(): AI {
    if (!this.aiImpl) throw new Error("No AI for design work here");
    return this.aiImpl;
  }

  private abs(...parts: string[]) {
    return path.join(this.project.dir, DESIGN_DIR, ...parts);
  }

  private async readJson<T>(rel: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.abs(rel), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(rel: string, data: unknown) {
    await mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await writeFile(this.abs(rel), JSON.stringify(data, null, 2) + "\n");
  }

  /**
   * Screenshots are re-taken from the running app, so they stay out of git. The rule goes in .git/info/exclude,
   * which isn't versioned, so an undo or restore can't remove it.
   */
  private async ensureIgnore() {
    const f = path.join(this.project.dir, ".git", "info", "exclude");
    const rule = `/${DESIGN_DIR}/screens/`;
    const current = existsSync(f) ? await readFile(f, "utf8") : "";
    if (current.split("\n").includes(rule)) return;
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, `${current.replace(/\n?$/, "\n")}# Chart Driven Development: screenshots are re-taken, not versioned\n${rule}\n`);
  }

  async state(): Promise<DesignState> {
    const settings = await this.readJson<{ appUrl?: string }>("settings.json", {});
    return {
      style: normStyle(await this.readJson("style.json", null)),
      references: arr(await this.readJson<DesignReference[]>("references.json", [])),
      mockups: arr(await this.readJson<Mockup[]>("mockups.json", [])),
      screenshots: obj(await this.readJson<Record<string, Screenshot>>("screens/screens.json", {})),
      appUrl: typeof settings?.appUrl === "string" ? settings.appUrl : null,
    };
  }

  private async changed(message: string, commit = true) {
    if (commit) await this.project.commit(message);
    this.project.emit({ type: "design", design: await this.state() });
  }

  /** Read an image from the design folder, for the UI. `rel` is relative to .chart/design. */
  async image(rel: string): Promise<{ bytes: Buffer; mime: string }> {
    const clean = String(rel);
    if (!/^(references|mockups|screens)\/[a-z0-9._/-]+\.(png|jpg|webp|gif)$/.test(clean) || clean.includes("..")) throw new HttpError(400, "Bad image path");
    try {
      return { bytes: await readFile(this.abs(clean)), mime: MIME_BY_EXT[clean.split(".").pop()!] };
    } catch {
      throw new HttpError(404, "Image not found");
    }
  }

  // ---------- context for the AI ----------

  /** The UI's source files: files of UI bubbles plus pages and stylesheets. */
  private async uiFiles(pc: ProjectChart): Promise<FileChange[]> {
    const paths = new Set<string>();
    for (const m of pc.root.nodes) {
      if (m.gui && m.file) paths.add(m.file);
      for (const f of m.children?.nodes ?? []) if (f.gui && f.file) paths.add(f.file);
    }
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || paths.size >= 12) return;
      for (const d of await readdir(path.join(this.project.dir, dir), { withFileTypes: true }).catch(() => [])) {
        const rel = dir ? `${dir}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!d.name.startsWith(".") && !["node_modules", "dist", "build", "target", "venv", "__pycache__"].includes(d.name)) await walk(rel, depth + 1);
        } else if (/\.(html|css|scss|vue|svelte)$/.test(d.name) && paths.size < 12) paths.add(rel);
      }
    };
    await walk("", 0);
    return this.project.readFiles([...paths]);
  }

  private async context(pc: ProjectChart, s: DesignState): Promise<DesignContext> {
    const referenceImages: string[] = [];
    for (const r of s.references.slice(-3)) {
      try {
        const img = await this.image(r.image.replace(`${DESIGN_DIR}/`, ""));
        referenceImages.push(`data:${img.mime};base64,${img.bytes.toString("base64")}`);
      } catch {
        /* missing file */
      }
    }
    return { chart: pc, style: s.style, references: s.references, referenceImages, files: await this.uiFiles(pc) };
  }

  // ---------- style + references ----------

  /** Replace the style guide (used by the assistant, which already holds the project lock). */
  async setStyleUnlocked(raw: unknown, message = "Update the style guide", commit = true): Promise<StyleGuide> {
    const style = normStyle(raw);
    if (!style) throw new HttpError(400, "A style guide needs a summary or colors");
    await this.writeJson("style.json", style);
    await this.changed(message, commit);
    return style;
  }

  addReference(dataUrl: string, note: string) {
    return this.project.exclusive(async () => {
      const img = decodeImage(dataUrl);
      const pc = await this.project.loadChart();
      const s = await this.state();
      this.project.progress("Looking at the reference image…");
      const read = await this.ai.readReference({ chart: pc, style: s.style, image: `data:${img.mime};base64,${img.bytes.toString("base64")}`, note });
      const id = newId();
      const rel = `references/${id}.${img.ext}`;
      await mkdir(this.abs("references"), { recursive: true });
      await writeFile(this.abs(rel), img.bytes);
      const ref: DesignReference = { id, image: `${DESIGN_DIR}/${rel}`, note: note.slice(0, 500), description: read.description, created: now() };
      await this.writeJson("references.json", [...s.references, ref]);
      await this.writeJson("style.json", read.style);
      await this.changed(`Add design reference${note ? `: ${note.slice(0, 60)}` : ""}\n\n${read.description}`);
      this.project.progress("Done");
      return { reference: ref, style: read.style, design: await this.state() };
    });
  }

  removeReference(id: string) {
    return this.project.exclusive(async () => {
      const s = await this.state();
      const ref = s.references.find((r) => r.id === id);
      if (!ref) throw new HttpError(404, "No such reference");
      if (/^\.chart\/design\/references\/[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(ref.image)) await rm(path.join(this.project.dir, ref.image), { force: true });
      await this.writeJson("references.json", s.references.filter((r) => r.id !== id));
      await this.changed(`Remove design reference${ref.note ? `: ${ref.note.slice(0, 60)}` : ""}`);
      return this.state();
    });
  }

  // ---------- mockups ----------

  makeMockup(request: string, bubbleIds: string[] = []) {
    return this.project.exclusive(async () => {
      const pc = await this.project.loadChart();
      const s = await this.state();
      const bubbles = bubbleIds.map((id) => locate(pc, id)?.bubble).filter((b): b is Bubble => !!b);
      this.project.progress("Drawing a mockup…");
      const draft = await this.ai.mockup({ ...(await this.context(pc, s)), request, bubbles });
      const m = await this.saveMockupUnlocked({ ...draft, request, bubbleIds: draft.bubbleIds.length ? draft.bubbleIds : bubbles.map((b) => b.id) });
      this.project.progress("Done");
      return m;
    });
  }

  /**
   * Render and store a mockup (from the AI or the assistant). Saved as a version unless `commit` is false
   * (the assistant saves everything from one turn as one version at the end).
   */
  async saveMockupUnlocked(d: { title: string; summary: string; request: string; bubbleIds: string[]; style: StyleGuide | null; html: string }, commit = true): Promise<Mockup> {
    const rendered = await renderHtml(d.html);
    const id = newId();
    const dir = `mockups/${id}`;
    await mkdir(this.abs(dir), { recursive: true });
    await writeFile(this.abs(dir, "mockup.html"), d.html);
    await writeFile(this.abs(dir, "mockup.png"), rendered.png);
    const crops: Record<string, string> = {};
    for (const [bubble, png] of Object.entries(rendered.crops)) {
      await writeFile(this.abs(dir, `${bubble}.png`), png);
      crops[bubble] = `${DESIGN_DIR}/${dir}/${bubble}.png`;
    }
    const m: Mockup = {
      id,
      title: d.title,
      request: d.request.slice(0, 1000),
      summary: d.summary,
      bubbleIds: [...new Set([...d.bubbleIds, ...Object.keys(crops)])],
      html: `${DESIGN_DIR}/${dir}/mockup.html`,
      image: `${DESIGN_DIR}/${dir}/mockup.png`,
      crops,
      style: d.style,
      created: now(),
    };
    let list = [m, ...(await this.state()).mockups];
    for (const old of list.slice(MAX_MOCKUPS)) {
      const safe = String(old.id).replace(/[^a-z0-9-]/g, "");
      if (safe) await rm(this.abs("mockups", safe), { recursive: true, force: true });
    }
    list = list.slice(0, MAX_MOCKUPS);
    await this.writeJson("mockups.json", list);
    await this.changed(`Mockup: ${m.title}\n\n${m.summary}`, commit);
    return m;
  }

  removeMockup(id: string) {
    return this.project.exclusive(async () => {
      const s = await this.state();
      if (!s.mockups.some((m) => m.id === id)) throw new HttpError(404, "No such mockup");
      await rm(this.abs("mockups", id.replace(/[^a-z0-9-]/g, "")), { recursive: true, force: true });
      await this.writeJson("mockups.json", s.mockups.filter((m) => m.id !== id));
      await this.changed("Remove a mockup");
      return this.state();
    });
  }

  /** Make the code look like a mockup (or like the style guide when id is null). The mockup's style becomes the project's. */
  applyMockup(id: string | null) {
    return this.project.exclusive(async () => {
      const pc = await this.project.loadChart();
      let s = await this.state();
      const m = id ? s.mockups.find((x) => x.id === id) : null;
      if (id && !m) throw new HttpError(404, "No such mockup");
      // The mockup's style is what the code should follow; it's saved only once the AI's changes are in.
      if (m?.style) s = { ...s, style: m.style };
      const html = m ? await readFile(path.join(this.project.dir, m.html), "utf8").catch(() => "") : "";
      this.project.progress(m ? `Applying "${m.title}" to the code…` : "Applying the style guide to the code…");
      const cs = await this.ai.applyDesign({ ...(await this.context(pc, s)), mockup: m ? { title: m.title, summary: m.summary, html } : null });
      if (m?.style) await this.writeJson("style.json", m.style);
      const result = await this.project.applyChangeSet(pc, cs, m ? `Apply mockup: ${m.title}` : "Apply the style guide");
      this.project.emit({ type: "design", design: await this.state() });
      return result;
    });
  }

  // ---------- UI bubbles + screenshots ----------

  setGui(level: Level, bubbleId: string, gui: { route?: string; selector?: string } | null) {
    return this.project.exclusive(async () => {
      const pc = await this.project.loadChart();
      const b = findBubble(pc, level, bubbleId);
      if (!b) throw new HttpError(404, `No bubble "${bubbleId}"`);
      applyOps(pc, [{ op: "upsertNode", parent: level, node: { id: b.id, gui: gui ?? (null as never) } }]);
      await this.project.saveChart(pc);
      await this.project.commit(gui ? `Mark ${b.name} as UI` : `${b.name} is not UI`);
      return { chart: pc };
    });
  }

  setAppUrl(url: string) {
    return this.project.exclusive(async () => {
      const clean = url.trim();
      if (clean) checkLocalUrl(clean);
      await this.writeJson("settings.json", clean ? { appUrl: clean.replace(/\/+$/, "") } : {});
      await this.changed(clean ? `App address for screenshots: ${clean}` : "Clear the app address for screenshots");
      return this.state();
    });
  }

  /** Where the running app is: set by hand, else the stack's, else printed by the running app. */
  private async baseUrl(pc: ProjectChart): Promise<string | null> {
    const s = await this.state();
    if (s.appUrl) return s.appUrl;
    const printed = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/.exec(appOutput(this.project.dir) ?? "")?.[0];
    return printed ?? pc.stack?.appUrl ?? null;
  }

  /**
   * Screenshot one UI bubble on the running app. With `mayStart`, the app is started first if nothing answers
   * (the user pressed the button, which says so); otherwise it must already be running.
   */
  screenshot(level: Level, bubbleId: string, mayStart: boolean) {
    return this.project.exclusive(() => this.screenshotUnlocked(level, bubbleId, mayStart));
  }

  async screenshotUnlocked(level: Level, bubbleId: string, mayStart: boolean): Promise<Screenshot> {
    const pc = await this.project.loadChart();
    if (!getLevel(pc, level)) throw new HttpError(404, `No module "${level}"`);
    const b = findBubble(pc, level, bubbleId);
    if (!b) throw new HttpError(404, `No bubble "${bubbleId}"`);
    if (!b.gui) throw new HttpError(400, `${b.name} isn't marked as UI`);
    let base = await this.baseUrl(pc);
    const up = async () => !!base && (await waitForUrl(base, 1500));
    if (!(await up())) {
      if (!mayStart) throw new HttpError(409, "The app isn't running. Start it first (start_app), then take the screenshot.");
      if (appOutput(this.project.dir) === null) {
        const cmd = pc.stack?.runCommand?.trim() || "npm start";
        this.project.progress(`Starting the app (${cmd})…`);
        startApp(this.project.dir, cmd);
      }
      // Look again each time: the app may print its real address (e.g. another port) only once it's up.
      const end = Date.now() + 25_000;
      let answered = false;
      while (!answered && Date.now() < end) {
        base = await this.baseUrl(pc);
        answered = !!base && (await waitForUrl(base, 1000));
        if (!answered) await new Promise((r) => setTimeout(r, 400));
      }
      if (!base) throw new HttpError(400, "I don't know the app's address. Set it under Design → App address (e.g. http://localhost:3000).");
      if (!answered) {
        const out = (appOutput(this.project.dir) ?? "").slice(-600);
        throw new HttpError(502, `The app didn't answer at ${base}.${out ? ` Its output:\n${out}` : ""}`);
      }
    }
    const url = new URL(b.gui.route ?? "/", base + "/").toString();
    this.project.progress(`Taking a screenshot of ${b.name}…`);
    const shot = await screenshotUrl(url, b.gui.selector || `[data-bubble="${b.id}"]`);
    await this.ensureIgnore();
    const file = `screens/${level === "root" ? "root" : level}__${b.id}.png`;
    await mkdir(this.abs("screens"), { recursive: true });
    await writeFile(this.abs(file), shot.png);
    const all = await this.readJson<Record<string, Screenshot>>("screens/screens.json", {});
    const entry: Screenshot = { bubbleId: b.id, level, image: `${DESIGN_DIR}/${file}`, url, cropped: shot.cropped, takenAt: now() };
    all[`${level}/${b.id}`] = entry;
    await this.writeJson("screens/screens.json", all);
    await this.changed("", false);
    this.project.progress("Done");
    return entry;
  }
}

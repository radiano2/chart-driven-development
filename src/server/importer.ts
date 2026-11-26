// Opening existing folders: browsing, telling what a folder holds, picking the code the AI reads,
// and searching the computer for project folders. Everything here only reads.
import { realpathSync, statSync, type Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileChange, FolderListing } from "../shared/types.ts";
import type { FolderCandidate } from "./ai/ai.ts";
import { HttpError } from "./project.ts";

/** Files that mark a folder as a project. */
export const PROJECT_MARKERS = [
  ".git",
  ".chart",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "pubspec.yaml",
  "mix.exs",
  "deno.json",
  "Package.swift",
];
const MARKER_SET = new Set(PROJECT_MARKERS);
const MARKER_EXT = /\.(sln|csproj|fsproj|xcodeproj)$/i;

/** Folders that are never a project's own code: dependencies, build output, caches, system folders. */
const SKIP_DIRS = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  "venv",
  "env",
  "site-packages",
  "Pods",
  "DerivedData",
  // system and app folders under a home folder
  "Library",
  "Applications",
  "AppData",
  "Application Data",
  "Local Settings",
  "Program Files",
  "Program Files (x86)",
  "Windows",
  "System",
  "System Volume Information",
  "$RECYCLE.BIN",
  "snap",
  "Music",
  "Movies",
  "Pictures",
  "Videos",
  "Photos Library.photoslibrary",
]);

/** Ignored in a folder the app turns into a git repo (written to .git/info/exclude, not a visible file). */
export const DEFAULT_EXCLUDES = [
  "node_modules/",
  "bower_components/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  "dist/",
  "build/",
  "out/",
  "target/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".cache/",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.*",
  "*.log",
];

const EXCLUDED_DIRS = new Set(DEFAULT_EXCLUDES.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)));

const SOURCE_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".scala": "Scala",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".fs": "F#",
  ".php": "PHP",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".lua": "Lua",
  ".r": "R",
  ".jl": "Julia",
  ".sh": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
};

/** Files that say what a project is and how it's built; read first. */
const MANIFEST = /^(package\.json|pyproject\.toml|setup\.py|requirements\.txt|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|CMakeLists\.txt|Makefile|Dockerfile|docker-compose\.ya?ml|pubspec\.yaml|mix\.exs|deno\.json|tsconfig\.json|vite\.config\.[jt]s|.*\.csproj|readme(\.\w+)?)$/i;
const ENTRY = /^(main|index|app|server|cli|program|lib|mod|__main__|manage)\.\w+$/i;
const NOT_SOURCE = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.next|__pycache__|\.venv|venv|migrations)\/|\.min\.\w+$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i;
const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.\w+$/i;

export const MAX_FILES = 20_000;

export function homeDir(): string {
  return os.homedir();
}

/** "~/code/app" → absolute. Relative paths are taken from the home folder (the server's cwd means nothing to the user). */
export function expandPath(input: string): string {
  const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new HttpError(400, "Type the folder's path, or use Browse");
  if (raw === "~") return homeDir();
  if (/^~[\\/]/.test(raw)) return path.resolve(homeDir(), raw.slice(2));
  return path.resolve(homeDir(), raw);
}

export function displayPath(abs: string): string {
  const home = homeDir();
  if (abs === home) return "~";
  return abs.startsWith(home + path.sep) ? `~${path.sep}${abs.slice(home.length + 1)}` : abs;
}

/** Resolve symlinks and require an existing folder. */
export function realFolder(abs: string): string {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new HttpError(404, `There's no folder at ${displayPath(abs)}`);
  }
  if (!statSync(real).isDirectory()) throw new HttpError(400, `${displayPath(abs)} is a file, not a folder`);
  return real;
}

/** `inner` is `outer` or inside it. */
export function within(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isProjectEntry(names: string[]): string[] {
  return names.filter((n) => MARKER_SET.has(n) || MARKER_EXT.test(n));
}

/** Sub-folders of a folder, for the Browse dialog. Hidden folders are left out unless asked for. */
export async function listFolder(input: string | null, showHidden = false): Promise<FolderListing> {
  const dir = realFolder(input ? expandPath(input) : homeDir());
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(403, `Can't read ${displayPath(dir)}`);
  }
  const dirs = entries
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && (showHidden || !d.name.startsWith(".")))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const LIMIT = 500;
  const out = [];
  for (const name of dirs.slice(0, LIMIT)) {
    const abs = path.join(dir, name);
    let project = false;
    try {
      if (!(await stat(abs)).isDirectory()) continue;
      project = isProjectEntry(await readdir(abs)).length > 0;
    } catch {
      /* unreadable: still list it */
    }
    out.push({ name, path: abs, project });
  }
  const parent = path.dirname(dir);
  return { path: dir, display: displayPath(dir), parent: parent === dir ? null : parent, dirs: out, more: dirs.length > LIMIT };
}

/** Count files a new git repo would hold (skipping DEFAULT_EXCLUDES-like folders), stopping at `cap`. */
export async function countFiles(dir: string, cap = MAX_FILES + 1): Promise<{ files: number; paths: string[] }> {
  const paths: string[] = [];
  const stack = [""];
  while (stack.length && paths.length < cap) {
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Same folders DEFAULT_EXCLUDES leaves out of the new repo, so the count matches what gets committed.
        if (e.name === ".git" || EXCLUDED_DIRS.has(e.name)) continue;
        stack.push(r);
      } else if (e.isFile() && !/^(\.DS_Store|Thumbs\.db)$/.test(e.name) && !/\.(log|pyc)$/.test(e.name) && !/^\.env(\.|$)/.test(e.name)) {
        paths.push(r);
        if (paths.length >= cap) break;
      }
    }
  }
  return { files: paths.length, paths };
}

export function languagesOf(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (NOT_SOURCE.test(f)) continue;
    const lang = SOURCE_EXT[path.extname(f).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l);
}

async function readHead(abs: string, max: number): Promise<string | null> {
  try {
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      const chunk = buf.subarray(0, bytesRead);
      if (chunk.includes(0)) return null; // binary
      return chunk.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Pick what the AI reads to draw the chart: manifests and README first, then source files
 * (entry points and shallow files first, tests last), within a character budget.
 */
export async function selectSources(dir: string, all: string[], budget = 110_000): Promise<{ tree: string[]; files: FileChange[]; omitted: number }> {
  const visible = all.filter((f) => !f.startsWith(".chart/") && !NOT_SOURCE.test(f)).sort();
  const tree = visible.slice(0, 2000);
  const manifests = visible.filter((f) => !f.includes("/") && MANIFEST.test(f));
  const sources = visible
    .filter((f) => SOURCE_EXT[path.extname(f).toLowerCase()] && !manifests.includes(f))
    .map((f) => ({ f, score: f.split("/").length * 2 + (TEST.test(f) ? 20 : 0) + (ENTRY.test(path.basename(f)) ? -3 : 0) }))
    .sort((a, b) => a.score - b.score || a.f.localeCompare(b.f))
    .map((x) => x.f);
  const files: FileChange[] = [];
  let used = 0;
  let omitted = 0;
  for (const [list, perFile] of [[manifests, 6_000], [sources, 14_000]] as const) {
    for (const f of list) {
      if (used >= budget) {
        if (list === sources) omitted++;
        continue;
      }
      let text = await readHead(path.join(dir, f), perFile + 1);
      if (text == null) continue;
      if (text.length > perFile) text = text.slice(0, perFile) + "\n…(cut)";
      if (used + text.length > budget) {
        if (list === sources) omitted++;
        continue;
      }
      used += text.length;
      files.push({ path: f, content: text });
    }
  }
  return { tree, files, omitted };
}

// ---------- finding projects on the computer ----------

export interface ScanOptions {
  roots: string[];
  /** How many folders deep below each root to look. */
  depth?: number;
  /** Stop after this long, in ms. */
  timeLimit?: number;
  /** Stop after looking in this many folders. */
  folderLimit?: number;
}

export interface ScanResult {
  candidates: FolderCandidate[];
  truncated: boolean;
}

async function describe(dir: string, names: string[]): Promise<string> {
  if (names.includes("package.json")) {
    const text = await readHead(path.join(dir, "package.json"), 64_000);
    try {
      const d = (JSON.parse(text ?? "") as { description?: unknown }).description;
      if (typeof d === "string" && d.trim()) return d.trim().slice(0, 200);
    } catch {
      /* not JSON */
    }
  }
  if (names.includes(".chart")) {
    const text = await readHead(path.join(dir, ".chart", "chart.json"), 200_000);
    try {
      const idea = (JSON.parse(text ?? "") as { idea?: unknown }).idea;
      if (typeof idea === "string" && idea.trim()) return idea.trim().slice(0, 200);
    } catch {
      /* not a chart */
    }
  }
  const readme = names.find((n) => /^readme(\.\w+)?$/i.test(n));
  if (readme) {
    const text = (await readHead(path.join(dir, readme), 4_000)) ?? "";
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^[#>*\s-]+/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim()).filter((l) => l && !/^(\[|<|=|```)/.test(l));
    if (lines.length) return lines.slice(0, 2).join(" ").slice(0, 200);
  }
  return "";
}

/**
 * Look for project folders under the roots. Read-only: lists folders, and reads a project's
 * package.json description or README's first lines. Skips hidden and system folders and doesn't
 * follow symlinks. Doesn't look inside a project once found.
 */
export async function scanForProjects(opts: ScanOptions): Promise<ScanResult> {
  const depth = opts.depth ?? 5;
  const deadline = Date.now() + (opts.timeLimit ?? 6_000);
  const folderLimit = opts.folderLimit ?? 30_000;
  const candidates: FolderCandidate[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;
  // Breadth first, so shallow projects (the likely ones) are found before the limits hit.
  let level: string[] = [];
  for (const r of opts.roots) {
    try {
      level.push(realpathSync(r));
    } catch {
      /* missing root */
    }
  }
  // A root is never a candidate itself (a home folder with a dotfiles repo would otherwise end the search there).
  const roots = new Set(level);
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (++visited > folderLimit || Date.now() > deadline) {
        truncated = true;
        break;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = entries.map((e) => e.name);
      const markers = roots.has(dir) ? [] : isProjectEntry(names);
      if (markers.length) {
        let modified = "";
        try {
          modified = (await stat(dir)).mtime.toISOString();
          for (const m of ["package.json", ".git", ".chart"]) if (names.includes(m)) modified = maxIso(modified, (await stat(path.join(dir, m))).mtime.toISOString());
        } catch {
          /* keep what we have */
        }
        candidates.push({ path: dir, name: path.basename(dir), description: await describe(dir, names), markers, modified });
        continue; // a project's sub-folders are its own business
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        next.push(path.join(dir, e.name));
      }
    }
    if (truncated) break;
    level = next;
  }
  return { candidates, truncated };
}

const maxIso = (a: string, b: string) => (a > b ? a : b);

const STOP = new Set(["the", "and", "for", "with", "that", "this", "app", "project", "my", "was", "where", "which", "some", "made", "one", "folder", "code", "find", "from", "about", "think", "called", "named", "using", "wrote", "built", "thing", "something"]);

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Keyword match, used to shortlist folders for the AI and when the AI isn't available. */
export function keywordScore(request: string, c: FolderCandidate): number {
  const want = words(request);
  if (!want.length) return 0;
  const name = c.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const hay = `${displayPath(c.path)} ${c.description}`.toLowerCase();
  let score = 0;
  for (const w of want) {
    if (name.includes(w)) score += 3;
    else if (hay.includes(w)) score += 1;
    else if (w.length > 4 && (name.includes(w.slice(0, -1)) || hay.includes(w.slice(0, -1)))) score += 1; // "todos" ~ "todo"
  }
  return score;
}

export function searchRoots(env = process.env): string[] {
  const raw = env.CDD_SEARCH_ROOTS?.trim();
  if (raw) return raw.split(path.delimiter).map((r) => expandPath(r));
  return [homeDir()];
}

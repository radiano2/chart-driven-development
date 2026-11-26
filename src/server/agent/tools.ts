// The tools the assistant (DeepSeek function calling) can use on ONE project.
// Files are confined to the project folder; commands are allowlisted, anything else needs the user's approval.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { applyOps, getLevel, normOps } from "../../shared/chart.ts";
import type { ToolDef } from "../ai/deepseek.ts";
import * as git from "../git.ts";
import { safePath, type Project } from "../project.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".chart", "dist", "build", "target", "__pycache__", ".venv", "venv"]);
const MAX_OUTPUT = 8000;

/**
 * Commands that run without asking. Matched exactly after collapsing whitespace and run without a shell,
 * so no one-liners or chaining. Note this is not a sandbox: install/test/build run the project's own scripts.
 */
export const ALLOWED_COMMANDS = [
  "npm install",
  "npm ci",
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "npx tsc --noEmit",
  "node --test",
  "pip install -r requirements.txt",
  "pytest",
  "python -m pytest",
  "cargo build",
  "cargo test",
  "go build ./...",
  "go test ./...",
];

export function isAllowed(command: string): boolean {
  return ALLOWED_COMMANDS.includes(command.trim().replace(/\s+/g, " "));
}

export interface ToolContext {
  project: Project;
  /** Ask the user before running a command that is not on the allowlist. */
  approve(command: string): Promise<boolean>;
  /** Set when the assistant changed files or the chart in this turn. */
  changed: Set<string>;
  /** Message used to save the turn's pending edits before an undo/restore. */
  pendingMessage: string;
}

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const TOOL_DEFS: ToolDef[] = [
  tool("get_project", "Name, idea, tech stack and folder of the current project."),
  tool("get_chart", "Get the root chart (modules) or one module's inner chart of functions.", { level: str('"root" or a module id') }),
  tool("list_files", "List files in the project (or a sub-folder), skipping .git, node_modules and build output.", { dir: str("Sub-folder, default the project root") }),
  tool("read_file", `Read a text file from the project. Long files come back in parts of about 48 KB; pass from_line to continue.`, { path: str("Path relative to the project folder"), from_line: { type: "integer", description: "First line to return (1-based), for long files" } }, ["path"]),
  tool("search_code", "Find lines containing some text (case-insensitive) across the project's files.", { text: str("Text to look for") }, ["text"]),
  tool("write_file", "Create or fully replace a file in the project. Give the COMPLETE content.", { path: str("Path relative to the project folder"), content: str("Full file content") }, ["path", "content"]),
  tool("delete_file", "Delete a file from the project.", { path: str("Path relative to the project folder") }, ["path"]),
  tool(
    "update_chart",
    "Change the chart with a list of operations (upsertNode, removeNode, upsertEdge, removeEdge). See the guide for the shape.",
    { ops: { type: "array", items: { type: "object" }, description: "Chart operations" } },
    ["ops"],
  ),
  tool("list_versions", "List saved versions (git commits), newest first."),
  tool("undo", "Go back to the version before the latest one (code and chart). Only when the user asks."),
  tool("restore_version", "Restore code and chart to a saved version. Only when the user asks.", { sha: str("Version id from list_versions") }, ["sha"]),
  tool("run_command", `Run a command in the project folder and return its output. These run directly: ${ALLOWED_COMMANDS.join(", ")}. Anything else asks the user first.`, { command: str("The command") }, ["command"]),
  tool("start_app", "Start the project's app in the background with its run command (the user is asked first), and return its first output."),
  tool("app_output", "Latest output of the app started with start_app."),
  tool("stop_app", "Stop the app started with start_app."),
  tool("open_folder", "Open the project folder in the user's file manager."),
];

// ---------- background app per project ----------

const apps = new Map<string, { child: ChildProcess; output: string }>();

function tail(s: string, n = MAX_OUTPUT) {
  return s.length > n ? "…" + s.slice(-n) : s;
}

export function stopApp(dir: string): boolean {
  const app = apps.get(dir);
  if (!app) return false;
  try {
    if (app.child.pid && process.platform !== "win32") process.kill(-app.child.pid, "SIGTERM");
    else app.child.kill("SIGTERM");
  } catch {
    try {
      app.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  apps.delete(dir);
  return true;
}

process.on("exit", () => {
  for (const dir of [...apps.keys()]) stopApp(dir);
});

function runShell(cmd: string, cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code ?? "error") : 0;
      const killed = (err as { killed?: boolean } | null)?.killed ? " (timed out)" : "";
      resolve(`exit code: ${code}${killed}\n${tail(String(stdout) + (stderr ? `\n[stderr]\n${stderr}` : ""))}`);
    });
  });
}

function runArgv(cmd: string, cwd: string, timeoutMs = 120_000): Promise<string> {
  const [file, ...args] = cmd.trim().split(/\s+/);
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code ?? "error") : 0;
      resolve(`exit code: ${code}\n${tail(String(stdout) + (stderr ? `\n[stderr]\n${stderr}` : ""))}`);
    });
  });
}

async function walk(root: string, dir: string, out: string[], limit = 500) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) await walk(root, path.join(dir, d.name), out, limit);
    } else if (d.isFile()) out.push(path.relative(root, path.join(dir, d.name)).split(path.sep).join("/"));
  }
}

/** Most text one read_file returns (~12k tokens), so a few reads never overflow the model's context. */
export const MAX_READ_CHARS = 48_000;

/** Return whole lines starting at `from` (1-based) up to MAX_READ_CHARS, telling the model how to continue. */
export function sliceLines(text: string, from = 1): string {
  const lines = text.split("\n");
  const start = Math.min(Math.max(1, Math.floor(from)), Math.max(1, lines.length));
  let used = 0;
  let end = start - 1;
  while (end < lines.length && used + lines[end].length + 1 <= MAX_READ_CHARS) used += lines[end++].length + 1;
  if (end === start - 1 && end < lines.length) end++; // a single very long line: return it anyway (cut)
  const body = lines.slice(start - 1, end).join("\n").slice(0, MAX_READ_CHARS);
  if (start === 1 && end >= lines.length) return body;
  const more = end < lines.length ? ` Call read_file with from_line=${end + 1} for more, or use search_code.` : "";
  return `[lines ${start}-${end} of ${lines.length}.${more}]\n${body}`;
}

// ---------- executor ----------

type Args = Record<string, unknown>;
const arg = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing "${k}"`);
  return v;
};

/** Run one tool call. Returns text for the model. Throws on bad input (the caller reports the error to the model). */
export async function runTool(name: string, a: Args, ctx: ToolContext): Promise<string> {
  const p = ctx.project;
  switch (name) {
    case "get_project": {
      const pc = await p.loadChart();
      return JSON.stringify({ name: p.name, idea: pc.idea, stack: pc.stack, folder: p.dir, modules: pc.root.nodes.map((n) => ({ id: n.id, name: n.name })) });
    }
    case "get_chart": {
      const pc = await p.loadChart();
      const level = typeof a.level === "string" && a.level ? a.level : "root";
      const c = getLevel(pc, level);
      if (!c) throw new Error(`No module "${level}"`);
      // At the root, summarize inner charts instead of nesting everything.
      const nodes = c.nodes.map(({ children, ...n }) => (children ? { ...n, inside: children.nodes.map((x) => x.id) } : n));
      return JSON.stringify({ level, nodes, edges: c.edges });
    }
    case "list_files": {
      const sub = typeof a.dir === "string" && a.dir ? a.dir : ".";
      const out: string[] = [];
      await walk(p.dir, safePath(p.dir, sub === "." ? "" : sub), out);
      return out.length ? out.join("\n") : "(no files)";
    }
    case "read_file": {
      const abs = safePath(p.dir, arg(a, "path"));
      const s = await stat(abs).catch(() => null);
      if (!s?.isFile()) throw new Error(`No such file: ${a.path}`);
      if (s.size > 5_000_000) throw new Error("File too large to read (over 5 MB). Use search_code to find the part you need.");
      return sliceLines(await readFile(abs, "utf8"), Number(a.from_line) || 1);
    }
    case "search_code": {
      const needle = arg(a, "text").toLowerCase();
      const files: string[] = [];
      await walk(p.dir, p.dir, files, 2000);
      const hits: string[] = [];
      for (const f of files) {
        const abs = path.join(p.dir, f);
        if ((await stat(abs)).size > 400_000) continue;
        const lines = (await readFile(abs, "utf8")).split("\n");
        lines.forEach((l, i) => {
          if (hits.length < 60 && l.toLowerCase().includes(needle)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`);
        });
        if (hits.length >= 60) break;
      }
      return hits.length ? hits.join("\n") : "No matches.";
    }
    case "write_file": {
      const rel = arg(a, "path");
      if (typeof a.content !== "string") throw new Error('Missing "content"');
      await p.writeFiles([{ path: rel, content: a.content }]);
      ctx.changed.add(rel);
      return `Wrote ${rel} (${a.content.length} characters).`;
    }
    case "delete_file": {
      const rel = arg(a, "path");
      await rm(safePath(p.dir, rel), { force: true });
      ctx.changed.add(rel);
      return `Deleted ${rel}.`;
    }
    case "update_chart": {
      const ops = normOps(a.ops);
      if (!ops.length) throw new Error("No valid operations. Each needs op, parent and node/edge/id.");
      const pc = await p.loadChart();
      const warnings = applyOps(pc, ops);
      await p.saveChart(pc);
      ctx.changed.add(".chart/chart.json");
      return `Applied ${ops.length - warnings.length} of ${ops.length} operation(s).${warnings.length ? ` Skipped: ${warnings.join("; ")}` : ""}`;
    }
    case "list_versions": {
      const h = await git.history(p.dir, 30);
      return h.map((e) => `${e.sha.slice(0, 7)}  ${e.date}  ${e.message.split("\n")[0]}`).join("\n");
    }
    case "undo": {
      await p.undoUnlocked(ctx.pendingMessage);
      ctx.changed.clear();
      return "Restored the previous version.";
    }
    case "restore_version": {
      await p.restoreUnlocked(arg(a, "sha"), ctx.pendingMessage);
      ctx.changed.clear();
      return `Restored version ${a.sha}.`;
    }
    case "run_command": {
      const cmd = arg(a, "command").trim();
      if (isAllowed(cmd)) return runArgv(cmd, p.dir);
      if (!(await ctx.approve(cmd))) return "The user did not allow this command. Do not try to run it another way.";
      return runShell(cmd, p.dir);
    }
    case "start_app": {
      if (apps.has(p.dir)) return `Already running.\n${tail(apps.get(p.dir)!.output, 3000)}`;
      const pc = await p.loadChart();
      const cmd = pc.stack?.runCommand?.trim() || "npm start";
      // Starting the app runs project code the assistant may have just written, so it always asks first.
      if (!(await ctx.approve(cmd))) return "The user did not allow starting the app.";
      const child = spawn(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], { cwd: p.dir, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const app = { child, output: "" };
      apps.set(p.dir, app);
      const onData = (d: Buffer) => (app.output = tail(app.output + d.toString(), 50_000));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => {
        app.output += `\n[exited with code ${code}]`;
        if (apps.get(p.dir) === app) apps.delete(p.dir);
      });
      // Spawn failures (e.g. the folder was moved) arrive as an event; without a listener they'd crash the server.
      child.on("error", (err) => {
        app.output += `\n[could not start: ${err.message}]`;
        if (apps.get(p.dir) === app) apps.delete(p.dir);
      });
      await new Promise((r) => setTimeout(r, 3000));
      return `Started \`${cmd}\`.\n${tail(app.output, 3000) || "(no output yet)"}`;
    }
    case "app_output": {
      const app = apps.get(p.dir);
      return app ? tail(app.output, 4000) || "(no output yet)" : "The app is not running.";
    }
    case "stop_app":
      return stopApp(p.dir) ? "Stopped the app." : "The app was not running.";
    case "open_folder": {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      try {
        spawn(opener, [p.dir], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
        return `Asked the system to open ${p.dir}.`;
      } catch {
        return `Could not open a file manager here. The folder is ${p.dir}.`;
      }
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

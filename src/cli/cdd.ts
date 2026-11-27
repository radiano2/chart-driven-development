#!/usr/bin/env -S npx tsx
// `cdd`: drive Chart Driven Development from a terminal, headless. Same projects, tools and versions as the web app.
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { Assistant } from "../server/agent/assistant.ts";
import { runTool, stopApp } from "../server/agent/tools.ts";
import { setup } from "../server/index.ts";
import { getLevel } from "../shared/chart.ts";
import type { AssistantEvent } from "../shared/types.ts";

const HELP = `Chart Driven Development, command line

  cdd projects                       list projects
  cdd open <folder> [--yes] [--draw functional|business|none]
                                     open a folder: a chart project, or any codebase (draws its functional
                                     chart by default; "business" draws the read-only business flow instead)
  cdd find <description…>            look for a project folder on this computer (read-only)
  cdd forget <project>               remove an opened folder from the list (the folder stays as it is)
  cdd remove <project> [--delete]    take a project off the list (app-made ones go to projects/.removed);
                                     --delete deletes its folder for good (asks you to type the name)
  cdd chart <project> [module]       print the chart (or one module's inner chart)
  cdd ask <project> <message…>       ask the assistant once, then exit
  cdd chat <project>                 talk to the assistant (type "exit" to quit, "reset" to forget)
  cdd sync <project>                 read files changed outside the app and update the chart
  cdd keep <project>                 keep outside edits without updating the chart
  cdd versions <project>             list saved versions
  cdd undo <project>                 go back one version
  cdd restore <project> <version>    restore a saved version
  cdd folder <project> [--open]      print (or open) the project folder
  cdd settings                       show which DeepSeek key and model are used
  cdd set-key                        save your DeepSeek API key (typed hidden; checked before it's saved)

Commands outside the safe list (install, test, build) ask before running.
In a non-interactive shell they are refused.
Set CDD_AI=mock to try it without an API key.`;

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const out = (s: string) => process.stdout.write(s + "\n");
const log = (s: string) => process.stderr.write(dim(s) + "\n");

function printEvent(e: AssistantEvent) {
  if (e.kind === "tool") log(`  → ${e.summary}`);
  else if (e.kind === "tool-result" && !e.ok) log(`    ✗ ${e.summary}`);
  else if (e.kind === "note") log(`  ${e.text}`);
}

async function main(argv: string[]) {
  const [cmd, name, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return out(HELP);

  const cfg = setup();
  const ws = cfg.ws;
  if (cmd === "settings") {
    const s = cfg.brain.settings.status();
    out(`AI:     ${cfg.brain.label}\nKey:    ${s.hasKey ? `from ${s.keySource} (ending ${s.keyHint})` : "none"}\nModel:  ${s.model}\nStored: ${s.file}`);
    return;
  }
  if (cmd === "set-key") {
    const key = (await readSecret("DeepSeek API key (hidden): ")).trim();
    if (!key) throw new Error("No key entered");
    // Refuse only a key DeepSeek says is wrong; no balance or no network isn't the key's fault.
    const t = await cfg.brain.settings.test(key);
    if (t.invalid) throw new Error(`Not saved: ${t.message}`);
    cfg.brain.update({ deepseekApiKey: key });
    out(t.ok ? "The key works and is saved." : `Saved. Note: ${t.message}`);
    return;
  }
  if (cmd === "projects") {
    const list = await ws.list();
    if (!list.length) return out(`No projects in ${cfg.workspace}.`);
    for (const p of list) out(`${p.name.padEnd(24)} ${p.missing ? "(folder missing)" : p.idea}${p.hasChart || p.missing ? "" : "  (not generated yet)"}${p.dir ? `\n${"".padEnd(25)}${p.dir}` : ""}`);
    return;
  }
  if (cmd === "open") {
    if (!name) throw new Error("Usage: cdd open <folder> [--yes] [--draw functional|business|none]");
    const di = rest.indexOf("--draw");
    const draw = di >= 0 ? rest[di + 1] : "functional";
    if (draw !== "functional" && draw !== "business" && draw !== "none") throw new Error('--draw takes "functional", "business" or "none"');
    const info = await ws.inspect(name);
    out(`${info.display}: ${info.kind === "chart" ? "Chart Driven Development project" : "codebase without a chart"}, ${info.git.repo ? `git repo${info.git.branch ? ` on ${info.git.branch}` : ""}` : "not a git repo yet"}, ${info.files} files${info.languages.length ? `, ${info.languages.join(", ")}` : ""}`);
    if (info.blocked) throw new Error(info.blocked);
    for (const line of info.plan) out(`  - ${line}`);
    if (!info.known && !rest.includes("--yes")) {
      if (process.stdin.isTTY !== true) throw new Error("Add --yes to open it from a script.");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const a = await rl.question("Go ahead? [y/N] ").finally(() => rl.close());
      if (!/^y(es)?$/i.test(a.trim())) return out("Nothing changed.");
    }
    if (info.kind === "code" && draw !== "none") log(draw === "business" ? "Reading the code and drawing the business flow…" : "Reading the code and drawing the chart…");
    const r = await ws.openFolder(name, { wait: true, draw });
    if (info.kind === "code" && draw === "business") {
      const p = ws.get(r.name);
      await p.businessJob;
      const st = await p.businessState();
      ws.closeAll();
      if (st.error) throw new Error(`Opened as "${r.name}", but the business flow couldn't be drawn: ${st.error}`);
      out(`Opened as "${r.name}". Business flow: ${st.flow?.summary ?? ""} (${st.flow?.steps.length ?? 0} steps)`);
      return;
    }
    ws.closeAll();
    out(`Opened as "${r.name}".${r.summary ? ` ${r.summary}` : ""}`);
    for (const w of r.warnings ?? []) log(`  ! ${w}`);
    return;
  }
  if (cmd === "find") {
    const text = [name, ...rest].filter(Boolean).join(" ");
    if (!text.trim()) throw new Error("Usage: cdd find <description…>");
    log("Looking through your folders (read-only)…");
    const r = await ws.find(text);
    if (r.note) log(r.note);
    if (!r.matches.length) return out(`Looked at ${r.searched} project folders in ${r.roots.join(", ")}; none matched.`);
    for (const m of r.matches) out(`${m.display}${m.chart ? "  (chart project)" : ""}\n    ${m.reason}`);
    out(`\nOpen one with: cdd open <folder>`);
    return;
  }
  if (cmd === "forget") {
    if (!name) throw new Error("Usage: cdd forget <project>");
    await ws.forget(name);
    return out(`Removed "${name}" from the list. Its folder is unchanged.`);
  }
  if (cmd === "remove") {
    if (!name) throw new Error("Usage: cdd remove <project> [--delete]");
    const deleteFolder = rest.includes("--delete");
    if (deleteFolder) {
      if (process.stdin.isTTY !== true) throw new Error("Deleting a folder needs an interactive terminal (type the project's name to confirm).");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const typed = await rl.question(`This deletes the folder of "${name}" (code, chart and history) for good. Type ${name} to confirm: `).finally(() => rl.close());
      if (typed.trim() !== name) return out("Nothing deleted.");
    }
    try {
      stopApp(ws.get(name).dir);
    } catch {
      /* folder already gone */
    }
    return out((await ws.remove(name, { deleteFolder })).message);
  }
  if (!name) throw new Error(`Usage: cdd ${cmd} <project>`);
  const project = ws.get(name);
  project.close(); // the CLI doesn't need outside-edit polling

  switch (cmd) {
    case "chart": {
      const pc = await project.loadChart();
      const level = rest[0] ?? "root";
      const c = getLevel(pc, level);
      if (!c) throw new Error(`No module "${level}"`);
      out(level === "root" ? `${pc.name}: ${pc.idea}` : `${pc.name} › ${level}`);
      for (const n of c.nodes) out(`  [${n.kind}] ${n.id}  ${n.name}${n.status === "draft" ? " (draft)" : ""}${n.file ? `  ${n.file}` : ""}\n      ${n.description}`);
      for (const e of [...c.edges].sort((a, b) => a.order - b.order)) out(`  ${e.order}. ${e.from} → ${e.to}  (${e.data})`);
      return;
    }
    case "sync": {
      const changed = await project.checkOutside(true);
      if (!changed.length) return out("No outside edits.");
      const r = await project.syncFromCode();
      return out(`Updated the chart from ${changed.length} changed file(s). ${r.summary}`);
    }
    case "keep":
      await project.acceptOutside();
      return out("Kept the outside edits without updating the chart.");
    case "versions":
      for (const h of await project.history()) out(`${h.sha.slice(0, 7)}  ${h.date}  ${h.message.split("\n")[0]}`);
      return;
    case "undo":
      await project.undo();
      return out("Went back one version.");
    case "restore":
      if (!rest[0]) throw new Error("Usage: cdd restore <project> <version>");
      await project.restore(rest[0]);
      return out(`Restored ${rest[0]}.`);
    case "folder":
      if (rest.includes("--open")) out(await runTool("open_folder", {}, { project, approve: async () => false, changed: new Set(), pendingMessage: "" }));
      else out(project.dir);
      return;
    case "ask":
    case "chat":
      return converse(project, cfg.tools, cmd === "ask" ? rest.join(" ") : null);
    default:
      throw new Error(`Unknown command "${cmd}". Run "cdd help".`);
  }
}

async function converse(project: ReturnType<ReturnType<typeof setup>["ws"]["get"]>, llm: ReturnType<typeof setup>["tools"], once: string | null) {
  const interactive = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const assistant = new Assistant(project, llm, {
    onEvent: printEvent,
    async approve(command) {
      if (!interactive) {
        log(`  ✗ refused \`${command}\` (needs approval; run cdd in an interactive terminal)`);
        return false;
      }
      const a = await rl.question(`Allow the assistant to run \`${command}\`? [y/N] `);
      return /^y(es)?$/i.test(a.trim());
    },
  });
  try {
    if (once !== null) {
      if (!once.trim()) throw new Error("Usage: cdd ask <project> <message>");
      const r = await assistant.ask(once);
      out(r.reply);
      if (r.changed.length) log(`Saved as a new version. Changed: ${r.changed.join(", ")}`);
      return;
    }
    log(`Talking to the assistant about "${project.name}". Type "exit" to quit.`);
    for (;;) {
      const line = (await rl.question("> ").catch(() => "exit")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      if (line === "reset") {
        assistant.reset();
        log("Forgot the conversation.");
        continue;
      }
      const r = await assistant.ask(line);
      out(r.reply);
      if (r.changed.length) log(`Saved as a new version. Changed: ${r.changed.join(", ")}`);
    }
  } finally {
    rl.close();
    stopApp(project.dir);
  }
}

/** Read a line without echoing it: readline writes to a muted stream, and we write the prompt ourselves. */
async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: process.stdin.isTTY === true });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

// Set the exit code instead of calling process.exit(), so piped output is fully flushed.
main(process.argv.slice(2)).then(
  () => {
    process.exitCode = 0;
  },
  (e) => {
    process.stderr.write(`cdd: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);

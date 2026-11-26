#!/usr/bin/env -S npx tsx
// `cdd`: drive Chart Driven Development from a terminal, headless. Same projects, tools and versions as the web app.
import readline from "node:readline/promises";
import { Assistant } from "../server/agent/assistant.ts";
import { runTool, stopApp } from "../server/agent/tools.ts";
import { setup } from "../server/index.ts";
import { getLevel } from "../shared/chart.ts";
import type { AssistantEvent } from "../shared/types.ts";

const HELP = `Chart Driven Development, command line

  cdd projects                       list projects
  cdd chart <project> [module]       print the chart (or one module's inner chart)
  cdd ask <project> <message…>       ask the assistant once, then exit
  cdd chat <project>                 talk to the assistant (type "exit" to quit, "reset" to forget)
  cdd versions <project>             list saved versions
  cdd undo <project>                 go back one version
  cdd restore <project> <version>    restore a saved version
  cdd folder <project> [--open]      print (or open) the project folder
  cdd settings                       show which DeepSeek key and model are used
  cdd set-key                        save your DeepSeek API key (asks for it, so it stays out of shell history)

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
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const key = (await rl.question("DeepSeek API key: ")).trim();
    rl.close();
    if (!key) throw new Error("No key entered");
    cfg.brain.update({ deepseekApiKey: key });
    const t = await cfg.brain.settings.test();
    out(t.ok ? "Saved. The key works." : `Saved, but: ${t.message}`);
    return;
  }
  if (cmd === "projects") {
    const list = await ws.list();
    if (!list.length) return out(`No projects in ${cfg.workspace}.`);
    for (const p of list) out(`${p.name.padEnd(24)} ${p.idea}${p.hasChart ? "" : "  (not generated yet)"}`);
    return;
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

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`cdd: ${(e as Error).message}\n`);
    process.exit(1);
  },
);

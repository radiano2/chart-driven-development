// The assistant: a scripted model calls the real tools on a real generated project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import type { ChatMessage, ToolCall, ToolDef, ToolLLM } from "../src/server/ai/deepseek.ts";
import { MockAI } from "../src/server/ai/mock.ts";
import { Assistant, loadSkill } from "../src/server/agent/assistant.ts";
import { isAllowed, TOOL_DEFS } from "../src/server/agent/tools.ts";
import { Workspace, type Project } from "../src/server/project.ts";
import type { AssistantEvent } from "../src/shared/types.ts";

const run = promisify(execFile);

/** Replays a fixed list of tool calls, one per model turn, then answers with text. Records what it was sent. */
class ScriptedLLM implements ToolLLM {
  seen: ChatMessage[][] = [];
  constructor(private script: { name: string; args?: Record<string, unknown> }[][], private final = "Done.") {}
  async chat(messages: ChatMessage[], _tools: ToolDef[]) {
    this.seen.push(messages);
    const step = this.script.shift();
    if (!step) return { content: this.final };
    const tool_calls: ToolCall[] = step.map((c, i) => ({ id: `c${this.seen.length}-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
    return { content: null, tool_calls };
  }
}

const toolResults = (llm: ScriptedLLM) =>
  llm.seen.at(-1)!.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool").map((m) => m.content);

let root = "";
let ws: Workspace;
let project: Project;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cdd-agent-"));
  ws = new Workspace(root, new MockAI());
  project = await ws.create("todo", "todo app");
  project.close();
  await project.generate((await project.proposeStack()).recommended);
});

after(async () => {
  ws.closeAll();
  await rm(root, { recursive: true, force: true });
});

describe("assistant", () => {
  it("gets the skill guide and project context as its system prompt", async () => {
    const llm = new ScriptedLLM([]);
    await new Assistant(project, llm, { approve: async () => false }).ask("hi");
    const system = llm.seen[0][0];
    assert.equal(system.role, "system");
    assert.match(String(system.content), /Chart Driven Development assistant/);
    assert.match(String(system.content), /- todos: Todos \(4 functions\)/);
    assert.ok(loadSkill().includes("update_chart"));
    assert.ok(TOOL_DEFS.length >= 15);
  });

  it("changes code and chart in one turn, saved as one version", async () => {
    const before = (await project.history()).length;
    const llm = new ScriptedLLM([
      [{ name: "get_chart", args: { level: "todos" } }, { name: "read_file", args: { path: "src/todos.js" } }],
      [
        { name: "write_file", args: { path: "src/todos.js", content: "export function clearDone(todos) {\n  return todos.filter((t) => !t.done);\n}\n" } },
        { name: "update_chart", args: { ops: [{ op: "upsertNode", parent: "todos", node: { id: "clear-done", name: "clearDone", file: "src/todos.js", symbol: "clearDone", description: "Removes done todos" } }] } },
      ],
    ], "Added clearDone.");
    const events: AssistantEvent[] = [];
    const r = await new Assistant(project, llm, { approve: async () => false, onEvent: (e) => events.push(e) }).ask("add clear done");
    assert.equal(r.reply, "Added clearDone.");
    assert.deepEqual(r.changed.sort(), [".chart/chart.json", "src/todos.js"]);
    const h = await project.history();
    assert.equal(h.length, before + 1);
    assert.match(h[0].message, /^Assistant: add clear done/);
    const pc = await project.loadChart();
    assert.ok(pc.root.nodes.find((n) => n.id === "todos")!.children!.nodes.some((n) => n.id === "clear-done"));
    assert.ok(events.some((e) => e.kind === "tool" && e.summary === "write_file src/todos.js"));
  });

  it("refuses paths outside the project and the chart file", async () => {
    const llm = new ScriptedLLM([
      [
        { name: "read_file", args: { path: "../../etc/passwd" } },
        { name: "write_file", args: { path: "/tmp/evil.txt", content: "x" } },
        { name: "write_file", args: { path: ".chart/chart.json", content: "{}" } },
        { name: "write_file", args: { path: ".git/config", content: "x" } },
      ],
    ]);
    const r = await new Assistant(project, llm, { approve: async () => false }).ask("try escaping");
    const results = toolResults(llm);
    assert.match(results[0], /^Error: Path escapes project/);
    // An absolute path is treated as relative to the project, never as a system path.
    assert.match(results[1], /^Wrote \/tmp\/evil\.txt/);
    assert.match(await readFile(path.join(project.dir, "tmp/evil.txt"), "utf8"), /x/);
    assert.match(results[2], /^Error: Reserved path/);
    assert.match(results[3], /^Error: Reserved path/);
    assert.deepEqual(r.changed, ["/tmp/evil.txt"]);
  });

  it("runs allowlisted commands directly and asks before anything else", async () => {
    assert.ok(isAllowed("npm  test"));
    assert.ok(!isAllowed("npm test; rm -rf /"));
    assert.ok(!isAllowed("rm -rf ."));
    const asked: string[] = [];
    const llm = new ScriptedLLM([
      [
        { name: "run_command", args: { command: "node --test" } },
        { name: "run_command", args: { command: "echo hacked > hacked.txt" } },
        { name: "run_command", args: { command: "echo fine" } },
      ],
    ]);
    const answers = [false, true];
    await new Assistant(project, llm, { approve: async (c) => (asked.push(c), answers.shift()!) }).ask("run things");
    const results = toolResults(llm);
    assert.match(results[0], /^exit code: /);
    assert.match(results[1], /did not allow/);
    assert.match(results[2], /^exit code: 0\nfine/);
    assert.deepEqual(asked, ["echo hacked > hacked.txt", "echo fine"]);
    await assert.rejects(readFile(path.join(project.dir, "hacked.txt")));
  });

  it("can list versions and undo its own last change", async () => {
    const llm = new ScriptedLLM([[{ name: "write_file", args: { path: "note.txt", content: "temp" } }], [{ name: "undo" }], [{ name: "list_versions" }]]);
    const r = await new Assistant(project, llm, { approve: async () => false }).ask("write then undo");
    await assert.rejects(readFile(path.join(project.dir, "note.txt")));
    assert.deepEqual(r.changed, []);
    assert.match(toolResults(llm).at(-1)!, /Restore: /);
  });

  it("reports AI errors as a reply and keeps the project usable", async () => {
    const broken: ToolLLM = { chat: async () => Promise.reject(new Error("401 bad key")) };
    const r = await new Assistant(project, broken, { approve: async () => false }).ask("hello");
    assert.match(r.reply, /401 bad key/);
    assert.ok((await project.history()).length > 0);
  });
});

describe("cdd CLI", () => {
  const cli = (args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/cli/cdd.ts", ...args], { env: { ...process.env, CDD_AI: "mock", CDD_WORKSPACE: root }, cwd: path.resolve(".") });

  it("lists projects and prints a module chart", async () => {
    assert.match((await cli(["projects"])).stdout, /^todo\s+todo app/m);
    const chart = (await cli(["chart", "todo", "todos"])).stdout;
    assert.match(chart, /\[function\] add-todo/);
    assert.match(chart, /1\. add-todo → create-todo/);
  });

  it("asks the assistant headless and lists versions", async () => {
    const r = await cli(["ask", "todo", "show", "me", "the", "files"]);
    assert.match(r.stdout, /Mock assistant/);
    assert.match(r.stderr, /→ list_files/);
    assert.match((await cli(["versions", "todo"])).stdout, /Assistant: /);
  });

  it("fails clearly on an unknown project", async () => {
    await assert.rejects(cli(["chart", "nope"]), /No project "nope"/);
  });
});

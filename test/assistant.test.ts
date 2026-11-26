// The assistant: a scripted model calls the real tools on a real generated project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import type { ChatMessage, ToolCall, ToolDef, ToolLLM } from "../src/server/ai/deepseek.ts";
import { MockAI } from "../src/server/ai/mock.ts";
import { Assistant, loadSkill } from "../src/server/agent/assistant.ts";
import { AssistantHub } from "../src/server/agent/hub.ts";
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
    assert.deepEqual(r.changed, ["tmp/evil.txt"]);
  });

  it("can't reach .git or .chart through ./, .., letter case or symlinks", async () => {
    const sneaky = ["./.git/config", "docs/../.git/config", ".GIT/config", "x/../.chart/chart.json", "src/.git/hooks/pre-commit", ".git./config"];
    const outside = await mkdtemp(path.join(tmpdir(), "cdd-outside-"));
    await symlink(outside, path.join(project.dir, "link-out"));
    await symlink(path.join(project.dir, ".git"), path.join(project.dir, "link-git"));
    await symlink(path.join(outside, "nope.txt"), path.join(project.dir, "dangling.txt"));
    await project.commit("add test symlinks"); // otherwise they count as outside edits
    const llm = new ScriptedLLM([
      [
        ...sneaky.map((p) => ({ name: "write_file", args: { path: p, content: "[core]\n\tfsmonitor = touch pwned\n" } })),
        { name: "write_file", args: { path: "link-out/escaped.txt", content: "x" } },
        { name: "read_file", args: { path: "link-git/config" } },
        { name: "write_file", args: { path: "dangling.txt", content: "x" } },
      ],
    ]);
    await new Assistant(project, llm, { approve: async () => false }).ask("sneak");
    const results = toolResults(llm);
    results.forEach((r, i) => assert.match(r, /^Error: (Reserved path|Path escapes project)/, `call ${i} should be refused: ${r}`));
    assert.doesNotMatch(await readFile(path.join(project.dir, ".git/config"), "utf8"), /fsmonitor/);
    await assert.rejects(readFile(path.join(outside, "escaped.txt")));
    await assert.rejects(readFile(path.join(outside, "nope.txt")));
    await rm(outside, { recursive: true, force: true });
    for (const l of ["link-out", "link-git", "dangling.txt"]) await rm(path.join(project.dir, l), { force: true });
    await project.commit("clean up symlinks");
  });

  it("commits files changed by commands too", async () => {
    const llm = new ScriptedLLM([[{ name: "run_command", args: { command: "echo lock > made-by-command.txt" } }]]);
    const r = await new Assistant(project, llm, { approve: async () => true }).ask("make a file with a command");
    assert.equal(r.committed, true);
    assert.deepEqual(r.changed, ["made-by-command.txt"]);
    assert.match((await project.history())[0].message, /^Assistant: make a file/);
    assert.deepEqual(await project.checkOutside(true), []);
  });

  it("won't start while there are outside edits the user hasn't decided about", async () => {
    await writeFile(path.join(project.dir, "outside.txt"), "edited in my editor");
    const llm = new ScriptedLLM([[{ name: "list_files" }]]);
    const before = (await project.history()).length;
    const r = await new Assistant(project, llm, { approve: async () => false }).ask("do something");
    assert.match(r.reply, /changed outside the app \(outside\.txt\).*Update the chart.*cdd sync todo/s);
    assert.equal(llm.seen.length, 0, "the model is not called");
    assert.equal((await project.history()).length, before, "nothing committed for the user");
    assert.deepEqual(await project.checkOutside(true), ["outside.txt"]);
    await project.acceptOutside();
  });

  it("reports nothing saved when nothing changed", async () => {
    const r = await new Assistant(project, new ScriptedLLM([[{ name: "list_files" }]]), { approve: async () => false }).ask("look around");
    assert.deepEqual([r.committed, r.changed], [false, []]);
  });

  it("reads long files in parts that fit the model", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n");
    await writeFile(path.join(project.dir, "big.txt"), big);
    await project.commit("add big file");
    const llm = new ScriptedLLM([[{ name: "read_file", args: { path: "big.txt" } }, { name: "read_file", args: { path: "big.txt", from_line: 19_999 } }]]);
    await new Assistant(project, llm, { approve: async () => false }).ask("read the big file");
    const [first, last] = toolResults(llm);
    assert.ok(first.length < 50_000, `first part is ${first.length} chars`);
    assert.match(first, /^\[lines 1-\d+ of 20000\. Call read_file with from_line=\d+ for more/);
    assert.match(last, /^\[lines 19999-20000 of 20000\.\]\nline 19999 /);
  });

  it("keeps the conversation it sends within the model's budget", async () => {
    const llm = new ScriptedLLM(Array.from({ length: 6 }, () => [{ name: "read_file", args: { path: "big.txt" } }]));
    const a = new Assistant(project, llm, { approve: async () => false });
    await a.ask("read it many times");
    for (const sent of llm.seen) {
      const chars = sent.slice(1).reduce((n, m) => n + (m.content?.length ?? 0), 0);
      assert.ok(chars <= 150_000, `sent ${chars} chars of conversation`);
    }
    await rm(path.join(project.dir, "big.txt"));
    await project.commit("remove big file");
  });

  it("asks before starting the app", async () => {
    const asked: string[] = [];
    const llm = new ScriptedLLM([[{ name: "start_app" }]]);
    await new Assistant(project, llm, { approve: async (c) => (asked.push(c), false) }).ask("start it");
    assert.deepEqual(asked, ["npm start"]);
    assert.match(toolResults(llm)[0], /did not allow starting/);
  });

  it("shows the model the selected bubble, but keeps it out of the transcript", async () => {
    const llm = new ScriptedLLM([]);
    const a = new Assistant(project, llm, { approve: async () => false });
    await a.ask("rename it", '[Selected bubble: addTodo (id "add-todo") at level "todos"]');
    assert.match(String(llm.seen[0].at(-1)!.content), /^\[Selected bubble: addTodo.*\n\nrename it$/s);
    assert.deepEqual(a.transcript, [{ role: "user", text: "rename it" }, { role: "assistant", text: "Done." }]);
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

describe("start_app", () => {
  it("reports a spawn failure instead of crashing the server", async () => {
    const gone = await ws.create("gone", "todo app");
    gone.close();
    await gone.generate((await gone.proposeStack()).recommended);
    const llm = new ScriptedLLM([[{ name: "start_app" }]]);
    const a = new Assistant(gone, llm, {
      approve: async () => {
        await rm(gone.dir, { recursive: true, force: true }); // folder disappears while the approval card is up
        return true;
      },
    });
    let crashed: unknown = null;
    const onCrash = (e: unknown) => (crashed = e);
    process.on("uncaughtException", onCrash);
    try {
      await a.ask("start it").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("uncaughtException", onCrash);
    }
    assert.equal(crashed, null);
    assert.match(toolResults(llm)[0], /could not start|ENOENT|Error/);
  });
});

describe("approvals in the web app", () => {
  it("refuses at once when no browser tab is open, and cancel stops a waiting approval", async () => {
    const hub = new AssistantHub(new ScriptedLLM([[{ name: "run_command", args: { command: "echo hi" } }]]));
    const r = await hub.get(project).ask("run it");
    assert.match(r.reply, /Done/);
    const seen: string[] = [];
    const listener = (e: { type: string; event?: { kind: string } }) => e.type === "assistant" && seen.push(e.event!.kind);
    project.events.on("event", listener);
    const hub2 = new AssistantHub(new ScriptedLLM([[{ name: "run_command", args: { command: "echo hi" } }]]));
    const turn = hub2.get(project).ask("run it");
    while (!seen.includes("approval")) await new Promise((r) => setTimeout(r, 10));
    hub2.cancel(project);
    const r2 = await turn;
    assert.equal(r2.reply, "Stopped.");
    assert.ok(seen.includes("approval-resolved"));
    project.events.off("event", listener);
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

describe("DeepSeek flash", () => {
  it("uses deepseek-flash and sends its thinking back on later tool requests", async () => {
    const http = await import("node:http");
    const { DeepSeekTools } = await import("../src/server/ai/deepseek.ts");
    const bodies: { model: string; messages: Record<string, unknown>[] }[] = [];
    // Behaves like DeepSeek with tools in thinking mode: an earlier assistant message without reasoning_content is a 400.
    const fake = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const b = JSON.parse(raw);
        bodies.push(b);
        if (b.messages.some((m: Record<string, unknown>) => m.role === "assistant" && !m.reasoning_content))
          return res.writeHead(400).end('{"error":"reasoning_content missing"}');
        const first = bodies.length === 1;
        const message = first
          ? { content: null, reasoning_content: "Look at the project first.", tool_calls: [{ id: "t1", type: "function", function: { name: "get_project", arguments: "{}" } }] }
          : { content: "It is a todo app.", reasoning_content: "Got it." };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const port = (fake.address() as import("node:net").AddressInfo).port;
      const llm = new DeepSeekTools({ apiKey: "sk-x", baseUrl: `http://127.0.0.1:${port}` });
      const r = await new Assistant(project, llm, { approve: async () => false }).ask("what is this?");
      assert.equal(r.reply, "It is a todo app.");
      assert.deepEqual(bodies.map((b) => b.model), ["deepseek-flash", "deepseek-flash"]);
      assert.equal(bodies[1].messages.find((m) => m.role === "assistant")?.reasoning_content, "Look at the project first.");
    } finally {
      fake.close();
    }
  });
});

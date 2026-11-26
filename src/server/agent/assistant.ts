// The assistant: DeepSeek + the CDD skill guide + tools, working on one project.
// Each user message is one turn; everything it changes is saved as one git commit at the end of the turn.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantEvent } from "../../shared/types.ts";
import type { ChatMessage, ToolLLM } from "../ai/deepseek.ts";
import type { Project } from "../project.ts";
import { runTool, TOOL_DEFS } from "./tools.ts";

const SKILL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/cdd-assistant.md");
const MAX_STEPS = 30;
const MAX_HISTORY = 60;

export function loadSkill(): string {
  return readFileSync(SKILL_PATH, "utf8");
}

export interface AssistantOptions {
  approve(command: string): Promise<boolean>;
  onEvent?(e: AssistantEvent): void;
}

function short(s: string, n = 160) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function describeCall(name: string, a: Record<string, unknown>): string {
  const target = a.path ?? a.level ?? a.command ?? a.sha ?? a.text ?? a.dir;
  if (name === "update_chart" && Array.isArray(a.ops)) return `update_chart (${a.ops.length} change${a.ops.length === 1 ? "" : "s"})`;
  return target ? `${name} ${String(target)}` : name;
}

export class Assistant {
  /** Conversation so far (without the system message). */
  history: ChatMessage[] = [];

  constructor(private project: Project, private llm: ToolLLM, private opts: AssistantOptions) {}

  private emit(e: AssistantEvent) {
    this.opts.onEvent?.(e);
  }

  private async systemPrompt(): Promise<string> {
    const pc = await this.project.loadChart();
    const modules = pc.root.nodes.map((n) => `- ${n.id}: ${n.name} (${n.children?.nodes.length ?? 0} functions)`).join("\n") || "(no modules yet)";
    return `${loadSkill()}

## Current project
Name: ${this.project.name}
Idea: ${pc.idea}
Stack: ${pc.stack ? `${pc.stack.name} (${pc.stack.language}); run with \`${pc.stack.runCommand}\`` : "not chosen yet"}
Modules:
${modules}`;
  }

  private trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;
    // Cut at a user message so tool results never lose their call.
    let start = this.history.length - MAX_HISTORY;
    while (start < this.history.length && this.history[start].role !== "user") start++;
    this.history = this.history.slice(start);
  }

  /** Handle one user message. Holds the project lock for the whole turn. */
  ask(text: string): Promise<{ reply: string; changed: string[] }> {
    return this.project.exclusive(async () => {
      const ctx = {
        project: this.project,
        approve: async (command: string) => this.opts.approve(command),
        changed: new Set<string>(),
        pendingMessage: `Assistant: ${short(text, 72)} (before undo)`,
      };
      this.history.push({ role: "user", content: text });
      let reply = "";
      try {
        const system: ChatMessage = { role: "system", content: await this.systemPrompt() };
        for (let step = 0; step < MAX_STEPS; step++) {
          this.emit({ kind: "thinking" });
          const msg = await this.llm.chat([system, ...this.history], TOOL_DEFS);
          this.history.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
          if (!msg.tool_calls?.length) {
            reply = msg.content?.trim() || "(no reply)";
            break;
          }
          if (msg.content?.trim()) this.emit({ kind: "note", text: msg.content.trim() });
          for (const call of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            let result: string;
            let ok = true;
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              this.emit({ kind: "tool", name: call.function.name, summary: describeCall(call.function.name, args) });
              result = await runTool(call.function.name, args, ctx);
            } catch (e) {
              ok = false;
              result = `Error: ${(e as Error).message}`;
            }
            this.emit({ kind: "tool-result", name: call.function.name, ok, summary: short(result) });
            this.history.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          if (step === MAX_STEPS - 1) reply = "I stopped after many steps without finishing. Tell me how you'd like to continue.";
        }
      } catch (e) {
        reply = `Something went wrong talking to the AI: ${(e as Error).message}`;
        this.history.push({ role: "assistant", content: reply });
      }
      {
        const changed = [...ctx.changed];
        if (changed.length) {
          await this.project.commit(`Assistant: ${short(text, 72)}\n\n${short(reply, 600)}\n\nChanged: ${changed.join(", ")}`);
          this.project.emit({ type: "chart", chart: await this.project.loadChart() });
        }
        this.trimHistory();
        this.emit({ kind: "reply", text: reply, changed });
        return { reply, changed };
      }
    });
  }

  reset() {
    this.history = [];
  }
}

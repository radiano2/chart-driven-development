// The assistant: DeepSeek + the CDD skill guide + tools, working on one project.
// Each user message is one turn; everything it changes is saved as one git commit at the end of the turn.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantEvent } from "../../shared/types.ts";
import type { ChatMessage, ToolLLM } from "../ai/deepseek.ts";
import * as git from "../git.ts";
import type { Project } from "../project.ts";
import { runTool, TOOL_DEFS } from "./tools.ts";

const SKILL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/cdd-assistant.md");
const MAX_STEPS = 30;
const MAX_HISTORY = 60;
/** Rough budget for the conversation sent to the model (~4 chars per token, leaving room for the guide and reply). */
const MAX_HISTORY_CHARS = 140_000;
const MAX_TOOL_RESULT = 50_000;

/**
 * A reply the app writes itself (stop, error) still goes into the history as an assistant message. DeepSeek flash
 * wants reasoning_content on every earlier assistant message when tools are used, so give it a short one.
 */
function ownReply(content: string): ChatMessage {
  return { role: "assistant", content, reasoning_content: "(written by the app, not the model)" };
}

function size(m: ChatMessage): number {
  if (m.role !== "assistant") return m.content.length;
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.reasoning_content?.length ?? 0);
}

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
  /** What the user sees: their own words and the final replies. */
  transcript: { role: "user" | "assistant"; text: string }[] = [];
  private cancelled = false;

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

  /**
   * Keep what we send under the model's context window: drop whole older turns first, then blank out the oldest
   * tool outputs of the current turn (the calls stay, so the conversation remains valid).
   */
  private compactHistory() {
    const total = () => this.history.reduce((n, m) => n + size(m), 0);
    while (total() > MAX_HISTORY_CHARS) {
      const nextUser = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (nextUser <= 0) break;
      this.history = this.history.slice(nextUser);
    }
    const tools = this.history.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    for (const i of tools.slice(0, -2)) {
      if (total() <= MAX_HISTORY_CHARS) break;
      const m = this.history[i] as Extract<ChatMessage, { role: "tool" }>;
      if (m.content.length > 200) this.history[i] = { ...m, content: "(output removed to save space; run the tool again if you need it)" };
    }
  }

  private trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;
    // Cut at a user message so tool results never lose their call.
    let start = this.history.length - MAX_HISTORY;
    while (start < this.history.length && this.history[start].role !== "user") start++;
    this.history = this.history.slice(start);
  }

  /**
   * Handle one user message. `context` (e.g. the selected bubble) is shown to the model but not in the transcript.
   * Holds the project lock for the whole turn, so everything that changes in the folder meanwhile is the turn's own
   * doing and is saved as one commit at the end.
   */
  ask(text: string, context?: string): Promise<{ reply: string; changed: string[]; committed: boolean }> {
    return this.project.exclusive(async () => {
      this.cancelled = false;
      // Edits made outside the app are the user's to resolve (update the chart from them, or keep them as they are).
      // Don't start a turn on top of them: it would either fold them into the assistant's version or decide for the user.
      const outside = (await git.changedFiles(this.project.dir)).filter((f) => !f.startsWith(".chart/"));
      if (outside.length) {
        const reply = `${outside.length} file${outside.length > 1 ? "s were" : " was"} changed outside the app (${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""}). First choose "Update the chart" or "Keep, don't update" in the banner above the chart (in a terminal: \`cdd sync ${this.project.name}\` or \`cdd keep ${this.project.name}\`), then ask me again.`;
        this.emit({ kind: "reply", text: reply, changed: [] });
        return { reply, changed: [], committed: false };
      }
      const ctx = {
        project: this.project,
        approve: async (command: string) => !this.cancelled && (await this.opts.approve(command)),
        changed: new Set<string>(),
        pendingMessage: `Assistant: ${short(text, 72)} (before undo)`,
      };
      this.history.push({ role: "user", content: context ? `${context}\n\n${text}` : text });
      this.transcript.push({ role: "user", text });
      let reply = "";
      try {
        const system: ChatMessage = { role: "system", content: await this.systemPrompt() };
        for (let step = 0; step < MAX_STEPS && !reply; step++) {
          if (this.cancelled) {
            reply = "Stopped.";
            this.history.push(ownReply(reply));
            break;
          }
          this.emit({ kind: "thinking" });
          this.compactHistory();
          const msg = await this.llm.chat([system, ...this.history], TOOL_DEFS);
          this.history.push({
            role: "assistant",
            content: msg.content,
            tool_calls: msg.tool_calls,
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
          });
          if (!msg.tool_calls?.length) {
            reply = msg.content?.trim() || "(no reply)";
            break;
          }
          if (msg.content?.trim()) this.emit({ kind: "note", text: msg.content.trim() });
          for (const call of msg.tool_calls) {
            let result: string;
            let ok = true;
            if (this.cancelled) {
              // Every tool call still needs an answer in the history.
              this.history.push({ role: "tool", tool_call_id: call.id, content: "Cancelled by the user." });
              continue;
            }
            try {
              const args: Record<string, unknown> = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              this.emit({ kind: "tool", name: call.function.name, summary: describeCall(call.function.name, args) });
              result = await runTool(call.function.name, args, ctx);
            } catch (e) {
              ok = false;
              result = `Error: ${(e as Error).message}`;
            }
            this.emit({ kind: "tool-result", name: call.function.name, ok, summary: short(result) });
            if (result.length > MAX_TOOL_RESULT) result = result.slice(0, MAX_TOOL_RESULT) + "\n…(cut to save space)";
            this.history.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          if (step === MAX_STEPS - 1 && !reply) reply = "I stopped after many steps without finishing. Tell me how you'd like to continue.";
        }
      } catch (e) {
        reply = `Something went wrong talking to the AI: ${(e as Error).message}`;
        this.history.push(ownReply(reply));
      }
      // Commit whatever is dirty now: files written by tools AND by commands (npm install → lockfile, etc.).
      const changed = (await git.changedFiles(this.project.dir));
      const committed = changed.length
        ? await this.project.commit(`Assistant: ${short(text, 72)}\n\n${short(reply, 600)}\n\nChanged: ${changed.join(", ")}`)
        : false;
      if (committed || ctx.changed.size) this.project.emit({ type: "chart", chart: await this.project.loadChart() });
      this.transcript.push({ role: "assistant", text: reply });
      if (this.transcript.length > 200) this.transcript = this.transcript.slice(-200);
      this.trimHistory();
      const result = { reply, changed: committed ? changed : [], committed };
      this.emit({ kind: "reply", text: reply, changed: result.changed });
      return result;
    });
  }

  /** Stop the running turn after the current step; pending approvals are denied by the caller. */
  cancel() {
    this.cancelled = true;
  }

  reset() {
    this.history = [];
    this.transcript = [];
  }
}

// One assistant per open project for the web UI; approvals go out as events and come back over HTTP.
import { randomUUID } from "node:crypto";
import type { ToolLLM } from "../ai/deepseek.ts";
import type { Project } from "../project.ts";
import { Assistant } from "./assistant.ts";

const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export class AssistantHub {
  private assistants = new Map<string, Assistant>();
  private pending = new Map<string, { project: string; resolve(allowed: boolean): void }>();

  constructor(private llm: ToolLLM) {}

  get(project: Project): Assistant {
    let a = this.assistants.get(project.name);
    if (!a) {
      a = new Assistant(project, this.llm, {
        onEvent: (event) => project.emit({ type: "assistant", event }),
        approve: (command) =>
          new Promise<boolean>((resolve) => {
            const id = randomUUID();
            const timer = setTimeout(() => this.resolve(project.name, id, false), APPROVAL_TIMEOUT_MS);
            this.pending.set(id, {
              project: project.name,
              resolve: (allowed) => {
                clearTimeout(timer);
                project.emit({ type: "assistant", event: { kind: "approval-resolved", id, allowed } });
                resolve(allowed);
              },
            });
            project.emit({ type: "assistant", event: { kind: "approval", id, command } });
          }),
      });
      this.assistants.set(project.name, a);
    }
    return a;
  }

  /** Answer a pending approval. Returns false if there was none with that id for this project. */
  resolve(project: string, id: string, allowed: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.project !== project) return false;
    this.pending.delete(id);
    p.resolve(allowed);
    return true;
  }

  /** Visible conversation: user messages and the assistant's final replies. */
  transcript(project: Project): { role: "user" | "assistant"; text: string }[] {
    const a = this.assistants.get(project.name);
    if (!a) return [];
    return a.history
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls?.length && m.content))
      .map((m) => ({ role: m.role as "user" | "assistant", text: String((m as { content: string }).content) }));
  }
}

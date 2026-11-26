// One assistant per open project for the web UI; approvals go out as events and come back over HTTP.
import { randomUUID } from "node:crypto";
import type { ToolLLM } from "../ai/deepseek.ts";
import type { Project } from "../project.ts";
import { Assistant } from "./assistant.ts";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

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
            // Nobody has the project open to answer: refuse instead of holding the project for minutes.
            if (project.events.listenerCount("event") === 0) return resolve(false);
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
      // When the last browser tab on this project goes away, refuse whatever it was asked to approve.
      project.events.on("removeListener", (name: string) => {
        if (name === "event" && project.events.listenerCount("event") === 0) this.denyAll(project.name);
      });
    }
    return a;
  }

  /** Stop the running turn on a project and refuse its pending approvals. */
  cancel(project: Project) {
    this.assistants.get(project.name)?.cancel();
    this.denyAll(project.name);
  }

  private denyAll(project: string) {
    for (const [id, p] of this.pending) if (p.project === project) this.resolve(project, id, false);
  }

  /** Answer a pending approval. Returns false if there was none with that id for this project. */
  resolve(project: string, id: string, allowed: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.project !== project) return false;
    this.pending.delete(id);
    p.resolve(allowed);
    return true;
  }

  /** Visible conversation: the user's own words and the assistant's final replies. */
  transcript(project: Project): { role: "user" | "assistant"; text: string }[] {
    return this.assistants.get(project.name)?.transcript ?? [];
  }
}

// Offline stand-in for DeepSeek function calling (CDD_AI=mock): picks one tool from keywords, then summarizes.
import type { ChatMessage, ToolCall, ToolDef, ToolLLM } from "../ai/deepseek.ts";

let n = 0;
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `mock-${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

export class MockToolLLM implements ToolLLM {
  async chat(messages: ChatMessage[], _tools: ToolDef[]) {
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      const t = last.content.toLowerCase();
      const run = t.match(/run\s+`([^`]+)`/);
      if (run) return { content: null, tool_calls: [call("run_command", { command: run[1] })] };
      if (/\bundo\b/.test(t)) return { content: null, tool_calls: [call("undo")] };
      if (/\btests?\b/.test(t)) return { content: null, tool_calls: [call("run_command", { command: "npm test" })] };
      if (/\bversions?|history\b/.test(t)) return { content: null, tool_calls: [call("list_versions")] };
      if (/\bfiles?\b/.test(t)) return { content: null, tool_calls: [call("list_files")] };
      if (/\bfolder\b/.test(t)) return { content: null, tool_calls: [call("open_folder")] };
      return { content: null, tool_calls: [call("get_chart", { level: "root" })] };
    }
    if (last.role === "tool") {
      const firstLine = last.content.split("\n").slice(0, 3).join(" ").slice(0, 240);
      return { content: `(Mock assistant, no AI connected.) I ran a tool for you. Result: ${firstLine}` };
    }
    return { content: "(Mock assistant) Nothing to do." };
  }
}

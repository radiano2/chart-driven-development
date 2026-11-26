// Minimal DeepSeek chat client (OpenAI-compatible API) that always asks for JSON.

export interface JsonLLM {
  json(system: string, user: string, opts?: { maxTokens?: number }): Promise<unknown>;
}

/** DeepSeek flash is the only model the app uses. */
export const DEEPSEEK_MODEL = "deepseek-flash";
/** Flash thinks before it answers, and the thinking counts toward max_tokens, so leave plenty of room. */
const MAX_TOKENS = 32_000;

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class DeepSeek implements JsonLLM {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: DeepSeekOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEEPSEEK_MODEL;
    this.baseUrl = (opts.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 240_000;
  }

  async json(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await this.chat(system, user, opts.maxTokens ?? MAX_TOKENS);
      try {
        return parseJsonLoose(content);
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`DeepSeek returned invalid JSON: ${(lastError as Error)?.message}`);
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new Error("DeepSeek returned an empty response");
    if (choice?.finish_reason === "length") throw new Error("DeepSeek response was cut off (too long). Try a smaller change.");
    return content;
  }
}

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("No JSON object found");
  }
}

// ---------- function calling (used by the assistant) ----------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  // reasoning_content is flash's thinking. With tools, DeepSeek requires it to be sent back on every later request
  // (it answers 400 otherwise), so it is kept in the history as it came.
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A chat model that can call tools (OpenAI-compatible function calling). */
export interface ToolLLM {
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<{ content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }>;
}

export class DeepSeekTools implements ToolLLM {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: DeepSeekOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEEPSEEK_MODEL;
    this.baseUrl = (opts.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, tools, max_tokens: MAX_TOKENS }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string | null } }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("DeepSeek returned an empty response");
    return {
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
      reasoning_content: msg.reasoning_content ?? undefined,
    };
  }
}

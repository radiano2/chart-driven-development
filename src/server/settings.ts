// App settings (DeepSeek key + model) kept in a local file outside git, and the AI that follows them live.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AI } from "./ai/ai.ts";
import { DeepSeek, DeepSeekTools, type ToolLLM } from "./ai/deepseek.ts";
import { LlmAI } from "./ai/llm.ts";
import { MockAI } from "./ai/mock.ts";
import { MockToolLLM } from "./agent/mock-llm.ts";
import { HttpError } from "./project.ts";

export interface Settings {
  deepseekApiKey?: string;
  deepseekModel?: string;
}

export interface SettingsStatus {
  mock: boolean;
  hasKey: boolean;
  /** Where the key in use comes from. The settings screen wins over .env / environment. */
  keySource: "settings" | "env" | null;
  /** Last 4 characters only; the key itself never leaves the server. */
  keyHint: string | null;
  model: string;
  file: string;
}

export const DEFAULT_MODEL = "deepseek-chat";
export const NO_KEY_MESSAGE = "No DeepSeek API key yet. Open Settings (top right) and paste your key, or put DEEPSEEK_API_KEY in .env.";

function hint(key: string) {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

export class SettingsStore {
  private data: Settings = {};

  constructor(readonly file: string, private env: NodeJS.ProcessEnv = process.env) {
    this.load();
  }

  load() {
    try {
      this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Settings) : {};
    } catch {
      this.data = {};
    }
  }

  /** Update settings. Empty string removes a value. */
  save(patch: Settings) {
    const next: Settings = { ...this.data };
    for (const k of ["deepseekApiKey", "deepseekModel"] as const) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k]).trim();
      if (v) next[k] = v;
      else delete next[k];
    }
    if (next.deepseekApiKey && /\s/.test(next.deepseekApiKey)) throw new HttpError(400, "The API key can't contain spaces");
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this platform */
    }
    this.data = next;
  }

  get mock() {
    return this.env.CDD_AI === "mock";
  }

  key(): { key: string; source: "settings" | "env" } | null {
    if (this.data.deepseekApiKey) return { key: this.data.deepseekApiKey, source: "settings" };
    if (this.env.DEEPSEEK_API_KEY) return { key: this.env.DEEPSEEK_API_KEY, source: "env" };
    return null;
  }

  model(): string {
    return this.data.deepseekModel || this.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  }

  baseUrl(): string {
    return (this.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  }

  status(): SettingsStatus {
    const k = this.key();
    return { mock: this.mock, hasKey: !!k, keySource: k?.source ?? null, keyHint: k ? hint(k.key) : null, model: this.model(), file: this.file };
  }

  /** Check a key (or the saved one) against DeepSeek. */
  async test(apiKey?: string): Promise<{ ok: boolean; message: string }> {
    const key = apiKey?.trim() || this.key()?.key;
    if (!key) return { ok: false, message: NO_KEY_MESSAGE };
    try {
      const res = await fetch(`${this.baseUrl()}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { ok: true, message: "Connected to DeepSeek. The key works." };
      if (res.status === 401) return { ok: false, message: "DeepSeek rejected this key (401). Check it was copied completely." };
      if (res.status === 402) return { ok: false, message: "The key works, but the DeepSeek account has no balance (402)." };
      return { ok: false, message: `DeepSeek answered ${res.status}.` };
    } catch (e) {
      return { ok: false, message: `Could not reach DeepSeek: ${(e as Error).message}` };
    }
  }
}

/** Build the AI from the current settings. */
function build(s: SettingsStore): { ai: AI; tools: ToolLLM; label: string } {
  if (s.mock) return { ai: new MockAI(), tools: new MockToolLLM(), label: "mock (canned todo app)" };
  const k = s.key();
  const model = s.model();
  if (!k) {
    const fail = () => Promise.reject(new HttpError(400, NO_KEY_MESSAGE));
    return {
      ai: new Proxy({} as AI, { get: () => fail }),
      tools: { chat: fail },
      label: "DeepSeek (no key yet)",
    };
  }
  const opts = { apiKey: k.key, model, baseUrl: s.baseUrl() };
  return { ai: new LlmAI(new DeepSeek(opts)), tools: new DeepSeekTools(opts), label: `DeepSeek (${model})` };
}

/**
 * The AI the app uses. It always follows the latest settings: saving a new key takes effect on the next
 * request, with no restart. `ai` and `tools` are stable objects that forward to the current implementation.
 */
export class Brain {
  private current: ReturnType<typeof build>;
  readonly ai: AI;
  readonly tools: ToolLLM;

  constructor(readonly settings: SettingsStore) {
    this.current = build(settings);
    this.ai = new Proxy({} as AI, {
      get: (_t, prop) => (...args: unknown[]) => (this.current.ai as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args),
    });
    this.tools = { chat: (m, t) => this.current.tools.chat(m, t) };
  }

  get label() {
    return this.current.label;
  }

  update(patch: Settings) {
    this.settings.save(patch);
    this.current = build(this.settings);
  }
}

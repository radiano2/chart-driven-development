import type {
  Bubble,
  HistoryEntry,
  Level,
  ProjectChart,
  ProjectSummary,
  Recommendation,
  RecommendationOption,
  RunTrace,
  ServerEvent,
  Stack,
  StackProposal,
} from "../shared/types.ts";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

const P = (name: string) => `/api/projects/${encodeURIComponent(name)}`;

export interface SettingsStatus {
  mock: boolean;
  hasKey: boolean;
  keySource: "settings" | "env" | null;
  keyHint: string | null;
  model: string;
  file: string;
}

export interface ChangeResult {
  chart: ProjectChart;
  summary?: string;
  files?: string[];
  warnings?: string[];
}

export const api = {
  info: () => call<{ ai: string; workspace: string; needsKey: boolean }>("GET", "/api/info"),
  settings: () => call<SettingsStatus>("GET", "/api/settings"),
  saveSettings: (patch: { deepseekApiKey?: string; deepseekModel?: string }) => call<SettingsStatus & { ai: string }>("PUT", "/api/settings", patch),
  testKey: (deepseekApiKey?: string) => call<{ ok: boolean; message: string }>("POST", "/api/settings/test", { deepseekApiKey }),
  projects: () => call<ProjectSummary[]>("GET", "/api/projects"),
  create: (name: string, idea: string) => call<{ name: string; chart: ProjectChart }>("POST", "/api/projects", { name, idea }),
  open: (name: string) => call<{ name: string; dir: string; chart: ProjectChart; outside: string[] }>("GET", P(name)),
  stack: (name: string) => call<StackProposal>("POST", `${P(name)}/stack`),
  generate: (name: string, stack: Stack) => call<{ chart: ProjectChart }>("POST", `${P(name)}/generate`, { stack }),
  recommend: (name: string, level: Level, bubbleId: string, request: string) =>
    call<Recommendation>("POST", `${P(name)}/recommend`, { level, bubbleId, request }),
  apply: (name: string, level: Level, bubbleId: string, request: string, option: RecommendationOption) =>
    call<ChangeResult>("POST", `${P(name)}/apply`, { level, bubbleId, request, option }),
  implement: (name: string, level: Level, bubbleId: string) => call<ChangeResult>("POST", `${P(name)}/implement`, { level, bubbleId }),
  addBubble: (name: string, level: Level, bubble: Partial<Bubble>) =>
    call<{ chart: ProjectChart; bubble: Bubble }>("POST", `${P(name)}/bubbles`, { level, bubble }),
  removeBubble: (name: string, level: Level, bubbleId: string) => call<ChangeResult>("POST", `${P(name)}/bubbles/remove`, { level, bubbleId }),
  addEdge: (name: string, level: Level, edge: { from: string; to: string; data: string }) =>
    call<ChangeResult>("POST", `${P(name)}/edges`, { level, edge }),
  run: (name: string, level: Level) => call<RunTrace>("POST", `${P(name)}/run`, { level }),
  history: (name: string) => call<HistoryEntry[]>("GET", `${P(name)}/history`),
  undo: (name: string) => call<ChangeResult>("POST", `${P(name)}/undo`),
  restore: (name: string, sha: string) => call<ChangeResult>("POST", `${P(name)}/restore`, { sha }),
  sync: (name: string) => call<ChangeResult>("POST", `${P(name)}/sync`),
  acceptOutside: (name: string) => call<{ ok: boolean }>("POST", `${P(name)}/accept-outside`),
  file: (name: string, path: string) => call<{ path: string; content: string }>("GET", `${P(name)}/file?path=${encodeURIComponent(path)}`),
  assistant: (name: string, message: string, context?: string) =>
    call<{ reply: string; changed: string[]; committed: boolean }>("POST", `${P(name)}/assistant`, { message, context }),
  cancelAssistant: (name: string) => call<{ ok: boolean }>("POST", `${P(name)}/assistant/cancel`),
  assistantTranscript: (name: string) => call<{ role: "user" | "assistant"; text: string }[]>("GET", `${P(name)}/assistant`),
  approve: (name: string, id: string, allow: boolean) => call<{ ok: boolean }>("POST", `${P(name)}/assistant/approve`, { id, allow }),
  resetAssistant: (name: string) => call<{ ok: boolean }>("POST", `${P(name)}/assistant/reset`),
  openFolder: (name: string) => call<{ message: string }>("POST", `${P(name)}/open-folder`),
  events(name: string, onEvent: (e: ServerEvent) => void): EventSource {
    const es = new EventSource(`${P(name)}/events`);
    es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent);
    return es;
  },
};

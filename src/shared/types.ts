// Types shared by the server and the browser UI.

/** One named value flowing into or out of a bubble. `type` is a human-readable data shape. */
export interface Port {
  name: string;
  type: string;
}

export type BubbleKind = "module" | "function";

/** "draft" = drawn by hand, no code yet. "ready" = backed by real code. */
export type BubbleStatus = "draft" | "ready";

export interface Bubble {
  id: string;
  name: string;
  kind: BubbleKind;
  description: string;
  inputs: Port[];
  outputs: Port[];
  status: BubbleStatus;
  /** Source file that holds this bubble's code (relative to the project folder). */
  file?: string;
  /** Function / symbol name inside `file`, for function bubbles. */
  symbol?: string;
  /** Inner chart, for module bubbles. */
  children?: Chart;
}

/**
 * An arrow. It shows both call order (`order`, 1-based) and the data shape passed (`data`).
 * Inside a module, an endpoint that is not a node of that chart (e.g. "storage/saveTodos")
 * is drawn as a ghost bubble belonging to another module.
 */
export interface Edge {
  id: string;
  from: string;
  to: string;
  data: string;
  order: number;
}

export interface Chart {
  nodes: Bubble[];
  edges: Edge[];
}

export interface Stack {
  name: string;
  language: string;
  runtime: string;
  libraries: string[];
  runCommand: string;
  reasoning: string;
}

export interface StackProposal {
  recommended: Stack;
  alternatives: Stack[];
}

export interface ProjectChart {
  version: 1;
  name: string;
  idea: string;
  stack: Stack | null;
  root: Chart;
}

/** Where in the chart we are: "root" is the module level, otherwise a module id. */
export type Level = "root" | string;

export type ChartOp =
  | { op: "upsertNode"; parent: Level; node: Partial<Bubble> & { id: string } }
  | { op: "removeNode"; parent: Level; id: string }
  | { op: "upsertEdge"; parent: Level; edge: Partial<Edge> & { from: string; to: string } }
  | { op: "removeEdge"; parent: Level; id: string };

export interface FileChange {
  path: string;
  /** null deletes the file. */
  content: string | null;
}

export interface ChangeSet {
  summary: string;
  ops: ChartOp[];
  files: FileChange[];
}

export interface RecommendationOption {
  id: string;
  /** "extend" | "split" | "rewrite" | "rewire" | other short verb */
  kind: string;
  label: string;
  description: string;
}

export interface Recommendation {
  summary: string;
  recommendedOptionId: string;
  options: RecommendationOption[];
}

export interface RunStep {
  nodeId: string;
  /** The edge the data travelled along to reach this node, if any. */
  edgeId?: string;
  data: string;
  note: string;
}

export interface RunTrace {
  scenario: string;
  steps: RunStep[];
}

export interface HistoryEntry {
  sha: string;
  message: string;
  date: string;
}

export interface ProjectSummary {
  name: string;
  idea: string;
  hasChart: boolean;
}

/** What the assistant is doing, streamed to the UI / CLI. */
export type AssistantEvent =
  | { kind: "thinking" }
  | { kind: "note"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "tool-result"; name: string; ok: boolean; summary: string }
  | { kind: "approval"; id: string; command: string }
  | { kind: "approval-resolved"; id: string; allowed: boolean }
  | { kind: "reply"; text: string; changed: string[] };

export type ServerEvent =
  | { type: "progress"; message: string }
  | { type: "chart"; chart: ProjectChart }
  | { type: "outside-change"; files: string[] }
  | { type: "error"; message: string }
  | { type: "assistant"; event: AssistantEvent };

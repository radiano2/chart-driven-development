// Types shared by the server and the browser UI.

/** One named value flowing into or out of a bubble. `type` is a human-readable data shape. */
export interface Port {
  name: string;
  type: string;
}

export type BubbleKind = "module" | "function";

/** "draft" = drawn by hand, no code yet. "ready" = backed by real code. */
export type BubbleStatus = "draft" | "ready";

/** Marks a bubble that shows UI. Screenshots open `route` on the running app and capture `selector`. */
export interface GuiInfo {
  /** Path on the running app, e.g. "/" or "/settings". Default "/". */
  route?: string;
  /** CSS selector of the part this bubble draws. Default [data-bubble="<id>"], else the whole page. */
  selector?: string;
}

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
  /** Set when this bubble shows UI: it gets screenshots and mockup crops. */
  gui?: GuiInfo;
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
  /** Where the running app can be opened, for web apps (e.g. http://localhost:3000). */
  appUrl?: string;
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

// ---------- design ----------

export interface StyleColor {
  name: string;
  value: string;
  use?: string;
}

/** The project's style guide: every mockup and UI change follows it. Stored in .chart/design/style.json. */
export interface StyleGuide {
  summary: string;
  colors: StyleColor[];
  fonts: { role: string; family: string }[];
  /** Short tokens like "8px" or "rounded corners, 12px". */
  radius: string;
  spacing: string;
  mood: string[];
  /** Do / don't rules, one sentence each. */
  rules: string[];
}

export interface DesignReference {
  id: string;
  /** Image path relative to the project, under .chart/design/references/. */
  image: string;
  note: string;
  /** What the AI saw in the image (used in later prompts). */
  description: string;
  created: string;
}

export interface Mockup {
  id: string;
  title: string;
  request: string;
  summary: string;
  /** Bubbles this mockup shows; each one with a region in the HTML gets a crop. */
  bubbleIds: string[];
  html: string;
  image: string;
  /** Bubble id → image path of that bubble's region (from data-bubble attributes). */
  crops: Record<string, string>;
  /** The style guide this mockup proposes; it becomes the project's when the mockup is applied. */
  style: StyleGuide | null;
  created: string;
}

export interface Screenshot {
  bubbleId: string;
  level: Level;
  image: string;
  url: string;
  /** True when the bubble's own element was found; false = whole page. */
  cropped: boolean;
  takenAt: string;
}

export interface DesignState {
  style: StyleGuide | null;
  references: DesignReference[];
  mockups: Mockup[];
  /** Keyed by "<level>/<bubbleId>". */
  screenshots: Record<string, Screenshot>;
  /** Address of the running app, when set by hand. */
  appUrl: string | null;
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
  | { type: "assistant"; event: AssistantEvent }
  | { type: "design"; design: DesignState };

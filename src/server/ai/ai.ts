import type {
  Bubble,
  BusinessFlow,
  Chart,
  ChangeSet,
  DesignReference,
  StyleGuide,
  FileChange,
  Level,
  ProjectChart,
  Recommendation,
  RecommendationOption,
  RunChatMessage,
  RunTrace,
  Stack,
  StackProposal,
} from "../../shared/types.ts";

/** What the AI sees about the selected bubble. */
export interface FocusContext {
  chart: ProjectChart;
  level: Level;
  bubble: Bubble;
  /** Contents of the source files relevant to this bubble / module. */
  files: FileChange[];
}

export interface WriteCodeContext {
  chart: ProjectChart;
  /** Module to write code for, or null for project scaffolding (manifest, entry point, README). */
  module: Bubble | null;
  /** Files already written in this project. */
  files: FileChange[];
}

export interface SyncContext {
  chart: ProjectChart;
  diff: string;
  files: FileChange[];
}

/** What the AI sees for design work. */
export interface DesignContext {
  chart: ProjectChart;
  style: StyleGuide | null;
  references: DesignReference[];
  /** A few reference images as data: URLs (deepseek-flash reads images). */
  referenceImages: string[];
  /** The UI's source files (pages, styles, UI bubbles' files). */
  files: FileChange[];
}

/** An existing codebase the user opened: what the AI sees to draw its chart. */
export interface ImportContext {
  /** The folder's name. */
  folder: string;
  /** Every file in the project (may be cut short for very big projects). */
  tree: string[];
  /** Contents of the most telling files (manifests, README, entry points, source), within a size budget. */
  files: FileChange[];
  /** Source files that exist but were left out of `files` for size. */
  omitted: number;
}

/** First step of drawing an existing codebase: its modules, the arrows between them, and which files each owns. */
export interface ImportedModules {
  /** One sentence on what the app does (shown as the project's idea). */
  idea: string;
  stack: Stack | null;
  /** Module bubbles (no inner charts yet) and the arrows between them. */
  root: ProjectChart["root"];
  /** Module id → the files that belong to it. */
  files: Record<string, string[]>;
  summary: string;
}

/** Second step, once per module: the module's own files, to draw its function bubbles. */
export interface ModuleContext {
  folder: string;
  /** The chart so far (modules, and the inner charts drawn already). */
  chart: ProjectChart;
  module: Bubble;
  files: FileChange[];
}

/** What the AI sees to describe the business flow: the code, and the functional chart when there is one. */
export interface BusinessContext extends ImportContext {
  chart: ProjectChart | null;
}

/** A project folder found on disk, as the AI sees it when picking matches. */
export interface FolderCandidate {
  path: string;
  name: string;
  description: string;
  markers: string[];
  modified: string;
}

export interface MockupDraft {
  title: string;
  summary: string;
  bubbleIds: string[];
  /** A new style guide, when the mockup proposes a new look. */
  style: StyleGuide | null;
  html: string;
}

/**
 * Everything the app asks the AI to do. Implemented by the DeepSeek-backed LLM AI
 * and by a canned mock used for tests and offline demos.
 */
export interface AI {
  proposeStack(idea: string): Promise<StackProposal>;
  designChart(idea: string, stack: Stack): Promise<ProjectChart["root"]>;
  writeCode(ctx: WriteCodeContext): Promise<FileChange[]>;
  /** Before changing anything, recommend how to proceed. */
  recommend(ctx: FocusContext & { request: string }): Promise<Recommendation>;
  /** Apply a chosen recommendation: returns chart ops + code changes. */
  applyChange(ctx: FocusContext & { request: string; option: RecommendationOption }): Promise<ChangeSet>;
  /** Write code for a hand-drawn (draft) bubble and wire it into the chart. */
  implementBubble(ctx: FocusContext): Promise<ChangeSet>;
  /** Read code edited outside the app and update the chart to match. */
  syncFromCode(ctx: SyncContext): Promise<ChangeSet>;
  /** Read an existing codebase and draw its module chart. Never changes code. */
  chartModules(ctx: ImportContext): Promise<ImportedModules>;
  /** Draw one module's inner chart of functions from its files. Never changes code. */
  chartModule(ctx: ModuleContext): Promise<Chart>;
  /**
   * Read the code and describe the business flow: how a user's actions travel through the program to their results
   * (where data comes in, where it's processed, which features it uses, where it comes out). Never changes code.
   */
  businessFlow(ctx: BusinessContext): Promise<Pick<BusinessFlow, "summary" | "steps" | "links">>;
  /** Pick the folders that best match what the user described. Paths must come from `candidates`. */
  pickProjects(ctx: { request: string; candidates: FolderCandidate[] }): Promise<{ path: string; reason: string }[]>;
  /** Invent abstract sample data and trace it through one chart level, explained in plain words. */
  simulateRun(chart: ProjectChart, level: Level): Promise<RunTrace>;
  /** Answer a question about a run, in plain words. */
  explainRun(ctx: { chart: ProjectChart; level: Level; trace: RunTrace; history: RunChatMessage[]; question: string }): Promise<string>;

  // ---------- design (see skills/cdd-design.md) ----------
  /** Look at a reference image and update the style guide from it. */
  readReference(ctx: { chart: ProjectChart; style: StyleGuide | null; image: string; note: string }): Promise<{ description: string; style: StyleGuide }>;
  /** Draw a mockup as one self-contained HTML page. `bubbles` are the UI bubbles in focus (may be empty = whole app). */
  mockup(ctx: DesignContext & { request: string; bubbles: Bubble[] }): Promise<MockupDraft>;
  /** Change the app's UI code to match a mockup (or just the style guide). */
  applyDesign(ctx: DesignContext & { mockup: { title: string; summary: string; html: string } | null }): Promise<ChangeSet>;
}

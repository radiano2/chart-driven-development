import type {
  Bubble,
  ChangeSet,
  DesignReference,
  StyleGuide,
  FileChange,
  Level,
  ProjectChart,
  Recommendation,
  RecommendationOption,
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
  /** Invent abstract sample data and trace it through one chart level. */
  simulateRun(chart: ProjectChart, level: Level): Promise<RunTrace>;

  // ---------- design (see skills/cdd-design.md) ----------
  /** Look at a reference image and update the style guide from it. */
  readReference(ctx: { chart: ProjectChart; style: StyleGuide | null; image: string; note: string }): Promise<{ description: string; style: StyleGuide }>;
  /** Draw a mockup as one self-contained HTML page. `bubbles` are the UI bubbles in focus (may be empty = whole app). */
  mockup(ctx: DesignContext & { request: string; bubbles: Bubble[] }): Promise<MockupDraft>;
  /** Change the app's UI code to match a mockup (or just the style guide). */
  applyDesign(ctx: DesignContext & { mockup: { title: string; summary: string; html: string } | null }): Promise<ChangeSet>;
}

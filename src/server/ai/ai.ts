import type {
  Bubble,
  ChangeSet,
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
}

// AI implementation backed by a JSON-returning LLM (DeepSeek by default).
import { getLevel, normChart, normOps, slug } from "../../shared/chart.ts";
import type {
  Chart,
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
import type { AI, FocusContext, SyncContext, WriteCodeContext } from "./ai.ts";
import type { JsonLLM } from "./deepseek.ts";

const PREAMBLE = `You are the engine of "Chart Driven Development", an app where software is built as a flowchart.
A project has a module-level chart ("root"). Each module bubble opens into an inner chart of function bubbles.
Each bubble has a description, inputs and outputs (name + data shape).
Arrows ("edges") show BOTH call order ("order", 1-based, the sequence in which the flow happens) AND the data passed ("data", a short data shape such as "Todo[]" or "{ title: string }").
Inside a module, an edge endpoint may reference a function of another module as "module-id/function-id".
Ids are lowercase kebab-case. Code is real, complete and runnable: no placeholders, no TODOs, no pseudo-code.
Respond ONLY with one JSON object matching the requested shape.`;

const CHART_SHAPE = `{
  "nodes": [ {
    "id": "kebab-id", "name": "Readable Name", "kind": "module",
    "description": "what this module is responsible for",
    "inputs": [{"name": "...", "type": "data shape"}], "outputs": [{"name": "...", "type": "data shape"}],
    "file": "path/of/main/file",
    "children": {
      "nodes": [ { "id": "kebab-id", "name": "functionName", "kind": "function", "description": "...",
                   "inputs": [...], "outputs": [...], "file": "path/to/file", "symbol": "exactFunctionName" } ],
      "edges": [ { "from": "id or other-module/id", "to": "id or other-module/id", "data": "data shape", "order": 1 } ]
    }
  } ],
  "edges": [ { "from": "module-id", "to": "module-id", "data": "data shape", "order": 1 } ]
}`;

const OPS_SHAPE = `"ops": [
  {"op": "upsertNode", "parent": "root" | "<module-id>", "node": { "id", "name", "kind", "description", "inputs", "outputs", "file", "symbol" }},
  {"op": "removeNode", "parent": "root" | "<module-id>", "id": "..."},
  {"op": "upsertEdge", "parent": "root" | "<module-id>", "edge": { "id"?, "from", "to", "data", "order" }},
  {"op": "removeEdge", "parent": "root" | "<module-id>", "id": "..."}
]
- parent "root" = the module-level chart (nodes there are modules); a module id = that module's inner chart (nodes there are functions).
- upsertNode merges into an existing node with the same id, or creates it. A new module needs a root upsertNode with kind "module"; its functions are then upsertNode ops with parent = that module id.
- Keep chart and code consistent: every function bubble you add or change must have "file" and "symbol", and that symbol must exist in the code you write.`;

const FILES_SHAPE = `"files": [ {"path": "relative/path", "content": "FULL new file content"} ]
- Always give the complete content of every file you change (never a diff or excerpt). Use "content": null to delete a file.
- Only include files you actually change.`;

function chartJson(pc: ProjectChart): string {
  return JSON.stringify({ idea: pc.idea, stack: pc.stack, root: pc.root });
}

function filesBlock(files: FileChange[], budget = 60_000): string {
  let used = 0;
  const parts: string[] = [];
  for (const f of files) {
    if (f.content == null) continue;
    let c = f.content;
    if (used + c.length > budget) c = c.slice(0, Math.max(0, budget - used)) + "\n…(truncated)";
    used += c.length;
    parts.push(`=== ${f.path} ===\n${c}`);
    if (used >= budget) break;
  }
  return parts.join("\n\n") || "(none)";
}

function normStack(raw: unknown): Stack | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    language: String(o.language ?? ""),
    runtime: String(o.runtime ?? ""),
    libraries: Array.isArray(o.libraries) ? o.libraries.map(String) : [],
    runCommand: String(o.runCommand ?? ""),
    reasoning: String(o.reasoning ?? ""),
  };
}

export function normFiles(raw: unknown): FileChange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f === "object" && typeof (f as FileChange).path === "string")
    .map((f) => {
      const o = f as Record<string, unknown>;
      return { path: String(o.path), content: o.content == null ? null : String(o.content) };
    });
}

function normChangeSet(raw: unknown): ChangeSet {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { summary: String(o.summary ?? "Updated the chart"), ops: normOps(o.ops), files: normFiles(o.files) };
}

function focusBlock(ctx: FocusContext): string {
  return `Full chart: ${chartJson(ctx.chart)}

Selected bubble (at level "${ctx.level}"): ${JSON.stringify({ ...ctx.bubble, children: undefined })}

Relevant source files:
${filesBlock(ctx.files)}`;
}

export class LlmAI implements AI {
  constructor(private llm: JsonLLM) {}

  async proposeStack(idea: string): Promise<StackProposal> {
    const raw = (await this.llm.json(
      PREAMBLE,
      `The user wants to build: "${idea}".
Help them pick a tech stack. Prefer simple, popular choices that run locally with few dependencies.
Return: { "recommended": STACK, "alternatives": [STACK, STACK] }
STACK = { "name": "short label", "language": "...", "runtime": "...", "libraries": ["..."], "runCommand": "command to start the app", "reasoning": "one or two sentences on why" }`,
    )) as Record<string, unknown>;
    const recommended = normStack(raw.recommended);
    if (!recommended) throw new Error("The AI did not propose a stack");
    const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : []).map(normStack).filter((s): s is Stack => !!s);
    return { recommended, alternatives };
  }

  async designChart(idea: string, stack: Stack): Promise<Chart> {
    const raw = await this.llm.json(
      PREAMBLE,
      `Design the architecture of: "${idea}".
Tech stack: ${JSON.stringify(stack)}
Draw it as a chart of 3 to 6 modules; give each module 2 to 6 function bubbles in its inner chart.
Each function bubble names the file and the exact symbol the code will define. Assign files so each module owns its own file(s).
Edges show the main flow of data through the app, numbered in call order.
Return exactly this shape:
${CHART_SHAPE}`,
    );
    const chart = normChart(raw, "module");
    if (!chart.nodes.length) throw new Error("The AI returned an empty chart");
    return chart;
  }

  async writeCode(ctx: WriteCodeContext): Promise<FileChange[]> {
    const target = ctx.module
      ? `Write the code for module "${ctx.module.id}". Implement EVERY function bubble of its inner chart, in the file each bubble names, using exactly the symbol each bubble names, matching its inputs and outputs. Import functions of other modules as the chart's edges and the existing files show.`
      : `Write the project scaffolding: the package manifest / build config, the entry point that wires the modules together and starts the app, and a README.md with how to install and run it (${ctx.chart.stack?.runCommand ?? ""}). Do NOT write the modules' own files yet; other calls will. Import them by the files and symbols the chart names.`;
    const raw = (await this.llm.json(
      PREAMBLE,
      `Project chart: ${chartJson(ctx.chart)}

Files already written:
${filesBlock(ctx.files, 40_000)}

${target}
Return: { ${FILES_SHAPE} }`,
      { maxTokens: 8000 },
    )) as Record<string, unknown>;
    return normFiles(raw.files);
  }

  async recommend(ctx: FocusContext & { request: string }): Promise<Recommendation> {
    const raw = (await this.llm.json(
      PREAMBLE,
      `${focusBlock(ctx)}

The user selected this bubble and asks: "${ctx.request}"
Before changing anything, recommend how to proceed. Offer 2 or 3 concrete options, such as:
- "extend": add new bubble(s) after/around the selected one
- "split": split the selected bubble into smaller bubbles
- "rewrite": rewrite the selected bubble's code in place
- "rewire": change which bubbles call which / reorder the flow
Return: { "summary": "your recommendation in 1-3 sentences", "recommendedOptionId": "...", "options": [ {"id": "kebab-id", "kind": "extend|split|rewrite|rewire", "label": "short button text", "description": "what exactly will change in the chart and the code"} ] }`,
      { maxTokens: 2000 },
    )) as Record<string, unknown>;
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .filter((o) => o && typeof o === "object")
      .map((o, i) => {
        const r = o as Record<string, unknown>;
        return {
          id: slug(String(r.id ?? `option-${i + 1}`)),
          kind: String(r.kind ?? "extend"),
          label: String(r.label ?? `Option ${i + 1}`),
          description: String(r.description ?? ""),
        };
      });
    if (!options.length) throw new Error("The AI did not return any options");
    const rec = slug(String(raw.recommendedOptionId ?? ""));
    return {
      summary: String(raw.summary ?? ""),
      recommendedOptionId: options.some((o) => o.id === rec) ? rec : options[0].id,
      options,
    };
  }

  async applyChange(ctx: FocusContext & { request: string; option: RecommendationOption }): Promise<ChangeSet> {
    const raw = await this.llm.json(
      PREAMBLE,
      `${focusBlock(ctx)}

The user asked: "${ctx.request}"
They chose this plan: ${JSON.stringify(ctx.option)}
Carry it out now: update the chart and write the code.
Return: { "summary": "one sentence on what changed", ${OPS_SHAPE},
${FILES_SHAPE} }`,
    );
    return normChangeSet(raw);
  }

  async implementBubble(ctx: FocusContext): Promise<ChangeSet> {
    const where = ctx.level === "root" ? "a new module" : `a function inside module "${ctx.level}"`;
    const raw = await this.llm.json(
      PREAMBLE,
      `${focusBlock(ctx)}

The user drew the selected bubble by hand (status "draft"); it is ${where} with no code yet.
Write its code, give it "file" and "symbol" (and inner function bubbles if it is a module), set "status": "ready",
and wire it into the flow with edges where it naturally fits (also update callers' code if they should now call it).
Return: { "summary": "one sentence on what changed", ${OPS_SHAPE},
${FILES_SHAPE} }`,
    );
    return normChangeSet(raw);
  }

  async syncFromCode(ctx: SyncContext): Promise<ChangeSet> {
    const raw = await this.llm.json(
      PREAMBLE,
      `Current chart: ${chartJson(ctx.chart)}

The code was edited outside the app. Diff since the chart was last in sync:
${ctx.diff.slice(0, 40_000)}

Current content of the changed files:
${filesBlock(ctx.files)}

Update the chart so it matches the code again (new/removed/renamed functions, changed inputs/outputs, changed flow).
Do not change any code. Return: { "summary": "one sentence on what changed in the chart", ${OPS_SHAPE} }`,
      { maxTokens: 4000 },
    );
    return { ...normChangeSet(raw), files: [] };
  }

  async simulateRun(chart: ProjectChart, level: Level): Promise<RunTrace> {
    const c = getLevel(chart, level) ?? chart.root;
    const raw = (await this.llm.json(
      PREAMBLE,
      `Chart level "${level}" of the project "${chart.idea}":
${JSON.stringify({ nodes: c.nodes.map(({ children, ...n }) => n), edges: c.edges })}

Invent a small, abstract but realistic test scenario and trace sample data through this level, following the edges in call order.
Each step is one bubble receiving data. "data" is a compact example value (max 80 chars) of what arrives at that bubble.
Return: { "scenario": "one sentence", "steps": [ {"nodeId": "id of a bubble or edge endpoint at this level", "edgeId": "id of the edge the data came along (omit for the first step)", "data": "...", "note": "what the bubble does with it"} ] }
Use 4 to 12 steps.`,
      { maxTokens: 3000 },
    )) as Record<string, unknown>;
    return normTrace(raw, c);
  }
}

export function normTrace(raw: Record<string, unknown>, c: Chart): RunTrace {
  const edgeIds = new Set(c.edges.map((e) => e.id));
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const o = s as Record<string, unknown>;
      const edgeId = o.edgeId ? String(o.edgeId) : undefined;
      return {
        nodeId: String(o.nodeId ?? ""),
        edgeId: edgeId && edgeIds.has(edgeId) ? edgeId : undefined,
        data: String(o.data ?? ""),
        note: String(o.note ?? ""),
      };
    })
    .filter((s) => s.nodeId);
  return { scenario: String(raw.scenario ?? "Sample run"), steps };
}

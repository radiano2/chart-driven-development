// AI implementation backed by a JSON-returning LLM (DeepSeek by default).
import { normBusiness } from "../../shared/business.ts";
import { getLevel, normChart, normOps, slug } from "../../shared/chart.ts";
import type {
  Bubble,
  Chart,
  StyleGuide,
  ChangeSet,
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normStyle } from "../design/style.ts";
import type { AI, BusinessContext, DesignContext, FocusContext, FolderCandidate, ImportContext, ImportedModules, MockupDraft, ModuleContext, SyncContext, WriteCodeContext } from "./ai.ts";
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
    "gui": { "route": "/", "selector": "#element-id" },  // only for bubbles that draw UI
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
- Keep chart and code consistent: every function bubble you add or change must have "file" and "symbol", and that symbol must exist in the code you write.
- A bubble that draws UI gets "gui": { "route", "selector" }; put data-bubble="<bubble-id>" on the root element it renders.`;

const FILES_SHAPE = `"files": [ {"path": "relative/path", "content": "FULL new file content"} ]
- Always give the complete content of every file you change (never a diff or excerpt). Use "content": null to delete a file.
- Only include files you actually change.`;

const DESIGN_GUIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/cdd-design.md");

/** The design guide is read on every call, so edits to skills/cdd-design.md apply right away. */
export function loadDesignGuide(): string {
  return readFileSync(DESIGN_GUIDE, "utf8");
}

const designSystem = () => `${PREAMBLE}\n\n${loadDesignGuide()}`;

function uiBubbles(pc: ProjectChart): string {
  const out: string[] = [];
  for (const m of pc.root.nodes) {
    if (m.gui) out.push(`- ${m.id} (module ${m.name}) gui=${JSON.stringify(m.gui)}: ${m.description}`);
    for (const f of m.children?.nodes ?? []) if (f.gui) out.push(`- ${f.id} (in ${m.id}, ${f.name}) gui=${JSON.stringify(f.gui)}: ${f.description}`);
  }
  return out.join("\n") || "(no bubbles are marked as UI yet)";
}

function designBlock(ctx: DesignContext): string {
  return `Project: "${ctx.chart.idea}" (stack: ${ctx.chart.stack?.name ?? "not chosen"})
UI bubbles:
${uiBubbles(ctx.chart)}

Current style guide: ${ctx.style ? JSON.stringify(ctx.style) : "(none yet: propose one)"}

Reference images the user gave${ctx.referenceImages.length ? " (the latest ones are attached)" : ""}:
${ctx.references.map((r) => `- ${r.note ? `"${r.note}": ` : ""}${r.description}`).join("\n") || "(none)"}

UI source files:
${filesBlock(ctx.files, 30_000)}`;
}

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
    ...(typeof o.appUrl === "string" && /^https?:\/\//.test(o.appUrl) ? { appUrl: o.appUrl } : {}),
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
STACK = { "name": "short label", "language": "...", "runtime": "...", "libraries": ["..."], "runCommand": "command to start the app", "appUrl": "http://localhost:<port> the app opens on (web apps only, else omit)", "reasoning": "one or two sentences on why" }`,
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
Mark every bubble that draws part of the user interface with "gui": { "route": "/path where it shows", "selector": "CSS selector of the element it draws" }.
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

  async chartModules(ctx: ImportContext): Promise<ImportedModules> {
    const tree = ctx.tree.join("\n").slice(0, 40_000);
    const raw = (await this.llm.json(
      PREAMBLE,
      `The user opened an existing project, folder "${ctx.folder}". The code was NOT written by this app. Read it and draw its module chart.
(Each module's inner chart of functions is drawn in a later step, from that module's files.)

All files in the project${ctx.tree.length >= 2000 ? " (first 2000)" : ""}:
${tree}

Contents of the most telling files${ctx.omitted ? ` (${ctx.omitted} more source files exist but aren't shown; place them in modules by their paths)` : ""}:
${filesBlock(ctx.files, 120_000)}

Draw the code AS IT IS. Do not invent features, and do not change or write any code.
- 2 to 8 modules: the real parts of the app (a folder, a layer, or a group of files that work together). Each module's "file" is its main file.
  Give each module a description, and its inputs and outputs as short data shapes.
- "files": for every module, the list of its source files (paths exactly as listed above). Every source file belongs to at most one module.
- Edges between modules: who calls whom and what data flows, numbered in call order.
- Mark modules that draw UI with "gui".
Also describe the project: "idea" is one sentence on what the app does, for the user; "stack" is the tech stack you see.
Return: { "idea": "...", "summary": "one or two sentences on how the code is organised",
"stack": { "name": "short label", "language": "...", "runtime": "...", "libraries": ["..."], "runCommand": "the command that starts it, from the manifest or README", "appUrl": "http://localhost:<port> if it's a web app and you can tell the port, else omit", "reasoning": "what you saw that tells you this" },
"modules": [ { "id": "kebab-id", "name": "Readable Name", "description": "...", "inputs": [...], "outputs": [...], "file": "main/file", "gui": {...} } ],
"edges": [ { "from": "module-id", "to": "module-id", "data": "data shape", "order": 1 } ],
"files": { "module-id": ["path", "..."] } }`,
      { maxTokens: 8_000 },
    )) as Record<string, unknown>;
    const root = normChart({ nodes: raw.modules ?? (raw.chart as Record<string, unknown> | undefined)?.nodes, edges: raw.edges ?? (raw.chart as Record<string, unknown> | undefined)?.edges }, "module");
    for (const m of root.nodes) {
      m.kind = "module";
      m.children = { nodes: [], edges: [] };
    }
    const files: Record<string, string[]> = {};
    const rawFiles = raw.files && typeof raw.files === "object" ? (raw.files as Record<string, unknown>) : {};
    for (const [id, list] of Object.entries(rawFiles)) if (Array.isArray(list)) files[slug(id)] = list.map(String).slice(0, 500);
    return {
      idea: String(raw.idea ?? "").trim().slice(0, 300),
      summary: String(raw.summary ?? "Drew the chart from the existing code.").trim().slice(0, 600),
      stack: normStack(raw.stack),
      root,
      files,
    };
  }

  async chartModule(ctx: ModuleContext): Promise<Chart> {
    const others = ctx.chart.root.nodes
      .filter((m) => m.id !== ctx.module.id)
      .map((m) => `- ${m.id} (${m.name}): ${m.description}${m.children?.nodes.length ? `; functions: ${m.children.nodes.map((f) => f.id).join(", ")}` : ""}`)
      .join("\n");
    const raw = await this.llm.json(
      PREAMBLE,
      `The user opened an existing project, folder "${ctx.folder}" (${ctx.chart.idea}). The code was NOT written by this app.
The module chart is drawn. Now draw the inner chart of module "${ctx.module.id}" (${ctx.module.name}): ${ctx.module.description}

Other modules:
${others || "(none)"}

The module's files:
${filesBlock(ctx.files, 70_000)}

Draw the code AS IT IS. Do not invent anything, and do not change or write any code.
- 2 to 8 function bubbles for the module's most important functions, classes or components, each with the "file" it is in and the exact "symbol" as written in the code. Only use the files shown and symbols you actually saw.
- Inputs and outputs: the real parameters and return values, as short data shapes.
- Edges: who calls whom inside the module, and what data flows, numbered in call order. A call to or from another module's function is an edge with "other-module-id/function-id" as that end.
- Mark bubbles that draw UI with "gui".
Return: { "nodes": [ { "id", "name", "kind": "function", "description", "inputs", "outputs", "file", "symbol" } ], "edges": [ { "from", "to", "data", "order" } ] }`,
      { maxTokens: 6_000 },
    );
    const chart = normChart(raw, "function");
    for (const f of chart.nodes) {
      f.kind = "function";
      delete f.children;
    }
    return chart;
  }

  async businessFlow(ctx: BusinessContext) {
    const chart = ctx.chart?.root.nodes.length
      ? `\n\nThe functional chart already drawn (modules and their functions):\n${JSON.stringify(ctx.chart.root.nodes.map((m) => ({ id: m.id, name: m.name, description: m.description, functions: m.children?.nodes.map((f) => f.name) })))}`
      : "";
    const raw = await this.llm.json(
      `You describe software to people who don't code. You read a program's code and draw its BUSINESS FLOW: what a user does with it, and what each action leads to inside the program.`,
      `Project folder "${ctx.folder}".${chart}

All files${ctx.tree.length >= 2000 ? " (first 2000)" : ""}:
${ctx.tree.join("\n").slice(0, 30_000)}

Contents of the most telling files${ctx.omitted ? ` (${ctx.omitted} more source files exist but aren't shown)` : ""}:
${filesBlock(ctx.files, 110_000)}

Draw the business flow of this program AS THE CODE SHOWS IT: the path a user's actions take through the program.
Show where data comes in (what the user does or enters, or what arrives from outside), where it goes, where it is processed,
which features of the program are used, and where results come out (what the user sees, what gets saved, sent or printed).
So the reader understands which action of one user leads to which consequences in the program.
- 5 to 14 steps. "kind": "action" (the user does something or data comes in), "process" (the program works on it),
  "decision" (the flow branches; label each outgoing link with the branch, e.g. "yes" / "no" / "card declined"), "output" (a result leaves the program).
- Every step: plain everyday words, no code names in "name" or "description". "actor": who or what does it ("User", "App", "Server", "Payment provider").
  "feature": the feature of the program used there. "dataIn" / "dataOut": what comes in and goes out, in plain words.
  "code": the files (paths exactly as listed) and module ids where it happens.
- Links: from step to step in the order things happen ("order", 1-based); "label" says what passes along, in plain words.
- If the program has several separate user journeys, draw the main ones side by side, each starting with an action.
Do not invent features the code doesn't have. Do not change or write code.
Return: { "summary": "one or two sentences: what the program does for its users", "steps": [ { "id": "kebab-id", "name": "...", "kind": "action", "actor": "...", "description": "...", "feature": "...", "dataIn": "...", "dataOut": "...", "code": ["..."] } ],
"links": [ { "from": "step-id", "to": "step-id", "label": "...", "order": 1 } ] }`,
      { maxTokens: 8_000 },
    );
    return normBusiness(raw);
  }

  async pickProjects(ctx: { request: string; candidates: FolderCandidate[] }): Promise<{ path: string; reason: string }[]> {
    const list = ctx.candidates
      .map((c) => `- ${c.path} | ${c.markers.join(",")} | changed ${c.modified.slice(0, 10) || "?"}${c.description ? ` | ${c.description}` : ""}`)
      .join("\n");
    const raw = (await this.llm.json(
      "You help someone find a project folder on their computer. Respond ONLY with one JSON object.",
      `They are looking for: "${ctx.request}"

Project folders found (path | marker files | last changed | description):
${list}

Pick the folders that best match, best first (at most 5). Only use paths exactly as listed. If nothing plausibly matches, return an empty list.
Return: { "matches": [ { "path": "exact path from the list", "reason": "one short sentence on why it matches" } ] }`,
      { maxTokens: 1500 },
    )) as Record<string, unknown>;
    return (Array.isArray(raw.matches) ? raw.matches : [])
      .filter((m) => m && typeof m === "object" && typeof (m as { path?: unknown }).path === "string")
      .map((m) => ({ path: String((m as { path: string }).path).trim(), reason: String((m as { reason?: unknown }).reason ?? "").trim().slice(0, 300) }));
  }

  async simulateRun(chart: ProjectChart, level: Level): Promise<RunTrace> {
    const c = getLevel(chart, level) ?? chart.root;
    const raw = (await this.llm.json(
      PREAMBLE,
      `Chart level "${level}" of the project "${chart.idea}":
${JSON.stringify({ nodes: c.nodes.map(({ children, ...n }) => n), edges: c.edges })}

Invent a small, abstract but realistic test scenario and trace sample data through this level, following the edges in call order.
Each step is one bubble receiving data. "data" is a compact example value (max 80 chars) of what arrives at that bubble.
The user watches the data move through the chart while a chat explains it, step by step, to someone who doesn't code.
Write "intro", each step's "explain" and "summary" for that person: plain everyday words, no jargon (say "the list of todos", not "Todo[]";
"saves it to a file", not "persists to storage"), short friendly sentences, and say WHY each step happens, not only what.
Return: { "scenario": "one sentence", "intro": "2 or 3 sentences: what this part of the app does and what we're about to follow",
"steps": [ {"nodeId": "id of a bubble or edge endpoint at this level", "edgeId": "id of the edge the data came along (omit for the first step)", "data": "...", "note": "what the bubble does with it, technical, one line", "explain": "1 or 2 plain sentences"} ],
"summary": "1 or 2 sentences: what happened overall" }
Use 4 to 12 steps.`,
      { maxTokens: 5000 },
    )) as Record<string, unknown>;
    return normTrace(raw, c);
  }

  async explainRun(ctx: { chart: ProjectChart; level: Level; trace: RunTrace; history: RunChatMessage[]; question: string }): Promise<string> {
    const c = getLevel(ctx.chart, ctx.level) ?? ctx.chart.root;
    const raw = (await this.llm.json(
      `${PREAMBLE}\nYou are explaining a test run of the app to someone who doesn't code. Use plain everyday words, no jargon, short friendly sentences.`,
      `Project: "${ctx.chart.idea}". Chart level "${ctx.level}":
${JSON.stringify({ nodes: c.nodes.map(({ children, ...n }) => ({ ...n, inner: children?.nodes.map((f) => f.name) })), edges: c.edges })}

The run they watched: ${JSON.stringify(ctx.trace)}

Conversation so far:
${ctx.history.map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.text}`).join("\n") || "(none)"}

Their question: "${ctx.question}"
Answer it in 1 to 4 short sentences, based on the chart and the run. If the chart doesn't tell, say so honestly.
Return: { "answer": "..." }`,
      { maxTokens: 1500 },
    )) as Record<string, unknown>;
    const answer = String(raw.answer ?? "").trim();
    if (!answer) throw new Error("The AI didn't answer. Try asking again.");
    return answer.slice(0, 3000);
  }

  async readReference(ctx: { chart: ProjectChart; style: StyleGuide | null; image: string; note: string }) {
    const raw = (await this.llm.json(
      designSystem(),
      `Project: "${ctx.chart.idea}"
Current style guide: ${ctx.style ? JSON.stringify(ctx.style) : "(none yet)"}
The user attached a reference image${ctx.note ? ` with this note: "${ctx.note}"` : " without a note"}.
Describe the visual style you see (palette with hex values, type, density, corners, shadows, layout pattern) and
update the style guide from it, following the design guide.
Return: { "description": "2 or 3 sentences describing the reference's style", "style": { the full style guide, in the shape the design guide gives } }`,
      { maxTokens: 2500, images: [ctx.image] },
    )) as Record<string, unknown>;
    const style = normStyle(raw.style);
    if (!style) throw new Error("The AI did not return a style guide for this image");
    return { description: String(raw.description ?? "").trim().slice(0, 1000), style };
  }

  async mockup(ctx: DesignContext & { request: string; bubbles: Bubble[] }): Promise<MockupDraft> {
    const focus = ctx.bubbles.length
      ? `Focus on these bubbles (show them in context of the screen they live on): ${ctx.bubbles.map((b) => `${b.id} (${b.name})`).join(", ")}`
      : "Show the app's main screen.";
    const raw = await this.llm.json(
      designSystem(),
      `${designBlock(ctx)}

The user asks for a mockup: "${ctx.request}"
${focus}
Follow the design guide's mockup HTML rules and answer format exactly.`,
      { maxTokens: 12_000, images: ctx.referenceImages },
    );
    return normMockup(raw, allBubbleIds(ctx.chart));
  }

  async applyDesign(ctx: DesignContext & { mockup: { title: string; summary: string; html: string } | null }): Promise<ChangeSet> {
    const target = ctx.mockup
      ? `Apply the mockup "${ctx.mockup.title}" (${ctx.mockup.summary}) to the app. Its HTML:\n${ctx.mockup.html.slice(0, 30_000)}`
      : "Apply the current style guide to the app's UI.";
    const raw = await this.llm.json(
      designSystem(),
      `${designBlock(ctx)}

Full chart: ${chartJson(ctx.chart)}

${target}
Follow "Applying a mockup or style to the code" in the design guide.
Return: { "summary": "one sentence on what changed", ${OPS_SHAPE},
${FILES_SHAPE} }`,
    );
    return normChangeSet(raw);
  }
}


export function normMockup(raw: unknown, known: Set<string>): MockupDraft {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const html = String(o.html ?? "").trim();
  if (!/<(html|body|div|main|section)\b/i.test(html)) throw new Error("The AI did not return mockup HTML");
  return {
    title: String(o.title ?? "Mockup").trim().slice(0, 80) || "Mockup",
    summary: String(o.summary ?? "").trim().slice(0, 800),
    bubbleIds: (Array.isArray(o.bubbleIds) ? o.bubbleIds : []).map((x) => slug(String(x))).filter((x) => known.has(x)),
    style: normStyle(o.style),
    html,
  };
}

export function allBubbleIds(pc: ProjectChart): Set<string> {
  const ids = new Set<string>();
  for (const m of pc.root.nodes) {
    ids.add(m.id);
    for (const f of m.children?.nodes ?? []) ids.add(f.id);
  }
  return ids;
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
        ...(o.explain ? { explain: String(o.explain).slice(0, 600) } : {}),
      };
    })
    .filter((s) => s.nodeId);
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 800) : undefined);
  const intro = text(raw.intro);
  const summary = text(raw.summary);
  return { scenario: String(raw.scenario ?? "Sample run"), ...(intro ? { intro } : {}), steps, ...(summary ? { summary } : {}) };
}

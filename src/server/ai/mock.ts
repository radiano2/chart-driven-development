// Offline AI for tests and demos without an API key (CDD_AI=mock).
// Always designs the same todo app; extensions add simple pass-through functions.
import { getLevel, slug } from "../../shared/chart.ts";
import type { Bubble, ChangeSet, ChartOp, FileChange, Level, ProjectChart, Recommendation, RunTrace } from "../../shared/types.ts";
import type { AI, FocusContext, SyncContext, WriteCodeContext } from "./ai.ts";
import { TODO_ALTERNATIVES, TODO_CHART, TODO_MODULE_FILES, TODO_SCAFFOLD, TODO_STACK } from "./mock-todo.ts";

const clone = <T>(v: T): T => structuredClone(v);

function camel(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).slice(0, 4);
  const out = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[a-z]/.test(out) ? out : `step${out}`;
}

function fileOf(ctx: FocusContext): string {
  if (ctx.bubble.file?.endsWith(".js")) return ctx.bubble.file;
  const moduleId = ctx.level === "root" ? ctx.bubble.id : ctx.level;
  const mod = ctx.chart.root.nodes.find((n) => n.id === moduleId);
  if (mod?.file?.endsWith(".js")) return mod.file;
  return `src/${moduleId}.js`;
}

function appendFunction(ctx: FocusContext, path: string, symbol: string, doc: string, params: string[]): FileChange {
  const existing = ctx.files.find((f) => f.path === path)?.content ?? "";
  const args = params.length ? params.join(", ") : "input";
  const fn = `\n/** ${doc.replace(/\*\//g, "")} */\nexport function ${symbol}(${args}) {\n  return ${params.length ? params[0] : "input"};\n}\n`;
  return { path, content: existing.replace(/\s*$/, "\n") + fn };
}

const sample = (shape: string): string => {
  if (/todo\[\]/i.test(shape)) return '[{"id":1,"title":"Buy milk","done":false}]';
  if (/title/i.test(shape)) return '{"title":"Buy milk"}';
  if (/method/i.test(shape)) return '{"method":"POST","path":"/api/todos","body":{"title":"Buy milk"}}';
  if (/path|file/i.test(shape)) return '"todos.json"';
  if (/id/i.test(shape)) return "1";
  return `<${shape || "data"}>`;
};

export class MockAI implements AI {
  async proposeStack() {
    return { recommended: clone(TODO_STACK), alternatives: clone(TODO_ALTERNATIVES) };
  }

  async designChart() {
    return clone(TODO_CHART);
  }

  async writeCode(ctx: WriteCodeContext): Promise<FileChange[]> {
    if (!ctx.module) return clone(TODO_SCAFFOLD);
    return clone(TODO_MODULE_FILES[ctx.module.id] ?? []);
  }

  async recommend(ctx: FocusContext & { request: string }): Promise<Recommendation> {
    const name = ctx.bubble.name;
    const options = [
      { id: "extend", kind: "extend", label: `Add a step after ${name}`, description: `Add a new bubble "${camel(ctx.request)}" that receives ${name}'s output, and write its code.` },
      { id: "rewrite", kind: "rewrite", label: `Rewrite ${name}`, description: `Change ${name} in place so it also handles: ${ctx.request}.` },
    ];
    return { summary: `I'd keep ${name} focused and add a separate step for "${ctx.request}".`, recommendedOptionId: "extend", options };
  }

  async applyChange(ctx: FocusContext & { request: string; option: { kind: string } }): Promise<ChangeSet> {
    const b = ctx.bubble;
    if (ctx.option.kind === "rewrite") {
      return {
        summary: `Updated ${b.name} to also handle "${ctx.request}".`,
        ops: [{ op: "upsertNode", parent: ctx.level, node: { id: b.id, description: `${b.description} Also: ${ctx.request}.` } }],
        files: [],
      };
    }
    const symbol = camel(ctx.request);
    const id = slug(symbol);
    const path = fileOf(ctx);
    // Selecting a module extends its inner chart; selecting a function extends its own level.
    const parent: Level = ctx.level === "root" ? b.id : ctx.level;
    const inputType = b.outputs[0]?.type ?? "data";
    const ops: ChartOp[] = [
      {
        op: "upsertNode",
        parent,
        node: { id, name: symbol, kind: "function", status: "ready", description: ctx.request, inputs: [{ name: "input", type: inputType }], outputs: [{ name: "result", type: inputType }], file: path, symbol },
      },
    ];
    if (ctx.level !== "root") {
      const level = getLevel(ctx.chart, ctx.level);
      const order = Math.max(0, ...(level?.edges.map((e) => e.order) ?? [])) + 1;
      ops.push({ op: "upsertEdge", parent, edge: { from: b.id, to: id, data: inputType, order } });
    }
    return { summary: `Added ${symbol} after ${b.name}.`, ops, files: [appendFunction(ctx, path, symbol, ctx.request, ["input"])] };
  }

  async implementBubble(ctx: FocusContext): Promise<ChangeSet> {
    const b = ctx.bubble;
    const symbol = camel(b.name);
    const params = b.inputs.map((p) => camel(p.name));
    if (ctx.level === "root") {
      const path = `src/${b.id}.js`;
      const fnId = slug(symbol);
      return {
        summary: `Wrote module ${b.name} in ${path}.`,
        ops: [
          { op: "upsertNode", parent: "root", node: { id: b.id, status: "ready", file: path } },
          { op: "upsertNode", parent: b.id, node: { id: fnId, name: symbol, kind: "function", status: "ready", description: b.description, inputs: b.inputs, outputs: b.outputs, file: path, symbol } },
        ],
        files: [appendFunction({ ...ctx, files: [] }, path, symbol, b.description, params)],
      };
    }
    const path = fileOf(ctx);
    return {
      summary: `Wrote ${symbol} in ${path}.`,
      ops: [{ op: "upsertNode", parent: ctx.level, node: { id: b.id, status: "ready", file: path, symbol } }],
      files: [appendFunction(ctx, path, symbol, b.description, params)],
    };
  }

  async syncFromCode(ctx: SyncContext): Promise<ChangeSet> {
    const ops: ChartOp[] = [];
    for (const f of ctx.files) {
      if (!f.path.endsWith(".js")) continue;
      const mod = ctx.chart.root.nodes.find((m) => m.file === f.path || m.children?.nodes.some((n) => n.file === f.path));
      if (!mod) continue;
      const symbols = new Set([...(f.content ?? "").matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]));
      const inner = mod.children?.nodes.filter((n) => n.file === f.path) ?? [];
      for (const n of inner) if (n.symbol && !symbols.has(n.symbol)) ops.push({ op: "removeNode", parent: mod.id, id: n.id });
      for (const s of symbols) {
        if (inner.some((n) => n.symbol === s)) continue;
        ops.push({ op: "upsertNode", parent: mod.id, node: { id: slug(s), name: s, kind: "function", status: "ready", description: `Found in ${f.path}.`, inputs: [], outputs: [], file: f.path, symbol: s } });
      }
    }
    return { summary: ops.length ? `Updated ${ops.length} bubble(s) from the code.` : "The chart already matches the code.", ops, files: [] };
  }

  async simulateRun(chart: ProjectChart, level: Level): Promise<RunTrace> {
    const c = getLevel(chart, level) ?? chart.root;
    const edges = [...c.edges].sort((a, b) => a.order - b.order);
    const steps: RunTrace["steps"] = [];
    const first: Bubble | undefined = c.nodes.find((n) => n.id === edges[0]?.from) ?? c.nodes[0];
    if (first) steps.push({ nodeId: first.id, data: sample(edges[0]?.data ?? first.inputs[0]?.type ?? ""), note: `${first.name} starts the flow.` });
    for (const e of edges) steps.push({ nodeId: e.to, edgeId: e.id, data: sample(e.data), note: `Receives ${e.data || "data"}.` });
    return { scenario: 'A user adds "Buy milk" to an empty list.', steps };
  }
}

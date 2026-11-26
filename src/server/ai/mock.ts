// Offline AI for tests and demos without an API key (CDD_AI=mock).
// Always designs the same todo app; extensions add simple pass-through functions.
import { getLevel, slug } from "../../shared/chart.ts";
import type { Bubble, ChangeSet, ChartOp, FileChange, Level, ProjectChart, Recommendation, RunTrace } from "../../shared/types.ts";
import type { StyleGuide } from "../../shared/types.ts";
import { styleCss } from "../design/style.ts";
import type { AI, DesignContext, FocusContext, MockupDraft, SyncContext, WriteCodeContext } from "./ai.ts";
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

  // ---------- design ----------

  async readReference(ctx: { note: string }) {
    const style = mockStyle(/dark|night/i.test(ctx.note) ? "dark" : "light");
    return { description: `(Mock AI, no image was read.) A ${style.mood.join(", ")} look with a ${style.colors.find((c) => c.name === "accent")?.value} accent.`, style };
  }

  async mockup(ctx: DesignContext & { request: string }): Promise<MockupDraft> {
    const wantsNew = !ctx.style || /dark|light|new look|theme|colou?r/i.test(ctx.request);
    const style = wantsNew ? mockStyle(/dark|night/i.test(ctx.request) ? "dark" : "light") : ctx.style!;
    return {
      title: wantsNew ? `${style.mood[0][0].toUpperCase()}${style.mood[0].slice(1)} todo list` : "Todo list in the current style",
      summary: `(Mock AI) The todo screen in the ${style.mood.join(", ")} style, for: ${ctx.request}.`,
      bubbleIds: ["web-ui", "render-todos", "on-submit"],
      style: wantsNew ? style : null,
      html: mockHtml(style),
    };
  }

  async applyDesign(ctx: DesignContext): Promise<ChangeSet> {
    const style = ctx.style ?? mockStyle("light");
    const page = ctx.files.find((f) => f.path === "public/index.html");
    if (!page?.content) return { summary: "(Mock AI) No page to restyle.", ops: [], files: [] };
    const css = `${styleCss(style)}
    body { background: var(--background); color: var(--text); font-family: ${style.fonts[0]?.family ?? "system-ui, sans-serif"}; }
    button { background: var(--accent); color: var(--surface); border: 0; border-radius: ${style.radius}; }`;
    const content = page.content.replace(/<style>[\s\S]*?<\/style>/, (block) => (block.includes("/* cdd-style */") ? block.replace(/\/\* cdd-style \*\/[\s\S]*?\/\* end cdd-style \*\//, `/* cdd-style */\n${css}\n    /* end cdd-style */`) : block.replace("</style>", `    /* cdd-style */\n${css}\n    /* end cdd-style */\n  </style>`)));
    return { summary: `(Mock AI) Applied the ${style.mood.join(", ")} style to the page.`, ops: [], files: [{ path: page.path, content }] };
  }
}

export function mockStyle(kind: "light" | "dark"): StyleGuide {
  const dark = kind === "dark";
  return {
    summary: dark ? "A calm dark theme with a teal accent and generous spacing." : "A bright, friendly look with soft cards and a violet accent.",
    colors: dark
      ? [
          { name: "background", value: "#14161c", use: "page" },
          { name: "surface", value: "#1e2129", use: "cards" },
          { name: "text", value: "#e8eaf0" },
          { name: "muted", value: "#9097a6" },
          { name: "accent", value: "#2ec4b6", use: "primary actions" },
          { name: "border", value: "#2b2f3a" },
        ]
      : [
          { name: "background", value: "#f6f5fb", use: "page" },
          { name: "surface", value: "#ffffff", use: "cards" },
          { name: "text", value: "#1d1b2c" },
          { name: "muted", value: "#6b6880" },
          { name: "accent", value: "#6d5dfc", use: "primary actions" },
          { name: "border", value: "#e4e2ee" },
        ],
    fonts: [
      { role: "body", family: "system-ui, -apple-system, Segoe UI, sans-serif" },
      { role: "heading", family: "system-ui, -apple-system, Segoe UI, sans-serif" },
    ],
    radius: "12px",
    spacing: "8px grid; 16px inside cards",
    mood: dark ? ["calm", "dark"] : ["friendly", "light"],
    rules: ["One primary action per screen, in the accent color.", "Done todos fade to the muted color."],
  };
}

function mockHtml(s: StyleGuide): string {
  const todos = [
    ["Buy milk", false],
    ["Call the dentist", true],
    ["Book train tickets", false],
  ] as const;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${styleCss(s)}
body { margin: 0; background: var(--background); color: var(--text); font-family: ${s.fonts[0]?.family}; }
main { max-width: 560px; margin: 64px auto; background: var(--surface); border: 1px solid var(--border); border-radius: ${s.radius}; padding: 32px; }
h1 { margin: 0 0 24px; font-size: 28px; }
form { display: flex; gap: 8px; margin-bottom: 16px; }
input { flex: 1; padding: 12px; border: 1px solid var(--border); border-radius: ${s.radius}; background: var(--background); color: var(--text); font-size: 16px; }
button { padding: 12px 18px; background: var(--accent); color: #fff; border: 0; border-radius: ${s.radius}; font-size: 16px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border); }
li.done span { color: var(--muted); text-decoration: line-through; }
.box { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--accent); }
li.done .box { background: var(--accent); }
</style></head><body>
<main data-bubble="web-ui">
  <h1>Todos</h1>
  <form data-bubble="on-submit"><input placeholder="What needs doing?"><button>Add</button></form>
  <ul data-bubble="render-todos">
${todos.map(([t, d]) => `    <li${d ? ' class="done"' : ""}><span class="box"></span><span>${t}</span></li>`).join("\n")}
  </ul>
</main>
</body></html>`;
}

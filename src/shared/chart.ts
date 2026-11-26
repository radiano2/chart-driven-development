// Pure chart helpers used by both server and client.
import type { Bubble, Chart, ChartOp, Edge, Level, Port, ProjectChart } from "./types.ts";

export function slug(s: string): string {
  const out = String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "node";
}

export function emptyChart(): Chart {
  return { nodes: [], edges: [] };
}

export function getLevel(pc: ProjectChart, level: Level): Chart | null {
  if (level === "root") return pc.root;
  const mod = pc.root.nodes.find((n) => n.id === level && n.kind === "module");
  if (!mod) return null;
  if (!mod.children) mod.children = emptyChart();
  return mod.children;
}

export function findBubble(pc: ProjectChart, level: Level, id: string): Bubble | undefined {
  return getLevel(pc, level)?.nodes.find((n) => n.id === id);
}

function normPorts(v: unknown): Port[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((p): Port | null => {
      if (typeof p === "string") {
        const [name, ...rest] = p.split(":");
        return { name: name.trim(), type: rest.join(":").trim() || "any" };
      }
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const name = String(o.name ?? "").trim();
        if (!name) return null;
        return { name, type: String(o.type ?? o.shape ?? "any").trim() || "any" };
      }
      return null;
    })
    .filter((p): p is Port => p !== null);
}

export function normBubble(raw: unknown, defaultKind: Bubble["kind"]): Bubble | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? o.id ?? "").trim();
  if (!name) return null;
  const kind = o.kind === "module" || o.kind === "function" ? o.kind : defaultKind;
  const b: Bubble = {
    id: slug(String(o.id ?? name)),
    name,
    kind,
    description: String(o.description ?? "").trim(),
    inputs: normPorts(o.inputs),
    outputs: normPorts(o.outputs),
    status: o.status === "draft" ? "draft" : "ready",
  };
  if (typeof o.file === "string" && o.file.trim()) b.file = o.file.trim();
  if (typeof o.symbol === "string" && o.symbol.trim()) b.symbol = o.symbol.trim();
  if (kind === "module") b.children = normChart(o.children, "function");
  return b;
}

export function normEdge(raw: unknown, idx: number): Edge | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const from = String(o.from ?? "").trim();
  const to = String(o.to ?? "").trim();
  if (!from || !to) return null;
  const order = Number(o.order);
  return {
    id: String(o.id ?? "").trim() || `${slug(from)}--${slug(to)}`,
    from: slugRef(from),
    to: slugRef(to),
    data: String(o.data ?? o.label ?? "").trim(),
    order: Number.isFinite(order) && order > 0 ? Math.round(order) : idx + 1,
  };
}

/** Node references may be "id" or "module/id"; slug each part. */
function slugRef(ref: string): string {
  return ref.split("/").map(slug).join("/");
}

export function normChart(raw: unknown, defaultKind: Bubble["kind"]): Chart {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nodes: Bubble[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(o.nodes) ? o.nodes : []) {
    const b = normBubble(r, defaultKind);
    if (b && !seen.has(b.id)) {
      seen.add(b.id);
      nodes.push(b);
    }
  }
  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  (Array.isArray(o.edges) ? o.edges : []).forEach((r, i) => {
    const e = normEdge(r, i);
    if (!e) return;
    while (edgeIds.has(e.id)) e.id += "-2";
    edgeIds.add(e.id);
    edges.push(e);
  });
  return { nodes, edges };
}

/** Apply chart operations in place. Returns human-readable warnings for ops that were skipped. */
export function applyOps(pc: ProjectChart, ops: ChartOp[]): string[] {
  const warnings: string[] = [];
  for (const op of ops) {
    const parent = op.parent && op.parent !== "root" ? slug(op.parent) : "root";
    const chart = getLevel(pc, parent);
    if (!chart) {
      warnings.push(`Unknown module "${op.parent}" in ${op.op}`);
      continue;
    }
    const defaultKind = parent === "root" ? "module" : "function";
    switch (op.op) {
      case "upsertNode": {
        const id = slug(op.node.id || op.node.name || "");
        const existing = chart.nodes.find((n) => n.id === id);
        if (existing) {
          const merged = normBubble({ ...existing, ...op.node, id, children: op.node.children ?? existing.children }, existing.kind);
          if (merged) Object.assign(existing, merged);
        } else {
          const b = normBubble({ ...op.node, id }, defaultKind);
          if (b) chart.nodes.push(b);
          else warnings.push(`Invalid node ${id}`);
        }
        break;
      }
      case "removeNode": {
        const id = slug(op.id);
        chart.nodes = chart.nodes.filter((n) => n.id !== id);
        chart.edges = chart.edges.filter((e) => e.from !== id && e.to !== id);
        break;
      }
      case "upsertEdge": {
        const e = normEdge(op.edge, chart.edges.length);
        if (!e) {
          warnings.push("Invalid edge");
          break;
        }
        const existing = chart.edges.find((x) => x.id === e.id || (x.from === e.from && x.to === e.to));
        if (existing) Object.assign(existing, { ...e, id: existing.id });
        else chart.edges.push(e);
        break;
      }
      case "removeEdge": {
        chart.edges = chart.edges.filter((e) => e.id !== op.id);
        break;
      }
      default:
        warnings.push(`Unknown op ${(op as { op: string }).op}`);
    }
  }
  return warnings;
}

export function normOps(raw: unknown): ChartOp[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const parent = typeof o.parent === "string" && o.parent ? o.parent : "root";
    if (o.op === "upsertNode" && o.node && typeof o.node === "object") {
      const node = o.node as Record<string, unknown>;
      const id = String(node.id ?? node.name ?? "");
      if (id) out.push({ op: "upsertNode", parent, node: { ...(node as object), id } as never });
    } else if (o.op === "removeNode" && typeof o.id === "string") {
      out.push({ op: "removeNode", parent, id: o.id });
    } else if (o.op === "upsertEdge" && o.edge && typeof o.edge === "object") {
      const edge = o.edge as Record<string, unknown>;
      if (edge.from && edge.to) out.push({ op: "upsertEdge", parent, edge: edge as never });
    } else if (o.op === "removeEdge" && typeof o.id === "string") {
      out.push({ op: "removeEdge", parent, id: o.id });
    }
  }
  return out;
}

/** All source files referenced by a level (or the whole chart). */
export function filesOf(pc: ProjectChart, level?: Level): string[] {
  const files = new Set<string>();
  const visit = (c: Chart) => {
    for (const n of c.nodes) {
      if (n.file) files.add(n.file);
      if (n.children) visit(n.children);
    }
  };
  if (!level) visit(pc.root);
  else {
    const mod = level === "root" ? null : pc.root.nodes.find((n) => n.id === level);
    if (mod?.file) files.add(mod.file);
    const c = getLevel(pc, level);
    if (c) visit(c);
  }
  return [...files];
}

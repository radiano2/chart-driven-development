// The business flow: how the program is used, end to end. Pure helpers shared by the server and the browser.
import { slug } from "./chart.ts";
import type { Bubble, BusinessFlow, BusinessLink, BusinessStep, BusinessStepKind, Chart, ProjectChart } from "./types.ts";

/** The level name runs use for the business flow. Chart ids are kebab-case, so it can't clash with a module. */
export const BUSINESS_LEVEL = "@business";

const KINDS: BusinessStepKind[] = ["action", "process", "decision", "output"];

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Clean up what the AI returned: known kinds, unique ids, arrows only between real steps. */
export function normBusiness(raw: unknown): Pick<BusinessFlow, "summary" | "steps" | "links"> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const steps: BusinessStep[] = [];
  const ids = new Set<string>();
  const rename = new Map<string, string>();
  for (const r of Array.isArray(o.steps) ? o.steps.slice(0, 30) : []) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const name = text(s.name ?? s.id, 80);
    if (!name) continue;
    let id = slug(String(s.id ?? name));
    const original = id;
    for (let i = 2; ids.has(id); i++) id = `${original}-${i}`;
    ids.add(id);
    if (!rename.has(original)) rename.set(original, id);
    const kind = KINDS.includes(s.kind as BusinessStepKind) ? (s.kind as BusinessStepKind) : "process";
    steps.push({
      id,
      name,
      kind,
      actor: text(s.actor, 40) || (kind === "action" ? "User" : "App"),
      description: text(s.description, 600),
      feature: text(s.feature, 120),
      dataIn: text(s.dataIn ?? s.in, 200),
      dataOut: text(s.dataOut ?? s.out, 200),
      code: (Array.isArray(s.code) ? s.code : []).map((c) => text(c, 200)).filter(Boolean).slice(0, 8),
    });
  }
  const links: BusinessLink[] = [];
  const linkIds = new Set<string>();
  (Array.isArray(o.links) ? o.links : Array.isArray(o.edges) ? o.edges : []).slice(0, 60).forEach((r: unknown, i: number) => {
    if (!r || typeof r !== "object") return;
    const l = r as Record<string, unknown>;
    const from = rename.get(slug(String(l.from ?? "")));
    const to = rename.get(slug(String(l.to ?? "")));
    if (!from || !to || from === to) return;
    let id = `${from}--${to}`;
    while (linkIds.has(id)) id += "-2";
    linkIds.add(id);
    const order = Number(l.order);
    links.push({ id, from, to, label: text(l.label ?? l.data, 80), order: Number.isFinite(order) && order > 0 ? Math.round(order) : i + 1 });
  });
  return { summary: text(o.summary, 600), steps, links };
}

/** The business flow as a chart the board can draw (and a run can follow). Steps become function-like bubbles. */
export function businessChart(flow: BusinessFlow): Chart {
  const nodes: Bubble[] = flow.steps.map((s) => ({
    id: s.id,
    name: s.name,
    kind: "function",
    description: s.description,
    inputs: s.dataIn ? [{ name: "in", type: s.dataIn }] : [],
    outputs: s.dataOut ? [{ name: "out", type: s.dataOut }] : [],
    status: "ready",
  }));
  return { nodes, edges: flow.links.map((l) => ({ id: l.id, from: l.from, to: l.to, data: l.label, order: l.order })) };
}

/** A stand-in project chart whose only level is the business flow, for the run and its questions. */
export function businessAsProject(pc: ProjectChart, flow: BusinessFlow): ProjectChart {
  const steps = new Map(flow.steps.map((s) => [s.id, s]));
  const root = businessChart(flow);
  // The run's AI sees who does each step and which feature it uses.
  for (const n of root.nodes) {
    const s = steps.get(n.id)!;
    n.description = `[${s.kind}, by ${s.actor}${s.feature ? `, feature: ${s.feature}` : ""}] ${s.description}`;
  }
  return { version: 1, name: pc.name, idea: `${pc.idea} — business flow (how a user's actions lead to results): ${flow.summary}`, stack: pc.stack, root };
}

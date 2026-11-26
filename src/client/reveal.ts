// Drawing a chart "live": the AI hands back many bubbles at once, but the board shows them one at a time, in a
// natural order, so it looks like the chart is being drawn in front of you. This file is the pure part (what
// comes next, and what is visible so far); main.ts paces it and opens each module as its insides are drawn.
import type { Chart, Level, ProjectChart } from "../shared/types.ts";

export interface RevealStep {
  level: Level;
  kind: "node" | "edge";
  id: string;
  key: string;
}

export const revealKey = (level: Level, kind: "node" | "edge", id: string) => `${level}\n${kind}\n${id}`;

/**
 * Everything in the chart, in the order it should appear: first the modules, each arrow right after both of
 * its ends are on the board, then each module's functions and arrows the same way, module by module.
 */
export function revealOrder(pc: ProjectChart): RevealStep[] {
  const out: RevealStep[] = [];
  const level = (lv: Level, c: Chart) => {
    const local = new Set(c.nodes.map((n) => n.id));
    const seen = new Set<string>();
    const edges = [...c.edges].sort((a, b) => a.order - b.order);
    const done = new Set<string>();
    // An end that isn't a bubble of this level (another module's function) is drawn as a ghost: always there.
    const ready = (end: string) => !local.has(end) || seen.has(end);
    const flush = () => {
      for (const e of edges) {
        if (done.has(e.id) || !ready(e.from) || !ready(e.to)) continue;
        done.add(e.id);
        out.push({ level: lv, kind: "edge", id: e.id, key: revealKey(lv, "edge", e.id) });
      }
    };
    for (const n of c.nodes) {
      seen.add(n.id);
      out.push({ level: lv, kind: "node", id: n.id, key: revealKey(lv, "node", n.id) });
      flush();
    }
    flush();
  };
  level("root", pc.root);
  for (const m of pc.root.nodes) if (m.kind === "module" && m.children) level(m.id, m.children);
  return out;
}

/** What still has to appear. */
export function pendingSteps(pc: ProjectChart, visible: Set<string>): RevealStep[] {
  return revealOrder(pc).filter((s) => !visible.has(s.key));
}

/** Every key of the chart: for showing it all at once. */
export function allKeys(pc: ProjectChart): Set<string> {
  return new Set(revealOrder(pc).map((s) => s.key));
}

/**
 * The part of the chart that is on the board so far. Bubbles keep their latest details (the AI may refine them);
 * only which bubbles and arrows exist is held back. An arrow shows only once both of its ends do.
 */
export function visiblePart(pc: ProjectChart, visible: Set<string>): ProjectChart {
  const part = (lv: Level, c: Chart): Chart => {
    const local = new Set(c.nodes.map((n) => n.id));
    const nodes = c.nodes
      .filter((n) => visible.has(revealKey(lv, "node", n.id)))
      .map((n) => (lv === "root" && n.children ? { ...n, children: part(n.id, n.children) } : n));
    const shown = new Set(nodes.map((n) => n.id));
    const there = (end: string) => !local.has(end) || shown.has(end);
    const edges = c.edges.filter((e) => visible.has(revealKey(lv, "edge", e.id)) && there(e.from) && there(e.to));
    return { nodes, edges };
  };
  return { ...pc, root: part("root", pc.root) };
}

/** How long the board holds after a step, at normal speed. */
export function stepPause(step: RevealStep): number {
  return step.kind === "node" ? 520 : 300;
}

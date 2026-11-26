// Renders one chart level as SVG (dagre layout), with pan/zoom, selection, drill-down and the run animation.
import { Graph, layout } from "@dagrejs/dagre";
import type { Bubble, Chart, RunStep } from "../shared/types.ts";

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

interface Pt {
  x: number;
  y: number;
}

/** Smooth path through dagre's edge points (Catmull-Rom → cubic Bézier). */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return d;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export interface ChartViewCallbacks {
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  onConnect(from: string, to: string): void;
  /** Display name for a ghost endpoint like "storage/save-todos". */
  ghostLabel(ref: string): string;
  /** Clicking a ghost bubble jumps to that module. */
  onGhost(ref: string): void;
}

export class ChartView {
  private root: SVGGElement;
  private nodesG: SVGGElement;
  private edgesG: SVGGElement;
  private fxG: SVGGElement;
  private nodeEls = new Map<string, SVGGElement>();
  private edgePaths = new Map<string, SVGPathElement>();
  private nodeBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  private view = { x: 0, y: 0, k: 1 };
  private bounds = { w: 0, h: 0 };
  private selected: string | null = null;
  connectFrom: string | null = null;
  private runToken = 0;
  /** What the last render showed, so the next one can animate what's new. */
  private last: { key: string; pos: Map<string, Pt>; edges: Set<string>; inside: Map<string, number> } | null = null;
  private smoothTimer = 0;

  constructor(private svg: SVGSVGElement, private cb: ChartViewCallbacks) {
    const defs = el("defs", {}, svg);
    const marker = el("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", class: "arrow-head" }, marker);
    this.root = el("g", {}, svg);
    this.edgesG = el("g", { class: "edges" }, this.root);
    this.nodesG = el("g", { class: "nodes" }, this.root);
    this.fxG = el("g", { class: "fx" }, this.root);
    this.setupPanZoom();
  }

  private setupPanZoom() {
    let drag: { x: number; y: number; vx: number; vy: number } | null = null;
    this.svg.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest(".node")) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add("panning");
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.view.x = drag.vx + (e.clientX - drag.x);
      this.view.y = drag.vy + (e.clientY - drag.y);
      this.applyView();
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4;
      drag = null;
      this.svg.classList.remove("panning");
      if (!moved) {
        this.connectFrom = null;
        this.cb.onSelect(null);
      }
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);
    this.svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.svg.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const k = Math.min(2.5, Math.max(0.25, this.view.k * Math.exp(-e.deltaY * 0.0015)));
        this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
        this.view.y = my - ((my - this.view.y) * k) / this.view.k;
        this.view.k = k;
        this.applyView();
      },
      { passive: false },
    );
  }

  private applyView() {
    this.root.style.transform = `translate(${this.view.x}px,${this.view.y}px) scale(${this.view.k})`;
  }

  /** Glide to the new view instead of jumping (used while the chart grows). Panning stays instant. */
  private smoothly(fn: () => void) {
    this.root.classList.add("smooth");
    fn();
    clearTimeout(this.smoothTimer);
    this.smoothTimer = window.setTimeout(() => this.root.classList.remove("smooth"), 700);
  }

  fit() {
    const r = this.svg.getBoundingClientRect();
    if (!this.bounds.w || !r.width) return;
    const pad = 40;
    const k = Math.min(1.2, (r.width - pad * 2) / this.bounds.w, (r.height - pad * 2) / this.bounds.h);
    this.view = { k, x: (r.width - this.bounds.w * k) / 2, y: (r.height - this.bounds.h * k) / 2 };
    this.applyView();
  }

  zoomBy(f: number) {
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(2.5, Math.max(0.25, this.view.k * f));
    this.view.x = r.width / 2 - ((r.width / 2 - this.view.x) * k) / this.view.k;
    this.view.y = r.height / 2 - ((r.height / 2 - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.applyView();
  }

  /**
   * Draw a chart level. With `animate`, and when the previous render showed the same level (`key`), new bubbles
   * pop in one after another, then new arrows draw themselves; bubbles that moved glide to their new place, and a
   * module that just got functions inside pulses. With `glide`, the view refits smoothly to the new size.
   */
  render(chart: Chart, opts: { keepView?: boolean; animate?: boolean; key?: string; glide?: boolean } = {}) {
    const prev = opts.animate && this.last && this.last.key === (opts.key ?? "") ? this.last : null;
    this.stopRun();
    this.nodesG.replaceChildren();
    this.edgesG.replaceChildren();
    this.nodeEls.clear();
    this.edgePaths.clear();
    this.nodeBoxes.clear();

    // Lay out left-to-right and top-to-bottom, and keep whichever fits the screen at a larger scale.
    const r = this.svg.getBoundingClientRect();
    const { g, ghosts } = [this.layoutGraph(chart, "LR"), this.layoutGraph(chart, "TB")]
      .map((l) => {
        const gi = l.g.graph() as { width?: number; height?: number };
        return { ...l, k: Math.min((r.width || 1000) / (gi.width ?? 1), (r.height || 700) / (gi.height ?? 1)) };
      })
      .sort((a, b) => b.k - a.k)[0];
    const gi = g.graph() as { width?: number; height?: number };
    this.bounds = { w: gi.width ?? 400, h: gi.height ?? 300 };

    for (const e of chart.edges) {
      const ed = g.edge({ v: e.from, w: e.to, name: e.id }) as { points: Pt[]; x: number; y: number };
      if (!ed) continue;
      const grp = el("g", { class: "edge", "data-id": e.id }, this.edgesG);
      const path = el("path", { d: smoothPath(ed.points), class: "edge-path", "marker-end": "url(#arrow)" }, grp);
      this.edgePaths.set(e.id, path);
      const lbl = el("g", { class: "edge-label", transform: `translate(${ed.x},${ed.y})` }, grp);
      const text = truncate(e.data, 26);
      const w = Math.min(220, 30 + text.length * 7.1);
      el("rect", { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }, lbl);
      el("circle", { cx: -w / 2 + 11, cy: 0, r: 9, class: "order" }, lbl);
      el("text", { x: -w / 2 + 11, y: 4, class: "order-text", "text-anchor": "middle" }, lbl).textContent = String(e.order);
      el("text", { x: -w / 2 + 24, y: 4, class: "data-text" }, lbl).textContent = text;
      el("title", {}, grp).textContent = `${e.order}. ${e.from} → ${e.to}\n${e.data}`;
    }

    for (const n of chart.nodes) this.drawNode(n, g.node(n.id) as unknown as { x: number; y: number; width: number; height: number });
    for (const ref of ghosts) this.drawGhost(ref, g.node(ref) as unknown as { x: number; y: number; width: number; height: number });

    if (prev) this.animateChanges(chart, prev);
    this.last = {
      key: opts.key ?? "",
      pos: new Map([...this.nodeBoxes].map(([id, b]) => [id, { x: b.x, y: b.y }])),
      edges: new Set(chart.edges.map((e) => e.id)),
      inside: new Map(chart.nodes.map((n) => [n.id, n.children?.nodes.length ?? 0])),
    };

    this.setSelected(this.selected && this.nodeEls.has(this.selected) ? this.selected : null);
    if (opts.glide) requestAnimationFrame(() => this.smoothly(() => this.fit()));
    else if (!opts.keepView) requestAnimationFrame(() => this.fit());
  }

  private animateChanges(chart: Chart, prev: NonNullable<ChartView["last"]>) {
    const STAGGER = 140;
    let fresh = 0;
    let moved = false;
    for (const [id, grp] of this.nodeEls) {
      const was = prev.pos.get(id);
      const now = this.nodeBoxes.get(id)!;
      if (!was) {
        grp.classList.add("appear");
        grp.style.setProperty("--delay", `${fresh++ * STAGGER}ms`);
      } else if (Math.abs(was.x - now.x) + Math.abs(was.y - now.y) > 1) {
        // Start where it was, then glide to where it is now.
        moved = true;
        grp.style.transform = `translate(${was.x}px,${was.y}px)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            grp.classList.add("glide");
            grp.style.transform = `translate(${now.x}px,${now.y}px)`;
          }),
        );
      }
    }
    for (const n of chart.nodes) {
      const before = prev.inside.get(n.id);
      if (before !== undefined && (n.children?.nodes.length ?? 0) > before) this.nodeEls.get(n.id)?.classList.add("filled");
    }
    let freshEdges = 0;
    for (const [id, path] of this.edgePaths) {
      const grp = path.parentElement as unknown as SVGGElement;
      if (prev.edges.has(id)) {
        // Its route changed with the layout: fade it in rather than jump. Unchanged layouts don't flicker.
        if (moved) grp.classList.add("reflow");
        continue;
      }
      grp.classList.add("appear");
      // The arrow head shows once the line has reached it.
      path.addEventListener("animationend", () => grp.classList.remove("appear"), { once: true });
      grp.style.setProperty("--len", String(Math.ceil(path.getTotalLength()) + 2));
      grp.style.setProperty("--delay", `${fresh * STAGGER + 250 + freshEdges++ * 90}ms`);
    }
  }

  private layoutGraph(chart: Chart, rankdir: "LR" | "TB") {
    const g = new Graph({ multigraph: true });
    g.setGraph({ rankdir, nodesep: rankdir === "LR" ? 46 : 60, ranksep: rankdir === "LR" ? 56 : 48, edgesep: 24, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(chart.nodes.map((n) => n.id));
    for (const n of chart.nodes) {
      g.setNode(n.id, { width: n.kind === "module" ? 220 : 190, height: n.kind === "module" ? 86 : 66 });
    }
    const ghosts = new Set<string>();
    for (const e of chart.edges) {
      for (const end of [e.from, e.to]) {
        if (!ids.has(end) && !ghosts.has(end)) {
          ghosts.add(end);
          g.setNode(end, { width: 170, height: 48 });
        }
      }
      g.setEdge(e.from, e.to, { width: Math.min(220, 30 + truncate(e.data, 26).length * 7.1), height: 22, labelpos: "c" }, e.id);
    }
    layout(g);
    return { g, ghosts };
  }

  private drawNode(n: Bubble, p: { x: number; y: number; width: number; height: number }) {
    const { width: w, height: h } = p;
    const outer = el("g", { class: `node ${n.kind} ${n.status}${n.gui ? " gui" : ""}`, "data-id": n.id, tabindex: 0 }, this.nodesG);
    outer.style.transform = `translate(${p.x - w / 2}px,${p.y - h / 2}px)`;
    // The inner group carries the pop-in animation, so it can scale around its own centre.
    const grp = el("g", { class: "node-inner" }, outer);
    this.nodeBoxes.set(n.id, { x: p.x - w / 2, y: p.y - h / 2, w, h });
    el("rect", { width: w, height: h, rx: n.kind === "module" ? 14 : h / 2, class: "body" }, grp);
    const kind = (n.kind === "module" ? "MODULE" : n.status === "draft" ? "DRAFT" : "FUNCTION") + (n.gui ? " · UI" : "");
    el("text", { x: w / 2, y: n.kind === "module" ? 24 : 21, class: "kind", "text-anchor": "middle" }, grp).textContent = n.status === "draft" ? `${kind} · no code yet` : kind;
    el("text", { x: w / 2, y: n.kind === "module" ? 47 : 41, class: "name", "text-anchor": "middle" }, grp).textContent = truncate(n.name, 24);
    const io = `${n.inputs.length} in · ${n.outputs.length} out${n.kind === "module" ? ` · ${n.children?.nodes.length ?? 0} inside` : ""}`;
    el("text", { x: w / 2, y: n.kind === "module" ? 68 : 57, class: "io", "text-anchor": "middle" }, grp).textContent = io;
    el("title", {}, grp).textContent = `${n.name}\n${n.description}${n.kind === "module" ? "\n\nDouble-click to open" : ""}`;

    outer.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.connectFrom && this.connectFrom !== n.id) {
        const from = this.connectFrom;
        this.connectFrom = null;
        this.cb.onConnect(from, n.id);
        return;
      }
      this.cb.onSelect(n.id);
    });
    outer.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (n.kind === "module") this.cb.onOpen(n.id);
    });
    outer.addEventListener("keydown", (e) => {
      if (e.key === "Enter") n.kind === "module" ? this.cb.onOpen(n.id) : this.cb.onSelect(n.id);
    });
    this.nodeEls.set(n.id, outer);
  }

  private drawGhost(ref: string, p: { x: number; y: number; width: number; height: number }) {
    const { width: w, height: h } = p;
    const outer = el("g", { class: "node ghost", "data-id": ref }, this.nodesG);
    outer.style.transform = `translate(${p.x - w / 2}px,${p.y - h / 2}px)`;
    const grp = el("g", { class: "node-inner" }, outer);
    this.nodeBoxes.set(ref, { x: p.x - w / 2, y: p.y - h / 2, w, h });
    el("rect", { width: w, height: h, rx: h / 2, class: "body" }, grp);
    const [mod, fn] = ref.includes("/") ? ref.split("/") : ["", ref];
    el("text", { x: w / 2, y: 19, class: "kind", "text-anchor": "middle" }, grp).textContent = mod ? `IN ${this.cb.ghostLabel(mod).toUpperCase()}` : "ELSEWHERE";
    el("text", { x: w / 2, y: 36, class: "name", "text-anchor": "middle" }, grp).textContent = truncate(this.cb.ghostLabel(ref) || fn, 22);
    el("title", {}, grp).textContent = `Lives in another module. Click to open it.`;
    outer.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onGhost(ref);
    });
    this.nodeEls.set(ref, outer);
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const [k, g] of this.nodeEls) g.classList.toggle("selected", k === id);
    this.svg.classList.toggle("connecting", !!this.connectFrom);
  }

  // ---------- run animation ----------

  stopRun() {
    this.runToken++;
    this.fxG.replaceChildren();
    for (const g of this.nodeEls.values()) g.classList.remove("active", "visited");
    for (const p of this.edgePaths.values()) p.classList.remove("active");
  }

  /** Animate sample data flowing through the chart. Resolves when finished or stopped. */
  async play(steps: RunStep[], onStep: (i: number) => void, speed = 1): Promise<void> {
    this.stopRun();
    const token = this.runToken;
    const alive = () => token === this.runToken;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms / speed));
    let prev: string | null = null;

    for (let i = 0; i < steps.length && alive(); i++) {
      const s = steps[i];
      onStep(i);
      let path = s.edgeId ? this.edgePaths.get(s.edgeId) : undefined;
      if (!path && prev) {
        // Fall back to any edge between the previous and this node.
        const id = [...this.edgePaths.keys()].find((k) => {
          const g = this.edgePaths.get(k)!.parentElement!;
          return g.querySelector("title")?.textContent?.includes(`${prev} → ${s.nodeId}`);
        });
        path = id ? this.edgePaths.get(id) : undefined;
      }
      if (path) await this.travel(path, s.data, alive);
      if (!alive()) return;
      const node = this.nodeEls.get(s.nodeId);
      if (node) {
        for (const g of this.nodeEls.values()) g.classList.remove("active");
        node.classList.add("active", "visited");
        this.tag(s.nodeId, s.data);
      }
      prev = s.nodeId;
      await wait(900);
    }
    if (alive()) {
      for (const g of this.nodeEls.values()) g.classList.remove("active");
      this.fxG.replaceChildren();
    }
  }

  private tag(nodeId: string, data: string) {
    const b = this.nodeBoxes.get(nodeId);
    if (!b) return;
    this.fxG.querySelectorAll(".data-tag").forEach((t) => t.remove());
    const g = el("g", { class: "data-tag", transform: `translate(${b.x + b.w / 2},${b.y - 14})` }, this.fxG);
    const text = truncate(data, 44);
    const w = 20 + text.length * 6.6;
    el("rect", { x: -w / 2, y: -14, width: w, height: 24, rx: 6 }, g);
    el("text", { x: 0, y: 3, "text-anchor": "middle" }, g).textContent = text;
  }

  private travel(path: SVGPathElement, data: string, alive: () => boolean): Promise<void> {
    path.classList.add("active");
    const len = path.getTotalLength();
    const dot = el("circle", { r: 7, class: "token" }, this.fxG);
    const label = el("text", { class: "token-label", "text-anchor": "middle" }, this.fxG);
    label.textContent = truncate(data, 36);
    const duration = Math.min(1400, 500 + len * 1.6);
    const start = performance.now();
    return new Promise((resolve) => {
      const frame = (t: number) => {
        if (!alive()) return resolve();
        const f = Math.min(1, (t - start) / duration);
        const ease = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
        const p = path.getPointAtLength(len * ease);
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        label.setAttribute("x", String(p.x));
        label.setAttribute("y", String(p.y - 14));
        if (f < 1) requestAnimationFrame(frame);
        else {
          dot.remove();
          label.remove();
          path.classList.remove("active");
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }
}

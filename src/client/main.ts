import { getLevel } from "../shared/chart.ts";
import type { Bubble, DesignState, FindResult, FolderInspection, FolderListing, Level, Mockup, Port, ProjectChart, ProjectSummary, Recommendation, RunTrace, ServerEvent, Stack } from "../shared/types.ts";
import { api, type ChangeResult } from "./api.ts";
import { ChartView } from "./chart-view.ts";

// ---------- tiny DOM helper (always textContent, never innerHTML: AI output is untrusted) ----------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k in e && typeof v !== "string") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c) e.append(c);
  return e;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------

interface State {
  project: string | null;
  chart: ProjectChart | null;
  level: Level;
  selected: string | null;
  busy: boolean;
  /** Pending AI recommendation for the selected bubble. */
  rec: { bubbleId: string; request: string; rec: Recommendation } | null;
  lastResult: { bubbleId: string | null; text: string; files: string[] } | null;
  code: { path: string; content: string } | null;
  drawing: boolean;
  run: { trace: RunTrace; current: number } | null;
  history: boolean;
  assistant: boolean;
  outside: string[];
  /** The chart of an opened codebase is being drawn right now (it grows on the board step by step). */
  drawingChart: boolean;
  /** Design panel open. */
  design: boolean;
  designData: DesignState | null;
  /** Unsent text in the design panel / a bubble's mockup box, kept across re-renders. */
  designDraft: string;
  refNote: string;
}

const state: State = {
  project: null,
  chart: null,
  level: "root",
  selected: null,
  busy: false,
  rec: null,
  lastResult: null,
  code: null,
  drawing: false,
  run: null,
  history: false,
  assistant: false,
  outside: [],
  drawingChart: false,
  design: false,
  designData: null,
  designDraft: "",
  refNote: "",
};

let events: EventSource | null = null;

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "reply"; text: string; changed?: string[] }
  | { kind: "activity"; text: string; ok: boolean }
  | { kind: "approval"; id: string; command: string; answer?: boolean };
interface Chat {
  items: ChatItem[];
  busy: boolean;
  draft: string;
}
/** One conversation per project, so a reply that arrives after switching projects lands in the right one. */
const chats = new Map<string, Chat>();
function chatFor(project: string): Chat {
  let c = chats.get(project);
  if (!c) chats.set(project, (c = { items: [], busy: false, draft: "" }));
  return c;
}

/** Display name for a reference like "storage" or "storage/save-todos". */
function ghostLabel(ref: string): string {
  const pc = state.chart;
  if (!pc) return ref;
  const [mod, fn] = ref.split("/");
  const m = pc.root.nodes.find((n) => n.id === mod);
  if (!fn) return m?.name ?? mod;
  return m?.children?.nodes.find((n) => n.id === fn)?.name ?? fn;
}

const view = new ChartView($("chart") as unknown as SVGSVGElement, {
  onSelect(id) {
    select(id);
  },
  onOpen(id) {
    openLevel(id);
  },
  onConnect(from, to) {
    void connect(from, to);
  },
  ghostLabel,
  onGhost(ref) {
    const mod = ref.split("/")[0];
    if (state.chart?.root.nodes.some((n) => n.id === mod)) {
      openLevel(mod);
      const fn = ref.split("/")[1];
      if (fn) select(fn);
    }
  },
});

// ---------- feedback ----------

function setBusy(message: string | null) {
  state.busy = !!message;
  $("status").hidden = !message;
  $("status-text").textContent = message ?? "";
  document.body.classList.toggle("busy", !!message);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".toolbar button, .panel button.ai")) b.disabled = !!message;
}

let toastTimer = 0;
function toast(message: string, kind: "info" | "error" = "info") {
  const t = $("toast");
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), kind === "error" ? 9000 : 4000);
}

async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) return;
  setBusy(label);
  try {
    return await fn();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    setBusy(null);
  }
}

// ---------- navigation ----------

function show(page: "home" | "stack-page" | "workspace" | "settings-page") {
  for (const id of ["home", "stack-page", "workspace", "settings-page"]) $(id).hidden = id !== page;
}

async function goHome() {
  events?.close();
  events = null;
  // Leaving a chart that's still being drawn: it keeps drawing, and opening the project again shows where it got to.
  if (state.drawingChart) {
    state.drawingChart = false;
    setBusy(null);
  }
  state.project = null;
  state.chart = null;
  history.replaceState(null, "", "/");
  show("home");
  renderCrumbs();
  const list = $("project-list");
  list.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    const projects = await api.projects();
    list.replaceChildren(...(projects.length ? projects.map(projectCard) : [h("p", { class: "muted" }, "No projects yet. Describe an idea above to start one, or open one you already have.")]));
  } catch (e) {
    list.replaceChildren(h("p", { class: "error" }, (e as Error).message));
  }
}

function projectCard(p: ProjectSummary) {
  const card = h(
    "button",
    { class: "project card", disabled: p.missing, onclick: () => void openProject(p.name) },
    h("strong", {}, p.name),
    p.missing ? h("span", { class: "error small" }, "The folder isn't there any more. It may have moved; open it again from its new place.") : h("span", { class: "muted" }, p.idea),
    p.dir && h("code", { class: "small muted path" }, p.dir),
    !p.hasChart && !p.missing && h("span", { class: "badge" }, "not generated yet"),
  );
  if (!p.linked) return card;
  const forget = h(
    "button",
    {
      class: "link small forget",
      title: "Remove it from this list. The folder, its code, chart and history stay as they are.",
      onclick: () =>
        void guard("Removing from the list…", async () => {
          await api.forget(p.name);
          await goHome();
        }),
    },
    "Remove from list",
  );
  return h("div", { class: "project-item" }, card, forget);
}

function subscribe(name: string) {
  events?.close();
  events = api.events(name, (ev) => onServerEvent(name, ev));
}

function onServerEvent(project: string, ev: ServerEvent) {
  if (project !== state.project) return;
  if (ev.type === "progress") {
    if (state.busy && ev.message !== "Done") $("status-text").textContent = ev.message;
    const log = $("gen-log");
    if (!$("stack-page").hidden && ev.message !== "Done") log.append(h("li", {}, ev.message));
  } else if (ev.type === "chart") {
    state.chart = ev.chart;
    if (!$("workspace").hidden) renderChart(true, true);
  } else if (ev.type === "drawn") {
    state.chart = ev.chart;
    stopDrawingUi();
    if (!$("workspace").hidden) renderChart(true, true);
    const extra = ev.warnings.length ? ` ${ev.warnings.length} note${ev.warnings.length === 1 ? "" : "s"}: ${ev.warnings.slice(0, 2).join(" ")}${ev.warnings.length > 2 ? " …" : ""}` : "";
    toast(`The chart is drawn. ${ev.summary} Double-click a module to open it.${extra}`, ev.warnings.length ? "error" : "info");
  } else if (ev.type === "draw-failed") {
    stopDrawingUi();
    toast(`Couldn't draw the chart: ${ev.message} The folder is as it was; open it again to try again.`, "error");
    void goHome();
  } else if (ev.type === "design") {
    state.designData = ev.design;
    if (!$("workspace").hidden) renderPanel();
  } else if (ev.type === "outside-change") {
    state.outside = ev.files;
    renderBanner();
  } else if (ev.type === "assistant") {
    const e = ev.event;
    const chat = chatFor(project);
    if (e.kind === "tool") chat.items.push({ kind: "activity", text: e.summary, ok: true });
    else if (e.kind === "tool-result" && !e.ok) chat.items.push({ kind: "activity", text: e.summary, ok: false });
    else if (e.kind === "approval") {
      chat.items.push({ kind: "approval", id: e.id, command: e.command });
      if (!state.assistant) openAssistant();
    } else if (e.kind === "approval-resolved") {
      const item = chat.items.find((i) => i.kind === "approval" && i.id === e.id);
      if (item && item.kind === "approval") item.answer = e.allowed;
    } else return;
    if (state.assistant) renderPanel();
  }
}

async function openProject(name: string) {
  const data = await guard("Opening project…", () => api.open(name));
  if (!data) return;
  state.project = name;
  state.chart = data.chart;
  state.outside = data.outside;
  const chat = chatFor(name);
  if (!chat.busy) {
    api
      .assistantTranscript(name)
      .then((t) => {
        if (chat.busy) return; // a turn started meanwhile; keep its live items
        chat.items = t.map((m): ChatItem => (m.role === "user" ? { kind: "user", text: m.text } : { kind: "reply", text: m.text }));
        if (state.project === name && state.assistant) renderPanel();
      })
      .catch(() => undefined);
  }
  subscribe(name);
  state.designData = null;
  api
    .design(name)
    .then((d) => {
      if (state.project !== name) return;
      state.designData = d;
      if (!$("workspace").hidden) renderPanel();
    })
    .catch(() => undefined);
  if (!data.chart.root.nodes.length && !data.drawing && !data.chart.drawing) return startStackChoice(name, data.chart.idea);
  history.replaceState(null, "", `/?p=${encodeURIComponent(name)}`);
  state.drawingChart = data.drawing;
  enterWorkspace();
  if (data.drawing) startDrawingUi();
}

/** While the chart of an opened codebase is drawn: the board grows live, and editing waits until it's done. */
function startDrawingUi() {
  const name = state.project;
  state.drawingChart = true;
  setBusy("Reading the code…");
  renderChart(true);
  // Events only flow from when we subscribed: if the drawing ended just before that, catch up now.
  if (name)
    api
      .open(name)
      .then((d) => {
        if (state.project !== name || !state.drawingChart || d.drawing) return;
        state.chart = d.chart;
        stopDrawingUi();
        renderChart(true, true);
      })
      .catch(() => undefined);
}

function stopDrawingUi() {
  if (!state.drawingChart) return;
  state.drawingChart = false;
  setBusy(null);
  renderBanner();
}

function enterWorkspace() {
  state.level = "root";
  state.selected = null;
  resetPanelState();
  show("workspace");
  renderChart();
  renderBanner();
}

function openLevel(level: Level) {
  view.stopRun();
  state.level = level;
  state.selected = null;
  resetPanelState();
  renderChart();
}

function resetPanelState() {
  state.rec = null;
  state.code = null;
  state.drawing = false;
  state.run = null;
  state.history = false;
  state.assistant = false;
  state.design = false;
  state.lastResult = null;
}

function select(id: string | null) {
  if (id !== state.selected) {
    state.rec = null;
    state.code = null;
    state.drawing = false;
    state.history = false;
    if (state.lastResult?.bubbleId !== id) state.lastResult = null;
  }
  state.selected = id;
  view.setSelected(id);
  $("connect-hint").hidden = !view.connectFrom;
  renderPanel();
}

function renderCrumbs() {
  const c = $("crumbs");
  c.replaceChildren();
  if (!state.project) return;
  c.append(h("button", { onclick: () => state.chart && openLevel("root") }, state.project));
  if (state.level !== "root") {
    const mod = state.chart?.root.nodes.find((n) => n.id === state.level);
    c.append(h("span", { class: "sep" }, "›"), h("span", { class: "current" }, mod?.name ?? state.level));
  }
}

// ---------- chart ----------

function currentChart() {
  return state.chart ? getLevel(state.chart, state.level) : null;
}

function currentBubble(): Bubble | undefined {
  return currentChart()?.nodes.find((n) => n.id === state.selected);
}

function renderChart(keepView = false, animate = false) {
  const chart = currentChart();
  if (!chart) {
    state.level = "root";
    return renderChart();
  }
  // While the chart is being drawn, keep the whole (growing) level in view.
  view.render(chart, { keepView, animate, key: `${state.project}/${state.level}`, glide: animate && state.drawingChart });
  const empty = $("empty-level");
  if (state.drawingChart && !chart.nodes.length) {
    empty.replaceChildren(h("span", { class: "drawing-note" }, h("span", { class: "spinner" }), state.level === "root" ? "Reading your code. Modules appear here as they're found." : "This module's functions appear here as soon as they're drawn."));
  } else {
    empty.replaceChildren("This module is empty. Use ", h("b", {}, "＋ Bubble"), " to draw its first function.");
  }
  if (state.selected && !chart.nodes.some((n) => n.id === state.selected)) state.selected = null;
  view.setSelected(state.selected);
  $("btn-up").hidden = state.level === "root";
  empty.hidden = chart.nodes.length > 0;
  renderCrumbs();
  renderPanel();
}

function applyResult(r: ChangeResult, bubbleId: string | null) {
  state.chart = r.chart;
  state.rec = null;
  state.lastResult = r.summary ? { bubbleId, text: r.summary, files: r.files ?? [] } : null;
  renderChart(true, true);
  if (r.warnings?.length) toast(`Some changes were skipped: ${r.warnings.join("; ")}`, "error");
}

// ---------- side panel ----------

function portsList(title: string, ports: Port[]) {
  return h(
    "div",
    { class: "ports" },
    h("h4", {}, title),
    ports.length
      ? h("ul", {}, ...ports.map((p) => h("li", {}, h("code", {}, p.name), h("span", { class: "type" }, p.type))))
      : h("p", { class: "muted small" }, "none"),
  );
}

function renderPanel() {
  const panel = $("panel");
  panel.replaceChildren();
  if (!state.chart) return;
  if (state.run) return panel.append(runPanel(state.run));
  if (state.assistant) return panel.append(assistantPanel());
  if (state.design) return panel.append(designPanel());
  if (state.history) {
    panel.append(historyPanel());
    return;
  }
  if (state.drawing) return panel.append(drawPanel());
  const b = currentBubble();
  panel.append(b ? bubblePanel(b) : levelPanel());
}

function levelPanel() {
  const pc = state.chart!;
  const mod = state.level === "root" ? null : pc.root.nodes.find((n) => n.id === state.level);
  const wrap = h("div", { class: "panel-body" });
  if (mod) {
    wrap.append(h("p", { class: "eyebrow" }, "Module"), h("h2", {}, mod.name), h("p", {}, mod.description), portsList("Inputs", mod.inputs), portsList("Outputs", mod.outputs));
  } else {
    wrap.append(h("p", { class: "eyebrow" }, "Project"), h("h2", {}, pc.name), h("p", {}, pc.idea));
    if (pc.stack) {
      wrap.append(
        h("div", { class: "stack-mini" }, h("h4", {}, "Tech stack"), h("p", {}, h("strong", {}, pc.stack.name), ` · ${pc.stack.language}`), pc.stack.runCommand && h("p", { class: "small" }, "Run it with ", h("code", {}, pc.stack.runCommand))),
      );
    }
  }
  if (state.lastResult && !state.lastResult.bubbleId) wrap.append(resultBox());
  wrap.append(
    h(
      "div",
      { class: "tips" },
      h("h4", {}, "How to use"),
      h(
        "ul",
        {},
        h("li", {}, "Click a bubble to see what it does."),
        state.level === "root" ? h("li", {}, "Double-click a module to open its inner chart.") : h("li", {}, "Dashed bubbles live in another module; click one to jump there."),
        h("li", {}, "Select a bubble and ask the AI to keep building from there."),
        h("li", {}, "Arrows show call order (number) and the data passed."),
      ),
    ),
  );
  return wrap;
}

function resultBox() {
  const r = state.lastResult!;
  return h(
    "div",
    { class: "result" },
    h("strong", {}, "Done. "),
    r.text,
    r.files.length ? h("p", { class: "small muted" }, `Files: ${r.files.join(", ")}`) : null,
  );
}

function bubblePanel(b: Bubble) {
  const name = state.project!;
  const wrap = h("div", { class: "panel-body" });
  wrap.append(
    h("p", { class: "eyebrow" }, b.kind === "module" ? "Module" : "Function", b.status === "draft" ? h("span", { class: "badge draft" }, "draft · no code") : null),
    h("h2", {}, b.name),
    h("p", {}, b.description || h("span", { class: "muted" }, "No description.")),
    h("div", { class: "io-grid" }, portsList("Inputs", b.inputs), portsList("Outputs", b.outputs)),
  );
  if (b.file) {
    wrap.append(
      h(
        "p",
        { class: "small file" },
        h("code", {}, b.file + (b.symbol ? ` · ${b.symbol}` : "")),
        " ",
        h(
          "button",
          {
            class: "link",
            onclick: async () => {
              if (state.code?.path === b.file) state.code = null;
              else {
                try {
                  state.code = await api.file(name, b.file!);
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }
              renderPanel();
            },
          },
          state.code?.path === b.file ? "Hide code" : "View code",
        ),
      ),
    );
    if (state.code?.path === b.file) wrap.append(codeBlock(state.code.content, b.symbol));
  }

  const actions = h("div", { class: "actions" });
  if (b.kind === "module") actions.append(h("button", { onclick: () => openLevel(b.id) }, "Open module →"));
  actions.append(
    h(
      "button",
      {
        title: "Draw an arrow from this bubble to another",
        onclick: () => {
          view.connectFrom = b.id;
          view.setSelected(b.id);
          $("connect-hint").hidden = false;
        },
      },
      "Draw arrow from here",
    ),
    h(
      "button",
      {
        class: "danger-link",
        onclick: () => {
          if (!confirm(`Remove "${b.name}" from the chart? (Its code stays; you can undo this.)`)) return;
          void guard("Removing…", async () => applyResult(await api.removeBubble(name, state.level, b.id), null));
        },
      },
      "Remove from chart",
    ),
  );
  wrap.append(actions);

  if (b.status === "draft") {
    wrap.append(
      h(
        "div",
        { class: "ask" },
        h("h3", {}, "This bubble has no code yet"),
        h("p", { class: "small muted" }, "The AI will write it and wire it into the flow."),
        h("button", { class: "primary ai", onclick: () => void guard(`Writing code for ${b.name}…`, async () => applyResult(await api.implement(name, state.level, b.id), b.id)) }, "Write the code"),
      ),
    );
  }

  if (state.lastResult?.bubbleId === b.id) wrap.append(resultBox());
  wrap.append(screenSection(b));
  wrap.append(askBox(b));
  return wrap;
}

function codeBlock(content: string, symbol?: string) {
  const pre = h("pre", { class: "code" });
  const lines = content.split("\n");
  const at = symbol ? lines.findIndex((l) => new RegExp(`\\b(function|def|fn|const|let|class)\\s+${symbol}\\b`).test(l)) : -1;
  lines.forEach((l, i) => pre.append(h("span", { class: i === at ? "hl" : "" }, l + "\n")));
  if (at > 0) requestAnimationFrame(() => (pre.scrollTop = Math.max(0, at * 17 - 40)));
  return pre;
}

function askBox(b: Bubble) {
  const name = state.project!;
  const box = h("div", { class: "ask" });
  box.append(h("h3", {}, "Keep building from here"));
  const ta = h("textarea", { rows: 3, placeholder: b.kind === "module" ? "e.g. add due dates to todos" : `e.g. after ${b.name}, also send a notification` }) as HTMLTextAreaElement;
  if (state.rec?.bubbleId === b.id) ta.value = state.rec.request;
  const ask = () => {
    const request = ta.value.trim();
    if (!request) return ta.focus();
    void guard("Thinking about how to proceed…", async () => {
      const rec = await api.recommend(name, state.level, b.id, request);
      state.rec = { bubbleId: b.id, request, rec };
      state.lastResult = null;
      renderPanel();
    });
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
  });
  box.append(ta, h("button", { class: "primary ai", onclick: ask }, "Ask for a recommendation"));

  if (state.rec?.bubbleId === b.id) {
    const { rec, request } = state.rec;
    box.append(h("div", { class: "rec" }, h("p", { class: "rec-summary" }, rec.summary)));
    for (const o of rec.options) {
      const recommended = o.id === rec.recommendedOptionId;
      box.append(
        h(
          "div",
          { class: `option${recommended ? " recommended" : ""}` },
          h("div", { class: "option-head" }, h("span", { class: "kind-chip" }, o.kind), h("strong", {}, o.label), recommended && h("span", { class: "badge" }, "recommended")),
          h("p", { class: "small" }, o.description),
          h("button", { class: `ai ${recommended ? "primary" : ""}`, onclick: () => void guard(`${o.label}…`, async () => applyResult(await api.apply(name, state.level, b.id, request, o), b.id)) }, "Do this"),
        ),
      );
    }
  }
  return box;
}

function parsePorts(text: string): Port[] {
  return text
    .split(/\n|,(?![^{<(]*[}>)])/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [n, ...t] = l.split(":");
      return { name: n.trim(), type: t.join(":").trim() || "any" };
    });
}

function drawPanel() {
  const name = state.project!;
  const where = state.level === "root" ? "a new module" : `a new function in ${state.chart!.root.nodes.find((n) => n.id === state.level)?.name}`;
  const form = h("form", { class: "panel-body draw" }) as HTMLFormElement;
  form.append(
    h("p", { class: "eyebrow" }, "Draw a bubble"),
    h("h2", {}, `Add ${where}`),
    h("label", {}, "Name", h("input", { name: "name", required: true, placeholder: state.level === "root" ? "e.g. Reminders" : "e.g. sendReminder" })),
    h("label", {}, "What should it do?", h("textarea", { name: "description", rows: 3, required: true, placeholder: "Describe it in a sentence or two" })),
    h("label", {}, "Inputs (optional, one per line: name: type)", h("textarea", { name: "inputs", rows: 2, placeholder: "todo: Todo" })),
    h("label", {}, "Outputs (optional)", h("textarea", { name: "outputs", rows: 2, placeholder: "sent: boolean" })),
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Add to chart"), h("button", { type: "button", onclick: () => ((state.drawing = false), renderPanel()) }, "Cancel")),
    h("p", { class: "small muted" }, "It is added as a draft. Then ask the AI to write its code."),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    void guard("Adding bubble…", async () => {
      const r = await api.addBubble(name, state.level, {
        name: String(fd.get("name")),
        description: String(fd.get("description")),
        inputs: parsePorts(String(fd.get("inputs") ?? "")),
        outputs: parsePorts(String(fd.get("outputs") ?? "")),
      });
      state.chart = r.chart;
      state.drawing = false;
      state.selected = r.bubble.id;
      renderChart(true);
    });
  });
  return form;
}

function runPanel(run: { trace: RunTrace; current: number }) {
  const wrap = h("div", { class: "panel-body" });
  wrap.append(
    h("p", { class: "eyebrow" }, "Run · invented test data"),
    h("h2", {}, run.trace.scenario),
    h(
      "ol",
      { class: "run-steps" },
      ...run.trace.steps.map((s, i) => {
        const label = ghostLabel(s.nodeId);
        const n = currentChart()?.nodes.find((x) => x.id === s.nodeId);
        return h("li", { class: i === run.current ? "current" : i < run.current ? "done" : "" }, h("strong", {}, n?.name ?? label), h("code", {}, s.data), h("span", { class: "small muted" }, s.note));
      }),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => void playRun(run.trace) }, "Replay"),
      h(
        "button",
        {
          onclick: () => {
            view.stopRun();
            state.run = null;
            renderPanel();
          },
        },
        "Close",
      ),
    ),
  );
  requestAnimationFrame(() => wrap.querySelector(".current")?.scrollIntoView({ block: "nearest" }));
  return wrap;
}

async function playRun(trace: RunTrace) {
  state.run = { trace, current: 0 };
  renderPanel();
  await view.play(trace.steps, (i) => {
    if (state.run?.trace !== trace) return;
    state.run.current = i;
    renderPanel();
  });
  if (state.run?.trace === trace) {
    state.run.current = trace.steps.length;
    renderPanel();
  }
}

function historyPanel() {
  const name = state.project!;
  const wrap = h("div", { class: "panel-body" }, h("p", { class: "eyebrow" }, "Version history"), h("h2", {}, "Every change is a git commit"));
  const list = h("ol", { class: "history" }, h("li", { class: "muted" }, "Loading…"));
  wrap.append(list, h("div", { class: "actions" }, h("button", { onclick: () => ((state.history = false), renderPanel()) }, "Close")));
  api
    .history(name)
    .then((entries) => {
      list.replaceChildren(
        ...entries.map((e, i) =>
          h(
            "li",
            {},
            h("div", {}, h("strong", {}, e.message), h("span", { class: "small muted" }, `${new Date(e.date).toLocaleString()} · ${e.sha.slice(0, 7)}`)),
            i === 0
              ? h("span", { class: "badge" }, "current")
              : h(
                  "button",
                  {
                    onclick: () =>
                      void guard("Restoring…", async () => {
                        const r = await api.restore(name, e.sha);
                        state.chart = r.chart;
                        renderChart(true);
                        toast(`Restored "${e.message}". This is a new version, so you can undo it.`);
                      }),
                  },
                  "Restore",
                ),
          ),
        ),
      );
    })
    .catch((e) => list.replaceChildren(h("li", { class: "error" }, (e as Error).message)));
  return wrap;
}

function renderBanner() {
  const b = $("outside-banner");
  if (state.project && state.chart?.drawing && !state.drawingChart) {
    // The app stopped while this chart was being drawn.
    const name = state.project;
    b.hidden = false;
    b.replaceChildren(
      h("span", {}, h("strong", {}, "This chart wasn't finished"), ": the app stopped while it was being drawn from the code."),
      h(
        "button",
        {
          class: "primary ai",
          onclick: async () => {
            try {
              await api.redraw(name);
              startDrawingUi();
              renderBanner();
            } catch (e) {
              toast((e as Error).message, "error");
            }
          },
        },
        "Draw it again",
      ),
    );
    return;
  }
  const files = state.outside;
  b.hidden = !files.length || !state.project;
  if (b.hidden) return;
  const name = state.project!;
  b.replaceChildren(
    h("span", {}, h("strong", {}, `${files.length} file${files.length > 1 ? "s" : ""} changed outside the app`), `: ${files.slice(0, 4).join(", ")}${files.length > 4 ? "…" : ""}. Read the changes and update the chart?`),
    h(
      "button",
      {
        class: "primary ai",
        onclick: () =>
          void guard("Reading the changes…", async () => {
            const r = await api.sync(name);
            state.outside = [];
            renderBanner();
            applyResult(r, null);
          }),
      },
      "Update the chart",
    ),
    h(
      "button",
      {
        onclick: () =>
          void guard("Saving…", async () => {
            await api.acceptOutside(name);
            state.outside = [];
            renderBanner();
          }),
      },
      "Keep, don't update",
    ),
  );
}

async function connect(from: string, to: string) {
  $("connect-hint").hidden = true;
  const data = prompt(`What data passes from "${from}" to "${to}"? (e.g. Todo[])`, "");
  if (data === null) return view.setSelected(state.selected);
  await guard("Drawing arrow…", async () => applyResult(await api.addEdge(state.project!, state.level, { from, to, data }), null));
}

// ---------- new project + stack ----------

async function startStackChoice(name: string, idea: string) {
  show("stack-page");
  $("stack-title").textContent = "Pick a tech stack";
  $("stack-idea").textContent = `“${idea}”`;
  const opts = $("stack-options");
  opts.replaceChildren();
  $("gen-log").replaceChildren();
  renderCrumbs();
  const proposal = await guard("Picking a tech stack…", () => api.stack(name));
  if (!proposal) {
    opts.append(h("button", { onclick: () => void startStackChoice(name, idea) }, "Try again"));
    return;
  }
  const card = (s: Stack, recommended: boolean) =>
    h(
      "div",
      { class: `stack card${recommended ? " recommended" : ""}` },
      h("div", { class: "option-head" }, h("strong", {}, s.name), recommended && h("span", { class: "badge" }, "recommended")),
      h("p", { class: "small" }, `${s.language} · ${s.runtime}`),
      s.libraries.length ? h("p", { class: "small muted" }, `Libraries: ${s.libraries.join(", ")}`) : null,
      h("p", {}, s.reasoning),
      h("button", { class: recommended ? "primary ai" : "ai", onclick: () => void generate(name, s) }, "Build with this"),
    );
  opts.append(card(proposal.recommended, true), ...proposal.alternatives.map((s) => card(s, false)));
}

async function generate(name: string, stack: Stack) {
  $("stack-title").textContent = `Building with ${stack.name}`;
  $("stack-options").replaceChildren();
  const r = await guard("Drawing the chart…", () => api.generate(name, stack));
  if (!r) {
    $("stack-options").append(h("button", { onclick: () => void generate(name, stack) }, "Try again"));
    return;
  }
  state.chart = r.chart;
  history.replaceState(null, "", `/?p=${encodeURIComponent(name)}`);
  enterWorkspace();
  toast("Your app is drawn and its code is written. Double-click a module to open it.");
}

$("new-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const idea = ($("idea") as HTMLTextAreaElement).value.trim();
  const folder = ($("project-name") as HTMLInputElement).value.trim();
  void guard("Creating project…", async () => {
    const p = await api.create(folder, idea);
    state.project = p.name;
    state.chart = p.chart;
    subscribe(p.name);
    setBusy(null);
    await startStackChoice(p.name, idea);
  });
});

// ---------- open an existing folder ----------

const openResult = () => $("open-result");

function closeOpenResult() {
  openResult().replaceChildren();
}

async function browse(path: string | null) {
  let listing: FolderListing;
  try {
    listing = await api.browse(path);
  } catch (e) {
    toast((e as Error).message, "error");
    return;
  }
  ($("open-path") as HTMLInputElement).value = listing.display;
  const rows = listing.dirs.map((d) =>
    h(
      "li",
      {},
      h("button", { class: "folder", title: d.path, onclick: () => void browse(d.path) }, `📁 ${d.name}`),
      d.project && h("span", { class: "badge" }, "project"),
      d.project && h("button", { class: "small", onclick: () => void inspectFolder(d.path) }, "Open…"),
    ),
  );
  openResult().replaceChildren(
    h(
      "div",
      { class: "browser" },
      h(
        "div",
        { class: "browser-head" },
        listing.parent ? h("button", { title: "Up one folder", onclick: () => void browse(listing.parent) }, "↑ Up") : null,
        h("code", { class: "small" }, listing.display),
        h("span", { class: "spacer" }),
        h("button", { class: "primary", onclick: () => void inspectFolder(listing.path) }, "Open this folder…"),
        h("button", { onclick: closeOpenResult }, "Close"),
      ),
      rows.length ? h("ul", { class: "folder-list" }, ...rows) : h("p", { class: "muted small" }, "No folders in here."),
      listing.more ? h("p", { class: "muted small" }, "Only the first 500 folders are shown. Type the path above to go straight to one.") : null,
    ),
  );
}

async function inspectFolder(path: string) {
  const info = await guard("Looking at the folder…", () => api.inspectFolder(path));
  if (!info) return;
  ($("open-path") as HTMLInputElement).value = info.display;
  openResult().replaceChildren(inspectionCard(info));
}

function inspectionCard(info: FolderInspection) {
  const facts = [
    info.kind === "chart" ? "Chart Driven Development project" : "Codebase without a chart",
    info.git.repo ? `git repo${info.git.branch ? ` on "${info.git.branch}"` : ""}` : "not a git repo yet",
    `${info.files.toLocaleString()} file${info.files === 1 ? "" : "s"}`,
    info.languages.join(", "),
  ].filter(Boolean);
  const go = info.kind === "code" ? "Read the code and draw the chart" : info.known ? "Open" : "Add and open";
  return h(
    "div",
    { class: "inspect" },
    h("h3", {}, info.display),
    h("p", { class: "small muted" }, facts.join(" · ")),
    info.blocked
      ? h("p", { class: "error" }, info.blocked)
      : info.plan.length
        ? h("ul", { class: "plan small" }, ...info.plan.map((line) => h("li", {}, line)))
        : null,
    h(
      "div",
      { class: "actions" },
      !info.blocked && h("button", { class: "primary ai", onclick: () => void openFolder(info) }, go),
      info.blocked && h("button", { onclick: () => void inspectFolder(info.path) }, "Check again"),
      h("button", { onclick: closeOpenResult }, "Cancel"),
    ),
  );
}

async function openFolder(info: FolderInspection) {
  const label = info.kind === "code" ? "Starting…" : "Opening project…";
  const r = await guard(label, () => api.openPath(info.path));
  if (!r) return;
  closeOpenResult();
  ($("open-path") as HTMLInputElement).value = "";
  await openProject(r.name);
}

function findResults(r: FindResult) {
  const items = r.matches.map((m) =>
    h(
      "li",
      { class: "found" },
      h("div", {}, h("strong", {}, m.name), m.chart && h("span", { class: "badge" }, "chart project")),
      h("code", { class: "small muted" }, m.display),
      m.description && h("p", { class: "small" }, m.description),
      m.reason && h("p", { class: "small muted" }, m.reason),
      h("button", { class: "small", onclick: () => void inspectFolder(m.path) }, "Open…"),
    ),
  );
  return h(
    "div",
    { class: "find-results" },
    h(
      "p",
      { class: "small muted" },
      r.matches.length
        ? `Looked at ${r.searched} project folder${r.searched === 1 ? "" : "s"} in ${r.roots.join(", ")}. Best matches:`
        : `Looked at ${r.searched} project folder${r.searched === 1 ? "" : "s"} in ${r.roots.join(", ")} and none matched. Try other words, or use Browse.`,
    ),
    r.note && h("p", { class: "small muted" }, r.note),
    items.length ? h("ul", { class: "found-list" }, ...items) : null,
    h("div", { class: "actions" }, h("button", { onclick: closeOpenResult }, "Close")),
  );
}

$("open-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = ($("open-path") as HTMLInputElement).value.trim();
  if (!path) return void browse(null);
  void inspectFolder(path);
});
$("open-browse").addEventListener("click", () => void browse(($("open-path") as HTMLInputElement).value.trim() || null));
$("find-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ($("find-text") as HTMLInputElement).value.trim();
  if (!text) return;
  void guard("Looking for project folders…", async () => {
    openResult().replaceChildren(findResults(await api.find(text)));
  });
});

// ---------- assistant ----------

function openAssistant() {
  view.stopRun();
  state.run = null;
  state.drawing = false;
  state.history = false;
  state.design = false;
  state.assistant = true;
  renderPanel();
}

function assistantPanel() {
  const name = state.project!;
  const chat = chatFor(name);
  const wrap = h("div", { class: "panel-body assistant" });
  wrap.append(
    h(
      "div",
      { class: "assistant-head" },
      h("div", {}, h("p", { class: "eyebrow" }, "Assistant"), h("h2", {}, "Ask DeepSeek to work on this project")),
      h("button", { onclick: () => ((state.assistant = false), renderPanel()) }, "Close"),
    ),
    h("p", { class: "small muted" }, "It can read and change the code and the chart, look at versions, and run install/test/build. Other commands ask you first. Each answer is saved as one version you can undo."),
  );
  const log = h("div", { class: "chat-log" });
  if (!chat.items.length) log.append(h("p", { class: "muted small" }, 'Try: "add a priority to todos and show it in the list", or "run the tests".'));
  for (const it of chat.items) {
    if (it.kind === "user") log.append(h("div", { class: "msg user" }, it.text));
    else if (it.kind === "reply")
      log.append(h("div", { class: "msg reply" }, it.text, it.changed?.length ? h("p", { class: "small muted" }, `Saved as a new version · ${it.changed.join(", ")}`) : null));
    else if (it.kind === "activity") log.append(h("div", { class: `activity${it.ok ? "" : " failed"}` }, `${it.ok ? "→" : "✗"} ${it.text}`));
    else {
      const answer = (allow: boolean) => () =>
        api.approve(name, it.id, allow).catch((e) => toast((e as Error).message, "error"));
      log.append(
        h(
          "div",
          { class: "approval" },
          h("p", {}, "The assistant wants to run:"),
          h("code", {}, it.command),
          it.answer === undefined
            ? h("div", { class: "actions" }, h("button", { class: "primary", onclick: answer(true) }, "Allow once"), h("button", { onclick: answer(false) }, "Don't allow"))
            : h("p", { class: "small muted" }, it.answer ? "Allowed." : "Not allowed."),
        ),
      );
    }
  }
  if (chat.busy) log.append(h("div", { class: "activity working" }, h("span", { class: "spinner" }), " Working…"));
  wrap.append(log);

  const ta = h("textarea", { rows: 3, placeholder: "What should the assistant do?", disabled: chat.busy }) as HTMLTextAreaElement;
  ta.value = chat.draft;
  ta.addEventListener("input", () => (chat.draft = ta.value));
  const b = currentBubble();
  const send = () => {
    const text = ta.value.trim();
    if (!text || chat.busy) return;
    const context = b ? `[Selected bubble: ${b.name} (id "${b.id}") at level "${state.level}"]` : state.level !== "root" ? `[Looking at module "${state.level}"]` : undefined;
    chat.items.push({ kind: "user", text });
    chat.draft = "";
    chat.busy = true;
    renderPanel();
    api
      .assistant(name, text, context)
      .then((r) => chat.items.push({ kind: "reply", text: r.reply, changed: r.committed ? r.changed : [] }))
      .catch((e) => chat.items.push({ kind: "reply", text: `Error: ${(e as Error).message}` }))
      .finally(() => {
        chat.busy = false;
        if (state.project === name && state.assistant) renderPanel();
      });
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  wrap.append(
    h(
      "div",
      { class: "chat-input" },
      b ? h("p", { class: "small muted" }, `About: ${b.name}`) : null,
      ta,
      h(
        "div",
        { class: "actions" },
        chat.busy
          ? h("button", { onclick: () => void api.cancelAssistant(name).catch((e) => toast((e as Error).message, "error")) }, "Stop")
          : h("button", { class: "primary", onclick: send }, "Send"),
        h(
          "button",
          {
            class: "link",
            disabled: chat.busy,
            onclick: () =>
              void api.resetAssistant(name).then(() => {
                chat.items = [];
                renderPanel();
              }),
          },
          "New conversation",
        ),
      ),
    ),
  );
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
    if (!chat.busy) ta.focus();
  });
  return wrap;
}

// ---------- design: style guide, references, mockups, screenshots ----------

function openDesign() {
  view.stopRun();
  state.run = null;
  state.drawing = false;
  state.history = false;
  state.assistant = false;
  state.design = true;
  renderPanel();
}

function designImg(stored: string, alt: string, version = "") {
  const src = api.designImage(state.project!, stored, version);
  return h("img", { src, alt, loading: "lazy", class: "shot", title: "Click to enlarge", onclick: () => lightbox(src, alt) });
}

function lightbox(src: string, alt: string) {
  const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", esc);
  };
  const overlay = h("div", { class: "lightbox", role: "dialog", "aria-label": alt, onclick: close }, h("img", { src, alt }), h("p", {}, alt, " · click anywhere to close"));
  document.addEventListener("keydown", esc);
  document.body.append(overlay);
}

/** Mockups that show this bubble, newest first. */
function mockupsFor(id: string): Mockup[] {
  return (state.designData?.mockups ?? []).filter((m) => m.bubbleIds.includes(id) || m.crops[id]);
}

/** On a bubble: its real screenshot, its part of recent mockups, and a mockup request box. */
function screenSection(b: Bubble) {
  const name = state.project!;
  const box = h("div", { class: "screen" });
  if (!b.gui) {
    box.append(
      h("h4", {}, "Screen"),
      h("p", { class: "small muted" }, "This bubble isn't marked as showing UI."),
      h("button", { class: "link", onclick: () => void guard("Saving…", async () => applyResult(await api.setGui(name, state.level, b.id, {}), b.id)) }, "It shows UI: add screenshots"),
    );
    return box;
  }
  const shot = state.designData?.screenshots[`${state.level}/${b.id}`];
  box.append(h("h4", {}, "Screen"));
  if (shot) {
    box.append(
      designImg(shot.image, `${b.name}, running app`, shot.takenAt),
      h("p", { class: "small muted" }, `From the running app, ${new Date(shot.takenAt).toLocaleString()}${shot.cropped ? "" : " (whole page: its element wasn't found)"}`),
    );
  } else box.append(h("p", { class: "small muted" }, "No screenshot yet."));
  const run = state.chart?.stack?.runCommand || "npm start";
  box.append(
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          title: `Starts your app with "${run}" if it isn't running, then captures this part`,
          onclick: () =>
            void guard(`Taking a screenshot of ${b.name}…`, async () => {
              await api.screenshot(name, state.level, b.id);
              state.designData = await api.design(name);
              renderPanel();
            }),
        },
        shot ? "Retake screenshot" : "Take screenshot",
      ),
      h("button", { class: "link", onclick: () => openDesign() }, "Design…"),
    ),
    h("p", { class: "small muted" }, `Starts the app (${run}) if it isn't running.`),
  );
  const ms = mockupsFor(b.id).slice(0, 3);
  for (const m of ms) {
    box.append(
      h("div", { class: "mock-crop" }, designImg(m.crops[b.id] ?? m.image, `${b.name} in mockup "${m.title}"`, m.created), h("p", { class: "small" }, h("strong", {}, "Mockup: "), m.title)),
    );
  }
  const ta = h("textarea", { rows: 2, placeholder: `Ask for a mockup of ${b.name}, e.g. "make it calmer, bigger tap targets"` }) as HTMLTextAreaElement;
  ta.value = state.designDraft;
  ta.addEventListener("input", () => (state.designDraft = ta.value));
  box.append(
    ta,
    h("div", { class: "actions" }, h("button", { class: "primary ai", onclick: () => requestMockup(ta.value, [b.id]) }, "Make a mockup")),
    h(
      "details",
      { class: "gui-edit" },
      h("summary", { class: "small muted" }, "Where it shows"),
      guiForm(b),
    ),
  );
  return box;
}

function guiForm(b: Bubble) {
  const name = state.project!;
  const route = h("input", { value: b.gui?.route ?? "/", placeholder: "/" }) as HTMLInputElement;
  const selector = h("input", { value: b.gui?.selector ?? "", placeholder: `[data-bubble="${b.id}"]` }) as HTMLInputElement;
  const form = h(
    "form",
    { class: "stack-form" },
    h("label", {}, "Page path", route),
    h("label", {}, "Element (CSS selector)", selector),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit" }, "Save"),
      h("button", { type: "button", class: "danger-link", onclick: () => void guard("Saving…", async () => applyResult(await api.setGui(name, state.level, b.id, null), b.id)) }, "Not UI"),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void guard("Saving…", async () => applyResult(await api.setGui(name, state.level, b.id, { route: route.value, selector: selector.value }), b.id));
  });
  return form;
}

function requestMockup(text: string, bubbleIds: string[]) {
  const name = state.project!;
  const request = text.trim();
  if (!request) return toast("Describe the design you want first.");
  void guard("Drawing a mockup…", async () => {
    const m = await api.mockup(name, request, bubbleIds);
    state.designDraft = "";
    state.designData = await api.design(name);
    renderPanel();
    toast(`Mockup ready: ${m.title}`);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file"));
    r.readAsDataURL(file);
  });
}

function uploadReference(file: File | undefined | null) {
  const name = state.project!;
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast("Use a PNG, JPEG, WebP or GIF image.", "error");
  if (file.size > 8 * 1024 * 1024) return toast("Images can be up to 8 MB.", "error");
  void guard("Looking at the reference image…", async () => {
    const r = await api.addReference(name, await readAsDataUrl(file), state.refNote);
    state.refNote = "";
    state.designData = r.design;
    renderPanel();
    toast("Reference added. The style guide was updated from it.");
  });
}

function styleBox(d: DesignState) {
  const name = state.project!;
  const s = d.style;
  const box = h("div", { class: "style-guide" }, h("h3", {}, "Style guide"));
  if (!s) {
    box.append(h("p", { class: "small muted" }, "No style yet. Add a reference image or ask for a mockup of a new look, and the AI writes one."));
    return box;
  }
  box.append(h("p", {}, s.summary));
  box.append(
    h(
      "div",
      { class: "swatches" },
      ...s.colors.map((c) => {
        const chip = h("span", { class: "chip" });
        chip.style.background = c.value;
        return h("div", { class: "swatch", title: c.use ?? c.name }, chip, h("span", { class: "small" }, c.name), h("code", {}, c.value));
      }),
    ),
  );
  if (s.fonts.length) box.append(h("p", { class: "small" }, ...s.fonts.flatMap((f, i) => [i ? " · " : "", h("strong", {}, f.role), ` ${f.family}`])));
  const meta = [s.radius && `corners ${s.radius}`, s.spacing, s.mood.join(", ")].filter(Boolean).join(" · ");
  if (meta) box.append(h("p", { class: "small muted" }, meta));
  if (s.rules.length) box.append(h("ul", { class: "rules small" }, ...s.rules.map((r) => h("li", {}, r))));
  box.append(
    h("button", { title: "Ask the AI to restyle the app's code to match this style guide", onclick: () => void guard("Applying the style guide to the code…", async () => applyResult(await api.applyDesign(name, null), null)) }, "Apply style to the code"),
  );
  return box;
}

function designPanel() {
  const name = state.project!;
  const d = state.designData ?? { style: null, references: [], mockups: [], screenshots: {}, appUrl: null };
  const b = currentBubble();
  const wrap = h("div", { class: "panel-body design" });
  wrap.append(
    h(
      "div",
      { class: "assistant-head" },
      h("div", {}, h("p", { class: "eyebrow" }, "Design"), h("h2", {}, "How the app looks")),
      h("button", { onclick: () => ((state.design = false), renderPanel()) }, "Close"),
    ),
    styleBox(d),
  );

  // Ask for a mockup
  const ta = h("textarea", { rows: 3, placeholder: 'e.g. "a dark theme with a teal accent" or "a denser list for power users"' }) as HTMLTextAreaElement;
  ta.value = state.designDraft;
  ta.addEventListener("input", () => (state.designDraft = ta.value));
  const focus = b?.gui ? (h("input", { type: "checkbox", checked: true }) as HTMLInputElement) : null;
  wrap.append(
    h(
      "div",
      { class: "ask" },
      h("h3", {}, "Ask for a mockup"),
      ta,
      focus ? h("label", { class: "small check" }, focus, ` Focus on ${b!.name}`) : null,
      h("button", { class: "primary ai", onclick: () => requestMockup(ta.value, focus?.checked && b ? [b.id] : []) }, "Make a mockup"),
    ),
  );

  // Mockups
  const mocks = h("div", { class: "mockups" }, h("h3", {}, `Mockups${d.mockups.length ? ` (${d.mockups.length})` : ""}`));
  if (!d.mockups.length) mocks.append(h("p", { class: "small muted" }, "None yet."));
  for (const m of d.mockups) {
    mocks.append(
      h(
        "div",
        { class: "mockup card" },
        designImg(m.image, m.title, m.created),
        h("p", {}, h("strong", {}, m.title)),
        m.summary ? h("p", { class: "small" }, m.summary) : null,
        m.style ? h("p", { class: "small muted" }, "Proposes a new style guide.") : null,
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            {
              class: "primary",
              title: m.style ? "Makes its style the project's style guide and restyles the code" : "Restyles the code to match",
              onclick: () => void guard(`Applying "${m.title}"…`, async () => applyResult(await api.applyDesign(name, m.id), null)),
            },
            "Apply to the code",
          ),
          h(
            "button",
            {
              class: "danger-link",
              onclick: () => {
                if (!confirm(`Delete the mockup "${m.title}"? You can undo this.`)) return;
                void guard("Deleting…", async () => {
                  state.designData = await api.removeMockup(name, m.id);
                  renderPanel();
                });
              },
            },
            "Delete",
          ),
        ),
      ),
    );
  }
  wrap.append(mocks);

  // References
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true }) as HTMLInputElement;
  file.addEventListener("change", () => uploadReference(file.files?.[0]));
  const note = h("input", { placeholder: 'What you like about it (optional), e.g. "the colors"' }) as HTMLInputElement;
  note.value = state.refNote;
  note.addEventListener("input", () => (state.refNote = note.value));
  const drop = h(
    "div",
    { class: "dropzone", tabindex: 0, role: "button", onclick: () => file.click(), onkeydown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && file.click() },
    "Drop an image here, paste one, or click to choose",
  );
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    uploadReference(e.dataTransfer?.files[0]);
  });
  const refs = h("div", { class: "references" }, h("h3", {}, "Reference images"), h("p", { class: "small muted" }, "Show the AI a look you like. It reads the image and updates the style guide."), note, drop, file);
  for (const r of d.references) {
    refs.append(
      h(
        "div",
        { class: "reference" },
        designImg(r.image, r.note || "Reference image", r.created),
        h(
          "div",
          {},
          r.note ? h("p", { class: "small" }, h("strong", {}, r.note)) : null,
          h("p", { class: "small muted" }, r.description),
          h(
            "button",
            { class: "danger-link", onclick: () => void guard("Removing…", async () => ((state.designData = await api.removeReference(name, r.id)), renderPanel())) },
            "Remove",
          ),
        ),
      ),
    );
  }
  wrap.append(refs);

  // App address
  const url = h("input", { value: d.appUrl ?? "", placeholder: state.chart?.stack?.appUrl ?? "http://localhost:3000" }) as HTMLInputElement;
  const urlForm = h(
    "form",
    { class: "app-url" },
    h("h3", {}, "App address for screenshots"),
    h("p", { class: "small muted" }, "Leave empty to use the address the app prints when it starts."),
    h("div", { class: "row" }, url, h("button", { type: "submit" }, "Save")),
  );
  urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void guard("Saving…", async () => {
      state.designData = await api.setAppUrl(name, url.value);
      renderPanel();
      toast("Saved.");
    });
  });
  wrap.append(urlForm);
  return wrap;
}

// Paste an image anywhere while the design panel is open → reference.
document.addEventListener("paste", (e) => {
  if (!state.design || !state.project) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  if (item) {
    e.preventDefault();
    uploadReference(item.getAsFile());
  }
});

// ---------- toolbar ----------

$("home-link").addEventListener("click", () => void goHome());
$("btn-up").addEventListener("click", () => openLevel("root"));
$("btn-draw").addEventListener("click", () => {
  view.stopRun();
  state.run = null;
  state.history = false;
  state.assistant = false;
  state.design = false;
  state.drawing = true;
  renderPanel();
  ($("panel").querySelector("input") as HTMLInputElement | null)?.focus();
});
$("btn-run").addEventListener("click", () => {
  const name = state.project;
  if (!name) return;
  void guard("Inventing test data…", async () => {
    const trace = await api.run(name, state.level);
    if (!trace.steps.length) return toast("Nothing to run at this level yet.");
    void playRun(trace);
  });
});
$("btn-undo").addEventListener("click", () => {
  const name = state.project;
  if (!name) return;
  void guard("Undoing…", async () => {
    const r = await api.undo(name);
    state.chart = r.chart;
    state.rec = null;
    state.lastResult = null;
    renderChart(true);
    toast("Undone. The previous version of the code and chart is back.");
  });
});
$("btn-assistant").addEventListener("click", () => (state.assistant ? ((state.assistant = false), renderPanel()) : openAssistant()));
$("btn-design").addEventListener("click", () => (state.design ? ((state.design = false), renderPanel()) : openDesign()));
$("btn-folder").addEventListener("click", () => {
  const name = state.project;
  if (name) api.openFolder(name).then((r) => toast(r.message), (e) => toast((e as Error).message, "error"));
});
$("btn-history").addEventListener("click", () => {
  view.stopRun();
  state.run = null;
  state.drawing = false;
  state.assistant = false;
  state.design = false;
  state.history = !state.history;
  renderPanel();
});
$("btn-fit").addEventListener("click", () => view.fit());
$("btn-zoom-in").addEventListener("click", () => view.zoomBy(1.2));
$("btn-zoom-out").addEventListener("click", () => view.zoomBy(1 / 1.2));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    view.connectFrom = null;
    $("connect-hint").hidden = true;
    view.setSelected(state.selected);
  }
});
window.addEventListener("resize", () => !$("workspace").hidden && view.fit());

// ---------- boot ----------

// ---------- settings ----------

function refreshInfo() {
  return api
    .info()
    .then((i) => {
      $("ai-label").textContent = `AI: ${i.ai}`;
      $("key-banner").hidden = !i.needsKey;
    })
    .catch(() => undefined);
}

let beforeSettings: (() => void) | null = null;

async function openSettings() {
  const wasWorkspace = !$("workspace").hidden && state.project;
  beforeSettings = wasWorkspace ? () => (show("workspace"), renderChart(true)) : () => void goHome();
  show("settings-page");
  $("settings-result").textContent = "";
  ($("set-key") as HTMLInputElement).value = "";
  try {
    renderSettings(await api.settings());
  } catch (e) {
    $("settings-status").replaceChildren(h("p", { class: "error" }, (e as Error).message));
  }
  ($("set-key") as HTMLInputElement).focus();
}

function renderSettings(s: import("./api.ts").SettingsStatus) {
  $("settings-file").textContent = s.file;
  $("settings-model").textContent = s.model;
  const line = s.mock
    ? "The app is running in mock mode (CDD_AI=mock), so no key is used until you restart it normally."
    : s.keySource === "settings"
      ? `Using the key saved here (ending ${s.keyHint}).`
      : s.keySource === "env"
        ? `Using DEEPSEEK_API_KEY from .env / environment (ending ${s.keyHint}). A key saved here takes priority.`
        : "No key yet.";
  $("settings-status").replaceChildren(h("p", { class: s.hasKey || s.mock ? "ok" : "warn" }, line));
  $("set-remove").hidden = s.keySource !== "settings";
}

function settingsResult(text: string, ok: boolean) {
  const r = $("settings-result");
  r.textContent = text;
  r.className = `small ${ok ? "ok" : "error"}`;
}

$("btn-settings").addEventListener("click", () => void openSettings());
$("key-banner-btn").addEventListener("click", () => void openSettings());
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = ($("set-key") as HTMLInputElement).value.trim();
  if (!key) return settingsResult("Paste a key first.", false);
  void guard("Checking the key…", async () => {
    // Check a new key BEFORE saving it, so a typo never replaces a working key.
    // Refuse only a key DeepSeek says is wrong (401); no balance or no network isn't the key's fault.
    const t = await api.testKey(key);
    if (t.invalid) return settingsResult(`Not saved: ${t.message}`, false);
    const note = t.ok ? "" : t.message;
    const s = await api.saveSettings({ deepseekApiKey: key });
    ($("set-key") as HTMLInputElement).value = "";
    renderSettings(s);
    await refreshInfo();
    if (note) settingsResult(`Saved. Note: ${note}`, false);
    else settingsResult("The key works and is saved.", true);
  });
});
$("set-done").addEventListener("click", () => beforeSettings?.());
$("set-test").addEventListener("click", () => {
  const key = ($("set-key") as HTMLInputElement).value.trim();
  void guard("Testing…", async () => {
    const t = await api.testKey(key || undefined);
    settingsResult(t.message, t.ok);
  });
});
$("set-remove").addEventListener("click", () => {
  if (!confirm("Remove the DeepSeek key saved in the app?")) return;
  void guard("Removing…", async () => {
    renderSettings(await api.saveSettings({ deepseekApiKey: "" }));
    await refreshInfo();
    settingsResult("Removed.", true);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settings-page").hidden) beforeSettings?.();
});

void refreshInfo();
const initial = new URLSearchParams(location.search).get("p");
if (initial) void openProject(initial).then(() => {
    if (!state.project) void goHome();
  });
else void goHome();

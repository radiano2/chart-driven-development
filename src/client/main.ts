import { BUSINESS_LEVEL, businessChart } from "../shared/business.ts";
import { getLevel } from "../shared/chart.ts";
import type { Bubble, BusinessState, BusinessStep, Chart, DesignState, FindResult, FolderInspection, FolderListing, Level, Mockup, Port, ProjectChart, ProjectSummary, Recommendation, RunChatMessage, RunTrace, ServerEvent, Stack } from "../shared/types.ts";
import { api, type ChangeResult } from "./api.ts";
import { ChartView, type NodeDecor } from "./chart-view.ts";
import { allKeys, pendingSteps, revealKey, stepPause, visiblePart } from "./reveal.ts";

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
  run: RunState | null;
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
  /** Which chart the board shows: the functional chart (editable) or the business flow (read-only). */
  view: "functional" | "business";
  business: BusinessState | null;
  /** The "what should the AI draw?" card is on the empty board. */
  choosing: boolean;
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
  view: "functional",
  business: null,
  choosing: false,
};

let events: EventSource | null = null;

/** One message in the run chat, in the order things happened. */
type RunItem = { kind: "intro" } | { kind: "step"; i: number } | { kind: "summary" } | { kind: "q"; text: string } | { kind: "a"; text: string; failed?: boolean };
interface RunState {
  trace: RunTrace;
  level: Level;
  /** The step being shown; steps.length once the run is over. */
  current: number;
  items: RunItem[];
  playing: boolean;
  paused: boolean;
  /** Waiting for an answer to a question. */
  asking: boolean;
  draft: string;
}

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
    void openLevel(id);
  },
  onConnect(from, to) {
    void connect(from, to);
  },
  ghostLabel,
  onGhost(ref) {
    const mod = ref.split("/")[0];
    if (state.chart?.root.nodes.some((n) => n.id === mod)) void openLevel(mod, ref.split("/")[1]);
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
  if (reveal) {
    stopReveal();
    setBusy(null);
  }
  if (state.drawingChart) {
    state.drawingChart = false;
    setBusy(null);
  }
  state.project = null;
  state.chart = null;
  state.view = "functional";
  state.business = null;
  state.choosing = false;
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
  const remove = h("button", { class: "link small forget", title: "Remove this project from the list, or delete it", onclick: () => removeDialog(p) }, "Remove…");
  return h("div", { class: "project-item" }, card, remove);
}

/** Ask how to remove a project. Taking it off the list is the default and loses nothing; deleting needs the name typed. */
function removeDialog(p: ProjectSummary) {
  const keepText = p.linked
    ? `Its folder ${p.dir ?? ""} stays exactly as it is. You can open it again any time.`
    : "Its folder is moved to projects/.removed, so nothing is lost. Move it back to restore it.";
  let mode: "list" | "delete" = "list";
  const typed = h("input", { placeholder: p.name, autocomplete: "off", spellcheck: "false", "aria-label": "Type the project's name to confirm" }) as HTMLInputElement;
  const confirmRow = h("label", { class: "confirm-name", hidden: true }, `Type ${p.name} to confirm`, typed);
  const go = h("button", { class: "primary" }, "Remove from list") as HTMLButtonElement;
  const update = () => {
    confirmRow.hidden = mode !== "delete";
    go.textContent = mode === "delete" ? "Delete for good" : "Remove from list";
    go.className = mode === "delete" ? "primary danger" : "primary";
    go.disabled = mode === "delete" && typed.value.trim() !== p.name;
  };
  const option = (value: "list" | "delete", title: string, text: string, warn = false) =>
    h(
      "label",
      { class: `remove-option${warn ? " warn" : ""}` },
      h("input", { type: "radio", name: "remove-mode", value, checked: value === "list", onchange: () => ((mode = value), update(), value === "delete" && typed.focus()) }),
      h("span", {}, h("strong", {}, title), h("span", { class: "small muted" }, text)),
    );
  const close = () => overlay.remove();
  const overlay = h(
    "div",
    { class: "modal-overlay", onclick: (e: Event) => e.target === overlay && close() },
    h(
      "div",
      { class: "modal card", role: "dialog", "aria-modal": "true", "aria-label": `Remove ${p.name}` },
      h("h2", {}, `Remove ${p.name}?`),
      option("list", "Remove from the list", keepText),
      p.missing
        ? null
        : option(
            "delete",
            "Delete the folder from disk",
            `Deletes ${p.linked ? p.dir : "the project's folder"} with all its code, chart and version history. This can't be undone.`,
            true,
          ),
      confirmRow,
      h(
        "div",
        { class: "actions" },
        go,
        h("button", { onclick: close }, "Cancel"),
      ),
    ),
  );
  typed.addEventListener("input", update);
  typed.addEventListener("keydown", (e) => e.key === "Enter" && go.click());
  go.addEventListener("click", () => {
    if (go.disabled) return;
    go.disabled = true;
    api
      .remove(p.name, mode === "delete", typed.value.trim())
      .then((r) => {
        close();
        toast(r.message);
        void goHome();
      })
      .catch((e) => {
        go.disabled = false;
        toast((e as Error).message, "error");
      });
  });
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.body.append(overlay);
  update();
  (overlay.querySelector("input[type=radio]") as HTMLInputElement | null)?.focus();
}

function subscribe(name: string) {
  events?.close();
  events = api.events(name, (ev) => onServerEvent(name, ev));
}

function onServerEvent(project: string, ev: ServerEvent) {
  if (project !== state.project) return;
  if (ev.type === "progress") {
    if (state.busy && ev.message !== "Done") $("status-text").textContent = ev.message;
    if (reveal && ev.module) {
      reveal.aiModule = ev.module;
      reveal.wake?.();
    }
    const log = $("gen-log");
    if (!$("stack-page").hidden && ev.message !== "Done") log.append(h("li", {}, ev.message));
  } else if (ev.type === "chart") {
    if (reveal) return feedReveal(ev.chart);
    if (generating === project && $("workspace").hidden && ev.chart.root.nodes.length) {
      // A new project's chart is ready (its code is still being written): draw it on the board now.
      state.chart = ev.chart;
      history.replaceState(null, "", `/?p=${encodeURIComponent(project)}`);
      enterWorkspace(true);
      startReveal(ev.chart, false);
      return;
    }
    state.chart = ev.chart;
    if (!$("workspace").hidden) renderChart(true, true);
  } else if (ev.type === "drawn") {
    const extra = ev.warnings.length ? ` ${ev.warnings.length} note${ev.warnings.length === 1 ? "" : "s"}: ${ev.warnings.slice(0, 2).join(" ")}${ev.warnings.length > 2 ? " …" : ""}` : "";
    const done = () => toast(`The chart is drawn. ${ev.summary} Double-click a module to open it.${extra}`, ev.warnings.length ? "error" : "info");
    if (reveal) return finishReveal(ev.chart, () => (stopDrawingUi(), done()));
    state.chart = ev.chart;
    stopDrawingUi();
    if (!$("workspace").hidden) renderChart(true, true);
    done();
  } else if (ev.type === "draw-failed") {
    stopReveal();
    stopDrawingUi();
    toast(`Couldn't draw the chart: ${ev.message} The board is back to empty and your code wasn't touched. You can try again.`, "error");
    api
      .open(project)
      .then((d) => {
        if (state.project !== project) return;
        state.chart = d.chart;
        state.business = d.business;
        if (!$("workspace").hidden) renderChart();
        offerChoice();
      })
      .catch(() => void goHome());
  } else if (ev.type === "business") {
    const was = state.business;
    state.business = ev.business;
    if (ev.business.status === "failed" && was?.status !== "failed") toast(`Couldn't draw the business flow: ${ev.business.error}`, "error");
    if ($("workspace").hidden) return;
    if (state.view === "business") {
      // A run follows the flow it started on; a rebuilt flow shows once it's closed.
      if (!state.run) renderChart(true, was?.flow?.updated !== ev.business.flow?.updated);
      else renderPanel();
    }
    renderToolbar();
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
  state.business = data.business;
  state.view = "functional";
  if (!data.chart.root.nodes.length && !data.drawing && !data.chart.drawing && !data.chart.undrawn) return startStackChoice(name, data.chart.idea);
  history.replaceState(null, "", `/?p=${encodeURIComponent(name)}`);
  state.drawingChart = data.drawing;
  // Code opened without a functional chart: show its business flow if it has one (or one is on the way).
  const biz = data.business;
  state.view = data.chart.undrawn && !data.drawing && (biz.flow || biz.status === "building") ? "business" : "functional";
  enterWorkspace(data.drawing);
  if (data.drawing) startDrawingUi(true);
  else offerChoice();
  if (state.view === "business") refreshBusiness();
}

/** Plain code with nothing drawn yet: ask what to draw, on the empty board. */
function offerChoice() {
  const b = state.business;
  state.choosing = !!state.chart?.undrawn && !state.drawingChart && !b?.flow && b?.status !== "building" && b?.status !== "updating";
  renderChoice();
}

function renderChoice() {
  const box = $("choice");
  box.hidden = !state.choosing || $("workspace").hidden;
  if (box.hidden) return box.replaceChildren();
  const option = (label: string, text: string, onclick: () => void, extra = "") => h("button", { class: extra, onclick }, h("strong", {}, label), h("span", {}, text));
  box.replaceChildren(
    h(
      "div",
      { class: "choice", role: "dialog", "aria-labelledby": "choice-title" },
      h("p", { class: "eyebrow" }, "The project is open"),
      h("h2", { id: "choice-title" }, "What should the AI draw?"),
      h("p", { class: "muted" }, "Nothing is drawn yet, and your code hasn't been changed. Pick one now, or later: both stay available on the board."),
      h(
        "div",
        { class: "choice-options" },
        option("Nothing for now", "Keep the board empty. You can draw either chart from here any time.", () => {
          state.choosing = false;
          renderChoice();
          renderChart();
        }),
        option("Functional chart", "Modules and functions: where the data goes, how it's processed and in what order. You can keep building on it with the AI.", () => void drawFunctional(), "recommended"),
        option("Business flow", "What a user does and what each action leads to in the program: where data comes in, where it's processed and where results come out. Read-only: it updates itself when the code changes.", () => void drawBusiness()),
      ),
    ),
  );
  (box.querySelector(".choice-options button.recommended") as HTMLButtonElement | null)?.focus();
}

/** Draw the functional chart of code that was opened without one. */
async function drawFunctional() {
  const name = state.project;
  if (!name) return;
  const ok = await guard("Starting…", () => api.redraw(name));
  if (!ok || state.project !== name) return;
  state.choosing = false;
  renderChoice();
  if (state.view !== "functional") setView("functional");
  startDrawingUi();
  renderBanner();
}

/** Make the business flow (the first time, or after it failed). */
async function drawBusiness() {
  const name = state.project;
  if (!name) return;
  const st = await guard("Starting…", () => api.buildBusiness(name));
  if (!st || state.project !== name) return;
  state.business = st;
  state.choosing = false;
  renderChoice();
  if (state.view !== "business") setView("business");
  else renderChart();
}

/** Ask for the business flow; the server rebuilds it first if the code changed. */
function refreshBusiness() {
  const name = state.project;
  if (!name) return;
  api
    .business(name)
    .then((st) => {
      if (state.project !== name) return;
      const changed = st.status !== state.business?.status || st.flow?.updated !== state.business?.flow?.updated;
      state.business = st;
      if (changed && state.view === "business" && !state.run && !$("workspace").hidden) renderChart(true);
      renderToolbar();
    })
    .catch(() => undefined);
}

/** Switch the board between the functional chart and the business flow. */
function setView(v: State["view"]) {
  if (v === state.view || moving) return;
  // The live drawing keeps going on the functional chart; it just stops moving the view around.
  if (reveal?.follow) {
    reveal.follow = false;
    renderRevealBar();
  }
  view.stopRun();
  view.connectFrom = null;
  $("connect-hint").hidden = true;
  state.view = v;
  state.level = "root";
  state.selected = null;
  resetPanelState();
  renderChart(false, false, { how: "in" });
  if (v === "business") refreshBusiness();
}

/**
 * While the chart of an opened codebase is drawn: the board grows live, and editing waits until it's done.
 * `showExisting`: what was drawn before we got here (the project was opened mid-drawing) shows right away.
 */
function startDrawingUi(showExisting = false) {
  const name = state.project;
  state.drawingChart = true;
  setBusy("Reading the code…");
  if (state.chart) startReveal(state.chart, showExisting);
  // Events only flow from when we subscribed: if the drawing ended just before that, catch up now.
  if (name)
    api
      .open(name)
      .then((d) => {
        if (state.project !== name || !state.drawingChart || d.drawing) return;
        finishReveal(d.chart, () => stopDrawingUi());
      })
      .catch(() => undefined);
}

function stopDrawingUi() {
  if (!state.drawingChart) return;
  state.drawingChart = false;
  if (!reveal) setBusy(null);
  renderBanner();
}

// ---------- drawing the chart live ----------

/**
 * The AI hands back many bubbles at once; the board shows them one by one, at a steady pace, so the chart looks
 * like it's being drawn in front of you. Each module opens (with the usual zoom) while its functions are drawn,
 * then the view goes back out to the modules and on to the next one. "Faster" and "Show all" are on the board.
 */
interface Reveal {
  /** The whole chart so far, as the server sent it. */
  target: ProjectChart;
  /** What is on the board already (keys from reveal.ts). */
  visible: Set<string>;
  speed: number;
  /** Open each module as it's drawn. Turned off when you go somewhere yourself. */
  follow: boolean;
  /** Show everything as soon as it arrives (the "Show all" button). */
  instant: boolean;
  /** The server has sent the finished chart: end once everything is on the board. */
  done: (() => void) | null;
  /** The module the AI is drawing right now, if we know it. */
  aiModule: string | null;
  /** Wakes the loop when new parts of the chart arrive. */
  wake: (() => void) | null;
}

let reveal: Reveal | null = null;
const SPEEDS = [1, 2, 4];
/** How long a level takes to settle after a zoom (chart-view's "settle"); drawing on it sooner cuts that short. */
const SETTLE_MS = 620;

function startReveal(target: ProjectChart, showExisting: boolean) {
  stopReveal();
  const r: Reveal = { target, visible: showExisting ? allKeys(target) : new Set(), speed: 1, follow: true, instant: false, done: null, aiModule: null, wake: null };
  reveal = r;
  state.chart = visiblePart(target, r.visible);
  if (!state.busy) setBusy("Drawing the chart…");
  renderChart(true);
  renderRevealBar();
  void runReveal(r);
}

/** Leave the chart as it is and drop the queue (leaving the project, or the drawing failed). */
function stopReveal() {
  if (!reveal) return;
  const r = reveal;
  reveal = null;
  r.wake?.();
  renderRevealBar();
}

function feedReveal(pc: ProjectChart) {
  if (!reveal) return;
  reveal.target = pc;
  reveal.wake?.();
}

/** The server is done: show the rest at the usual pace, then `then`. */
function finishReveal(pc: ProjectChart, then: () => void) {
  if (!reveal) {
    state.chart = pc;
    if (!$("workspace").hidden) renderChart(true, true);
    return then();
  }
  reveal.target = pc;
  reveal.done = then;
  if (state.busy) $("status-text").textContent = "Drawing the chart…";
  reveal.wake?.();
}

const sleep = (ms: number, alive: () => boolean) =>
  new Promise<void>((res) => {
    const end = Date.now() + ms;
    const tick = () => (!alive() || Date.now() >= end ? res() : setTimeout(tick, Math.min(80, end - Date.now())));
    tick();
  });

/** Move the view to `level` the way a person would: back out to the modules first, then into the next one. */
async function followTo(r: Reveal, level: Level) {
  const alive = () => reveal === r && r.follow;
  if (state.level !== "root") {
    await sleep(650 / r.speed, alive); // a moment to see the finished module
    if (!alive()) return;
    await openLevel("root", undefined, true);
    await sleep(SETTLE_MS, alive);
  }
  if (level !== "root" && alive() && state.level !== level) {
    await openLevel(level, undefined, true);
    await sleep(SETTLE_MS, alive);
  }
}

async function runReveal(r: Reveal) {
  const alive = () => reveal === r;
  while (alive()) {
    const next = pendingSteps(r.target, r.visible);
    if (r.instant && next.length) {
      for (const s of next) r.visible.add(s.key);
      showRevealed(r);
      continue;
    }
    const step = next[0];
    if (!step) {
      if (r.done) break;
      // Nothing to show yet: the AI is still working. Go and wait inside the module it's drawing.
      const mod = r.aiModule;
      if (r.follow && mod && mod !== state.level && r.visible.has(revealKey("root", "node", mod))) {
        await followTo(r, mod);
        continue;
      }
      await new Promise<void>((res) => (r.wake = res));
      r.wake = null;
      continue;
    }
    if (r.follow && step.level !== state.level) {
      await followTo(r, step.level);
      if (!alive()) return;
      if (r.follow && step.level !== state.level) {
        await sleep(120, alive); // a click got in the way; look again
        continue;
      }
    }
    r.visible.add(step.key);
    showRevealed(r);
    // Off-screen steps (you went elsewhere) still take their turn, but quickly.
    await sleep((step.level === state.level ? stepPause(step) : 60) / r.speed, alive);
  }
  if (!alive()) return;
  if (r.follow && state.level !== "root") {
    await sleep(700 / r.speed, alive);
    if (alive() && r.follow) {
      await openLevel("root", undefined, true);
      await sleep(SETTLE_MS, alive);
    }
  }
  if (!alive()) return;
  reveal = null;
  state.chart = r.target;
  if (!$("workspace").hidden) renderChart(true, true);
  renderRevealBar();
  setBusy(null);
  r.done?.();
}

function showRevealed(r: Reveal) {
  // During a zoom only the data changes: the level drawn when the zoom ends shows it.
  state.chart = visiblePart(r.target, r.visible);
  if (!$("workspace").hidden && !moving) renderChart(true, true);
  renderRevealBar();
}

function renderRevealBar() {
  const bar = $("reveal-bar");
  const r = reveal;
  bar.hidden = !r;
  view.bottomInset = r ? 56 : 0;
  if (!r) return bar.replaceChildren();
  const total = allKeys(r.target).size;
  const shown = total - pendingSteps(r.target, r.visible).length;
  const waiting = !r.done && shown >= total;
  const parts: Child[] = [
    h("span", { class: "spinner" }),
    h("span", { class: "reveal-text" }, !total ? "The AI is reading the code…" : waiting ? "The AI is still working…" : "Drawing the chart", total ? h("span", { class: "muted" }, ` ${shown} of ${total}${r.done ? "" : "+"}`) : null),
    h("span", { class: "reveal-meter", "aria-hidden": "true" }, h("span", { style: `width:${total ? Math.round((shown / total) * 100) : 0}%` })),
    !r.follow &&
      h(
        "button",
        {
          title: "Open each module again as it's drawn",
          onclick: () => {
            if (state.view !== "functional") setView("functional");
            r.follow = true;
            r.wake?.();
            renderRevealBar();
          },
        },
        "Follow along",
      ),
    !r.instant &&
      h(
        "button",
        {
          title: "Change the drawing speed",
          onclick: () => {
            r.speed = SPEEDS[(SPEEDS.indexOf(r.speed) + 1) % SPEEDS.length];
            renderRevealBar();
          },
        },
        `Speed ${r.speed}×`,
      ),
    !r.instant &&
      h(
        "button",
        {
          title: "Put everything on the board now",
          onclick: () => {
            r.instant = true;
            r.follow = false;
            r.wake?.();
            renderRevealBar();
          },
        },
        "Show all",
      ),
  ];
  bar.replaceChildren(...parts.filter((p): p is Node => !!p));
}

/** `live`: the chart is about to be drawn step by step, so don't draw what's there yet. */
function enterWorkspace(live = false) {
  state.level = "root";
  state.selected = null;
  state.choosing = false;
  resetPanelState();
  show("workspace");
  renderChoice();
  if (!live || state.view === "business") renderChart();
  renderToolbar();
  renderBanner();
}

/** Toolbar buttons that fit the chart on the board: the business flow can only be looked at and run. */
function renderToolbar() {
  const biz = state.view === "business";
  // Nothing to build on until the functional chart is drawn (drawing it is offered on the board).
  const undrawn = !biz && !!state.chart?.undrawn;
  $("view-functional").setAttribute("aria-selected", String(!biz));
  $("view-business").setAttribute("aria-selected", String(biz));
  $("btn-up").hidden = biz || state.level === "root";
  $("btn-draw").hidden = biz || undrawn;
  $("btn-design").hidden = biz || undrawn;
  $("btn-run").hidden = biz ? !state.business?.flow : undrawn;
}

/** A level change in progress: ignore other clicks until its animation is done. */
let moving = false;

/**
 * Go to a level, zooming into the module's bubble (or pulling back out of it) on the way. `auto`: the live drawing
 * is moving the view; anything else is you, so the drawing stops following its modules.
 */
async function openLevel(level: Level, focus?: string, auto = false) {
  if (!auto && reveal?.follow && !moving && level !== state.level) {
    reveal.follow = false;
    renderRevealBar();
  }
  if (state.view === "business") return;
  if (moving || !state.chart || level === state.level) {
    if (focus && level === state.level) select(focus);
    return;
  }
  const from = state.level;
  const project = state.project;
  moving = true;
  try {
    view.stopRun();
    if (from === "root") await view.zoomInto(level);
    else await view.zoomAway();
    if (state.project !== project || !state.chart) return; // left the project during the zoom
    state.level = level;
    state.selected = null;
    resetPanelState();
    renderChart(false, false, level === "root" ? { how: "out", from } : { how: "in" });
    if (focus) select(focus);
  } finally {
    moving = false;
  }
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
  c.append(h("button", { onclick: () => void openLevel("root") }, state.project));
  if (state.view === "business") {
    c.append(h("span", { class: "sep" }, "›"), h("span", { class: "current" }, "Business flow"));
  } else if (state.level !== "root") {
    const mod = state.chart?.root.nodes.find((n) => n.id === state.level);
    c.append(h("span", { class: "sep" }, "›"), h("span", { class: "current" }, mod?.name ?? state.level));
  }
}

// ---------- chart ----------

function currentChart(): Chart | null {
  if (state.view === "business") {
    const flow = state.business?.flow;
    return flow ? businessChart(flow) : { nodes: [], edges: [] };
  }
  return state.chart ? getLevel(state.chart, state.level) : null;
}

const STEP_KIND: Record<BusinessStep["kind"], string> = { action: "Action", process: "Processing", decision: "Decision", output: "Result" };

/** The business flow's steps are drawn with who does them and what kind of step they are. */
function businessDecor(): Map<string, NodeDecor> {
  const out = new Map<string, NodeDecor>();
  for (const s of state.business?.flow?.steps ?? []) {
    out.set(s.id, {
      top: `${STEP_KIND[s.kind]} · ${s.actor}`.toUpperCase(),
      bottom: s.feature || s.dataOut || s.dataIn,
      cls: `biz biz-${s.kind}`,
      title: `${s.name}\n${s.description}`,
    });
  }
  return out;
}

function businessStep(id: string | null): BusinessStep | undefined {
  return id ? state.business?.flow?.steps.find((s) => s.id === id) : undefined;
}

function currentBubble(): Bubble | undefined {
  return currentChart()?.nodes.find((n) => n.id === state.selected);
}

function renderChart(keepView = false, animate = false, enter?: { how: "in" | "out"; from?: string }) {
  if (state.view === "business") return renderBusinessChart(keepView, animate, enter);
  const chart = currentChart();
  if (!chart) {
    if (!state.chart || state.level === "root") return;
    state.level = "root";
    return renderChart();
  }
  // While the chart is being drawn, keep the whole (growing) level in view.
  view.render(chart, { keepView, animate, key: `${state.project}/${state.level}`, glide: animate && (state.drawingChart || !!reveal), enter });
  const empty = $("empty-level");
  if ((state.drawingChart || reveal) && !chart.nodes.length) {
    empty.replaceChildren(h("span", { class: "drawing-note" }, h("span", { class: "spinner" }), state.level === "root" ? "Reading your code. Modules appear here as they're found." : "This module's functions appear here as soon as they're drawn."));
  } else if (state.chart?.undrawn && state.level === "root") {
    empty.replaceChildren(
      h("p", {}, h("strong", {}, "The functional chart isn't drawn yet.")),
      h("p", {}, "The AI can read the code and draw its modules and functions: where the data goes and in what order."),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "primary ai", onclick: () => void drawFunctional() }, "Draw the functional chart"),
        h("button", { onclick: () => setView("business") }, "See the business flow"),
      ),
    );
  } else {
    empty.replaceChildren("This module is empty. Use ", h("b", {}, "＋ Bubble"), " to draw its first function.");
  }
  if (state.selected && !chart.nodes.some((n) => n.id === state.selected)) state.selected = null;
  view.setSelected(state.selected);
  empty.hidden = chart.nodes.length > 0 || state.choosing;
  renderToolbar();
  renderCrumbs();
  renderPanel();
}

/** The business flow on the board. It can be looked at and run, never edited. */
function renderBusinessChart(keepView: boolean, animate: boolean, enter?: { how: "in" | "out"; from?: string }) {
  const chart = currentChart()!;
  view.render(chart, { keepView, animate, key: `${state.project}/${BUSINESS_LEVEL}`, enter, decor: businessDecor() });
  const empty = $("empty-level");
  const st = state.business;
  if (st?.status === "building") {
    empty.replaceChildren(h("span", { class: "drawing-note" }, h("span", { class: "spinner" }), "The AI is reading the code to work out the business flow…"));
  } else {
    empty.replaceChildren(
      h("p", {}, h("strong", {}, "There's no business flow yet.")),
      h("p", {}, "The AI reads the code and draws what a user does and what each action leads to in the program. It's read-only and updates itself when the code changes."),
      st?.status === "failed" ? h("p", { class: "error small" }, `Last try failed: ${st.error}`) : "",
      h("div", { class: "actions" }, h("button", { class: "primary ai", onclick: () => void drawBusiness() }, st?.status === "failed" ? "Try again" : "Draw the business flow")),
    );
  }
  if (state.selected && !chart.nodes.some((n) => n.id === state.selected)) state.selected = null;
  view.setSelected(state.selected);
  empty.hidden = chart.nodes.length > 0 || state.choosing;
  renderToolbar();
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
  // The run chat re-renders on every step: keep the cursor in its question box.
  const typing = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains("run-input");
  // ...and leave the chat where the user scrolled it, unless they were following along at the bottom.
  const oldLog = panel.querySelector<HTMLElement>(".run-chat .chat-log");
  runScroll = oldLog ? { top: oldLog.scrollTop, atBottom: oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40 } : { top: 0, atBottom: true };
  panel.replaceChildren();
  if (!state.chart) return;
  if (state.run) {
    panel.append(runPanel(state.run));
    const ta = panel.querySelector<HTMLTextAreaElement>(".run-input");
    if (typing && ta && !ta.disabled) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    return;
  }
  if (state.assistant) return panel.append(assistantPanel());
  if (state.design) return panel.append(designPanel());
  if (state.history) {
    panel.append(historyPanel());
    return;
  }
  if (state.view === "business") return panel.append(businessPanel());
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

function businessPanel() {
  const st = state.business;
  const flow = st?.flow ?? null;
  const step = businessStep(state.selected);
  const wrap = h("div", { class: "panel-body" });
  if (step) {
    const name = state.project!;
    wrap.append(
      h("p", { class: "eyebrow" }, `${STEP_KIND[step.kind]} · ${step.actor}`),
      h("h2", {}, step.name),
      h("p", {}, step.description || h("span", { class: "muted" }, "No description.")),
      step.feature ? h("p", {}, h("strong", {}, "Feature: "), step.feature) : "",
      h(
        "div",
        { class: "io-grid" },
        h("div", { class: "ports" }, h("h4", {}, "Comes in"), h("p", { class: step.dataIn ? "" : "muted small" }, step.dataIn || "nothing")),
        h("div", { class: "ports" }, h("h4", {}, "Goes out"), h("p", { class: step.dataOut ? "" : "muted small" }, step.dataOut || "nothing")),
      ),
    );
    const files = step.code.filter((c) => c.includes(".") || c.includes("/"));
    if (files.length) {
      wrap.append(
        h("h4", {}, "Where it happens in the code"),
        h(
          "div",
          { class: "biz-files" },
          ...files.map((f) =>
            h(
              "button",
              {
                title: state.code?.path === f ? "Hide the code" : "Show the code",
                "aria-pressed": String(state.code?.path === f),
                onclick: async () => {
                  if (state.code?.path === f) state.code = null;
                  else {
                    try {
                      state.code = await api.file(name, f);
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }
                  renderPanel();
                },
              },
              f,
            ),
          ),
        ),
      );
      if (state.code && files.includes(state.code.path)) wrap.append(codeBlock(state.code.content));
    }
    wrap.append(h("p", { class: "small muted" }, "This flow is read-only. To change what the program does, use the functional chart or the Assistant; the flow follows the code."));
    return wrap;
  }
  wrap.append(h("p", { class: "eyebrow" }, "Business flow ", h("span", { class: "badge readonly" }, "read-only")), h("h2", {}, state.chart?.name ?? state.project ?? ""));
  if (flow) wrap.append(h("p", {}, flow.summary));
  const status =
    st?.status === "building"
      ? h("p", { class: "biz-status" }, h("span", { class: "spinner" }), "Reading the code…")
      : st?.status === "updating"
        ? h("p", { class: "biz-status" }, h("span", { class: "spinner" }), "The code changed. Updating the flow…")
        : st?.status === "failed"
          ? h("div", {}, h("p", { class: "error small" }, `Couldn't ${flow ? "update" : "draw"} it: ${st.error}`), h("button", { onclick: () => void drawBusiness() }, "Try again"))
          : flow
            ? h("p", { class: "small muted" }, `Matches the code as of ${new Date(flow.updated).toLocaleString()}.`)
            : null;
  if (status) wrap.append(status);
  if (flow) {
    wrap.append(
      h("div", { class: "legend" }, ...(["action", "process", "decision", "output"] as const).map((k) => h("span", {}, h("i", { class: k }), STEP_KIND[k]))),
      h(
        "div",
        { class: "tips" },
        h("h4", {}, "How to read it"),
        h(
          "ul",
          {},
          h("li", {}, "It shows what a user does and what each action leads to: where data comes in, where it's processed and where results come out."),
          h("li", {}, "Click a step to see what happens there and where in the code."),
          h("li", {}, "Press ▶ Run to follow invented test data through the flow."),
          h("li", {}, "Nobody edits it, the AI included. It's redrawn from the code whenever the code changes."),
        ),
      ),
    );
  }
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
  if (b.kind === "module") actions.append(h("button", { onclick: () => void openLevel(b.id) }, "Open module →"));
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

/** The run chat: the AI explains, step by step and in plain words, how the test data moves; you can ask about it. */
function runPanel(run: RunState) {
  const name = state.project!;
  const t = run.trace;
  const wrap = h("div", { class: "panel-body assistant run-chat" });
  wrap.append(
    h(
      "div",
      { class: "assistant-head" },
      h("div", {}, h("p", { class: "eyebrow" }, "Run · invented test data"), h("h2", {}, t.scenario)),
      h("button", { onclick: closeRun }, "Close"),
    ),
  );
  const log = h("div", { class: "chat-log" });
  for (const it of run.items) {
    if (it.kind === "intro") log.append(h("div", { class: "msg reply run-msg" }, t.intro || t.scenario));
    else if (it.kind === "summary") log.append(h("div", { class: "msg reply run-msg summary" }, h("strong", {}, "That's it. "), t.summary || "The data made it all the way through."));
    else if (it.kind === "q") log.append(h("div", { class: "msg user" }, it.text));
    else if (it.kind === "a") log.append(h("div", { class: `msg reply run-msg${it.failed ? " failed" : ""}` }, it.text));
    else {
      const st = t.steps[it.i];
      const label = currentChart()?.nodes.find((x) => x.id === st.nodeId)?.name ?? ghostLabel(st.nodeId);
      log.append(
        h(
          "button",
          {
            class: `msg reply run-msg step${it.i === run.current && run.playing ? " current" : ""}`,
            title: "Show this bubble",
            onclick: () => {
              if (currentChart()?.nodes.some((x) => x.id === st.nodeId)) select(st.nodeId);
            },
          },
          h("span", { class: "run-step-head" }, h("span", { class: "step-no" }, String(it.i + 1)), h("strong", {}, label)),
          st.data ? h("code", { class: "run-data" }, st.data) : null,
          h("span", {}, st.explain || st.note),
        ),
      );
    }
  }
  if (run.asking) log.append(h("div", { class: "activity working" }, h("span", { class: "spinner" }), " Thinking…"));
  wrap.append(log);

  const ta = h("textarea", { rows: 2, placeholder: run.playing ? "Ask about what you're seeing…" : "Ask about this run, e.g. \"why does it go there?\"", disabled: run.asking, class: "run-input" }) as HTMLTextAreaElement;
  ta.value = run.draft;
  ta.addEventListener("input", () => (run.draft = ta.value));
  const send = () => {
    const question = ta.value.trim();
    if (!question || run.asking) return;
    // Pause while the answer comes, so the explanation doesn't run away from it.
    if (run.playing) run.paused = view.paused = true;
    const history = run.items.flatMap((x): RunChatMessage[] => (x.kind === "q" ? [{ role: "user", text: x.text }] : x.kind === "a" && !x.failed ? [{ role: "assistant", text: x.text }] : []));
    run.items.push({ kind: "q", text: question });
    run.draft = "";
    run.asking = true;
    renderPanel();
    api
      .runAsk(name, run.level, t, history, question)
      .then((r) => run.items.push({ kind: "a", text: r.answer }))
      .catch((e) => run.items.push({ kind: "a", text: `Couldn't answer: ${(e as Error).message}`, failed: true }))
      .finally(() => {
        run.asking = false;
        if (state.run === run) renderPanel();
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
      ta,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "primary", onclick: send, disabled: run.asking }, "Ask"),
        run.playing
          ? h(
              "button",
              {
                onclick: () => {
                  run.paused = view.paused = !run.paused;
                  renderPanel();
                },
              },
              run.paused ? "▶ Continue" : "❚❚ Pause",
            )
          : h("button", { onclick: () => void playRun(t, run.level) }, "↻ Replay"),
      ),
    ),
  );
  const scroll = runScroll;
  requestAnimationFrame(() => (log.scrollTop = scroll.atBottom ? log.scrollHeight : scroll.top));
  return wrap;
}

let runScroll = { top: 0, atBottom: true };

function closeRun() {
  view.stopRun();
  view.paused = false;
  state.run = null;
  renderPanel();
}

/** Time to read a step's explanation before the data moves on. */
const dwellFor = (text: string | undefined) => (text ? Math.min(5000, 1200 + text.length * 30) : 900);

async function playRun(trace: RunTrace, level: Level = state.level) {
  const run: RunState = { trace, level, current: 0, items: [{ kind: "intro" }], playing: true, paused: false, asking: false, draft: state.run?.draft ?? "" };
  state.run = run;
  view.paused = false;
  renderPanel();
  // Let the intro be read before the first step.
  await view.wait(dwellFor(trace.intro), () => state.run === run);
  if (state.run !== run) return;
  await view.play(
    trace.steps,
    (i) => {
      if (state.run !== run) return;
      run.current = i;
      run.items.push({ kind: "step", i });
      renderPanel();
    },
    1,
    (i) => dwellFor(trace.steps[i]?.explain),
  );
  if (state.run === run) {
    run.current = trace.steps.length;
    run.playing = false;
    run.paused = view.paused = false;
    run.items.push({ kind: "summary" });
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
  const changed = h("strong", {}, `${files.length} file${files.length > 1 ? "s" : ""} changed outside the app`);
  const list = `: ${files.slice(0, 4).join(", ")}${files.length > 4 ? "…" : ""}.`;
  if (state.chart?.undrawn) {
    // No functional chart to update. Keeping the changes is what moves the business flow along.
    b.replaceChildren(
      h("span", {}, changed, list, state.business?.flow ? " Keep them, and the business flow updates to match." : " Keep them as a version so they can be undone?"),
      h(
        "button",
        {
          class: "primary",
          onclick: () =>
            void guard("Saving…", async () => {
              await api.acceptOutside(name);
              state.outside = [];
              renderBanner();
            }),
        },
        "Keep the changes",
      ),
    );
    return;
  }
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
  generating = name;
  // As soon as the chart is designed it's drawn on the board (see onServerEvent), while the code is written.
  const r = await guard("Drawing the chart…", () => api.generate(name, stack)).finally(() => (generating = null));
  if (state.project !== name) return;
  const done = () => toast("Your app is drawn and its code is written. Double-click a module to open it.");
  if (!r) {
    if ($("workspace").hidden) {
      $("stack-options").append(h("button", { onclick: () => void generate(name, stack) }, "Try again"));
      return;
    }
    // The chart was drawn but writing the code failed: keep what's there, the error is on screen.
    if (reveal) reveal.instant = true;
    return finishReveal(reveal?.target ?? state.chart!, () => undefined);
  }
  if ($("workspace").hidden) {
    state.chart = r.chart;
    history.replaceState(null, "", `/?p=${encodeURIComponent(name)}`);
    enterWorkspace(true);
    startReveal(r.chart, false);
  }
  if (reveal) setBusy("Drawing the chart…"); // guard just cleared it; the board is still drawing
  finishReveal(r.chart, done);
}

/** The new project whose chart and code are being made right now. */
let generating: string | null = null;

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
$("btn-up").addEventListener("click", () => void openLevel("root"));
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
    const level = state.view === "business" ? BUSINESS_LEVEL : state.level;
    const trace = await api.run(name, level);
    if (!trace.steps.length) return toast("Nothing to run at this level yet.");
    if (state.project !== name || (level === BUSINESS_LEVEL) !== (state.view === "business")) return; // switched meanwhile
    void playRun(trace, level);
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
$("view-functional").addEventListener("click", () => setView("functional"));
$("view-business").addEventListener("click", () => setView("business"));
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

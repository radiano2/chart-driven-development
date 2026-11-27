// Local web server: JSON API + server-sent events + static UI. Binds to 127.0.0.1 only.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunChatMessage, RunTrace, ServerEvent } from "../shared/types.ts";
import { AssistantHub } from "./agent/hub.ts";
import { MockToolLLM } from "./agent/mock-llm.ts";
import { runTool, stopApp } from "./agent/tools.ts";
import { Design } from "./design/design.ts";
import { closeBrowser } from "./design/render.ts";
import { listFolder } from "./importer.ts";
import { HttpError, type Project, Workspace } from "./project.ts";
import { Brain, SettingsStore } from "./settings.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

/** Load .env and settings, set up the AI and open the workspace. Shared by the server and the `cdd` CLI. */
export function setup(env = process.env) {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const settings = new SettingsStore(path.resolve(env.CDD_SETTINGS || path.join(ROOT, ".cdd", "settings.json")), env);
  const brain = new Brain(settings);
  const workspace = path.resolve(env.CDD_WORKSPACE || path.join(ROOT, "projects"));
  return { brain, tools: brain.tools, workspace, ws: new Workspace(workspace, brain.ai, { protectedDirs: [ROOT] }) };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only the app's own page may call the API. Blocks other websites (CSRF) and DNS-rebinding,
 * which matters because the API can change files and run commands.
 */
function checkLocalRequest(req: http.IncomingMessage) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, "Requests must come from localhost");
  const origin = req.headers.origin;
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw new HttpError(403, "Bad origin");
    }
    // Same host AND port as this server: another app on localhost doesn't count as us.
    if (o.host !== req.headers.host) throw new HttpError(403, "Cross-site requests are not allowed");
  }
  if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send JSON (content-type: application/json)");
  }
}

async function body(req: http.IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, "Request too large");
  }
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Send a JSON object");
  return data as Record<string, unknown>;
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `Missing "${name}"`);
  return v;
};

export function createServer(ws: Workspace, brainOrLabel: Brain | string, hub = new AssistantHub(new MockToolLLM())) {
  const brain = typeof brainOrLabel === "string" ? null : brainOrLabel;
  const label = () => (brain ? brain.label : (brainOrLabel as string));
  const designs = new WeakMap<Project, Design>();
  const design = (p: Project) => {
    let d = designs.get(p);
    if (!d) designs.set(p, (d = new Design(p, ws.ai)));
    return d;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      let parts: string[];
      try {
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new HttpError(400, "Malformed URL");
      }
      if (parts[0] !== "api") return await serveStatic(url.pathname, res);
      checkLocalRequest(req);
      const method = req.method ?? "GET";

      if (parts.length === 2 && parts[1] === "info") return send(res, 200, { ai: label(), workspace: ws.root, needsKey: brain ? !brain.settings.mock && !brain.settings.key() : false });
      if (parts[1] === "settings") {
        if (!brain) throw new HttpError(404, "Settings are not available");
        if (parts.length === 2 && method === "GET") return send(res, 200, brain.settings.status());
        if (parts.length === 2 && method === "PUT") {
          const b = await body(req);
          brain.update(typeof b.deepseekApiKey === "string" ? { deepseekApiKey: b.deepseekApiKey } : {});
          return send(res, 200, { ...brain.settings.status(), ai: brain.label });
        }
        if (parts.length === 3 && parts[2] === "test" && method === "POST") {
          const b = await body(req);
          return send(res, 200, await brain.settings.test(typeof b.deepseekApiKey === "string" ? b.deepseekApiKey : undefined));
        }
        throw new HttpError(404, "Not found");
      }
      // Opening folders from elsewhere on disk. Browse and inspect only read; open writes .chart (and git) into the folder.
      if (parts.length === 2 && parts[1] === "browse" && method === "GET") {
        return send(res, 200, await listFolder(url.searchParams.get("path"), url.searchParams.get("hidden") === "1"));
      }
      if (parts[1] === "open" && method === "POST") {
        const b = await body(req);
        if (parts.length === 3 && parts[2] === "inspect") return send(res, 200, await ws.inspect(str(b.path, "path")));
        // The page opens plain code on an empty board and asks what to draw, unless it says already.
        const draw = b.draw === "functional" || b.draw === "business" ? b.draw : "none";
        if (parts.length === 2) return send(res, 200, await ws.openFolder(str(b.path, "path"), { draw }));
      }
      if (parts.length === 2 && parts[1] === "find" && method === "POST") {
        const b = await body(req);
        return send(res, 200, await ws.find(str(b.description, "description").slice(0, 500)));
      }
      if (parts.length === 2 && parts[1] === "projects") {
        if (method === "GET") return send(res, 200, await ws.list());
        if (method === "POST") {
          const b = await body(req);
          const p = await ws.create(String(b.name ?? ""), str(b.idea, "idea"));
          return send(res, 201, { name: p.name, chart: await p.loadChart() });
        }
      }
      if (parts[1] !== "projects" || parts.length < 3) throw new HttpError(404, "Not found");

      if (parts.length === 4 && parts[3] === "redraw" && method === "POST") {
        await body(req);
        return send(res, 200, await ws.redraw(parts[2]));
      }
      if (parts.length === 4 && parts[3] === "forget" && method === "POST") {
        await body(req);
        return send(res, 200, await ws.forget(parts[2]));
      }
      if (parts.length === 4 && parts[3] === "remove" && method === "POST") {
        const b = await body(req);
        const deleteFolder = b.deleteFolder === true;
        // Deleting is for good: the request must carry the project's name, typed by the user.
        if (deleteFolder && b.confirm !== parts[2]) throw new HttpError(400, `Type the project's name (${parts[2]}) to delete its folder`);
        let p: Project | null = null;
        try {
          p = ws.get(parts[2]);
        } catch {
          /* its folder is gone: nothing running to stop */
        }
        if (p) {
          hub.cancel(p);
          stopApp(p.dir);
        }
        return send(res, 200, await ws.remove(parts[2], { deleteFolder }));
      }
      const p = ws.get(parts[2]);
      const action = parts.slice(3).join("/");

      if (method === "GET") {
        switch (action) {
          case "":
            return send(res, 200, { name: p.name, dir: p.dir, chart: await p.loadChart(), outside: await p.checkOutside(true), drawing: !!p.drawing, business: await p.businessState() });
          case "business":
            // Only reads. There's no way to edit it.
            return send(res, 200, await p.businessState());
          case "history":
            return send(res, 200, await p.history());
          case "file":
            return send(res, 200, { path: url.searchParams.get("path"), content: await p.readSourceFile(str(url.searchParams.get("path"), "path")) });
          case "events":
            return streamEvents(p.events, req, res);
          case "assistant":
            return send(res, 200, hub.transcript(p));
          case "design":
            return send(res, 200, await design(p).state());
          case "design/image": {
            const img = await design(p).image(str(url.searchParams.get("path"), "path"));
            res.writeHead(200, { "content-type": img.mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
            return res.end(img.bytes);
          }
        }
      }

      if (method === "POST") {
        // Reference images are sent as data: URLs (up to 8 MB of image, so about 11 MB of base64).
        const b = await body(req, action === "design/references" ? 12_000_000 : 2_000_000);
        const level = typeof b.level === "string" && b.level ? b.level : "root";
        switch (action) {
          case "stack":
            return send(res, 200, await p.proposeStack());
          case "generate": {
            const stack = b.stack as { name?: unknown } | undefined;
            if (!stack || typeof stack !== "object" || typeof stack.name !== "string") throw new HttpError(400, 'Missing "stack"');
            return send(res, 200, { chart: await p.generate(b.stack as never) });
          }
          case "recommend":
            return send(res, 200, await p.recommend(level, str(b.bubbleId, "bubbleId"), str(b.request, "request")));
          case "apply":
            return send(res, 200, await p.applyChange(level, str(b.bubbleId, "bubbleId"), str(b.request, "request"), b.option as never));
          case "implement":
            return send(res, 200, await p.implementBubble(level, str(b.bubbleId, "bubbleId")));
          case "bubbles":
            return send(res, 200, await p.addBubble(level, b.bubble as never));
          case "bubbles/remove":
            return send(res, 200, await p.removeBubble(level, str(b.bubbleId, "bubbleId")));
          case "edges":
            return send(res, 200, await p.addEdge(level, b.edge as never));
          case "business":
            // Make it (first time, or after a failure). Refused when it already matches the code: it's read-only.
            return send(res, 200, await p.requestBusiness());
          case "business/update":
            // Looking at it: bring it up to date if the code changed while the app wasn't watching. (A POST, not part
            // of the GET, because it can start an AI call.)
            return send(res, 200, await p.viewBusiness());
          case "run":
            return send(res, 200, await p.simulateRun(level));
          case "run/ask": {
            const trace = b.trace as RunTrace | undefined;
            if (!trace || typeof trace !== "object" || !Array.isArray(trace.steps)) throw new HttpError(400, 'Missing "trace"');
            const history = (Array.isArray(b.history) ? b.history : [])
              .filter((m): m is RunChatMessage => !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
              .slice(-12)
              .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
            return send(res, 200, { answer: await p.explainRun(level, trace, history, str(b.question, "question").slice(0, 1000)) });
          }
          case "undo":
            return send(res, 200, await p.undo());
          case "restore":
            return send(res, 200, await p.restore(str(b.sha, "sha")));
          case "sync":
            return send(res, 200, await p.syncFromCode());
          case "accept-outside":
            return send(res, 200, await p.acceptOutside());
          case "assistant":
            return send(res, 200, await hub.get(p).ask(str(b.message, "message"), typeof b.context === "string" ? b.context.slice(0, 2000) : undefined));
          case "assistant/cancel":
            hub.cancel(p);
            return send(res, 200, { ok: true });
          case "assistant/approve":
            if (!hub.resolve(p.name, str(b.id, "id"), b.allow === true)) throw new HttpError(404, "No such request (it may have timed out)");
            return send(res, 200, { ok: true });
          case "assistant/reset":
            hub.get(p).reset();
            return send(res, 200, { ok: true });
          case "design/references":
            return send(res, 200, await design(p).addReference(str(b.image, "image"), typeof b.note === "string" ? b.note : ""));
          case "design/references/remove":
            return send(res, 200, await design(p).removeReference(str(b.id, "id")));
          case "design/mockups":
            return send(res, 200, await design(p).makeMockup(str(b.request, "request"), Array.isArray(b.bubbleIds) ? b.bubbleIds.map(String).slice(0, 20) : []));
          case "design/mockups/remove":
            return send(res, 200, await design(p).removeMockup(str(b.id, "id")));
          case "design/apply":
            return send(res, 200, await design(p).applyMockup(typeof b.id === "string" && b.id ? b.id : null));
          case "design/gui":
            return send(res, 200, await design(p).setGui(level, str(b.bubbleId, "bubbleId"), b.gui && typeof b.gui === "object" ? (b.gui as { route?: string; selector?: string }) : null));
          case "design/app-url":
            return send(res, 200, await design(p).setAppUrl(typeof b.url === "string" ? b.url : ""));
          case "design/screenshot":
            // The button says it starts the app if needed, so pressing it is the user's go-ahead.
            return send(res, 200, await design(p).screenshot(level, str(b.bubbleId, "bubbleId"), true));
          case "open-folder":
            return send(res, 200, { message: await runTool("open_folder", {}, { project: p, approve: async () => false, changed: new Set(), pendingMessage: "" }) });
        }
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
    }
  });
  // Generating a whole project takes several AI calls; don't time the request out.
  server.requestTimeout = 0;
  return server;
}

function streamEvents(events: NodeJS.EventEmitter, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const onEvent = (ev: ServerEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  events.on("event", onEvent);
  req.on("close", () => {
    clearInterval(ping);
    events.off("event", onEvent);
  });
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + path.sep) || !existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
  res.end(await readFile(abs));
}

async function main() {
  const cfg = setup();
  const port = Number(process.env.PORT) || 4317;
  process.env.CDD_PORT = String(port);
  createServer(cfg.ws, cfg.brain, new AssistantHub(cfg.tools)).listen(port, "127.0.0.1", () => {
    console.log(`Chart Driven Development: http://localhost:${port}`);
    console.log(`AI: ${cfg.brain.label}   Projects folder: ${cfg.workspace}`);
    if (!cfg.brain.settings.mock && !cfg.brain.settings.key()) console.log("No DeepSeek API key yet: add it in the app under Settings.");
  });
  process.on("SIGINT", () => {
    cfg.ws.closeAll();
    void closeBrowser();
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

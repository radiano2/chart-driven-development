// Local web server: JSON API + server-sent events + static UI. Binds to 127.0.0.1 only.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "../shared/types.ts";
import type { AI } from "./ai/ai.ts";
import { DeepSeek } from "./ai/deepseek.ts";
import { LlmAI } from "./ai/llm.ts";
import { MockAI } from "./ai/mock.ts";
import { HttpError, Workspace } from "./project.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

export function makeAI(env = process.env): { ai: AI; label: string } {
  if (env.CDD_AI === "mock") return { ai: new MockAI(), label: "mock (canned todo app)" };
  const key = env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("DEEPSEEK_API_KEY is not set. Put it in .env (see .env.example), or run `npm run start:mock` to try the app offline.");
  }
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  return { ai: new LlmAI(new DeepSeek({ apiKey: key, model, baseUrl: env.DEEPSEEK_BASE_URL })), label: `DeepSeek (${model})` };
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new HttpError(413, "Request too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `Missing "${name}"`);
  return v;
};

export function createServer(ws: Workspace, aiLabel: string) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] !== "api") return await serveStatic(url.pathname, res);
      const method = req.method ?? "GET";

      if (parts.length === 2 && parts[1] === "info") return send(res, 200, { ai: aiLabel, workspace: ws.root });
      if (parts.length === 2 && parts[1] === "projects") {
        if (method === "GET") return send(res, 200, await ws.list());
        if (method === "POST") {
          const b = await body(req);
          const p = await ws.create(String(b.name ?? ""), str(b.idea, "idea"));
          return send(res, 201, { name: p.name, chart: await p.loadChart() });
        }
      }
      if (parts[1] !== "projects" || parts.length < 3) throw new HttpError(404, "Not found");

      const p = ws.get(parts[2]);
      const action = parts.slice(3).join("/");

      if (method === "GET") {
        switch (action) {
          case "":
            return send(res, 200, { name: p.name, dir: p.dir, chart: await p.loadChart(), outside: await p.checkOutside(true) });
          case "history":
            return send(res, 200, await p.history());
          case "file":
            return send(res, 200, { path: url.searchParams.get("path"), content: await p.readSourceFile(str(url.searchParams.get("path"), "path")) });
          case "events":
            return streamEvents(p.events, req, res);
        }
      }

      if (method === "POST") {
        const b = await body(req);
        const level = typeof b.level === "string" && b.level ? b.level : "root";
        switch (action) {
          case "stack":
            return send(res, 200, await p.proposeStack());
          case "generate":
            return send(res, 200, { chart: await p.generate(b.stack as never) });
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
          case "run":
            return send(res, 200, await p.simulateRun(level));
          case "undo":
            return send(res, 200, await p.undo());
          case "restore":
            return send(res, 200, await p.restore(str(b.sha, "sha")));
          case "sync":
            return send(res, 200, await p.syncFromCode());
          case "accept-outside":
            return send(res, 200, await p.acceptOutside());
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
  if (!abs.startsWith(PUBLIC + path.sep) || !existsSync(abs)) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
  res.end(await readFile(abs));
}

async function main() {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  let ai: { ai: AI; label: string };
  try {
    ai = makeAI();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const workspace = path.resolve(process.env.CDD_WORKSPACE || path.join(ROOT, "projects"));
  const ws = new Workspace(workspace, ai.ai);
  const port = Number(process.env.PORT) || 4317;
  createServer(ws, ai.label).listen(port, "127.0.0.1", () => {
    console.log(`Chart Driven Development: http://localhost:${port}`);
    console.log(`AI: ${ai.label}   Projects folder: ${workspace}`);
  });
  process.on("SIGINT", () => {
    ws.closeAll();
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

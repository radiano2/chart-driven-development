// The canned "todo app" used by the mock AI: a chart and real, runnable code (Node, zero dependencies).
import type { Chart, FileChange, Stack } from "../../shared/types.ts";

export const TODO_STACK: Stack = {
  name: "Node.js + plain HTML",
  language: "JavaScript (ES modules)",
  runtime: "Node.js 20+",
  libraries: [],
  runCommand: "npm start",
  reasoning: "A todo app needs a tiny HTTP API, a JSON file for storage and one web page. Node's built-in http module does it with zero dependencies.",
};

export const TODO_ALTERNATIVES: Stack[] = [
  {
    name: "TypeScript + Express + SQLite",
    language: "TypeScript",
    runtime: "Node.js 20+",
    libraries: ["express", "better-sqlite3"],
    runCommand: "npm run dev",
    reasoning: "More structure and a real database, at the cost of a build step and native dependencies.",
  },
  {
    name: "Python + Flask",
    language: "Python 3",
    runtime: "CPython 3.11+",
    libraries: ["flask"],
    runCommand: "flask --app app run",
    reasoning: "Very readable and quick to start, if you prefer Python.",
  },
];

const port = (name: string, type: string) => ({ name, type });

export const TODO_CHART: Chart = {
  nodes: [
    {
      id: "web-ui",
      name: "Web UI",
      kind: "module",
      status: "ready",
      description: "The browser page: shows the list, lets the user add, tick off and delete todos.",
      inputs: [port("todos", "Todo[]")],
      outputs: [port("request", "{ method, path, body? }")],
      file: "public/app.js",
      children: {
        nodes: [
          { id: "load-todos", name: "loadTodos", kind: "function", status: "ready", description: "Fetches all todos from the API and renders them.", inputs: [], outputs: [port("todos", "Todo[]")], file: "public/app.js", symbol: "loadTodos" },
          { id: "render-todos", name: "renderTodos", kind: "function", status: "ready", description: "Draws the todo list into the page.", inputs: [port("todos", "Todo[]")], outputs: [port("html", "DOM list")], file: "public/app.js", symbol: "renderTodos" },
          { id: "on-submit", name: "onSubmit", kind: "function", status: "ready", description: "Reads the new todo's title from the form and POSTs it.", inputs: [port("event", "SubmitEvent")], outputs: [port("todos", "Todo[]")], file: "public/app.js", symbol: "onSubmit" },
          { id: "on-toggle", name: "onToggle", kind: "function", status: "ready", description: "Marks a todo done / not done.", inputs: [port("id", "number")], outputs: [port("todos", "Todo[]")], file: "public/app.js", symbol: "onToggle" },
          { id: "on-delete", name: "onDelete", kind: "function", status: "ready", description: "Deletes a todo.", inputs: [port("id", "number")], outputs: [port("todos", "Todo[]")], file: "public/app.js", symbol: "onDelete" },
        ],
        edges: [
          { id: "load-render", from: "load-todos", to: "render-todos", data: "Todo[]", order: 1 },
          { id: "submit-api", from: "on-submit", to: "http-api/handle-request", data: "POST { title }", order: 2 },
          { id: "toggle-api", from: "on-toggle", to: "http-api/handle-request", data: "PATCH /api/todos/:id", order: 3 },
          { id: "delete-api", from: "on-delete", to: "http-api/handle-request", data: "DELETE /api/todos/:id", order: 4 },
          { id: "submit-render", from: "on-submit", to: "render-todos", data: "Todo[]", order: 5 },
        ],
      },
    },
    {
      id: "http-api",
      name: "HTTP API",
      kind: "module",
      status: "ready",
      description: "A small JSON API over Node's http module. Serves the page and the /api/todos routes.",
      inputs: [port("request", "{ method, path, body? }")],
      outputs: [port("response", "Todo[] as JSON")],
      file: "src/server.js",
      children: {
        nodes: [
          { id: "start-server", name: "startServer", kind: "function", status: "ready", description: "Starts listening on a port and hands every request to handleRequest.", inputs: [port("port", "number"), port("dataFile", "string")], outputs: [port("server", "http.Server")], file: "src/server.js", symbol: "startServer" },
          { id: "handle-request", name: "handleRequest", kind: "function", status: "ready", description: "Routes GET/POST/PATCH/DELETE /api/todos and serves static files.", inputs: [port("req", "IncomingMessage"), port("res", "ServerResponse")], outputs: [port("response", "Todo[] as JSON")], file: "src/server.js", symbol: "handleRequest" },
          { id: "read-json-body", name: "readJsonBody", kind: "function", status: "ready", description: "Reads and parses a JSON request body.", inputs: [port("req", "IncomingMessage")], outputs: [port("body", "object")], file: "src/server.js", symbol: "readJsonBody" },
          { id: "send-json", name: "sendJson", kind: "function", status: "ready", description: "Writes a JSON response with a status code.", inputs: [port("res", "ServerResponse"), port("status", "number"), port("body", "any")], outputs: [], file: "src/server.js", symbol: "sendJson" },
        ],
        edges: [
          { id: "start-handle", from: "start-server", to: "handle-request", data: "req, res", order: 1 },
          { id: "handle-body", from: "handle-request", to: "read-json-body", data: "IncomingMessage", order: 2 },
          { id: "handle-load", from: "handle-request", to: "storage/load-todos", data: "dataFile path", order: 3 },
          { id: "handle-todos", from: "handle-request", to: "todos/add-todo", data: "Todo[], title", order: 4 },
          { id: "handle-save", from: "handle-request", to: "storage/save-todos", data: "Todo[]", order: 5 },
          { id: "handle-send", from: "handle-request", to: "send-json", data: "200, Todo[]", order: 6 },
        ],
      },
    },
    {
      id: "todos",
      name: "Todos",
      kind: "module",
      status: "ready",
      description: "Pure logic for the todo list: create, add, toggle, remove, filter. No I/O.",
      inputs: [port("todos", "Todo[]"), port("command", "{ title } | { id }")],
      outputs: [port("todos", "Todo[]")],
      file: "src/todos.js",
      children: {
        nodes: [
          { id: "create-todo", name: "createTodo", kind: "function", status: "ready", description: "Builds a new todo with the next id.", inputs: [port("todos", "Todo[]"), port("title", "string")], outputs: [port("todo", "Todo")], file: "src/todos.js", symbol: "createTodo" },
          { id: "add-todo", name: "addTodo", kind: "function", status: "ready", description: "Validates the title and appends a new todo.", inputs: [port("todos", "Todo[]"), port("title", "string")], outputs: [port("todos", "Todo[]")], file: "src/todos.js", symbol: "addTodo" },
          { id: "toggle-todo", name: "toggleTodo", kind: "function", status: "ready", description: "Flips the done flag of one todo.", inputs: [port("todos", "Todo[]"), port("id", "number")], outputs: [port("todos", "Todo[]")], file: "src/todos.js", symbol: "toggleTodo" },
          { id: "remove-todo", name: "removeTodo", kind: "function", status: "ready", description: "Removes one todo.", inputs: [port("todos", "Todo[]"), port("id", "number")], outputs: [port("todos", "Todo[]")], file: "src/todos.js", symbol: "removeTodo" },
        ],
        edges: [{ id: "add-create", from: "add-todo", to: "create-todo", data: "Todo[], title", order: 1 }],
      },
    },
    {
      id: "storage",
      name: "Storage",
      kind: "module",
      status: "ready",
      description: "Keeps todos in a JSON file on disk.",
      inputs: [port("todos", "Todo[]")],
      outputs: [port("todos", "Todo[]")],
      file: "src/storage.js",
      children: {
        nodes: [
          { id: "load-todos", name: "loadTodos", kind: "function", status: "ready", description: "Reads todos from the JSON file (empty list if missing).", inputs: [port("file", "string")], outputs: [port("todos", "Todo[]")], file: "src/storage.js", symbol: "loadTodos" },
          { id: "save-todos", name: "saveTodos", kind: "function", status: "ready", description: "Writes todos to the JSON file.", inputs: [port("file", "string"), port("todos", "Todo[]")], outputs: [], file: "src/storage.js", symbol: "saveTodos" },
        ],
        edges: [
          { id: "load-out", from: "load-todos", to: "todos/add-todo", data: "Todo[]", order: 1 },
          { id: "save-in", from: "todos/add-todo", to: "save-todos", data: "Todo[]", order: 2 },
        ],
      },
    },
  ],
  edges: [
    { id: "ui-api", from: "web-ui", to: "http-api", data: "{ method, path, body? }", order: 1 },
    { id: "api-storage", from: "http-api", to: "storage", data: "dataFile path", order: 2 },
    { id: "storage-todos", from: "storage", to: "todos", data: "Todo[]", order: 3 },
    { id: "todos-storage", from: "todos", to: "storage", data: "Todo[] (changed)", order: 4 },
    { id: "todos-api", from: "todos", to: "http-api", data: "Todo[]", order: 5 },
    { id: "api-ui", from: "http-api", to: "web-ui", data: "Todo[] as JSON", order: 6 },
  ],
};

export const TODO_SCAFFOLD: FileChange[] = [
  {
    path: "package.json",
    content: JSON.stringify({ name: "todo-app", version: "0.1.0", private: true, type: "module", scripts: { start: "node src/main.js" }, engines: { node: ">=20" } }, null, 2) + "\n",
  },
  {
    path: "src/main.js",
    content: `import { startServer } from "./server.js";

const port = Number(process.env.PORT) || 3000;
const dataFile = process.env.TODO_FILE || "todos.json";

startServer(port, dataFile);
console.log(\`Todo app running on http://localhost:\${port}\`);
`,
  },
  {
    path: "README.md",
    content: `# Todo app

Generated with Chart Driven Development.

\`\`\`
npm start
\`\`\`

Then open http://localhost:3000. Todos are stored in \`todos.json\`.
`,
  },
  { path: ".gitignore", content: "node_modules/\ntodos.json\n" },
];

export const TODO_MODULE_FILES: Record<string, FileChange[]> = {
  storage: [
    {
      path: "src/storage.js",
      content: `import { readFile, writeFile } from "node:fs/promises";

/** Reads todos from the JSON file (empty list if the file does not exist yet). */
export async function loadTodos(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Writes todos to the JSON file. */
export async function saveTodos(file, todos) {
  await writeFile(file, JSON.stringify(todos, null, 2));
}
`,
    },
  ],
  todos: [
    {
      path: "src/todos.js",
      content: `/** Builds a new todo with the next id. */
export function createTodo(todos, title) {
  const id = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  return { id, title, done: false };
}

/** Validates the title and appends a new todo. */
export function addTodo(todos, title) {
  const clean = String(title ?? "").trim();
  if (!clean) throw new Error("Title is required");
  return [...todos, createTodo(todos, clean)];
}

/** Flips the done flag of one todo. */
export function toggleTodo(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

/** Removes one todo. */
export function removeTodo(todos, id) {
  return todos.filter((t) => t.id !== id);
}
`,
    },
  ],
  "http-api": [
    {
      path: "src/server.js",
      content: `import http from "node:http";
import { readFile } from "node:fs/promises";
import { loadTodos, saveTodos } from "./storage.js";
import { addTodo, toggleTodo, removeTodo } from "./todos.js";

const STATIC = { "/": ["public/index.html", "text/html"], "/app.js": ["public/app.js", "text/javascript"] };

/** Starts listening on a port and hands every request to handleRequest. */
export function startServer(port, dataFile) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, dataFile).catch((err) => sendJson(res, 400, { error: err.message }));
  });
  server.listen(port);
  return server;
}

/** Routes GET/POST/PATCH/DELETE /api/todos and serves static files. */
export async function handleRequest(req, res, dataFile) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { "content-type": type });
    res.end(await readFile(file));
    return;
  }
  const match = url.pathname.match(/^\\/api\\/todos(?:\\/(\\d+))?$/);
  if (!match) return sendJson(res, 404, { error: "Not found" });
  const id = match[1] ? Number(match[1]) : null;
  let todos = await loadTodos(dataFile);
  if (req.method === "GET" && id === null) return sendJson(res, 200, todos);
  if (req.method === "POST" && id === null) {
    const body = await readJsonBody(req);
    todos = addTodo(todos, body.title);
  } else if (req.method === "PATCH" && id !== null) {
    todos = toggleTodo(todos, id);
  } else if (req.method === "DELETE" && id !== null) {
    todos = removeTodo(todos, id);
  } else {
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  await saveTodos(dataFile, todos);
  sendJson(res, 200, todos);
}

/** Reads and parses a JSON request body. */
export async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Writes a JSON response with a status code. */
export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
`,
    },
  ],
  "web-ui": [
    {
      path: "public/index.html",
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Todos</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
    form { display: flex; gap: .5rem; } input { flex: 1; padding: .5rem; } button { padding: .5rem .8rem; }
    ul { list-style: none; padding: 0; } li { display: flex; gap: .5rem; align-items: center; padding: .4rem 0; border-bottom: 1px solid #eee; }
    li span { flex: 1; } li.done span { text-decoration: line-through; color: #888; }
  </style>
</head>
<body>
  <h1>Todos</h1>
  <form id="new-todo"><input name="title" placeholder="What needs doing?" autocomplete="off"><button>Add</button></form>
  <ul id="list"></ul>
  <script type="module" src="/app.js"></script>
</body>
</html>
`,
    },
    {
      path: "public/app.js",
      content: `const list = document.getElementById("list");
const form = document.getElementById("new-todo");

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

/** Fetches all todos from the API and renders them. */
export async function loadTodos() {
  renderTodos(await api("GET", "/api/todos"));
}

/** Draws the todo list into the page. */
export function renderTodos(todos) {
  list.innerHTML = "";
  for (const t of todos) {
    const li = document.createElement("li");
    li.className = t.done ? "done" : "";
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: t.done });
    box.onchange = () => onToggle(t.id);
    const span = Object.assign(document.createElement("span"), { textContent: t.title });
    const del = Object.assign(document.createElement("button"), { textContent: "×", title: "Delete" });
    del.onclick = () => onDelete(t.id);
    li.append(box, span, del);
    list.append(li);
  }
}

/** Reads the new todo's title from the form and POSTs it. */
export async function onSubmit(event) {
  event.preventDefault();
  const title = form.title.value.trim();
  if (!title) return;
  form.title.value = "";
  renderTodos(await api("POST", "/api/todos", { title }));
}

/** Marks a todo done / not done. */
export async function onToggle(id) {
  renderTodos(await api("PATCH", \`/api/todos/\${id}\`));
}

/** Deletes a todo. */
export async function onDelete(id) {
  renderTodos(await api("DELETE", \`/api/todos/\${id}\`));
}

form.addEventListener("submit", onSubmit);
loadTodos();
`,
    },
  ],
};

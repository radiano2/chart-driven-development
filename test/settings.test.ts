// DeepSeek key in app settings: stored locally, never sent back, switches the AI live; API only accepts local JSON calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AssistantHub } from "../src/server/agent/hub.ts";
import { createServer } from "../src/server/index.ts";
import { Workspace } from "../src/server/project.ts";
import { Brain, NO_KEY_MESSAGE, SettingsStore } from "../src/server/settings.ts";

let dir = "";
let fake: http.Server;
let fakeUrl = "";
let lastAuth = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cdd-settings-"));
  // Stand-in for api.deepseek.com/models: accepts only "sk-good-key-1234".
  fake = http.createServer((req, res) => {
    lastAuth = String(req.headers.authorization);
    res.writeHead(lastAuth === "Bearer sk-good-key-1234" ? 200 : lastAuth === "Bearer sk-broke-key-5555" ? 402 : 401).end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(async () => {
  fake.close();
  await rm(dir, { recursive: true, force: true });
});

describe("settings store", () => {
  it("saves the key to a private file; the settings key wins over .env", async () => {
    const file = path.join(dir, "a", "settings.json");
    const s = new SettingsStore(file, { DEEPSEEK_API_KEY: "sk-from-env-9999" });
    assert.deepEqual([s.status().keySource, s.status().keyHint], ["env", "…9999"]);
    s.save({ deepseekApiKey: "  sk-saved-key-5678 " });
    assert.deepEqual([s.status().keySource, s.status().keyHint, s.status().model], ["settings", "…5678", "deepseek-flash"]);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    // Reload from disk
    assert.equal(new SettingsStore(file, {}).key()?.key, "sk-saved-key-5678");
    s.save({ deepseekApiKey: "" });
    assert.equal(s.status().keySource, "env");
    assert.throws(() => s.save({ deepseekApiKey: "sk with space" }), /spaces/);
  });

  it("tests a key against DeepSeek", async () => {
    const s = new SettingsStore(path.join(dir, "b.json"), { DEEPSEEK_BASE_URL: fakeUrl });
    assert.deepEqual(await s.test(), { ok: false, invalid: true, message: NO_KEY_MESSAGE });
    assert.equal((await s.test("sk-good-key-1234")).ok, true);
    const bad = await s.test("sk-bad");
    assert.deepEqual([bad.ok, bad.invalid], [false, true]);
    // No balance and no network are not the key's fault: not "invalid", so it may be saved.
    const broke = await s.test("sk-broke-key-5555");
    assert.deepEqual([broke.ok, broke.invalid], [false, false]);
    assert.match(broke.message, /no balance/);
    const offline = await new SettingsStore(path.join(dir, "b2.json"), { DEEPSEEK_BASE_URL: "http://127.0.0.1:9" }).test("sk-any");
    assert.deepEqual([offline.ok, offline.invalid], [false, false]);
  });

  it("switches the AI as soon as a key is saved, no restart", async () => {
    const brain = new Brain(new SettingsStore(path.join(dir, "c.json"), {}));
    assert.equal(brain.label, "DeepSeek (no key yet)");
    await assert.rejects(brain.ai.proposeStack("x"), /No DeepSeek API key yet/);
    await assert.rejects(brain.tools.chat([], []), /No DeepSeek API key yet/);
    brain.update({ deepseekApiKey: "sk-new-key-0000" });
    assert.equal(brain.label, "DeepSeek (deepseek-flash)");
  });
});

describe("settings API", () => {
  let base = "";
  let server: http.Server;
  let file = "";

  before(async () => {
    file = path.join(dir, "api", "settings.json");
    const brain = new Brain(new SettingsStore(file, { DEEPSEEK_BASE_URL: fakeUrl }));
    const ws = new Workspace(path.join(dir, "ws"), brain.ai);
    server = createServer(ws, brain, new AssistantHub(brain.tools));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const json = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("saves a key, tests it, and never returns it", async () => {
    assert.equal((await (await fetch(`${base}/api/info`)).json()).needsKey, true);
    const saved = await (await json("PUT", "/api/settings", { deepseekApiKey: "sk-good-key-1234" })).json();
    assert.deepEqual([saved.hasKey, saved.keyHint, saved.ai], [true, "…1234", "DeepSeek (deepseek-flash)"]);
    const raw = await (await fetch(`${base}/api/settings`)).text();
    assert.doesNotMatch(raw, /sk-good-key/);
    assert.equal((await (await json("POST", "/api/settings/test", {})).json()).ok, true);
    assert.equal(lastAuth, "Bearer sk-good-key-1234");
    assert.match(await readFile(file, "utf8"), /sk-good-key-1234/);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).needsKey, false);
  });

  it("refuses calls from other websites and non-JSON posts", async () => {
    const cross = await json("PUT", "/api/settings", { deepseekApiKey: "sk-evil" }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
    // Another app on localhost (different port) is a different origin too.
    const otherPort = await json("PUT", "/api/settings", { deepseekApiKey: "sk-evil" }, { origin: "http://localhost:5173" });
    assert.equal(otherPort.status, 403);
    const same = await json("GET", "/api/settings", undefined, { origin: base });
    assert.equal(same.status, 200);
    assert.equal((await fetch(`${base}/api/projects/%E0%A4%A`)).status, 400);
    const form = await fetch(`${base}/api/settings/test`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415);
    const notObject = await json("PUT", "/api/settings", null);
    assert.equal(notObject.status, 400);
    // fetch() won't let us fake the Host header, so use a raw request (a DNS-rebinding page would send this).
    const rebind = await new Promise<number>((resolve, reject) =>
      http.get(`${base}/api/info`, { headers: { host: "evil.example" } }, (r) => (r.resume(), resolve(r.statusCode!))).on("error", reject),
    );
    assert.equal(rebind, 403);
    assert.doesNotMatch(await readFile(file, "utf8"), /sk-evil/);
  });
});

describe("cdd set-key", () => {
  // Needs a real terminal (pty) to prove the key isn't echoed; util-linux `script` provides one on Linux.
  const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;

  const setKey = (key: string, settings: string) =>
    new Promise<string>((resolve) => {
      const cmd = `${process.execPath} --import tsx src/cli/cdd.ts set-key`;
      const child = spawn("script", ["-qec", cmd, "/dev/null"], { env: { ...process.env, CDD_SETTINGS: settings, DEEPSEEK_BASE_URL: fakeUrl } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      setTimeout(() => child.stdin.write(`${key}\r`), 1500);
      child.on("close", () => resolve(out));
    });

  it("doesn't show the key while typing, saves a good key, refuses a rejected one", { skip: !hasScript && "needs util-linux script for a pty" }, async () => {
    const file = path.join(dir, "cli-settings.json");
    const good = await setKey("sk-good-key-1234", file);
    assert.doesNotMatch(good, /sk-good-key-1234/);
    assert.match(good, /The key works and is saved/);
    assert.match(await readFile(file, "utf8"), /sk-good-key-1234/);
    const bad = await setKey("sk-wrong-key-0000", file);
    assert.doesNotMatch(bad, /sk-wrong-key-0000/);
    assert.match(bad, /Not saved: DeepSeek rejected this key/);
    assert.doesNotMatch(await readFile(file, "utf8"), /sk-wrong-key/);
  });
});

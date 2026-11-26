// The DeepSeek-backed AI: prompts go out, sloppy JSON comes back, the app normalizes it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOps } from "../src/shared/chart.ts";
import { parseJsonLoose, type JsonLLM } from "../src/server/ai/deepseek.ts";
import { LlmAI } from "../src/server/ai/llm.ts";
import type { ProjectChart } from "../src/shared/types.ts";

function fakeLLM(reply: unknown): JsonLLM & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async json(_system, user) {
      prompts.push(user);
      return reply;
    },
  };
}

describe("LlmAI", () => {
  it("normalizes a designed chart (ids, ports as strings, nested modules)", async () => {
    const llm = fakeLLM({
      nodes: [
        { name: "Storage Layer", description: "keeps data", inputs: ["todos: Todo[]"], file: "src/storage.ts", children: { nodes: [{ name: "saveTodos", symbol: "saveTodos", file: "src/storage.ts" }], edges: [] } },
        { id: "API", name: "API" },
      ],
      edges: [{ from: "API", to: "Storage Layer", data: "Todo[]" }],
    });
    const chart = await new LlmAI(llm).designChart("todo", { name: "x", language: "", runtime: "", libraries: [], runCommand: "", reasoning: "" });
    assert.deepEqual(chart.nodes.map((n) => n.id), ["storage-layer", "api"]);
    assert.equal(chart.nodes[0].kind, "module");
    assert.deepEqual(chart.nodes[0].inputs, [{ name: "todos", type: "Todo[]" }]);
    assert.equal(chart.nodes[0].children!.nodes[0].id, "save-todos");
    assert.deepEqual(chart.edges[0], { id: "api--storage-layer", from: "api", to: "storage-layer", data: "Todo[]", order: 1 });
  });

  it("falls back to the first option when the recommended id is unknown", async () => {
    const llm = fakeLLM({ summary: "s", recommendedOptionId: "nope", options: [{ id: "Split It", kind: "split", label: "Split" }] });
    const pc: ProjectChart = { version: 1, name: "p", idea: "i", stack: null, root: { nodes: [], edges: [] } };
    const rec = await new LlmAI(llm).recommend({ chart: pc, level: "root", bubble: { id: "a", name: "A", kind: "module", description: "", inputs: [], outputs: [], status: "ready" }, files: [], request: "do x" });
    assert.equal(rec.recommendedOptionId, "split-it");
    assert.match(llm.prompts[0], /do x/);
  });

  it("change sets apply to the chart; invalid ops are dropped", async () => {
    const llm = fakeLLM({
      summary: "added",
      ops: [
        { op: "upsertNode", parent: "root", node: { id: "mod", name: "Mod", kind: "module" } },
        { op: "upsertNode", parent: "mod", node: { id: "fn", name: "fn", file: "a.js", symbol: "fn" } },
        { op: "upsertEdge", parent: "mod", edge: { from: "fn", to: "other/x", data: "n" } },
        { op: "explode" },
      ],
      files: [{ path: "a.js", content: "export function fn() {}" }],
    });
    const pc: ProjectChart = { version: 1, name: "p", idea: "i", stack: null, root: { nodes: [], edges: [] } };
    const bubble = { id: "a", name: "A", kind: "module" as const, description: "", inputs: [], outputs: [], status: "ready" as const };
    const cs = await new LlmAI(llm).applyChange({ chart: pc, level: "root", bubble, files: [], request: "r", option: { id: "o", kind: "extend", label: "L", description: "" } });
    assert.equal(cs.ops.length, 3);
    assert.deepEqual(applyOps(pc, cs.ops), []);
    const mod = pc.root.nodes[0];
    assert.equal(mod.children!.nodes[0].kind, "function");
    assert.equal(mod.children!.edges[0].to, "other/x");
  });

  it("parses JSON wrapped in code fences or prose", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Here you go: {"a":2} hope it helps'), { a: 2 });
  });
});

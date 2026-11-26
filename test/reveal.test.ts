// Drawing a chart live: the order things appear in, and what's on the board part way through.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allKeys, pendingSteps, revealKey, revealOrder, visiblePart } from "../src/client/reveal.ts";
import type { Bubble, ProjectChart } from "../src/shared/types.ts";

const node = (id: string, kind: Bubble["kind"] = "function", children?: Bubble["children"]): Bubble => ({ id, name: id, kind, description: "", inputs: [], outputs: [], status: "ready", children });
const edge = (from: string, to: string, order: number) => ({ id: `${from}--${to}`, from, to, data: "x", order });

const pc: ProjectChart = {
  version: 1,
  name: "t",
  idea: "",
  stack: null,
  root: {
    nodes: [
      node("ui", "module", { nodes: [node("render"), node("click")], edges: [edge("click", "render", 1), edge("click", "store/save", 2)] }),
      node("store", "module", { nodes: [node("save")], edges: [] }),
    ],
    edges: [edge("ui", "store", 1)],
  },
};

describe("live chart drawing", () => {
  it("shows modules first, each arrow right after both its ends, then each module's insides", () => {
    const order = revealOrder(pc).map((s) => `${s.level}:${s.kind}:${s.id}`);
    assert.deepEqual(order, [
      "root:node:ui",
      "root:node:store",
      "root:edge:ui--store",
      "ui:node:render",
      "ui:node:click",
      "ui:edge:click--render",
      "ui:edge:click--store/save", // the other end is another module's function: drawn as a ghost, always there
      "store:node:save",
    ]);
  });

  it("puts on the board only what has been revealed, with the latest details", () => {
    const visible = new Set([revealKey("root", "node", "ui"), revealKey("root", "edge", "ui--store"), revealKey("ui", "node", "click")]);
    const part = visiblePart(pc, visible);
    assert.deepEqual(part.root.nodes.map((n) => n.id), ["ui"]);
    assert.equal(part.root.edges.length, 0, "an arrow waits for both of its ends");
    assert.deepEqual(part.root.nodes[0].children?.nodes.map((n) => n.id), ["click"]);
    assert.equal(pc.root.nodes[0].children?.nodes.length, 2, "the real chart is untouched");
    assert.equal(pendingSteps(pc, visible)[0].id, "store");
  });

  it("picks up new parts as the AI sends them, and ends with everything shown", () => {
    const visible = allKeys(pc);
    assert.equal(pendingSteps(pc, visible).length, 0);
    const more = structuredClone(pc);
    more.root.nodes[1].children!.nodes.push(node("load"));
    assert.deepEqual(pendingSteps(more, visible).map((s) => s.id), ["load"]);
    assert.deepEqual(visiblePart(pc, visible), pc);
  });
});

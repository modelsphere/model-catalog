"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { variantProblems } = require("./variant-rules");
const { schemaValidator } = require("./catalog");

const video = (patch = {}) => ({
  id: "h3-tp4-h800",
  engine: "video",
  chart: { name: "minimax-h3", version: ">=0.3.0" },
  requires: { gpus: 4, gpuProduct: ["NVIDIA-H800"] },
  ...patch,
});
const problems = (v) => variantProblems(v, "");

test("a video variant on its own chart, one pod, passes", () => {
  assert.deepStrictEqual(problems(video()), []);
  assert.deepStrictEqual(problems(video({ requires: { gpus: 4, topology: "single-node" } })), []);
});

test("a video variant describes one pod: no pd or lws topology, no nodes", () => {
  assert.match(problems(video({ requires: { gpus: 4, topology: "pd" } })).join("\n"), /requires\.topology pd: a video variant is single-node/);
  assert.match(problems(video({ requires: { gpus: 4, nodes: 2 } })).join("\n"), /requires\.nodes 2: a video variant takes no nodes/);
  // The schema documents "no nodes": even 1 is refused.
  assert.match(problems(video({ requires: { gpus: 4, nodes: 1 } })).join("\n"), /requires\.nodes 1: a video variant takes no nodes/);
});

test("a video variant carries no LLM chart layout in its values", () => {
  assert.match(problems(video({ values: { pd: { enabled: false } } })).join("\n"), /values\.pd: a video chart has no pd layout/);
  assert.match(problems(video({ values: { lws: { enabled: true, size: 1 } } })).join("\n"), /values\.lws: a video chart has no lws layout/);
});

test("a video variant does not run on an engine chart", () => {
  assert.match(problems(video({ chart: { name: "sglang", version: "0.8.0" } })).join("\n"), /a video variant runs on a video chart/);
});

test("engines keep their charts", () => {
  const llm = (engine, chart) => ({ id: "x", engine, chart: { name: chart, version: "1.0.0" }, requires: { gpus: 8 } });
  assert.deepStrictEqual(problems(llm("sglang", "sglang")), []);
  assert.deepStrictEqual(problems(llm("vllm", "vllm")), []);
  assert.match(problems(llm("sglang", "vllm")).join("\n"), /chart\.name vllm is not its engine, sglang/);
  assert.match(problems(llm("vllm", "minimax-h3")).join("\n"), /chart\.name minimax-h3 is not its engine, vllm/);
  assert.deepStrictEqual(problems(llm("mock", "vllm")), []);
  assert.match(problems(llm("mock", "minimax-h3")).join("\n"), /a mock runs on the sglang or vllm chart/);
});

// The same pairing holds for a consumer that validates with the schema alone.
test("the variant schema enforces the engine-to-chart pairing", () => {
  const validate = schemaValidator()("variant.schema.json");
  const file = (engine, chart) => ({
    apiVersion: "catalog.swiss/v2",
    kind: "Variant",
    model: "m",
    id: "v",
    version: "1.0.0",
    engine,
    chart: { name: chart, version: "1.0.0" },
    requires: { gpus: 4 },
  });
  for (const [engine, chart, ok] of [
    ["sglang", "sglang", true],
    ["vllm", "vllm", true],
    ["mock", "sglang", true],
    ["video", "minimax-h3", true],
    ["sglang", "vllm", false],
    ["vllm", "minimax-h3", false],
    ["mock", "minimax-h3", false],
    ["video", "sglang", false],
    ["video", "vllm", false],
  ]) {
    assert.strictEqual(validate(file(engine, chart)), ok, `${engine} on ${chart}: ${JSON.stringify(validate.errors)}`);
  }
});

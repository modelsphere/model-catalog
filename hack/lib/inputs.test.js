"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inputProblems } = require("./inputs");

const master = {
  key: "storageKVOffload.mooncake.master",
  title: "Mooncake master",
  pattern: "[^\\s:/]+:[0-9]+",
  example: "mooncake-master.example:50051",
};
const variant = (inputs, values = {}) => ({ requires: { gpus: 8 }, inputs, values });

test("a declared input that values leaves alone, with a valid example and default, passes", () => {
  const values = { storageKVOffload: { enabled: true, mooncake: { protocol: "rdma" } } };
  assert.deepEqual(inputProblems(variant([master], values)), []);
  assert.deepEqual(inputProblems(variant([{ ...master, default: "mc:50051" }], values)), []);
  assert.deepEqual(inputProblems({ requires: { gpus: 1 } }), []);
});

test("values may set an input's key, as the base an answer overrides, but no non-map above it", () => {
  for (const value of ["mooncake-master.example:50051", ""]) {
    assert.deepEqual(inputProblems(variant([master], { storageKVOffload: { mooncake: { master: value } } })), []);
  }
  assert.deepEqual(inputProblems(variant([master], { storageKVOffload: { mooncake: "off" } }), "v: "), [
    "v: inputs[0] storageKVOffload.mooncake.master: values.storageKVOffload.mooncake is not a map, so the answer has no place to go",
  ]);
});

test("the default is an answer: of the input's type, matching its pattern", () => {
  const one = (input) => inputProblems(variant([{ key: "a.b", title: "t", ...input }]));
  assert.match(one({ example: "h:1", default: "no-port", pattern: master.pattern })[0], /default "no-port" does not match the pattern$/);
  assert.match(one({ example: "h:1", default: "", pattern: master.pattern })[0], /default "" does not match the pattern$/);
  assert.match(one({ example: 1, default: "8", type: "integer" })[0], /default "8" is not an integer$/);
  assert.deepEqual(one({ example: false, default: true, type: "boolean" }), []);
});

test("a key is declared once", () => {
  assert.deepEqual(inputProblems(variant([master, master])), ["inputs[1] storageKVOffload.mooncake.master: declared twice"]);
});

test("the example is an answer: of the input's type, matching its pattern", () => {
  const one = (input) => inputProblems(variant([{ key: "a.b", title: "t", ...input }]));
  assert.deepEqual(one({ example: "mooncake-master:50051", pattern: master.pattern }), []);
  assert.match(one({ example: "no-port", pattern: master.pattern })[0], /example "no-port" does not match the pattern$/);
  assert.match(one({ example: "8", type: "integer" })[0], /example "8" is not an integer$/);
  assert.match(one({ example: 1.5, type: "integer" })[0], /is not an integer$/);
  assert.deepEqual(one({ example: 8, type: "integer" }), []);
  assert.deepEqual(one({ example: false, type: "boolean" }), []);
  assert.match(one({ example: 8 })[0], /example 8 is not a string$/);
});

test("a pattern compiles, and only a string input has one", () => {
  assert.match(inputProblems(variant([{ ...master, pattern: "(" }]))[0], /pattern does not compile/);
  assert.match(
    inputProblems(variant([{ key: "a.b", title: "t", type: "integer", pattern: "[0-9]+", example: 1 }]))[0],
    /pattern is only for a string input, and this one is integer$/,
  );
});

// A key that is only fields may be missing from values; any other key must
// resolve to exactly one primitive there.
const problems = (key, values, extra = {}) => inputProblems(variant([{ key, title: "t", ...extra }], values));
const matchCount = (key, n) => [`inputs[0] ${key}: matches ${n} values in values, not exactly one`];

test("a list key must reach exactly one primitive in values: zero or several is an error", () => {
  const cases = [
    {
      key: "volumes.[name=draft-model].hostPath.path",
      one: {
        volumes: [
          { name: "draft-model", hostPath: { path: "/data/draft" } },
          { name: "cache", hostPath: { path: "/data/cache" } },
        ],
      },
      zero: { volumes: [{ name: "cache", hostPath: { path: "/data/cache" } }] },
      multi: {
        volumes: [
          { name: "draft-model", hostPath: { path: "/data/draft" } },
          { name: "draft-model", hostPath: { path: "/data/other" } },
        ],
      },
    },
    {
      key: "extraArgs.[=--foo=1]",
      one: { extraArgs: ["--foo=1", "--bar=2"] },
      zero: { extraArgs: ["--bar=2"] },
      multi: { extraArgs: ["--foo=1", "--bar=2", "--foo=1"] },
    },
    {
      key: "extraArgs.[^=--speculative-draft-model-path=]",
      one: { extraArgs: ["--speculative-draft-model-path=/models/draft", "--other=1"] },
      zero: { extraArgs: ["--other=1"] },
      multi: {
        extraArgs: ["--speculative-draft-model-path=/models/a", "--speculative-draft-model-path=/models/b"],
      },
    },
    {
      key: "volumes.0.hostPath.path",
      one: { volumes: [{ hostPath: { path: "/data/draft" } }, { hostPath: { path: "/data/cache" } }] },
      zero: { volumes: [] },
    },
  ];
  for (const c of cases) {
    assert.deepEqual(problems(c.key, c.one), [], `${c.key} one`);
    assert.deepEqual(problems(c.key, c.zero), matchCount(c.key, 0), `${c.key} zero`);
    if (c.multi) assert.deepEqual(problems(c.key, c.multi), matchCount(c.key, 2), `${c.key} multi`);
  }
  const missing = "volumes.[name=draft-model].hostPath.path";
  assert.deepEqual(problems(missing, {}), matchCount(missing, 0));
});

test("a list key that stops at a map or a list is an error", () => {
  assert.deepEqual(problems("volumes.[name=draft-model]", { volumes: [{ name: "draft-model", hostPath: { path: "/x" } }] }), [
    "inputs[0] volumes.[name=draft-model]: selects a non-primitive in values",
  ]);
  assert.deepEqual(problems("volumes.[name=draft-model].hostPath", { volumes: [{ name: "draft-model", hostPath: { path: "/x" } }] }), [
    "inputs[0] volumes.[name=draft-model].hostPath: selects a non-primitive in values",
  ]);
  assert.deepEqual(problems("groups.0", { groups: [[1, 2], [3]] }), ["inputs[0] groups.0: selects a non-primitive in values"]);
});

test("a patcher is a string template with {value} exactly once", () => {
  const key = "extraArgs.[^=--speculative-draft-model-path=]";
  const patcher = "--speculative-draft-model-path={value}";
  const values = { extraArgs: ["--speculative-draft-model-path=/models/draft", "--other=1"] };
  assert.deepEqual(problems(key, values, { patcher }), []);
  assert.match(problems(key, values, { patcher: "no-placeholder" })[0], /patcher must contain \{value\} exactly once$/);
  assert.match(problems(key, values, { patcher: "{value} and {value}" })[0], /patcher must contain \{value\} exactly once$/);
  assert.match(problems(key, values, { patcher, type: "integer", example: 1 })[0], /patcher is only for a string input, and this one is integer$/);
  assert.match(
    problems(key, values, { patcher: "--speculative-draft-model-path={value}.gguf" })[0],
    /values gives "--speculative-draft-model-path=\/models\/draft", which does not fit the patcher$/,
  );
});

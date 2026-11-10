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

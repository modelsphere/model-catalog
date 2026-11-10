"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inputProblems } = require("./inputs");

const master = {
  path: "storageKVOffload.mooncake.master",
  title: "Mooncake master",
  pattern: "[^\\s:/]+:[0-9]+",
  example: "mooncake-master.example:50051",
};
const variant = (inputs, values = {}) => ({ requires: { gpus: 8, inputs }, values });

test("a declared input with a valid example passes, with or without a default", () => {
  assert.deepEqual(inputProblems(variant([master], { storageKVOffload: { enabled: true, mooncake: { protocol: "rdma" } } })), []);
  assert.deepEqual(inputProblems(variant([master], { storageKVOffload: { mooncake: { master: "mc:50051" } } })), []);
  assert.deepEqual(inputProblems({ requires: { gpus: 1 } }), []);
});

test("values' default for an input is an answer, and nothing in values is in its way", () => {
  const one = (values, input = master) => inputProblems(variant([input], values), "v: ");
  assert.deepEqual(one({ storageKVOffload: { mooncake: { master: "no-port" } } }), [
    'v: requires.inputs[0] storageKVOffload.mooncake.master: default "no-port" does not match the pattern',
  ]);
  assert.match(one({ storageKVOffload: { mooncake: { master: "" } } })[0], /default "" does not match the pattern$/);
  assert.match(one({ storageKVOffload: { mooncake: { master: null } } })[0], /default null is not a string$/);
  assert.match(one({ storageKVOffload: { mooncake: { master: { host: "h" } } } })[0], /default \{"host":"h"\} is not a string$/);
  assert.match(one({ a: { b: "8" } }, { path: "a.b", title: "t", type: "integer", example: 1 })[0], /default "8" is not an integer$/);
  assert.deepEqual(one({ storageKVOffload: { mooncake: "off" } }), [
    "v: requires.inputs[0] storageKVOffload.mooncake.master: values.storageKVOffload.mooncake is not a map, so it cannot hold this input",
  ]);
});

test("a path is declared once", () => {
  assert.deepEqual(inputProblems(variant([master, master])), ["requires.inputs[1] storageKVOffload.mooncake.master: declared twice"]);
});

test("the example is an answer: of the input's type, matching its pattern", () => {
  const one = (input) => inputProblems(variant([{ path: "a.b", title: "t", ...input }]));
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
    inputProblems(variant([{ path: "a.b", title: "t", type: "integer", pattern: "[0-9]+", example: 1 }]))[0],
    /pattern is only for a string input, and this one is integer$/,
  );
});

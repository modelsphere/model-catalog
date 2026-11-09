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

test("a declared input that values leaves alone, with a valid example, passes", () => {
  assert.deepEqual(inputProblems(variant([master], { storageKVOffload: { enabled: true, mooncake: { protocol: "rdma" } } })), []);
  assert.deepEqual(inputProblems({ requires: { gpus: 1 } }), []);
});

test("values may not answer an input: at its path, under it, or with a non-map on the way", () => {
  for (const [values, at] of [
    [{ storageKVOffload: { mooncake: { master: "" } } }, "storageKVOffload.mooncake.master"],
    [{ storageKVOffload: { mooncake: { master: { host: "h" } } } }, "storageKVOffload.mooncake.master"],
    [{ storageKVOffload: { mooncake: "off" } }, "storageKVOffload.mooncake"],
  ]) {
    const [line, ...rest] = inputProblems(variant([master], values), "v: ");
    assert.equal(rest.length, 0);
    assert.match(line, new RegExp(`^v: requires\\.inputs\\[0\\] storageKVOffload\\.mooncake\\.master: values\\.${at.replace(/\./g, "\\.")} sets it`));
  }
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

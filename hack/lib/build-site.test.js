"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { comparisonFor } = require("../build-site");

const version = {
  version: "1.0.0",
  variants: [
    { id: "baseline" },
    { id: "optimized", default: true },
  ],
};

function tuning(overrides = {}) {
  return {
    version: "1.0.0",
    baseline: "baseline",
    optimized: "optimized",
    uplift: 15.5,
    ...overrides,
  };
}

test("the headline uses the highest workload improvement", () => {
  const got = comparisonFor("model", [
    tuning({
      workloads: [
        { name: "50k + 1.5k", uplift: 15.5 },
        { name: "8k + 1k", uplift: 21.3 },
      ],
    }),
  ], version);

  assert.equal(got.bestPct, 21.3);
  assert.equal(got.bestLabel, "+21.3%");
  assert.equal(got.bestWorkload, "8k + 1k");
});

test("the headline falls back to tuning.uplift without workloads", () => {
  const got = comparisonFor("model", [tuning()], version);

  assert.equal(got.bestPct, 15.5);
  assert.equal(got.bestLabel, "+15.5%");
  assert.equal(got.bestWorkload, null);
});

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { rewritesOf } = require("./data");

const index = (models) => ({ models: models.map(([name, versions]) => ({ name, versions })) });
const v = (version, path, digest) => ({ version, path, digest });

test("a published version is matched by model and version: moved unchanged is a move, not a rewrite", () => {
  const published = index([
    ["gemma-it", [v("1.0.0", "models/gemma/gemma-it-1.0.0.yaml", "sha256:a")]],
    ["kimi", [v("1.0.1", "models/kimi/kimi-1.0.1.yaml", "sha256:b"), v("1.0.0", "models/kimi/kimi-1.0.0.yaml", "sha256:c")]],
  ]);
  const now = index([
    ["gemma-it", [v("1.0.0", "models/gemma-it/gemma-it-1.0.0.yaml", "sha256:a")]],
    ["kimi", [v("1.0.1", "models/kimi/kimi-1.0.1.yaml", "sha256:x")]],
  ]);
  assert.deepEqual(rewritesOf(published, now), {
    rewrites: [
      "models/kimi/kimi-1.0.1.yaml: published, now edited -- publish a new version instead",
      "models/kimi/kimi-1.0.0.yaml: published, now deleted -- deprecate the model instead",
    ],
    moves: ["models/gemma/gemma-it-1.0.0.yaml: moved to models/gemma-it/gemma-it-1.0.0.yaml, unchanged"],
  });
});

test("nothing published yet: nothing to check", () => {
  assert.deepEqual(rewritesOf(null, index([["m", [v("1.0.0", "models/m/m-1.0.0.yaml", "sha256:a")]]])), { rewrites: [], moves: [] });
});

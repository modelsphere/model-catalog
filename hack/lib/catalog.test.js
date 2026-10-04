"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { root, buildIndex, compareVersions, digest, latestOf } = require("./catalog");

const sorted = (vs) => [...vs].sort(compareVersions);

test("versions sort by semver precedence", () => {
  assert.deepEqual(sorted(["1.10.0", "1.2.0", "1.9.0"]), ["1.2.0", "1.9.0", "1.10.0"]);
  // The spec's own example.
  assert.deepEqual(
    sorted(["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-alpha.1", "1.0.0-alpha"]),
    ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
  );
});

test("latest is never a prerelease while a release exists", () => {
  assert.equal(latestOf(sorted(["1.1.0", "1.2.0-rc1"])), "1.1.0");
  assert.equal(latestOf(sorted(["1.2.0", "1.10.0-rc.1"])), "1.2.0");
  assert.equal(latestOf(sorted(["1.2.0-rc.1", "1.2.0-rc.2"])), "1.2.0-rc.2");
});

test("the index locks every version to its file's bytes", () => {
  const index = buildIndex();
  assert.ok(index.count > 0);
  for (const m of index.models) {
    assert.ok(m.versions.some((v) => v.version === m.latest), `${m.name}: latest is not one of its versions`);
    for (const v of m.versions) {
      assert.equal(v.digest, digest(fs.readFileSync(path.join(root, v.path))), v.path);
    }
  }
});

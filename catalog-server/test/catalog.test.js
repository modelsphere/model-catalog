"use strict";
// The catalog at a commit, as index-v2.json and its histories have it.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { test } = require("node:test");
const { catalogRepo, variant, catalogFiles, tmp, git } = require("./helpers");
const { Repo } = require("../src/git");
const { buildSnapshot } = require("../src/catalog");
const { parseTokens, Tokens } = require("../src/tokens");

const sha = (s) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");

function snapshotOf({ dir }, opts) {
  const r = new Repo({ dir, branch: "main" });
  return buildSnapshot(r, r.tip(), opts);
}

test("index-v2.json has the v2 models, each variant at its last change", () => {
  const repo = catalogRepo([
    ["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "models/m2/r.html": "<!doctype html><title>r</title>" }],
    ["2026-10-02T23:30:00Z", "tp4 1.0.1", { "models/m2/sglang-tp4.yaml": variant("sglang-tp4", "1.0.1", 2) }],
    ["2026-10-03T10:00:00Z", "catalog.yaml", { "catalog.yaml": { ...catalogFiles["catalog.yaml"], site: "https://example.com/d/" } }],
  ]);
  try {
    const { index, histories, commit } = snapshotOf(repo);
    assert.deepEqual(
      { ...index, models: undefined },
      {
        apiVersion: "catalog.swiss/v2",
        site: "https://example.com/d/",
        repo: "https://github.com/o/c",
        raw: "https://raw.githubusercontent.com/o/c/",
        commit,
        count: 1,
        models: undefined,
      },
    );
    const [m] = index.models;
    assert.deepEqual([m.name, m.reports, m.defaultVariant], ["m2", ["r.html"], "sglang-tp8"]);
    const tp4 = m.variants.find((v) => v.id === "sglang-tp4");
    assert.deepEqual(
      [tp4.version, tp4.releaseDate, tp4.commit, tp4.path, tp4.history],
      ["1.0.1", "2026-10-02", git(repo.dir, ["rev-parse", "main~1"]), "models/m2/sglang-tp4.yaml", "models/m2/sglang-tp4.history.json"],
    );
    const h = JSON.parse(histories.get("models/m2/sglang-tp4.history.json"));
    assert.deepEqual(
      h.revisions.map((r) => [r.version, r.releaseDate, r.subject]),
      [
        ["1.0.1", "2026-10-02", "tp4 1.0.1"],
        ["1.0.0", "2026-10-01", "init"],
      ],
    );
    assert.equal(h.revisions[0].digest, tp4.digest);
  } finally {
    repo.rm();
  }
});

test("catalog.yaml says where the catalog is served and its old revisions fetched", () => {
  const settings = {
    apiVersion: "catalog.swiss/v1",
    site: "https://c.example.com/x/",
    raw: "https://c.example.com/x/raw/",
    repo: "https://git.example.com/c",
  };
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "catalog.yaml": settings }]]);
  try {
    const { index } = snapshotOf(repo);
    assert.deepEqual([index.site, index.raw, index.repo], [settings.site, settings.raw, settings.repo]);
  } finally {
    repo.rm();
  }
});

test("a variant file's digest is of its bytes, comments and all", () => {
  const body = "# tuned\napiVersion: catalog.swiss/v2\nkind: Variant\nmodel: m2\nid: sglang-tp8\nversion: 1.0.0\n";
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "models/m2/sglang-tp8.yaml": body }]]);
  try {
    const { index } = snapshotOf(repo);
    assert.equal(index.models[0].variants.find((v) => v.id === "sglang-tp8").digest, sha(body));
  } finally {
    repo.rm();
  }
});

test("tokens name who writes, by the token or its sha256, and are read again when changed", () => {
  const hash = crypto.createHash("sha256").update("another-token-for-ci").digest("hex");
  const list = parseTokens(`- {name: CI, email: ci@example.com, sha256: ${hash}}\n`);
  assert.equal(list[0].name, "CI");
  assert.throws(() => parseTokens("- {name: x, email: x@example.com, token: short}"), /16 characters/);
  assert.throws(() => parseTokens("- {name: x, token: long-enough-token-1}"), /email/);

  const dir = tmp("tokens-");
  try {
    const file = `${dir}/tokens.yaml`;
    fs.writeFileSync(file, `- {name: CI, email: ci@example.com, sha256: ${hash}}\n`);
    const tokens = new Tokens(file);
    assert.deepEqual(tokens.who("Bearer another-token-for-ci"), { name: "CI", email: "ci@example.com" });
    assert.equal(tokens.who("Bearer another-token-for-cj"), null);
    assert.equal(tokens.who("Basic another-token-for-ci"), null);
    fs.writeFileSync(file, "[]\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(tokens.who("Bearer another-token-for-ci"), null, "revoked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

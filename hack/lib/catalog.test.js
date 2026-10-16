"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { root, buildIndex, compareVersions, digest, latestOf, schemaValidator } = require("./catalog");

const sorted = (vs) => [...vs].sort(compareVersions);

test("v1 and v2 tuning results do not require a report file", () => {
  const validateMetadata = schemaValidator()("metadata.schema.json");
  const validateMetadataV2 = schemaValidator()("metadata.v2.schema.json");
  const tuning = { baseline: "baseline@1.0.0", optimized: "optimized@1.0.0", uplift: 1.2 };
  assert.ok(
    validateMetadata({
      apiVersion: "catalog.swiss/v1",
      name: "demo",
      source: { hf: "org/demo" },
      tuning: [{ version: "1.0.0", baseline: "baseline", optimized: "optimized", uplift: 1.2 }],
    }),
    JSON.stringify(validateMetadata.errors),
  );
  assert.ok(
    validateMetadataV2({ apiVersion: "catalog.swiss/v2", name: "demo", source: { hf: "org/demo" }, tuning: [tuning] }),
    JSON.stringify(validateMetadataV2.errors),
  );
  assert.ok(
    validateMetadataV2({
      apiVersion: "catalog.swiss/v2",
      name: "demo",
      source: { hf: "org/demo" },
      tuning: [{ ...tuning, report: "missing.html" }],
    }),
    "A supplied safe report filename remains valid at schema level",
  );
  assert.ok(
    !validateMetadataV2({
      apiVersion: "catalog.swiss/v2",
      name: "demo",
      source: { hf: "org/demo" },
      tuning: [{ ...tuning, report: "../outside.html" }],
    }),
    "A supplied report must remain a safe filename",
  );
});

test("versions sort by semver precedence", () => {
  assert.deepEqual(sorted(["1.10.0", "1.2.0", "1.9.0"]), ["1.2.0", "1.9.0", "1.10.0"]);
  // The spec's own example.
  assert.deepEqual(
    sorted(["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-alpha.1", "1.0.0-alpha"]),
    ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"],
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
    assert.ok(
      m.versions.some((v) => v.version === m.latest),
      `${m.name}: latest is not one of its versions`,
    );
    for (const v of m.versions) {
      assert.equal(v.digest, digest(fs.readFileSync(path.join(root, v.path))), v.path);
    }
  }
});

const os = require("node:os");
const { execFileSync } = require("node:child_process");
const YAML = require("yaml");
const { buildIndexV2, checkIndexV2, modelFiles, revisionProblems, versionFiles, variantFiles } = require("./catalog");

// A git repo; each step writes files (null deletes) and commits at a UTC time.
function fixture(steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
  const git = (args, at) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      stdio: "pipe",
    });
  git(["init", "-q", "-b", "master"]);
  const write = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(dir, rel);
      if (body === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof body === "string" ? body : YAML.stringify(body));
      }
    }
  };
  const commit = (at, subject, files) => {
    write(files);
    git(["add", "-A"], at);
    git(["commit", "-q", "-m", subject], at);
  };
  for (const step of steps) commit(...step);
  return {
    dir,
    write,
    commit,
    head: () => git(["rev-parse", "HEAD"]).toString().trim(),
    sha: (n) =>
      git(["rev-parse", `HEAD~${n}`])
        .toString()
        .trim(),
  };
}

const variant = (id, version = "1.0.0", gpus = 8) => ({
  apiVersion: "catalog.swiss/v2",
  kind: "Variant",
  model: "m2",
  id,
  version,
  engine: "sglang",
  chart: { name: "sglang", version: ">=0.7.0" },
  requires: { gpus },
});

const catalogFiles = {
  "catalog.yaml": { apiVersion: "catalog.swiss/v1", site: "https://example.com/c/", repo: "https://github.com/o/c" },
  "models/m1/metadata.yaml": { apiVersion: "catalog.swiss/v1", name: "m1", source: { hf: "o/m1" } },
  "models/m1/m1-1.0.0.yaml": {
    apiVersion: "catalog.swiss/v1",
    name: "m1",
    version: "1.0.0",
    variants: [
      { id: "a", engine: "vllm", chart: { name: "vllm", version: "0.1.0" }, requires: { gpus: 1 } },
      { id: "b", default: true, engine: "vllm", chart: { name: "vllm", version: "0.1.0" }, requires: { gpus: 2 } },
    ],
  },
  "models/m2/metadata.yaml": { apiVersion: "catalog.swiss/v2", name: "m2", source: { hf: "o/m2" }, defaultVariant: "sglang-tp8" },
  "models/m2/sglang-tp8.yaml": variant("sglang-tp8"),
  "models/m2/sglang-tp4.yaml": variant("sglang-tp4", "1.0.0", 4),
};

test("a file is a v1 version or a v2 variant by its content, never its name", () => {
  const { dir } = fixture([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const models = path.join(dir, "models");
  assert.deepEqual(versionFiles("m1", models), ["models/m1/m1-1.0.0.yaml"]);
  assert.deepEqual(variantFiles("m2", models), ["models/m2/sglang-tp4.yaml", "models/m2/sglang-tp8.yaml"]);
  fs.writeFileSync(path.join(models, "m2/odd-1.0.0.yaml"), "apiVersion: catalog.swiss/v3\n");
  fs.writeFileSync(path.join(models, "m2/broken.yaml"), "a: [\n");
  const odd = modelFiles("m2", models).filter((f) => !f.kind);
  assert.deepEqual(
    odd.map((f) => [f.rel, !!f.error]),
    [
      ["models/m2/broken.yaml", true],
      ["models/m2/odd-1.0.0.yaml", false],
    ],
  );
});

test("index-v2 lists only v2 models, each variant file at its latest version", () => {
  const repo = fixture([
    ["2026-10-01T10:00:00Z", "init", catalogFiles],
    ["2026-10-02T08:00:00Z", "tp8: one", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 7) }],
    ["2026-10-02T21:00:00-05:00", "tp8: two", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.1.0", 6) }],
    ["2026-10-03T09:00:00Z", "drop tp4", { "models/m2/sglang-tp4.yaml": null }],
  ]);
  const built = buildIndexV2({ root: repo.dir, warn: () => {} });
  const { index, histories } = built;
  assert.deepEqual(checkIndexV2(built), []);
  assert.equal(index.commit, repo.head());
  assert.equal(index.raw, "https://raw.githubusercontent.com/o/c/");
  assert.deepEqual(
    index.models.map((m) => m.name),
    ["m2"],
  );
  const [m2] = index.models;
  assert.deepEqual(
    m2.variants.map((v) => [v.id, v.version, v.commit, v.history]),
    [["sglang-tp8", "1.1.0", repo.sha(1), "models/m2/sglang-tp8.history.json"]],
  );
  const tp8 = histories.get("models/m2/sglang-tp8.yaml");
  assert.deepEqual(
    tp8.revisions.map((r) => [r.version, r.subject]),
    [
      ["1.1.0", "tp8: two"],
      ["1.0.1", "tp8: one"],
      ["1.0.0", "init"],
    ],
  );
  // Each version's release date is its commit's, in UTC.
  assert.equal(m2.variants[0].releaseDate, "2026-10-03");
  assert.deepEqual(
    tp8.revisions.map((r) => r.releaseDate),
    ["2026-10-03", "2026-10-02", "2026-10-01"],
  );
  assert.equal(tp8.revisions[0].digest, m2.variants[0].digest);
  const tp4 = histories.get("models/m2/sglang-tp4.yaml");
  assert.deepEqual([tp4.revisions.map((r) => r.version), tp4.deleted.subject], [["1.0.0"], "drop tp4"]);
  assert.deepEqual(revisionProblems({ root: repo.dir }), []);
  assert.deepEqual(revisionProblems({ root: repo.dir, since: repo.sha(3) }), []);
});

test("a change must raise the version, and a raised version must change something", () => {
  const repo = fixture([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const since = repo.head();
  // The whole history, the working copy its newest change; and since a commit.
  const problems = () => [revisionProblems({ root: repo.dir }), revisionProblems({ root: repo.dir, since })];
  repo.write({ "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.0", 7) });
  assert.deepEqual(problems(), [
    [["models/m2/sglang-tp8.yaml", "working copy: changed without raising version above 1.0.0"]],
    [["models/m2/sglang-tp8.yaml", "changed without raising version above 1.0.0"]],
  ]);
  repo.write({ "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1") });
  assert.deepEqual(problems(), [
    [["models/m2/sglang-tp8.yaml", "working copy: version 1.0.1 changes nothing else"]],
    [["models/m2/sglang-tp8.yaml", "version 1.0.1 changes nothing else"]],
  ]);
  repo.write({ "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 7) });
  const { index } = buildIndexV2({ root: repo.dir, warn: () => {} });
  const tp8 = index.models[0].variants[1];
  assert.deepEqual([tp8.version, tp8.commit, tp8.releaseDate], ["1.0.1", undefined, undefined]);
  assert.deepEqual(problems(), [[], []]);
});

test("with since, versions are checked against one commit: the branch's commits since it are one change", () => {
  const repo = fixture([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const since = repo.head();
  repo.commit("2026-10-02T10:00:00Z", "bump", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 7) });
  repo.commit("2026-10-03T10:00:00Z", "fix values", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 6) });
  assert.deepEqual(revisionProblems({ root: repo.dir, since }), []);
  // The whole history has the fix as a change of its own, at the same version.
  assert.deepEqual(revisionProblems({ root: repo.dir }), [
    ["models/m2/sglang-tp8.yaml", `${repo.head().slice(0, 7)}: changed without raising version above 1.0.1`],
  ]);
  // From the bump on, the fix alone is a change at the same version.
  assert.deepEqual(revisionProblems({ root: repo.dir, since: repo.sha(1) }), [
    ["models/m2/sglang-tp8.yaml", "changed without raising version above 1.0.1"],
  ]);
  // Uncommitted edits count too.
  repo.write({ "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.0", 5) });
  assert.deepEqual(revisionProblems({ root: repo.dir, since }), [["models/m2/sglang-tp8.yaml", "changed without raising version above 1.0.0"]]);
  // Back to the bytes at that commit: nothing changed, so nothing to raise.
  repo.write({ "models/m2/sglang-tp8.yaml": variant("sglang-tp8") });
  assert.deepEqual(revisionProblems({ root: repo.dir, since }), []);
});

test("a shallow clone is refused: its versions would be wrong", () => {
  const repo = fixture([
    ["2026-10-01T10:00:00Z", "init", catalogFiles],
    ["2026-10-02T10:00:00Z", "edit", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 7) }],
  ]);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-shallow-"));
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${repo.dir}`, clone]);
  assert.throws(() => buildIndexV2({ root: clone, warn: () => {} }), /shallow clone/);
});

test("the catalog's own index-v2.json passes its checks", () => {
  const built = buildIndexV2({ warn: () => {} });
  assert.deepEqual(checkIndexV2(built), []);
  assert.ok(built.index.models.every((m) => m.variants.every((v) => v.history)));
});

"use strict";
// An empty catalog, made one: GET api/v2/init says whether it is, and POST
// commits the template's files.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { catalogRepo, serve, variant, catalogFiles, git, tmp, YAML } = require("./helpers");

const PUBLIC = "https://catalog.example.com/";
const model = JSON.stringify({
  metadata: YAML.stringify({ apiVersion: "catalog.swiss/v2", name: "m2" }),
  variants: [YAML.stringify(variant("sglang-tp8"))],
});

test("an empty directory is a catalog to initialize, and nothing is written to it until it is", async (t) => {
  const dir = path.join(tmp("empty-"), "catalog");
  const s = await serve({ dir });
  t.after(() => (s.close(), fs.rmSync(path.dirname(dir), { recursive: true, force: true })));
  assert.equal(fs.existsSync(dir), false, "nothing made at start");
  assert.deepEqual((await s.json("api/v2/init", { auth: null })).body, { initialized: false, commit: null });
  assert.deepEqual((await s.json("index-v2.json")).body.models, []);

  const early = await s.json("api/v2/models", { method: "POST", body: model });
  assert.deepEqual([early.status, early.body.error], [409, "the catalog is not initialized: POST api/v2/init first"]);
  assert.equal((await s.json("api/v2/init", { method: "POST", auth: null })).status, 401);
  const dry = await s.json("api/v2/init?dryRun=true", { method: "POST" });
  assert.deepEqual([dry.body.dryRun, dry.body.commit, s.repo.tip()], [true, null, null]);
  assert.deepEqual([dry.body.files, fs.existsSync(dir)], [["README.md", "catalog.yaml"], false], "nor by a dry run");

  const done = await s.json("api/v2/init?message=Start+the+catalog", {
    method: "POST",
    body: JSON.stringify({ site: "https://catalog.example.com", repo: "https://git.example.com/ml/catalog/" }),
  });
  assert.equal(done.status, 201);
  assert.equal(git(dir, ["rev-parse", "--is-bare-repository"]), "true", "made by setting it up");
  assert.deepEqual(done.body, { commit: s.repo.tip(), initialized: true, files: ["README.md", "catalog.yaml"] });
  assert.equal(git(dir, ["log", "--format=%an|%s", "main"]), "Ada Lovelace|Start the catalog");
  const settings = YAML.parse(git(dir, ["show", "main:catalog.yaml"]));
  // Where it is served is the catalog's to say: the index follows it.
  assert.deepEqual(settings, { apiVersion: "catalog.swiss/v1", site: PUBLIC, raw: `${PUBLIC}raw/`, repo: "https://git.example.com/ml/catalog" });
  const index = (await s.json("index-v2.json")).body;
  assert.deepEqual([index.site, index.raw], [PUBLIC, `${PUBLIC}raw/`]);
  assert.deepEqual((await s.json("api/v2/init")).body, { initialized: true, commit: done.body.commit });
  assert.equal((await s.json("index-v2.json")).body.repo, "https://git.example.com/ml/catalog");

  assert.equal((await s.json("api/v2/init", { method: "POST" })).status, 409, "once");
  assert.equal((await s.json("api/v2/models", { method: "POST", body: model })).status, 201);
});

test("a setting left unset is left out of catalog.yaml, not written empty", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  await s.json("api/v2/init", { method: "POST" });
  const text = git(s.repo.dir, ["show", "main:catalog.yaml"]);
  assert.deepEqual(YAML.parse(text), { apiVersion: "catalog.swiss/v1" });
  assert.doesNotMatch(text, /^(site|raw|repo):/m);
  // Nor their comments: the file reads as one with nothing unset.
  assert.doesNotMatch(text, /served|revisions|repository/);
  assert.match(text, /^apiVersion: catalog\.swiss\/v1$/m);
});

test("a site or repo that is not an http(s) URL, or has credentials in it, is refused", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  const bad = await s.json("api/v2/init", {
    method: "POST",
    body: JSON.stringify({ site: "catalog.example.com", repo: "https://u:secret@git.example.com/c" }),
  });
  assert.equal(bad.status, 422);
  assert.deepEqual(
    bad.body.problems.map((p) => p.split(":")[1].trim()),
    ["site", "repo"],
  );
  assert.equal(s.repo.tip(), null);
});

test("a repository with models but no catalog.yaml is initialized around them, its files kept", async (t) => {
  const { "catalog.yaml": _, ...rest } = catalogFiles;
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "models", { ...rest, "README.md": "ours\n" }]]);
  const s = await serve({ dir: repo.dir });
  t.after(() => (s.close(), repo.rm()));
  assert.equal((await s.json("api/v2/init")).body.initialized, false);
  assert.equal((await s.json("index-v2.json")).body.count, 1, "served meanwhile");
  const done = await s.json("api/v2/init", { method: "POST" });
  assert.deepEqual(done.body.files, ["catalog.yaml"]);
  assert.equal(repo.head(), done.body.commit);
  assert.equal(git(repo.dir, ["show", "main:README.md"]), "ours");
});

test("a template of one's own", async (t) => {
  const template = tmp("template-");
  fs.mkdirSync(path.join(template, "docs"));
  fs.writeFileSync(path.join(template, "catalog.yaml"), "apiVersion: catalog.swiss/v1\nsite: {{site}}\n");
  fs.writeFileSync(path.join(template, "docs/HOWTO.md"), "Served at {{site}}.\n");
  const s = await serve({ template });
  t.after(() => (s.close(), fs.rmSync(template, { recursive: true, force: true })));
  const done = await s.json("api/v2/init", { method: "POST", body: JSON.stringify({ site: PUBLIC }) });
  assert.deepEqual(done.body.files, ["catalog.yaml", "docs/HOWTO.md"]);
  assert.equal(git(s.repo.dir, ["show", "main:docs/HOWTO.md"]), `Served at ${PUBLIC}.`);
});

test("an empty directory stays empty until setup, and one made there meanwhile is taken as it is", async (t) => {
  const dir = tmp("mount-");
  const s = await serve({ dir });
  t.after(() => (s.close(), fs.rmSync(dir, { recursive: true, force: true })));
  assert.deepEqual(fs.readdirSync(dir), []);
  await s.store.sync();
  assert.deepEqual(fs.readdirSync(dir), [], "a sync makes nothing either");

  // Someone puts a catalog there by hand.
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  t.after(() => repo.rm());
  fs.rmSync(dir, { recursive: true });
  git(path.dirname(dir), ["clone", "-q", "--bare", repo.dir, dir]);
  await s.store.sync();
  assert.deepEqual((await s.json("api/v2/init")).body, { initialized: true, commit: repo.head() });
  assert.equal((await s.json("index-v2.json")).body.count, 1);
});

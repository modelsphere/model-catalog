"use strict";
// Writes as a client makes them, over HTTP.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { afterEach, beforeEach, test } = require("node:test");
const { catalogRepo, serve, variant, catalogFiles, YAML } = require("./helpers");

const PUBLIC = "https://catalog.example.com/";
const sha = (s) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");

let repo;
let s;
beforeEach(async () => {
  // Served, its catalog.yaml says, at PUBLIC: old revisions at its raw/.
  const settings = { ...catalogFiles["catalog.yaml"], site: PUBLIC, raw: `${PUBLIC}raw/` };
  repo = catalogRepo([["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "catalog.yaml": settings }]]);
  s = await serve({ dir: repo.dir });
});
afterEach(() => {
  s.close();
  repo.rm();
});

const put = (rel, body, headers = {}, init = {}) => s.json(rel, { method: "PUT", body, headers, ...init });
const tp4 = "api/v2/models/m2/variants/sglang-tp4";

test("a variant is read with its digest, and replaced at that digest", async () => {
  const res = await s.fetch(tp4);
  const text = await res.text();
  assert.equal(res.headers.get("etag"), `"${sha(text)}"`);

  const body = YAML.stringify({ ...variant("sglang-tp4", "1.1.0", 4), description: "TP4, measured" });
  const done = await put(tp4, body, { "If-Match": res.headers.get("etag"), "X-Commit-Message": "tp4: measured" });
  assert.equal(done.status, 200);
  assert.equal(done.body.commit, repo.head(), "committed before it answered");
  assert.deepEqual(
    { version: done.body.version, digest: done.body.digest, path: done.body.path, history: done.body.history },
    { version: "1.1.0", digest: sha(body), path: "models/m2/sglang-tp4.yaml", history: "models/m2/sglang-tp4.history.json" },
  );
  assert.equal(done.etag, `"${sha(body)}"`);
  assert.equal(repo.show(done.body.commit), "Ada Lovelace <ada@example.com>|catalog-server|tp4: measured");

  // Served at once, exactly as sent.
  assert.equal(await (await s.fetch("models/m2/sglang-tp4.yaml")).text(), body);
  const index = await (await s.fetch("index-v2.json")).json();
  const v = index.models.find((m) => m.name === "m2").variants.find((x) => x.id === "sglang-tp4");
  assert.deepEqual([v.version, v.commit, v.digest], ["1.1.0", done.body.commit, sha(body)]);
  assert.equal(index.commit, done.body.commit);
});

test("an old revision stays where swiss fetches it, at its digest", async () => {
  const before = await (await s.fetch("models/m2/sglang-tp4.yaml")).text();
  const res = await s.fetch(tp4);
  await put(tp4, YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), { "If-Match": res.headers.get("etag") });
  const index = await (await s.fetch("index-v2.json")).json();
  assert.deepEqual([index.site, index.raw], [PUBLIC, `${PUBLIC}raw/`]);
  const v = index.models[0].variants.find((x) => x.id === "sglang-tp4");
  const { revisions } = await (await s.fetch(v.history)).json();
  assert.deepEqual(
    revisions.map((r) => r.version),
    ["1.0.1", "1.0.0"],
  );
  // swiss: <raw><commit>/<path>, checked against the revision's digest.
  const old = await s.fetch(`raw/${revisions[1].commit}/${v.path}`);
  const bytes = await old.text();
  assert.equal(bytes, before);
  assert.equal(sha(bytes), revisions[1].digest);
  assert.match(old.headers.get("cache-control"), /immutable/);
});

test("a variant is added once, and only where it is named", async () => {
  const rel = "api/v2/models/m2/variants/vllm-tp2";
  const body = YAML.stringify({ ...variant("vllm-tp2", "0.1.0", 2), engine: "vllm" });
  const done = await put(rel, body, { "If-None-Match": "*" });
  assert.equal(done.status, 201);
  assert.match(repo.show(done.body.commit), /\|m2\/vllm-tp2: add 0\.1\.0$/);
  assert.equal((await s.fetch("models/m2/vllm-tp2.history.json")).status, 200);
  const again = await put(rel, YAML.stringify(variant("vllm-tp2", "0.2.0", 2)), { "If-None-Match": "*" });
  assert.equal(again.status, 412);
  assert.equal(again.body.current, sha(body));

  const elsewhere = await put("api/v2/models/m2/variants/other", body, { "If-None-Match": "*" });
  assert.equal(elsewhere.status, 422);
  assert.deepEqual(elsewhere.body.problems, ['models/m2/other.yaml: id: "vllm-tp2" is not other, the file it is written to']);
});

test("a write must have seen what it replaces", async () => {
  const body = YAML.stringify(variant("sglang-tp4", "1.1.0", 4));
  const missing = await put(tp4, body);
  assert.equal(missing.status, 428);
  const stale = await put(tp4, body, { "If-Match": `"${sha("something else")}"` });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current, sha(await (await s.fetch("models/m2/sglang-tp4.yaml")).text()));
  assert.equal(repo.head(), s.store.snapshot.commit, "nothing committed");
});

test("each change raises the version, and changes more than that", async () => {
  const etag = (await s.fetch(tp4)).headers.get("etag");
  const same = await put(tp4, YAML.stringify(variant("sglang-tp4", "1.0.0", 2)), { "If-Match": etag });
  assert.equal(same.status, 422);
  assert.match(same.body.problems[0], /1\.0\.0 does not raise 1\.0\.0, the last revision's -- send 1\.0\.1 or above/);
  const only = await put(tp4, `# reworded\n${YAML.stringify(variant("sglang-tp4", "1.0.1", 4))}`, { "If-Match": etag });
  assert.equal(only.status, 422);
  assert.match(only.body.problems[0], /version 1\.0\.1 changes nothing else from 1\.0\.0/);
  const bad = await put(tp4, "model: [", { "If-Match": etag });
  assert.equal(bad.status, 422);
  assert.match(bad.body.problems[0], /^models\/m2\/sglang-tp4\.yaml: not YAML/);
  const wrong = await put(tp4, YAML.stringify({ ...variant("sglang-tp4", "2", 4), apiVersion: "catalog.swiss/v1", model: "m1" }), {
    "If-Match": etag,
  });
  assert.deepEqual(wrong.body.problems, [
    "models/m2/sglang-tp4.yaml: apiVersion: want catalog.swiss/v2",
    'models/m2/sglang-tp4.yaml: model: "m1" is not m2, the model it is written to',
    'models/m2/sglang-tp4.yaml: version: "2" is not a semver version, such as "1.0.0"',
  ]);
});

test("the same bytes again commit nothing, whatever they were read at", async () => {
  const etag = (await s.fetch(tp4)).headers.get("etag");
  const body = YAML.stringify(variant("sglang-tp4", "1.0.1", 2));
  const first = await put(tp4, body, { "If-Match": etag });
  const retry = await put(tp4, body, { "If-Match": etag });
  assert.equal(retry.status, 200);
  assert.deepEqual([retry.body.unchanged, retry.body.commit], [true, first.body.commit]);
});

test("a dry run says what a write would do, and commits nothing", async () => {
  const etag = (await s.fetch(tp4)).headers.get("etag");
  const head = repo.head();
  const ok = await put(`${tp4}?dryRun=true`, YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), { "If-Match": etag });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.dryRun, ok.body.commit, ok.body.version], [true, null, "1.0.1"]);
  const no = await put(`${tp4}?dryRun=true`, YAML.stringify(variant("sglang-tp4", "0.9.0", 2)), { "If-Match": etag });
  assert.equal(no.status, 422);
  assert.equal(repo.head(), head);
  assert.equal(s.store.repo.tip(), head);
  assert.equal((await (await s.fetch("index-v2.json")).json()).commit, head);
});

test("only a token's holder writes", async () => {
  const body = YAML.stringify(variant("sglang-tp4", "1.0.1", 2));
  const none = await put(tp4, body, {}, { auth: null });
  const wrong = await put(tp4, body, {}, { auth: "not-the-token-at-all" });
  assert.deepEqual(
    [none.status, none.body.error, wrong.status, wrong.body.error],
    [401, "send Authorization: Bearer <token>", 401, "that token is not in the server's tokensFile"],
  );
  const closed = await serve({ dir: repo.dir, tokens: null });
  try {
    assert.equal((await closed.json(tp4, { method: "PUT", body })).status, 403);
    assert.equal((await closed.fetch("index-v2.json", { auth: null })).status, 200, "reads need none");
  } finally {
    closed.close();
  }
});

test("a variant is deleted unless something names it, and its history stays", async () => {
  const tp8 = "api/v2/models/m2/variants/sglang-tp8";
  const named = await s.json(tp8, { method: "DELETE", headers: { "If-Match": (await s.fetch(tp8)).headers.get("etag") } });
  assert.equal(named.status, 422);
  assert.deepEqual(named.body.problems, ["models/m2/metadata.yaml: defaultVariant is sglang-tp8 -- name another first"]);

  const old = await (await s.fetch("index-v2.json")).json();
  const done = await s.json(tp4, { method: "DELETE", headers: { "If-Match": (await s.fetch(tp4)).headers.get("etag") } });
  assert.equal(done.status, 200);
  assert.equal(done.body.deleted, true);
  assert.equal((await s.fetch(tp4)).status, 404);
  assert.equal((await s.fetch("models/m2/sglang-tp4.yaml")).status, 404);
  const history = await (await s.fetch("models/m2/sglang-tp4.history.json")).json();
  assert.equal(history.deleted.commit, done.body.commit);
  // A deploy pinned to it still finds it.
  const v = old.models[0].variants.find((x) => x.id === "sglang-tp4");
  assert.equal(sha(await (await s.fetch(`raw/${v.commit}/${v.path}`)).text()), v.digest);

  // Back again, its history goes on: it must raise the last version.
  const back = await put(tp4, YAML.stringify(variant("sglang-tp4", "1.0.0", 2)), { "If-None-Match": "*" });
  assert.equal(back.status, 422);
  assert.equal((await put(tp4, YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), { "If-None-Match": "*" })).status, 201);
});

test("metadata is replaced at its digest, naming variants the model has", async () => {
  const rel = "api/v2/models/m2/metadata";
  const res = await s.fetch(rel);
  const meta = YAML.parse(await res.text());
  const unknown = await put(rel, YAML.stringify({ ...meta, defaultVariant: "nope" }), { "If-Match": res.headers.get("etag") });
  assert.equal(unknown.status, 422);
  const done = await put(rel, YAML.stringify({ ...meta, displayName: "M2", defaultVariant: "sglang-tp4" }), { "If-Match": res.headers.get("etag") });
  assert.equal(done.status, 200);
  const index = await (await s.fetch("index-v2.json")).json();
  assert.deepEqual([index.models[0].displayName, index.models[0].defaultVariant], ["M2", "sglang-tp4"]);
});

test("a model is created with its first variants, in one commit", async () => {
  const meta = { apiVersion: "catalog.swiss/v2", name: "m3", displayName: "M3", defaultVariant: "a" };
  const body = JSON.stringify({
    metadata: YAML.stringify(meta),
    variants: [variant("a", "1.0.0", 1, "m3"), variant("b", "1.0.0", 2, "m3")].map((v) => YAML.stringify(v)),
  });
  const done = await s.json("api/v2/models", { method: "POST", body });
  assert.equal(done.status, 201);
  assert.deepEqual(
    done.body.variants.map((v) => v.id),
    ["a", "b"],
  );
  const index = await (await s.fetch("index-v2.json")).json();
  assert.deepEqual(
    index.models.map((m) => m.name),
    ["m2", "m3"],
  );
  assert.equal((await s.json("api/v2/models", { method: "POST", body })).status, 409);
  const noDefault = JSON.stringify({ metadata: YAML.stringify({ ...meta, name: "m4" }), variants: [YAML.stringify(variant("b", "1.0.0", 1, "m4"))] });
  assert.deepEqual((await s.json("api/v2/models", { method: "POST", body: noDefault })).body.problems, [
    'models/m4/metadata.yaml: defaultVariant: "a" is not a variant of m4',
  ]);
});

test("a v1 model is not written, nor its files served", async () => {
  const res = await put("api/v2/models/m1/variants/a", YAML.stringify(variant("a", "1.0.0", 1, "m1")), { "If-None-Match": "*" });
  assert.equal(res.status, 422);
  assert.match(res.body.problems[0], /only v2 models are written here/);
  assert.equal((await s.fetch("models/m1/m1-1.0.0.yaml")).status, 404);
  assert.equal((await put("api/v2/models/nope/variants/a", "", { "If-None-Match": "*" })).status, 404);
});

test("a commit message may come in the query, in any script", async () => {
  const etag = (await s.fetch(tp4)).headers.get("etag");
  const done = await put(`${tp4}?message=${encodeURIComponent("tp4: 显存 0.86")}`, YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), {
    "If-Match": etag,
  });
  assert.match(repo.show(done.body.commit), /\|tp4: 显存 0\.86$/);
});

test("the server says it takes writes, and how", async () => {
  assert.deepEqual((await s.json("api/v2/", { auth: null })).body, { apiVersion: "catalog.swiss/v2", write: true, auth: "bearer" });
  assert.equal((await s.fetch("api/v2", { auth: null })).status, 200);
  const closed = await serve({ dir: repo.dir, tokens: null });
  try {
    assert.equal((await closed.json("api/v2/")).body.write, false);
  } finally {
    closed.close();
  }
});

test("catalog.yaml is read at its digest, and replaced there: the index follows it at once", async () => {
  const res = await s.fetch("api/v2/catalog", { auth: null });
  const text = await res.text();
  assert.match(text, /^site: https:\/\/catalog\.example\.com\/$/m);
  const moved = text
    .replace(/^site: .*$/m, "site: https://catalog.internal.example/")
    .replace(/^raw: .*$/m, "raw: https://catalog.internal.example/raw/");

  assert.equal((await put("api/v2/catalog", moved)).status, 428);
  assert.equal((await put("api/v2/catalog", moved, { "If-Match": `"${sha("other")}"` })).status, 412);
  const dry = await put("api/v2/catalog?dryRun=true", moved, { "If-Match": res.headers.get("etag") });
  assert.deepEqual([dry.status, dry.body.commit, dry.body.site], [200, null, "https://catalog.internal.example/"]);
  assert.equal((await s.json("index-v2.json")).body.site, PUBLIC, "a dry run moves nothing");

  const done = await put("api/v2/catalog?message=catalog%3A+moved", moved, { "If-Match": res.headers.get("etag") });
  assert.equal(done.status, 200);
  assert.equal(done.body.commit, repo.head());
  assert.match(repo.show(done.body.commit), /^Ada Lovelace <ada@example\.com>\|catalog-server\|catalog: moved$/);
  const index = (await s.json("index-v2.json")).body;
  assert.deepEqual([index.site, index.raw], ["https://catalog.internal.example/", "https://catalog.internal.example/raw/"]);
});

test("catalog.yaml's settings are model-catalog's, each an http(s) URL with no credentials in it", async () => {
  const etag = (await s.fetch("api/v2/catalog")).headers.get("etag");
  const bad = await put(
    "api/v2/catalog",
    "apiVersion: catalog.swiss/v2\nsite: catalog.example.com\nraw: https://u:pw@catalog.example.com/raw/\nrepo: ssh://git@git.example.com/c\ntitle: x\n",
    { "If-Match": etag },
  );
  assert.equal(bad.status, 422);
  assert.deepEqual(
    bad.body.problems.map((p) => p.split(":")[1].trim()),
    ["apiVersion", "site", "raw", "repo", "title"],
  );
});

test("plain http, and a slash or none, are fine: the index puts the slash each needs", async () => {
  const etag = (await s.fetch("api/v2/catalog")).headers.get("etag");
  const done = await put(
    "api/v2/catalog",
    "apiVersion: catalog.swiss/v1\nsite: http://127.0.0.1:8000\nraw: http://127.0.0.1:8000/raw\nrepo: http://127.0.0.1:8000/\n",
    { "If-Match": etag },
  );
  assert.equal(done.status, 200);
  const index = (await s.json("index-v2.json")).body;
  assert.deepEqual([index.site, index.raw, index.repo], ["http://127.0.0.1:8000/", "http://127.0.0.1:8000/raw/", "http://127.0.0.1:8000"]);
});

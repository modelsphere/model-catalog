"use strict";
// The server and a push to its repository: who moves first, and what is
// served meanwhile.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { catalogRepo, serve, variant, catalogFiles, git, YAML } = require("./helpers");

const tp4 = "api/v2/models/m2/variants/sglang-tp4";

test("a push to the repository is served after the next sync", async (t) => {
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const s = await serve({ dir: repo.dir });
  t.after(() => (s.close(), repo.rm()));
  const at = repo.commit("2026-10-02T10:00:00Z", "tp4 1.0.1", { "models/m2/sglang-tp4.yaml": variant("sglang-tp4", "1.0.1", 2) });
  assert.notEqual(s.store.snapshot.commit, at, "not before");
  await s.store.sync();
  const index = await (await s.fetch("index-v2.json")).json();
  assert.equal(index.commit, at);
  const v = index.models[0].variants.find((x) => x.id === "sglang-tp4");
  assert.deepEqual([v.version, v.releaseDate], ["1.0.1", "2026-10-02"]);

  // A force-push is served too: the branch is what it is.
  git(repo.work, ["reset", "-q", "--hard", "HEAD~1"]);
  git(repo.work, ["push", "-q", "--force", "origin", "HEAD:main"]);
  await s.store.sync();
  assert.equal(s.store.snapshot.commit, repo.head());
});

test("a write plans on the tip, so a push it has not served yet is no conflict", async (t) => {
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const s = await serve({ dir: repo.dir });
  t.after(() => (s.close(), repo.rm()));
  const etag = (await s.fetch(tp4)).headers.get("etag");
  repo.commit("2026-10-02T10:00:00Z", "tp8 1.0.1", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 4) });
  const done = await s.json(tp4, { method: "PUT", body: YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), headers: { "If-Match": etag } });
  assert.equal(done.status, 200);
  assert.equal(repo.head(), done.body.commit);
  assert.match(git(repo.dir, ["log", "--format=%s", "-2", "main"]), /^m2\/sglang-tp4: 1\.0\.1\ntp8 1\.0\.1$/);
});

test("a push between a write's commit and its move is a conflict, and the push stays", async (t) => {
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", catalogFiles]]);
  const s = await serve({ dir: repo.dir });
  t.after(() => (s.close(), repo.rm()));
  const etag = (await s.fetch(tp4)).headers.get("etag");
  const move = s.repo.move.bind(s.repo);
  s.repo.move = (...args) => {
    repo.commit("2026-10-02T10:00:00Z", "tp8 1.0.1", { "models/m2/sglang-tp8.yaml": variant("sglang-tp8", "1.0.1", 4) });
    return move(...args);
  };
  const before = s.store.snapshot.commit;
  const done = await s.json(tp4, { method: "PUT", body: YAML.stringify(variant("sglang-tp4", "1.0.1", 2)), headers: { "If-Match": etag } });
  assert.equal(done.status, 409);
  assert.match(done.body.error, /moved while this was written/);
  assert.equal(s.store.snapshot.commit, before);
  assert.match(git(repo.dir, ["log", "--format=%s", "-1", "main"]), /^tp8/);
});

test("healthz says which commit is served, and what is wrong with it", async (t) => {
  const repo = catalogRepo([["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "models/m3/metadata.yaml": "name: [" }]]);
  const s = await serve({ dir: repo.dir, base: "/catalog/" });
  const gone = `${repo.dir}.gone`;
  t.after(() => {
    s.close();
    if (fs.existsSync(gone)) fs.renameSync(gone, repo.dir);
    repo.rm();
  });
  const res = await fetch(new URL("/healthz", s.base));
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.commit, repo.head());
  assert.match(health.warnings[0], /^models\/m3\/metadata\.yaml: .* -- skipped$/);

  // The repository gone (a volume unmounted): the last snapshot is served,
  // not an empty catalog, and said to be.
  fs.renameSync(repo.dir, gone);
  await s.store.sync();
  const after = await (await fetch(new URL("/healthz", s.base))).json();
  assert.equal(after.commit, health.commit);
  assert.match(after.problem, /git/);
  assert.equal((await s.json("index-v2.json")).body.count, 1);
  const write = await s.json(tp4, { method: "PUT", body: "x", headers: { "If-Match": "*" } });
  assert.equal(write.status, 503);
});

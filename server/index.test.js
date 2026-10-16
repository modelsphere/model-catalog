"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { fixture, catalogFiles, report } = require("../hack/lib/fixture");
const { createServer } = require(".");

let server;
let base;
let dir;
before(async () => {
  ({ dir } = fixture([["2026-10-01T10:00:00Z", "init", { ...catalogFiles, "models/m2/m2-report.html": report }]]));
  server = createServer({ root: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("index.json is the catalog swiss reads, and anyone may fetch it", async () => {
  const res = await fetch(`${base}/index.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const index = await res.json();
  assert.equal(index.apiVersion, "catalog.swiss/v1");
  assert.deepEqual(
    index.models.map((m) => m.name),
    ["m1"],
  );
});

test("every version file the index names is served at its path, as it is", async () => {
  const index = await (await fetch(`${base}/index.json`)).json();
  const rel = index.models[0].versions[0].path;
  const res = await fetch(`${base}/${rel}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/yaml/);
  assert.equal(await res.text(), fs.readFileSync(path.join(dir, rel), "utf8"));
});

test("index-v2.json lists only v2 models, and each variant's file and history is served", async () => {
  const index = await (await fetch(`${base}/index-v2.json`)).json();
  assert.equal(index.apiVersion, "catalog.swiss/v2");
  assert.deepEqual(
    index.models.map((m) => m.name),
    ["m2"],
  );
  for (const v of index.models.flatMap((m) => m.variants)) {
    const h = await (await fetch(`${base}/${v.history}`)).json();
    assert.deepEqual([h.path, h.revisions[0].digest], [v.path, v.digest]);
    assert.equal(await (await fetch(`${base}/${v.path}`)).text(), fs.readFileSync(path.join(dir, v.path), "utf8"));
  }
});

test("the perf reports index-v2.json lists are served, and catalog.json is gone", async () => {
  const index = await (await fetch(`${base}/index-v2.json`)).json();
  assert.deepEqual(index.models[0].reports, ["m2-report.html"]);
  const res = await fetch(`${base}/models/m2/m2-report.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.equal((await fetch(`${base}/catalog.json`)).status, 404);
});

test("nothing outside models/ is served, and only reads are allowed", async () => {
  for (const p of [
    "/catalog.yaml",
    "/models/../catalog.yaml",
    "/models/%2e%2e/catalog.yaml",
    "/models/m1/../../catalog.yaml",
    "/models/nope/x.yaml",
  ]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(`${base}/models/m1/m1-1.0.0.yaml`, { method: "POST" })).status, 405);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { root, modelNames, versionFiles } = require("../hack/lib/catalog");
const { createServer } = require(".");

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("index.json is the catalog swiss reads, and anyone may fetch it", async () => {
  const res = await fetch(`${base}/index.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const index = await res.json();
  assert.equal(index.apiVersion, "catalog.swiss/v1");
  assert.equal(index.count, modelNames().length);
});

test("every version file the index names is served at its path, as it is", async () => {
  const index = await (await fetch(`${base}/index.json`)).json();
  const rel = index.models[0].versions[0].path;
  const res = await fetch(`${base}/${rel}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/yaml/);
  assert.equal(await res.text(), fs.readFileSync(path.join(root, rel), "utf8"));
});

test("catalog.json and the perf reports it links are served", async () => {
  const catalog = await (await fetch(`${base}/catalog.json`)).json();
  assert.equal(catalog.count, modelNames().length);
  const report = catalog.models.flatMap((m) => m.reports)[0];
  const res = await fetch(`${base}/${report.path}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
});

test("index-v2.json lists only v2 models, and each variant's history is served", async () => {
  const index = await (await fetch(`${base}/index-v2.json`)).json();
  assert.equal(index.apiVersion, "catalog.swiss/v2");
  for (const v of index.models.flatMap((m) => m.variants)) {
    const h = await (await fetch(`${base}/${v.history}`)).json();
    assert.deepEqual([h.path, h.revisions[0].digest], [v.path, v.digest]);
  }
});

test("nothing outside models/ is served, and only reads are allowed", async () => {
  const name = modelNames()[0];
  for (const p of ["/package.json", "/models/../package.json", "/models/%2e%2e/catalog.yaml", `/models/${name}/../../catalog.yaml`, "/models/nope/x.yaml"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(`${base}/${versionFiles(name)[0]}`, { method: "POST" })).status, 405);
});

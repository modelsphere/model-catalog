"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseRepository, isPrivateAddress, manifestProblem, imageProblem, buildOf, reportMismatches } = require("./images");

const publicDns = async () => [{ address: "52.45.125.121" }];

// A registry that wants an anonymous token, as Docker Hub and Harbor do.
function registry({ manifests = {}, token = "t", failures = 0 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(url);
    if (failures-- > 0) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    if (url.startsWith("https://auth.example/token")) {
      return { ok: Boolean(token), status: token ? 200 : 401, json: async () => (token ? { token } : {}) };
    }
    const authed = init.headers && init.headers.Authorization === `Bearer ${token}`;
    if (!authed) {
      return { ok: false, status: 401, headers: new Headers({ "www-authenticate": 'Bearer realm="https://auth.example/token",service="reg"' }) };
    }
    const ref = url.split("/manifests/")[1];
    return { ok: Boolean(manifests[ref]), status: manifests[ref] ? 200 : 404, headers: new Headers() };
  };
  return { fetch, calls };
}

test("repositories resolve the way containerd resolves them", () => {
  assert.deepEqual(parseRepository("lmsysorg/sglang"), { registry: "docker.io", host: "registry-1.docker.io", name: "lmsysorg/sglang" });
  assert.deepEqual(parseRepository("nginx"), { registry: "docker.io", host: "registry-1.docker.io", name: "library/nginx" });
  assert.deepEqual(parseRepository("quay.io/ascend/vllm-ascend"), { registry: "quay.io", host: "quay.io", name: "ascend/vllm-ascend" });
  assert.deepEqual(parseRepository("localhost:5000/x"), { registry: "localhost:5000", host: "localhost:5000", name: "x" });
});

test("private, loopback and link-local addresses are not public", () => {
  for (const ip of ["10.1.2.3", "172.27.133.35", "192.168.0.1", "127.0.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["172.32.0.1", "52.45.125.121", "100.63.226.34", "2600:1f18::1"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("an image anyone can pull passes, after an anonymous token", async () => {
  const { fetch } = registry({ manifests: { "v1": true, "sha256:abc": true } });
  assert.equal(await imageProblem({ repository: "org/app", tag: "v1", digest: "sha256:abc" }, { fetch, lookup: publicDns }), null);
});

test("a missing tag or pinned digest fails", async () => {
  const { fetch } = registry({ manifests: { "v1": true } });
  assert.match(await imageProblem({ repository: "org/app", tag: "v2" }, { fetch, lookup: publicDns }), /org\/app:v2: no such manifest/);
  assert.match(await imageProblem({ repository: "org/app", tag: "v1", digest: "sha256:abc" }, { fetch, lookup: publicDns }), /@sha256:abc: no such manifest/);
});

test("a registry that gives no anonymous token fails", async () => {
  const { fetch } = registry({ token: null });
  assert.match(await manifestProblem("org/app", "v1", { fetch, lookup: publicDns }), /no anonymous pull token/);
});

test("a registry on a private network fails without being asked", async () => {
  const { fetch, calls } = registry({ manifests: { "v1": true } });
  const lookup = async () => [{ address: "172.27.133.35" }];
  assert.match(await manifestProblem("harbor.example.io/team/app", "v1", { fetch, lookup }), /harbor\.example\.io is on a private network \(172\.27\.133\.35\)/);
  assert.equal(calls.length, 0);
});

test("a dropped connection is retried", async () => {
  const { fetch } = registry({ manifests: { "v1": true }, failures: 1 });
  assert.equal(await manifestProblem("org/app", "v1", { fetch, lookup: publicDns }), null);
  const down = registry({ failures: 10 });
  assert.match(await manifestProblem("org/app", "v1", { fetch: down.fetch, lookup: publicDns, attempts: 2 }), /could not reach registry-1\.docker\.io: ECONNRESET/);
});

// A perf report as AutoTune writes it: each language carries the comparison.
const report = (baseline, ...attempts) => {
  const run = (image) => ({ launch: { config: { image } } });
  const comparison = { baseline: run(baseline), attempts: attempts.map(run) };
  const data = { reports: [{ lang: "en", comparison }, { lang: "zh", comparison }] };
  return `<!doctype html><html><body><script type="application/json" id="d">${JSON.stringify(data)}</script></body></html>`;
};

test("a build is the image's own name and tag, wherever it is pulled from", () => {
  assert.equal(buildOf("harbor.example.io/team/sglang:v0.5.19"), "sglang:v0.5.19");
  assert.equal(buildOf("lmsysorg/sglang:v0.5.19"), "sglang:v0.5.19");
  assert.equal(buildOf("harbor.example.io/team/vllm/vllm-openai:v0.30.0"), buildOf("vllm/vllm-openai:v0.30.0"));
  assert.equal(buildOf("quay.io/ascend/vllm-ascend:v1@sha256:ff"), "vllm-ascend:v1");
  assert.equal(buildOf("localhost:5000/app"), "app:latest");
});

test("a report that measured its variants' builds passes, from any registry", () => {
  const html = report("harbor.example.io/team/sglang:v0.5.19", "harbor.example.io/team/sglang:v0.5.19");
  assert.deepEqual(reportMismatches(html, { baseline: "lmsysorg/sglang:v0.5.19", optimized: "lmsysorg/sglang:v0.5.19" }), []);
});

test("a report that measured another build fails, per side", () => {
  const html = report("x/sglang:v0.5.18", "x/sglang:v0.5.19");
  const got = reportMismatches(html, { baseline: "lmsysorg/sglang:v0.5.19", optimized: "lmsysorg/sglang:v0.5.20" });
  assert.equal(got.length, 2);
  assert.match(got[0], /baseline variant runs lmsysorg\/sglang:v0\.5\.19, but the report measured x\/sglang:v0\.5\.18/);
  assert.match(got[1], /tuned variant runs lmsysorg\/sglang:v0\.5\.20/);
});

test("the tuned build need only be among the attempts", () => {
  const html = report("x/sglang:a", "x/sglang:b", "x/sglang:c");
  assert.deepEqual(reportMismatches(html, { baseline: "y/sglang:a", optimized: "y/sglang:c" }), []);
});

test("a report that records no images says so", () => {
  const got = reportMismatches("<!doctype html><html><body></body></html>", { baseline: "a:1", optimized: "a:1" });
  assert.deepEqual(got, ["records no baseline image", "records no tuned image"]);
});

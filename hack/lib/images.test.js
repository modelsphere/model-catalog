"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { parseRepository, isPrivateAddress, resolveManifest, checkImage, imageRef, reportMismatches } = require("./images");

const publicDns = async () => [{ address: "52.45.125.121" }];
const digestOf = (manifest) => `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
const [V1, V2] = ['{"schemaVersion":2,"build":1}', '{"schemaVersion":2,"build":2}'];

// A registry that wants an anonymous token, as Docker Hub and registry do.
// manifests maps a tag or digest to the manifest it serves.
function registry({ manifests = {}, token = "t", failures = 0, digestHeader = true } = {}) {
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
    const manifest = manifests[url.split("/manifests/")[1]];
    if (!manifest) return { ok: false, status: 404, headers: new Headers() };
    const headers = new Headers(digestHeader ? { "docker-content-digest": digestOf(manifest) } : {});
    return { ok: true, status: 200, headers, arrayBuffer: async () => new TextEncoder().encode(init.method === "HEAD" ? "" : manifest).buffer };
  };
  return { fetch, calls };
}

test("repositories resolve the way containerd resolves them", () => {
  assert.deepEqual(parseRepository("lmsysorg/sglang"), { registry: "docker.io", host: "registry-1.docker.io", name: "lmsysorg/sglang" });
  assert.deepEqual(parseRepository("nginx"), { registry: "docker.io", host: "registry-1.docker.io", name: "library/nginx" });
  assert.deepEqual(parseRepository("docker.io/nginx"), parseRepository("nginx"));
  assert.deepEqual(parseRepository("index.docker.io/lmsysorg/sglang"), parseRepository("lmsysorg/sglang"));
  assert.deepEqual(parseRepository("quay.io/ascend/vllm-ascend"), { registry: "quay.io", host: "quay.io", name: "ascend/vllm-ascend" });
  assert.deepEqual(parseRepository("localhost:5000/x"), { registry: "localhost:5000", host: "localhost:5000", name: "x" });
});

test("private, loopback and link-local addresses are not public", () => {
  for (const ip of ["10.1.2.3", "172.27.133.35", "192.168.0.1", "127.0.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["172.32.0.1", "52.45.125.121", "100.63.226.34", "2600:1f18::1"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("an image anyone can pull is ok, after an anonymous token", async () => {
  const { fetch } = registry({ manifests: { "v1": V1 } });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1" }, { fetch, lookup: publicDns }), {
    level: "ok",
    message: `org/app:v1: pullable, resolves to ${digestOf(V1)}`,
  });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1", digest: digestOf(V1) }, { fetch, lookup: publicDns }), {
    level: "ok",
    message: `org/app:v1@${digestOf(V1)}: pullable, tag matches the pinned digest`,
  });
});

test("a missing tag or pinned digest is an error", async () => {
  const { fetch } = registry({ manifests: { "v1": V1 } });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v2" }, { fetch, lookup: publicDns }), {
    level: "error",
    message: "org/app:v2: no such manifest",
  });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1", digest: digestOf(V2) }, { fetch, lookup: publicDns }), {
    level: "error",
    message: `org/app:v1@${digestOf(V2)}: no such manifest`,
  });
});

test("a tag that has moved off its pinned digest warns, or is an error when they must match", async () => {
  const { fetch } = registry({ manifests: { "v1": V1, [digestOf(V2)]: V2 } });
  const image = { repository: "org/app", tag: "v1", digest: digestOf(V2) };
  const moved = `org/app:v1@${digestOf(V2)}: the tag resolves to ${digestOf(V1)} now, not the pinned digest`;
  assert.deepEqual(await checkImage(image, { fetch, lookup: publicDns }), { level: "warning", message: `${moved}; both are pullable` });
  assert.deepEqual(await checkImage(image, { fetch, lookup: publicDns, matchDigest: true }), { level: "error", message: moved });
  assert.equal((await checkImage({ ...image, digest: digestOf(V1) }, { fetch, lookup: publicDns, matchDigest: true })).level, "ok");
});

test("a registry that names no digest is read from the manifest's bytes", async () => {
  const { fetch } = registry({ manifests: { "v1": V1 }, digestHeader: false });
  assert.deepEqual(await resolveManifest("org/app", "v1", { fetch, lookup: publicDns }), { digest: digestOf(V1) });
});

test("a registry that gives no anonymous token fails", async () => {
  const { fetch } = registry({ token: null });
  assert.match((await resolveManifest("org/app", "v1", { fetch, lookup: publicDns })).problem, /no anonymous pull token/);
});

test("a registry on a private network fails without being asked", async () => {
  const { fetch, calls } = registry({ manifests: { "v1": V1 } });
  const lookup = async () => [{ address: "172.27.133.35" }];
  assert.match((await resolveManifest("registry.example.io/team/app", "v1", { fetch, lookup })).problem, /registry\.example\.io is on a private network \(172\.27\.133\.35\)/);
  assert.equal(calls.length, 0);
});

test("a dropped connection is retried", async () => {
  const { fetch } = registry({ manifests: { "v1": V1 }, failures: 1 });
  assert.deepEqual(await resolveManifest("org/app", "v1", { fetch, lookup: publicDns }), { digest: digestOf(V1) });
  const down = registry({ failures: 10 });
  assert.match((await resolveManifest("org/app", "v1", { fetch: down.fetch, lookup: publicDns, attempts: 2 })).problem, /could not reach registry-1\.docker\.io: ECONNRESET/);
});

// A perf report as AutoTune writes it: each language carries the comparison.
const report = (baseline, ...attempts) => {
  const run = (image) => ({ launch: { config: { image } } });
  const comparison = { baseline: run(baseline), attempts: attempts.map(run) };
  const data = { reports: [{ lang: "en", comparison }, { lang: "zh", comparison }] };
  return `<!doctype html><html><body><script type="application/json" id="d">${JSON.stringify(data)}</script></body></html>`;
};

test("an image is its registry, repository and tag", () => {
  assert.equal(imageRef("lmsysorg/sglang:v0.5.19"), "docker.io/lmsysorg/sglang:v0.5.19");
  assert.equal(imageRef("docker.io/library/nginx"), imageRef("nginx:latest"));
  assert.equal(imageRef("quay.io/ascend/vllm-ascend:v1@sha256:ff"), "quay.io/ascend/vllm-ascend:v1");
  assert.equal(imageRef("localhost:5000/app"), "localhost:5000/app:latest");
  assert.notEqual(imageRef("registry.example.io/team/sglang:v0.5.19"), imageRef("lmsysorg/sglang:v0.5.19"));
});

test("a report that measured its variants' images passes", () => {
  const html = report("docker.io/lmsysorg/sglang:v0.5.19", "lmsysorg/sglang:v0.5.19");
  assert.deepEqual(reportMismatches(html, { baseline: "lmsysorg/sglang:v0.5.19", optimized: "lmsysorg/sglang:v0.5.19" }), []);
});

test("a report that measured the same tag from another registry fails", () => {
  const html = report("registry.example.io/team/sglang:glm", "registry.example.io/team/sglang:glm");
  assert.deepEqual(reportMismatches(html, { baseline: "org/sglang:glm", optimized: "org/sglang:glm" }), [
    "the baseline variant runs org/sglang:glm, but the report measured registry.example.io/team/sglang:glm",
    "the tuned variant runs org/sglang:glm, but the report measured registry.example.io/team/sglang:glm",
  ]);
});

test("a report that measured another build fails, per side", () => {
  const html = report("x/sglang:v0.5.18", "x/sglang:v0.5.19");
  const got = reportMismatches(html, { baseline: "lmsysorg/sglang:v0.5.19", optimized: "lmsysorg/sglang:v0.5.20" });
  assert.equal(got.length, 2);
  assert.match(got[0], /baseline variant runs lmsysorg\/sglang:v0\.5\.19, but the report measured x\/sglang:v0\.5\.18/);
  assert.match(got[1], /tuned variant runs lmsysorg\/sglang:v0\.5\.20/);
});

test("the tuned image need only be among the attempts", () => {
  const html = report("x/sglang:a", "x/sglang:b", "x/sglang:c");
  assert.deepEqual(reportMismatches(html, { baseline: "x/sglang:a", optimized: "x/sglang:c" }), []);
});

test("a report that records no images says so", () => {
  const got = reportMismatches("<!doctype html><html><body></body></html>", { baseline: "a:1", optimized: "a:1" });
  assert.deepEqual(got, ["records no baseline image", "records no tuned image"]);
});

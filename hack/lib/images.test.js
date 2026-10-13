"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseRepository, isPrivateAddress, craneProblem, resolveManifest, checkImage, imageRef, reportMismatches } = require("./images");

const publicDns = async () => [{ address: "52.45.125.121" }];
const [D1, D2] = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];

// crane digest against a registry holding manifests, which maps a reference
// (repository:tag or repository@digest) to its digest.
function registry(manifests = {}) {
  const calls = [];
  const digestOf = async (reference) => {
    calls.push(reference);
    return manifests[reference] ? { digest: manifests[reference] } : { problem: "no such manifest" };
  };
  return { digestOf, calls };
}

test("repositories resolve the way containerd resolves them", () => {
  assert.deepEqual(parseRepository("lmsysorg/sglang"), { registry: "docker.io", host: "registry-1.docker.io", name: "lmsysorg/sglang" });
  assert.deepEqual(parseRepository("nginx"), { registry: "docker.io", host: "registry-1.docker.io", name: "library/nginx" });
  assert.deepEqual(parseRepository("docker.io/nginx"), parseRepository("nginx"));
  assert.deepEqual(parseRepository("index.docker.io/lmsysorg/sglang"), parseRepository("lmsysorg/sglang"));
  assert.deepEqual(parseRepository("quay.io/ascend/vllm-ascend"), { registry: "quay.io", host: "quay.io", name: "ascend/vllm-ascend" });
  assert.deepEqual(parseRepository("localhost:5000/x"), { registry: "localhost:5000", host: "localhost:5000", name: "x" });
});

test("private, carrier-grade NAT, loopback and link-local addresses are not public", () => {
  for (const ip of [
    "10.1.2.3",
    "172.27.133.35",
    "192.168.0.1",
    "100.100.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["172.32.0.1", "52.45.125.121", "100.63.226.34", "2600:1f18::1", "::ffff:52.45.125.121"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("crane's errors read in this check's words", () => {
  const missing = "Error: GET https://index.docker.io/v2/lmsysorg/sglang/manifests/x: MANIFEST_UNKNOWN: manifest unknown; unknown tag=x\n";
  const hidden = "Error: GET https://index.docker.io/v2/org/nope/manifests/v1: UNAUTHORIZED: authentication required; [map[Action:pull]]\n";
  const denied =
    "Error: GET https://ghcr.io/token?scope=repository%3Aorg%2Fapp%3Apull&service=ghcr.io: DENIED: requested access to the resource is denied\n";
  const down = 'Error: Get "https://registry.example.io/v2/": dial tcp: lookup registry.example.io: no such host\n';
  assert.equal(craneProblem(missing), "no such manifest");
  assert.equal(craneProblem(hidden), "not pullable without a login (private, or no such repository)");
  assert.equal(craneProblem(denied), "not pullable without a login (private, or no such repository)");
  assert.equal(
    craneProblem(`2026/10/11 retrying\n${down}`),
    'Get "https://registry.example.io/v2/": dial tcp: lookup registry.example.io: no such host',
  );
});

test("a tag or digest is asked for by its full reference", async () => {
  const { digestOf, calls } = registry({ "org/app:v1": D1, [`org/app@${D1}`]: D1 });
  assert.deepEqual(await resolveManifest("org/app", "v1", { digestOf, lookup: publicDns }), { digest: D1 });
  assert.deepEqual(await resolveManifest("org/app", D1, { digestOf, lookup: publicDns }), { digest: D1 });
  assert.deepEqual(calls, ["org/app:v1", `org/app@${D1}`]);
});

test("an image anyone can pull is ok", async () => {
  const { digestOf } = registry({ "org/app:v1": D1 });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1" }, { digestOf, lookup: publicDns }), {
    level: "ok",
    message: `org/app:v1: pullable, resolves to ${D1}`,
  });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1", digest: D1 }, { digestOf, lookup: publicDns }), {
    level: "ok",
    message: `org/app:v1@${D1}: pullable, tag matches the pinned digest`,
  });
});

test("a missing tag or pinned digest is an error", async () => {
  const { digestOf } = registry({ "org/app:v1": D1 });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v2" }, { digestOf, lookup: publicDns }), {
    level: "error",
    message: "org/app:v2: no such manifest",
  });
  assert.deepEqual(await checkImage({ repository: "org/app", tag: "v1", digest: D2 }, { digestOf, lookup: publicDns }), {
    level: "error",
    message: `org/app:v1@${D2}: no such manifest`,
  });
});

test("a tag that has moved off its pinned digest warns, or is an error when they must match", async () => {
  const { digestOf } = registry({ "org/app:v1": D1, [`org/app@${D2}`]: D2 });
  const image = { repository: "org/app", tag: "v1", digest: D2 };
  const moved = `org/app:v1@${D2}: the tag resolves to ${D1} now, not the pinned digest`;
  assert.deepEqual(await checkImage(image, { digestOf, lookup: publicDns }), { level: "warning", message: `${moved}; both are pullable` });
  assert.deepEqual(await checkImage(image, { digestOf, lookup: publicDns, matchDigest: true }), { level: "error", message: moved });
  assert.equal((await checkImage({ ...image, digest: D1 }, { digestOf, lookup: publicDns, matchDigest: true })).level, "ok");
});

test("a registry on a private network fails without being asked", async () => {
  const { digestOf, calls } = registry({ "registry.example.io/team/app:v1": D1 });
  const lookup = async () => [{ address: "172.27.133.35" }];
  assert.match(
    (await resolveManifest("registry.example.io/team/app", "v1", { digestOf, lookup })).problem,
    /registry\.example\.io is on a private network \(172\.27\.133\.35\)/,
  );
  assert.equal(calls.length, 0);
});

// A perf report as AutoTune writes it: each language carries the comparison.
const report = (baseline, ...attempts) => {
  const run = (image) => ({ launch: { config: { image } } });
  const comparison = { baseline: run(baseline), attempts: attempts.map(run) };
  const data = {
    reports: [
      { lang: "en", comparison },
      { lang: "zh", comparison },
    ],
  };
  return `<!doctype html><html><body><script type="application/json" id="autotune-report-data">${JSON.stringify(data)}</script></body></html>`;
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

test("only the block the report renders from is read", () => {
  const runs = { baseline: "x/sglang:a", optimized: "x/sglang:b" };
  const decoy = report("y/sglang:a", "y/sglang:b").replace("autotune-report-data", "other-data");
  const decoyBlock = decoy.match(/<script[\s\S]*<\/script>/)[0];
  assert.deepEqual(reportMismatches(report("x/sglang:a", "x/sglang:b").replace("<body>", `<body>${decoyBlock}`), runs), []);
  assert.deepEqual(reportMismatches(decoy, runs), ["records no baseline image", "records no tuned image"]);
});

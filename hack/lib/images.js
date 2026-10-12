"use strict";
// Whether an image the catalog names can be pulled by anyone: no login, from
// the registry it names. A catalog is public; an image only one site can pull
// is a variant only that site can deploy.

const { execFile } = require("child_process");
const dns = require("dns").promises;
const fs = require("fs");
const net = require("net");
const path = require("path");
const { promisify } = require("util");
const ipaddr = require("ipaddr.js");
const { command } = require("./helm-validation");
const { root, modelNames, versionFiles, variantFiles } = require("./catalog");
const { jsonBlocks } = require("./report");

// A repository the way containerd reads it: no registry host (or docker.io)
// means Docker Hub, and a bare name there is an official image under library/.
function parseRepository(repository) {
  const parts = repository.split("/");
  const first = parts[0];
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (first !== "docker.io" && first !== "index.docker.io") return { registry: first, host: first, name: parts.slice(1).join("/") };
    parts.shift();
  }
  return { registry: "docker.io", host: "registry-1.docker.io", name: parts.length === 1 ? `library/${parts[0]}` : parts.join("/") };
}

// Ranges nobody outside reaches: RFC 1918, carrier-grade NAT (where tailnets
// live), loopback, link-local and unique-local. An IPv4-mapped IPv6 address
// counts as the IPv4 address it maps.
const PRIVATE_RANGES = new Set(["private", "carrierGradeNat", "loopback", "linkLocal", "uniqueLocal"]);

function isPrivateAddress(ip) {
  return PRIVATE_RANGES.has(ipaddr.process(ip).range());
}

// The private address a registry host resolves to, when it resolves to
// nothing else; null for a host the internet can reach (or that does not
// resolve, which the request itself reports). A proxy or VPN that reaches it
// from here does not make it public.
async function privateNetwork(host, lookup = dns.lookup) {
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(name) ? [name] : (await lookup(name, { all: true })).map((a) => a.address);
  } catch {
    return null;
  }
  return addresses.length && addresses.every(isPrivateAddress) ? addresses[0] : null;
}

// crane's error for a lookup that failed, in this check's words where one
// fits, else crane's own.
function craneProblem(stderr) {
  const message = String(stderr).trim().split("\n").pop().replace(/^Error: /, "");
  if (/\b(MANIFEST_UNKNOWN|NAME_UNKNOWN)\b/.test(message)) return "no such manifest";
  if (/\b(UNAUTHORIZED|DENIED)\b/.test(message)) return "not pullable without a login (private, or no such repository)";
  return message;
}

const execFileAsync = promisify(execFile);

// crane uses the docker logins on this machine, and the outside world has
// none: point it at a config of its own that holds no credentials.
let anonymous;
function anonymousConfig() {
  if (!anonymous) {
    anonymous = path.join(root, ".cache/crane-anonymous");
    fs.mkdirSync(anonymous, { recursive: true });
    fs.writeFileSync(path.join(anonymous, "config.json"), "{}\n");
  }
  return anonymous;
}

// What crane digest says of reference, as { digest } or { problem }. crane
// sends HEAD first, which Docker Hub does not count against pulls, gets any
// registry's anonymous token, honors HTTP(S)_PROXY, and retries what is worth
// retrying. The pinned crane from npm run tools:install, else one on PATH.
async function craneDigest(reference) {
  const installed = path.join(root, ".cache/bin/crane");
  const crane = fs.existsSync(installed) ? installed : "crane";
  try {
    const { stdout } = await execFileAsync(crane, ["digest", reference], {
      env: { ...process.env, DOCKER_CONFIG: anonymousConfig() },
      timeout: 5 * 60 * 1000,
    });
    return { digest: stdout.trim() };
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("crane not found: run npm run tools:install");
    return { problem: err.killed ? "crane timed out" : craneProblem(err.stderr || err.message) };
  }
}

// The manifest digest ref (a tag or digest) names in repository, pulled
// anonymously, as { digest }; or why it cannot be pulled, as { problem }.
async function resolveManifest(repository, ref, { lookup, digestOf = craneDigest } = {}) {
  const { host } = parseRepository(repository);
  const internal = await privateNetwork(host, lookup);
  if (internal) return { problem: `${host} is on a private network (${internal})` };
  return digestOf(`${repository}${ref.startsWith("sha256:") ? "@" : ":"}${ref}`);
}

// How an image block fares pulled anonymously, as { level, message }. "error"
// when its tag or pinned digest cannot be pulled; "warning" when the tag has
// moved off a pinned digest that is still pullable; else "ok". With
// matchDigest a moved tag is an error: a runtime pulls the digest and ignores
// the tag, so the two name different builds. Tags move, so only a change
// being made can be held to that.
async function checkImage(image, { matchDigest = false, ...opts } = {}) {
  const ref = `${image.repository}:${image.tag}`;
  const tag = await resolveManifest(image.repository, image.tag, opts);
  if (tag.problem) return { level: "error", message: `${ref}: ${tag.problem}` };
  if (!image.digest) return { level: "ok", message: `${ref}: pullable, resolves to ${tag.digest}` };
  const pinned = `${ref}@${image.digest}`;
  if (tag.digest === image.digest) return { level: "ok", message: `${pinned}: pullable, tag matches the pinned digest` };
  const moved = `the tag resolves to ${tag.digest} now, not the pinned digest`;
  if (matchDigest) return { level: "error", message: `${pinned}: ${moved}` };
  const digest = await resolveManifest(image.repository, image.digest, opts);
  if (digest.problem) return { level: "error", message: `${pinned}: ${digest.problem}` };
  return { level: "warning", message: `${pinned}: ${moved}; both are pullable` };
}

// The data block an AutoTune report renders from: its page mounts with
// AutotuneReport.mountStandalone("autotune-report", "autotune-report-data").
const REPORT_DATA = "autotune-report-data";

// The images a perf report's benchmark ran, from the block it renders from:
// the baseline's, and each tuning attempt's, which the page shows as its Image
// row. Empty sets when it records none.
function reportImages(html) {
  const out = { baseline: new Set(), attempts: new Set() };
  let data;
  try {
    data = JSON.parse(jsonBlocks(html).find((block) => block.id === REPORT_DATA).text);
  } catch {
    return out;
  }
  const image = (run) => run && run.launch && run.launch.config && run.launch.config.image;
  for (const r of data.reports || []) {
    const c = r && r.comparison;
    if (!c) continue;
    if (image(c.baseline)) out.baseline.add(image(c.baseline));
    for (const a of c.attempts || []) if (image(a)) out.attempts.add(image(a));
  }
  return out;
}

// An image reference in full, the way containerd reads it, digest aside:
// registry, repository and tag, so nginx and docker.io/library/nginx:latest are
// one image, and the same tag on another registry or namespace is another.
function imageRef(ref) {
  const name = String(ref).split("@")[0];
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const { registry, name: repository } = parseRepository(colon > slash ? name.slice(0, colon) : name);
  return `${registry}/${repository}:${colon > slash ? name.slice(colon + 1) : "latest"}`;
}

// Why a tuned pair's report did not measure the images its two variants run.
// The tuned build need only be among the attempts: a tuning run may try more
// than one, and its best overall can be the baseline.
function reportMismatches(html, { baseline, optimized }) {
  const ran = reportImages(html);
  const out = [];
  for (const [role, want, got] of [["baseline", baseline, ran.baseline], ["tuned", optimized, ran.attempts]]) {
    if (!got.size) out.push(`records no ${role} image`);
    else if (![...got].some((x) => imageRef(x) === imageRef(want))) {
      out.push(`the ${role} variant runs ${want}, but the report measured ${[...got].join(", ")}`);
    }
  }
  return out;
}

// Version files a branch adds or changes since its merge-base with base, and
// every version of a model whose metadata or perf report changed. Deleted
// files have nothing left to check.
function changedVersionFiles(root, base) {
  const git = (args) => {
    const result = command("git", args, { cwd: root });
    if (!result.ok) throw new Error(result.log);
    return result.stdout;
  };
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const changed = git(["diff", "--name-only", "-z", "--diff-filter=AMR", mergeBase, "HEAD"]).split("\0").filter(Boolean);
  const touched = new Set(changed.filter((f) => /^models\/[^/]+\/(metadata\.yaml|[^/]+\.html)$/.test(f)).map((f) => f.split("/")[1]));
  const models = path.join(root, "models");
  const versions = modelNames(models).flatMap((name) => [...versionFiles(name, models), ...variantFiles(name, models)]);
  return versions.filter((file) => changed.includes(file) || touched.has(file.split("/")[1]));
}

module.exports = { parseRepository, isPrivateAddress, craneProblem, resolveManifest, checkImage, reportImages, imageRef, reportMismatches, changedVersionFiles };

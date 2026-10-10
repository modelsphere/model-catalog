"use strict";
// Whether an image the catalog names can be pulled by anyone: no login, from
// the registry it names. A catalog is public; an image only one site can pull
// is a variant only that site can deploy.

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const { command } = require("./helm-validation");
const { modelNames, versionFiles } = require("./catalog");
const { jsonBlocks } = require("./report");

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

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

// RFC 1918, loopback, link-local and unique-local: nobody outside reaches them.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
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

function bearerChallenge(header) {
  if (!/^\s*bearer\s/i.test(header || "")) return null;
  const params = {};
  for (const [, k, v] of header.matchAll(/(\w+)="([^"]*)"/g)) params[k.toLowerCase()] = v;
  return params.realm ? params : null;
}

// The manifest digest ref (a tag or digest) names in repository, pulled
// anonymously, as { digest }; or why it cannot be pulled, as { problem }.
// HEAD first: Docker Hub does not count it against pulls.
async function resolveManifest(repository, ref, { fetch = globalThis.fetch, lookup, tokens = new Map(), attempts = 3 } = {}) {
  const { host, name } = parseRepository(repository);
  const internal = await privateNetwork(host, lookup);
  if (internal) return { problem: `${host} is on a private network (${internal})` };
  const url = `https://${host}/v2/${name}/manifests/${ref}`;
  const request = async (method) => {
    const token = tokens.get(`${host}/${name}`);
    return fetch(url, { method, headers: { Accept: ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  };
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      let r = await request("HEAD");
      if (r.status === 405) r = await request("GET");
      if (r.status === 401 && !tokens.has(`${host}/${name}`)) {
        const challenge = bearerChallenge(r.headers.get("www-authenticate"));
        if (!challenge) return { problem: "the registry requires a login" };
        const q = new URLSearchParams({ scope: `repository:${name}:pull` });
        if (challenge.service) q.set("service", challenge.service);
        const t = await fetch(`${challenge.realm}?${q}`);
        const body = t.ok ? await t.json() : {};
        if (!(body.token || body.access_token)) return { problem: "the registry gives no anonymous pull token" };
        tokens.set(`${host}/${name}`, body.token || body.access_token);
        r = await request("HEAD");
        if (r.status === 405) r = await request("GET");
      }
      if (r.ok) {
        // Registries name the digest in a header; for one that does not, it is
        // the digest of the manifest's bytes.
        let digest = r.headers.get("docker-content-digest");
        if (!digest) {
          const body = await request("GET");
          if (!body.ok) throw new Error(`HTTP ${body.status}`);
          digest = `sha256:${crypto.createHash("sha256").update(Buffer.from(await body.arrayBuffer())).digest("hex")}`;
        }
        return { digest };
      }
      if (r.status === 401 || r.status === 403) return { problem: "not pullable without a login (private, or no such repository)" };
      if (r.status === 404) return { problem: "no such manifest" };
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return { problem: `HTTP ${r.status}` };
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
    }
  }
  const reason = lastError && lastError.cause ? lastError.cause.code || lastError.cause.message : lastError && lastError.message;
  return { problem: `could not reach ${host}: ${reason}` };
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

// The images a perf report's benchmark ran, from the JSON it embeds: the
// baseline's, and each tuning attempt's. Empty sets when it records none.
function reportImages(html) {
  const out = { baseline: new Set(), attempts: new Set() };
  let data;
  try {
    data = JSON.parse(jsonBlocks(html)[0].text);
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
  const versions = modelNames(models).flatMap((name) => versionFiles(name, models));
  return versions.filter((file) => changed.includes(file) || touched.has(file.split("/")[1]));
}

module.exports = { parseRepository, isPrivateAddress, resolveManifest, checkImage, reportImages, imageRef, reportMismatches, changedVersionFiles };

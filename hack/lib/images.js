"use strict";
// Whether an image the catalog names can be pulled by anyone: no login, from
// the registry it names. A catalog is public; an image only one site can pull
// is a variant only that site can deploy.

const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const { command } = require("./helm-validation");
const { modelNames, versionFiles } = require("./catalog");

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// A repository the way containerd reads it: no registry host means Docker Hub,
// and a bare name is an official image under library/.
function parseRepository(repository) {
  const parts = repository.split("/");
  const first = parts[0];
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    return { registry: first, host: first, name: parts.slice(1).join("/") };
  }
  return { registry: "docker.io", host: "registry-1.docker.io", name: parts.length === 1 ? `library/${repository}` : repository };
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

// Why ref (a tag or digest) cannot be pulled anonymously from repository, or
// null when it can. HEAD first: Docker Hub does not count it against pulls.
async function manifestProblem(repository, ref, { fetch = globalThis.fetch, lookup, tokens = new Map(), attempts = 3 } = {}) {
  const { host, name } = parseRepository(repository);
  const internal = await privateNetwork(host, lookup);
  if (internal) return `${host} is on a private network (${internal})`;
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
        if (!challenge) return "the registry requires a login";
        const q = new URLSearchParams({ scope: `repository:${name}:pull` });
        if (challenge.service) q.set("service", challenge.service);
        const t = await fetch(`${challenge.realm}?${q}`);
        const body = t.ok ? await t.json() : {};
        if (!(body.token || body.access_token)) return "the registry gives no anonymous pull token";
        tokens.set(`${host}/${name}`, body.token || body.access_token);
        r = await request("HEAD");
        if (r.status === 405) r = await request("GET");
      }
      if (r.ok) return null;
      if (r.status === 401 || r.status === 403) return "not pullable without a login (private, or no such repository)";
      if (r.status === 404) return "no such manifest";
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
    }
  }
  const reason = lastError && lastError.cause ? lastError.cause.code || lastError.cause.message : lastError && lastError.message;
  return `could not reach ${host}: ${reason}`;
}

// Why an image block cannot be pulled anonymously, or null when it can: its
// tag must resolve, and a pinned digest must exist in the same repository.
async function imageProblem(image, opts = {}) {
  const ref = `${image.repository}:${image.tag}`;
  const tag = await manifestProblem(image.repository, image.tag, opts);
  if (tag) return `${ref}: ${tag}`;
  if (image.digest) {
    const pinned = await manifestProblem(image.repository, image.digest, opts);
    if (pinned) return `${ref}@${image.digest}: ${pinned}`;
  }
  return null;
}

// The images a perf report's benchmark ran, from the JSON it embeds: the
// baseline's, and each tuning attempt's. Empty sets when it records none.
function reportImages(html) {
  const out = { baseline: new Set(), attempts: new Set() };
  const block = /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  let data;
  try {
    data = JSON.parse(block[1]);
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

// A build, wherever it is pulled from: the image's own name, which a registry
// mirror keeps (swiss's does), and its tag.
function buildOf(ref) {
  const name = String(ref).split("@")[0];
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const repo = colon > slash ? name.slice(0, colon) : name;
  return `${repo.split("/").pop()}:${colon > slash ? name.slice(colon + 1) : "latest"}`;
}

// Why a tuned pair's report did not measure the builds its two variants run.
// The tuned build need only be among the attempts: a tuning run may try more
// than one, and its best overall can be the baseline.
function reportMismatches(html, { baseline, optimized }) {
  const ran = reportImages(html);
  const out = [];
  for (const [role, want, got] of [["baseline", baseline, ran.baseline], ["tuned", optimized, ran.attempts]]) {
    if (!got.size) out.push(`records no ${role} image`);
    else if (![...got].some((x) => buildOf(x) === buildOf(want))) {
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

module.exports = { parseRepository, isPrivateAddress, manifestProblem, imageProblem, reportImages, buildOf, reportMismatches, changedVersionFiles };

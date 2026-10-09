"use strict";
// What every hack/ step reads the catalog through: the files, the version
// order, the digest and the index swiss consumes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const root = path.resolve(__dirname, "../..");
const modelsDir = path.join(root, "models");

function readYaml(p) {
  return yaml.parse(fs.readFileSync(p, "utf8"));
}

// Model directory names, sorted.
function modelNames(dir = modelsDir) {
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();
}

// A model's version files (<name>-<version>.yaml), as repo-relative paths.
// metadata.yaml has no "-", which is what tells the two apart.
function versionFiles(name, dir = modelsDir) {
  return fs
    .readdirSync(path.join(dir, name))
    .filter((f) => f.endsWith(".yaml") && f.includes("-"))
    .sort()
    .map((f) => `models/${name}/${f}`);
}

function digest(buf) {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

// Semver precedence: a prerelease sorts below its release; its identifiers
// compare numerically when numeric, numeric below alphanumeric, and a shorter
// list below a longer one it prefixes (alpha < alpha.1 < beta, rc.2 < rc.10).
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v));
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] - B.core[i];
  if (!A.pre.length || !B.pre.length) return B.pre.length - A.pre.length;
  for (let i = 0; i < Math.min(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return typeof x === "number" ? x - y : x < y ? -1 : 1;
  }
  return A.pre.length - B.pre.length;
}

function isPrerelease(v) {
  return (parseVersion(v)?.pre.length ?? 0) > 0;
}

// What a deploy naming no version gets: the newest release, or, for a model
// with nothing but prereleases, the newest of those. Sorted ascending.
function latestOf(sortedVersions) {
  const releases = sortedVersions.filter((v) => !isPrerelease(v));
  return (releases.length ? releases : sortedVersions).at(-1);
}

// Null and undefined go, at every depth: the index carries no empty keys.
function prune(value) {
  if (Array.isArray(value)) return value.filter((v) => v != null).map(prune);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v != null) out[k] = prune(v);
    return out;
  }
  return value;
}

// index.json: the published surface. Each version carries a sha256 of its
// file -- the lock a deploy records -- and metadata.yaml is inlined, since a
// consumer never fetches it.
function buildIndex() {
  const models = [];
  for (const name of modelNames()) {
    const metaPath = path.join(modelsDir, name, "metadata.yaml");
    if (!fs.existsSync(metaPath)) throw new Error(`models/${name}/: no metadata.yaml`);
    const meta = readYaml(metaPath) ?? {};
    const versions = versionFiles(name).map((rel) => {
      const body = fs.readFileSync(path.join(root, rel));
      const doc = yaml.parse(body.toString("utf8"));
      return {
        name: doc.name,
        version: doc.version,
        path: rel,
        digest: digest(body),
        variants: (doc.variants ?? []).map((v) => ({
          id: v.id,
          engine: v.engine,
          default: v.default,
          description: v.description,
          link: v.link,
          chart: v.chart,
          requires: v.requires,
        })),
      };
    });
    if (versions.length === 0) continue;
    versions.sort((a, b) => compareVersions(a.version, b.version));
    const source = meta.source ?? {};
    models.push(
      prune({
        name: versions.at(-1).name,
        displayName: meta.displayName,
        description: meta.description,
        family: meta.family,
        tags: meta.tags,
        deprecated: meta.deprecated,
        tuning: meta.tuning,
        source: { hf: source.hf, revision: source.revision, sizeGiB: source.sizeGiB },
        latest: latestOf(versions.map((v) => v.version)),
        versions: versions.reverse().map(({ version, path: p, digest: d, variants }) => ({
          version,
          path: p,
          digest: d,
          variants,
        })),
      })
    );
  }
  models.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const site = readYaml(path.join(root, "catalog.yaml"))?.site;
  return prune({ apiVersion: "catalog.swiss/v1", site, count: models.length, models });
}

function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

module.exports = {
  root,
  modelsDir,
  readYaml,
  modelNames,
  versionFiles,
  digest,
  compareVersions,
  isPrerelease,
  latestOf,
  buildIndex,
  serializeIndex,
};

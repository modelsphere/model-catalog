"use strict";
// A catalog at one commit, as the server serves it: index-v2.json, each
// variant's history.json, and the files they name. It is the v2 half of
// model-catalog's build (hack/lib/catalog.js and history.js there), read from
// git objects instead of a checkout, so its output matches the published
// site's byte for byte: swiss and the web app read either.
//
// Only schema v2: a model whose metadata.yaml is not catalog.swiss/v2 is not
// in the index, and v1 version files (<name>-<version>.yaml) are not served.

const crypto = require("crypto");
const yaml = require("yaml");
const { run } = require("./git");

const V2 = "catalog.swiss/v2";

const digest = (buf) => "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
const historyPath = (rel) => rel.replace(/\.yaml$/, ".history.json");

function parseOrNull(bytes) {
  try {
    return yaml.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

// A variant file's document, by content, never by file name.
const isVariant = (doc) => !!doc && typeof doc === "object" && doc.apiVersion === V2 && doc.kind === "Variant";
const isV2 = (meta) => meta?.apiVersion === V2;

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

const serialize = (doc) => JSON.stringify(doc, null, 2) + "\n";

// variants[].link is only schema-checked as a URI, which admits javascript:.
const safeLink = (link) => (typeof link === "string" && /^https?:\/\//i.test(link) ? link : undefined);

// Changes to models/<name>/*.yaml on commit's first-parent chain, oldest
// first: path -> [{commit, date, subject, deleted, bytes}], date the commit's
// UTC committer date (YYYY-MM-DD). last is the last commit touching models/
// or catalog.yaml.
function fileHistory(repo, commit) {
  const files = new Map();
  if (!commit) return { files, last: null };
  const log = run(repo.dir, [
    "log",
    "--reverse",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--name-status",
    "-z",
    "--format=%x1e%H%x1f%ct%x1f%s",
    commit,
    "--",
    "models",
    "catalog.yaml",
  ]).toString("utf8");
  let last = null;
  const pending = [];
  for (const record of log.split("\x1e").slice(1)) {
    const end = record.indexOf("\0");
    const [hash, time, subject] = record.slice(0, end).split("\x1f");
    const date = new Date(Number(time) * 1000).toISOString().slice(0, 10);
    last = hash;
    const fields = record
      .slice(end + 1)
      .replace(/^\n/, "")
      .split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [status, file] = [fields[i], fields[i + 1]];
      if (!/^models\/[^/]+\/[^/]+\.yaml$/.test(file) || file.endsWith("/metadata.yaml")) continue;
      const change = { commit: hash, date, subject, deleted: status === "D", bytes: null };
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(change);
      if (!change.deleted) pending.push([change, `${hash}:${file}`]);
    }
  }
  const bodies = repo.blobs(pending.map(([, spec]) => spec));
  pending.forEach(([change], i) => (change.bytes = bodies[i]));
  return { files, last };
}

// Every variant file's revisions, oldest first, by path, deleted ones
// included. A revision's release date is its commit's.
function variantRevisions(files) {
  const out = new Map();
  for (const [rel, changes] of files) {
    const revisions = changes
      .map((c) => ({ c, doc: c.bytes && parseOrNull(c.bytes) }))
      .filter(({ doc }) => isVariant(doc))
      .map(({ c, doc }) => ({ doc, commit: c.commit, releaseDate: c.date, subject: c.subject, digest: digest(c.bytes) }));
    if (revisions.length) out.set(rel, { revisions, gone: changes.at(-1).deleted ? changes.at(-1) : null });
  }
  return out;
}

function historyDoc(rel, { revisions, gone }) {
  const [, model, file] = rel.split("/");
  return prune({
    model,
    id: file.replace(/\.yaml$/, ""),
    path: rel,
    revisions: revisions
      .map((r) => ({ version: r.doc.version, releaseDate: r.releaseDate, commit: r.commit, digest: r.digest, subject: r.subject }))
      .reverse(),
    deleted: gone && { commit: gone.commit, subject: gone.subject },
  });
}

// A URL that has a path joined onto it ends with one slash; a repository's,
// which links append /commit/<sha> to, with none.
const withSlash = (u) => (typeof u === "string" && u ? u.replace(/\/*$/, "/") : undefined);
const withoutSlash = (u) => (typeof u === "string" && u ? u.replace(/\/+$/, "") : undefined);

function rawBase(settings) {
  if (settings.raw) return withSlash(settings.raw);
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(settings.repo ?? "");
  return m ? `https://raw.githubusercontent.com/${m[1]}/` : undefined;
}

function summary(v) {
  return {
    engine: v.engine,
    description: v.description,
    link: safeLink(v.link),
    chart: v.chart,
    image: v.image,
    requires: v.requires,
  };
}

// The catalog at commit (null: an empty one). Where it is served, and where
// its old revisions are fetched, are its catalog.yaml's site and raw: the
// repository decides, whatever routes to the server. A file that does not
// parse is skipped, with a warning, rather than taking the catalog down.
function buildSnapshot(repo, commit) {
  const warnings = [];
  const tree = repo.tree(commit);
  const paths = [...tree.keys()];
  const read = (rels) => {
    const bodies = repo.blobs(rels.map((rel) => tree.get(rel)));
    return new Map(rels.map((rel, i) => [rel, bodies[i]]));
  };

  // What the index needs: catalog.yaml, every metadata.yaml and model YAML.
  const yamlFiles = paths.filter((p) => p === "catalog.yaml" || /^models\/[^/]+\/[^/]+\.yaml$/.test(p));
  const bodies = read(yamlFiles);
  const docOf = (rel) => {
    try {
      return yaml.parse(bodies.get(rel).toString("utf8"));
    } catch (err) {
      warnings.push(`${rel}: ${err.message.split("\n")[0]} -- skipped`);
      return null;
    }
  };
  const settings = (bodies.has("catalog.yaml") && docOf("catalog.yaml")) || {};

  const { files, last } = fileHistory(repo, commit);
  const revisions = variantRevisions(files);
  const histories = new Map([...revisions].map(([rel, h]) => [rel, historyDoc(rel, h)]));

  const names = [...new Set(paths.filter((p) => p.startsWith("models/")).map((p) => p.split("/")[1]))].sort();
  const models = [];
  // Every model's files, v1 ones included: a write checks them by name.
  const dirs = new Map();
  for (const name of names) {
    const inDir = paths.filter((p) => p.startsWith(`models/${name}/`) && p.split("/").length === 3);
    const metaRel = `models/${name}/metadata.yaml`;
    const meta = bodies.has(metaRel) ? docOf(metaRel) : null;
    const variants = inDir
      .filter((p) => p.endsWith(".yaml") && p !== metaRel)
      .map((p) => p.split("/")[2])
      .sort()
      .map((f) => `models/${name}/${f}`)
      .flatMap((rel) => {
        const doc = parseOrNull(bodies.get(rel));
        return isVariant(doc) ? [{ rel, doc, body: bodies.get(rel) }] : [];
      });
    dirs.set(name, { meta, metaRel: bodies.has(metaRel) ? metaRel : null, variants });
    if (!isV2(meta) || !variants.length) continue;

    // Perf reports, linked by file name. model-catalog's validate:schema
    // checks they are documents a reader can open; this serves what is there.
    const reports = inDir
      .filter((p) => p.endsWith(".html"))
      .map((p) => p.split("/")[2])
      .sort();
    // The legacy version is index.json's.
    const tuning = (Array.isArray(meta.tuning) ? meta.tuning : []).map(({ version, ...t }) => {
      if (!t.report || reports.includes(t.report)) return t;
      warnings.push(`models/${name}/${t.report}: missing -- not linked`);
      return { ...t, report: undefined };
    });
    models.push(
      prune({
        name,
        displayName: meta.displayName,
        description: meta.description,
        family: meta.family,
        series: meta.series,
        tags: meta.tags,
        deprecated: meta.deprecated,
        source: meta.source && { hf: meta.source.hf, revision: meta.source.revision, sizeGiB: meta.source.sizeGiB },
        quantization: meta.quantization,
        defaultVariant: meta.defaultVariant,
        reports,
        tuning,
        variants: variants.map(({ rel, doc, body }) => {
          const top = histories.get(rel).revisions[0];
          return {
            id: doc.id,
            version: doc.version,
            releaseDate: top.releaseDate,
            commit: top.commit,
            path: rel,
            digest: digest(body),
            history: historyPath(rel),
            servedName: doc.servedName,
            ...summary(doc),
            deprecated: doc.deprecated,
            replaces: doc.replaces,
          };
        }),
      }),
    );
  }

  const index = prune({
    apiVersion: V2,
    site: withSlash(settings.site),
    repo: withoutSlash(settings.repo),
    raw: rawBase(settings),
    commit: last,
    count: models.length,
    models,
  });
  return {
    commit,
    tree,
    blob: (oid) => repo.blobs([oid])[0],
    // Whether commit has a file at rel, anywhere: tree has catalog.yaml and
    // models/ alone.
    has: (rel) => !!commit && repo.show(commit, rel) !== null,
    dirs,
    revisions,
    warnings,
    index,
    indexJson: serialize(index),
    histories: new Map([...histories].map(([rel, h]) => [historyPath(rel), serialize(h)])),
  };
}

module.exports = { V2, buildSnapshot, digest, historyPath, isVariant, isV2, parseVersion, compareVersions };

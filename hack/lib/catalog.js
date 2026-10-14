"use strict";
// What every hack/ step reads the catalog through: the files, the version
// order, the digest and the index swiss consumes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { spawnSync } = require("child_process");
const yaml = require("yaml");
const { fileHistory } = require("./history");

const root = path.resolve(__dirname, "../..");
const modelsDir = path.join(root, "models");

const V1 = "catalog.swiss/v1";
const V2 = "catalog.swiss/v2";

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

// "version" (v1), "variant" (v2) or null, by content, never by file name.
function kindOf(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.apiVersion === V1 && doc.kind === undefined) return "version";
  if (doc.apiVersion === V2 && doc.kind === "Variant") return "variant";
  return null;
}

// A model's YAML files but metadata.yaml, each with its kind.
function modelFiles(name, dir = modelsDir) {
  return fs
    .readdirSync(path.join(dir, name), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".yaml") && e.name !== "metadata.yaml")
    .map((e) => e.name)
    .sort()
    .map((f) => {
      const rel = `models/${name}/${f}`;
      try {
        return { rel, kind: kindOf(yaml.parse(fs.readFileSync(path.join(dir, name, f), "utf8"))) };
      } catch (error) {
        return { rel, kind: null, error };
      }
    });
}

// A model's v1 version files (<name>-<version>.yaml), as repo-relative paths.
function versionFiles(name, dir = modelsDir) {
  return modelFiles(name, dir)
    .filter((f) => f.kind === "version")
    .map((f) => f.rel);
}

// A model's v2 variant files (<id>.yaml).
function variantFiles(name, dir = modelsDir) {
  return modelFiles(name, dir)
    .filter((f) => f.kind === "variant")
    .map((f) => f.rel);
}

function schemaOf(meta) {
  return meta?.apiVersion === V2 ? "v2" : "v1";
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
// consumer never fetches it. A v2 model keeps only its tuning with a v1 version.
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
        tuning: schemaOf(meta) === "v1" ? meta.tuning : legacyTuning(meta.tuning),
        source: { hf: source.hf, revision: source.revision, sizeGiB: source.sizeGiB },
        latest: latestOf(versions.map((v) => v.version)),
        versions: versions.reverse().map(({ version, path: p, digest: d, variants }) => ({
          version,
          path: p,
          digest: d,
          variants,
        })),
      }),
    );
  }
  models.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const site = readYaml(path.join(root, "catalog.yaml"))?.site;
  return prune({ apiVersion: V1, site, count: models.length, models });
}

function legacyTuning(tuning) {
  const out = (Array.isArray(tuning) ? tuning : [])
    .filter((t) => t?.version != null)
    .map((t) => ({ ...t, baseline: String(t.baseline).split("@")[0], optimized: String(t.optimized).split("@")[0] }));
  return out.length ? out : undefined;
}

function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

// variants[].link is only schema-checked as a URI, which admits javascript:.
function safeLink(link) {
  return typeof link === "string" && /^https?:\/\//i.test(link) ? link : undefined;
}

const historyPath = (rel) => rel.replace(/\.yaml$/, ".history.json");

// Reports the site may link; validate:schema fails on the others.
function linkableReports(base, name, warn) {
  const { reportProblem } = require("./report");
  const dir = path.join(base, "models", name);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .filter((f) => {
      const problem = reportProblem(path.join(dir, f));
      if (problem) warn(`models/${name}/${f}: ${problem} -- not linked`);
      return !problem;
    });
}

// Every v2 variant's revisions, oldest first, by path, deleted ones included.
// A revision's release date is its commit's; an uncommitted edit has neither.
function variantRevisions(files, base) {
  const out = new Map();
  for (const [rel, changes] of files) {
    const revisions = changes
      .map((c) => ({ c, doc: c.bytes && parseOrNull(c.bytes) }))
      .filter(({ doc }) => kindOf(doc) === "variant")
      .map(({ c, doc }) => ({ doc, commit: c.commit, releaseDate: c.date, subject: c.subject, digest: digest(c.bytes) }));
    if (revisions.length) out.set(rel, { revisions, gone: changes.at(-1).deleted ? changes.at(-1) : null });
  }
  for (const name of modelNames(path.join(base, "models"))) {
    for (const rel of variantFiles(name, path.join(base, "models"))) {
      const body = fs.readFileSync(path.join(base, rel));
      const h = out.get(rel) ?? { revisions: [], gone: null };
      out.set(rel, h);
      if (!h.gone && h.revisions.at(-1)?.digest === digest(body)) continue;
      h.revisions.push({ doc: yaml.parse(body.toString("utf8")), digest: digest(body), subject: "(uncommitted)" });
      h.gone = null;
    }
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

function historiesOf({ root: base = root } = {}) {
  return new Map([...variantRevisions(fileHistory(base).files, base)].map(([rel, h]) => [rel, historyDoc(rel, h)]));
}

// A variant file changed since a commit -- the branch's merge-base with master,
// or CI's --base -- raises its version, and changes more than that. Commits in
// between are one change, as the pull request is once merged.
function revisionProblems({ root: dir = root, since }) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: dir, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr || r.error?.message || "").trim()}`);
    return r.stdout;
  };
  const strip = ({ version, ...rest }) => rest;
  const out = [];
  // Modified only: a new file has no version to raise, a deleted one nothing to check.
  const changed = git(["diff", "--name-only", "--no-renames", "--diff-filter=M", "-z", since, "--", "models"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const rel of changed) {
    const now = parseOrNull(fs.readFileSync(path.join(dir, rel)));
    const was = parseOrNull(git(["show", `${since}:${rel}`]));
    if (kindOf(now) !== "variant" || kindOf(was) !== "variant") continue;
    if (!(compareVersions(String(now.version), String(was.version)) > 0)) {
      out.push([rel, `changed without raising version above ${was.version}`]);
    } else if (isDeepStrictEqual(strip(now), strip(was))) {
      out.push([rel, `version ${now.version} changes nothing else`]);
    }
  }
  return out;
}

function parseOrNull(bytes) {
  try {
    return yaml.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function rawBase(settings) {
  if (settings.raw) return settings.raw;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(settings.repo ?? "");
  return m ? `https://raw.githubusercontent.com/${m[1]}/` : undefined;
}

// index-v2.json: v2 models and their variant files only; and the histories.
function buildIndexV2({ root: base = root, warn = console.warn } = {}) {
  const dir = path.join(base, "models");
  const settings = readYaml(path.join(base, "catalog.yaml")) ?? {};
  const { files, last } = fileHistory(base);
  const histories = new Map([...variantRevisions(files, base)].map(([rel, h]) => [rel, historyDoc(rel, h)]));
  const models = [];
  for (const name of modelNames(dir)) {
    const metaPath = path.join(dir, name, "metadata.yaml");
    const meta = fs.existsSync(metaPath) ? readYaml(metaPath) : null;
    if (schemaOf(meta) !== "v2") continue;
    const variants = v2Variants(base, name, histories);
    if (!variants.length) continue;
    const reports = linkableReports(base, name, warn);
    // The legacy version is index.json's.
    const tuning = (Array.isArray(meta.tuning) ? meta.tuning : []).map(({ version, ...t }) => {
      if (!t.report || reports.includes(t.report)) return t;
      if (!fs.existsSync(path.join(dir, name, t.report))) warn(`models/${name}/${t.report}: missing -- not linked`);
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
        variants,
      }),
    );
  }
  const index = prune({
    apiVersion: V2,
    site: settings.site,
    repo: settings.repo,
    raw: rawBase(settings),
    commit: last,
    count: models.length,
    models,
  });
  return { index, histories };
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

function v2Variants(base, name, histories) {
  return variantFiles(name, path.join(base, "models")).map((rel) => {
    const body = fs.readFileSync(path.join(base, rel));
    const doc = yaml.parse(body.toString("utf8"));
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
  });
}

// Validators for schema/*.schema.json, by file name; they $ref each other.
function schemaValidator() {
  const Ajv2020 = require("ajv/dist/2020");
  const addFormats = require("ajv-formats");
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, verbose: true });
  addFormats(ajv);
  const dir = path.join(root, "schema");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), f);
  }
  return (file) => {
    const validate = ajv.getSchema(file);
    if (!validate) throw new Error(`schema/${file}: no such schema`);
    return validate;
  };
}

// The index matches its schema and each variant its newest revision.
function checkIndexV2({ index, histories }) {
  const validate = schemaValidator()("index-v2.schema.json");
  const problems = [];
  if (!validate(index)) {
    problems.push(...validate.errors.map((e) => `index-v2.json${e.instancePath}: ${e.message}`));
  }
  for (const m of index.models ?? []) {
    for (const v of m.variants ?? []) {
      if (!v.history) continue;
      const top = histories.get(v.path)?.revisions[0];
      if (!top || top.version !== v.version || top.commit !== v.commit || top.digest !== v.digest) {
        problems.push(`${v.history}: its newest revision is not ${m.name}/${v.id} as index-v2.json lists it`);
      }
    }
  }
  return problems;
}

module.exports = {
  root,
  modelsDir,
  V1,
  V2,
  readYaml,
  modelNames,
  kindOf,
  modelFiles,
  versionFiles,
  variantFiles,
  schemaOf,
  digest,
  compareVersions,
  isPrerelease,
  latestOf,
  buildIndex,
  serializeIndex,
  legacyTuning,
  historyPath,
  historiesOf,
  revisionProblems,
  buildIndexV2,
  schemaValidator,
  checkIndexV2,
};

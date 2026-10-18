"use strict";
// What a write changes, decided against the catalog it is made on: each
// function here takes the snapshot of the branch's tip and a request, and
// returns the plan -- the files to change, the commit message -- or throws an
// HttpError saying why not. They read nothing else and change nothing: the
// store (store.js) commits a plan.
//
// What they check is what keeps the index and the histories coherent: a
// file's identity (its model, its id, its path), its schema (v2 only), that
// the client saw what it replaces (If-Match), and that each change raises the
// variant's version. Whether a variant is a good one -- its JSON schema, its
// chart, its images -- is model-catalog's validate, not this.

const { isDeepStrictEqual } = require("util");
const yaml = require("yaml");
const { V2, digest, isV2, isVariant, parseVersion, compareVersions } = require("./catalog");

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    Object.assign(this, { status, extra });
  }
}

// What a 422 lists: every problem found, not just the first.
const invalid = (problems) => new HttpError(422, "not a change this catalog takes", { problems });

const MODEL = /^[a-z0-9][a-z0-9._-]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A header's digest: an ETag, quoted, or bare.
const tag = (v) =>
  v == null
    ? null
    : String(v)
        .trim()
        .replace(/^W\//, "")
        .replace(/^"(.*)"$/, "$1");

// The client saw current (null: no file): If-Match names it, or
// If-None-Match: * says there is none. An edit without If-Match is refused,
// so no one replaces a file they have not read.
function precondition(current, { ifMatch, ifNoneMatch }, what) {
  if (tag(ifNoneMatch) === "*") {
    if (current) throw new HttpError(412, `${what} exists`, { current });
    return;
  }
  if (ifMatch == null) {
    if (current) throw new HttpError(428, `${what} exists: send If-Match with the digest it was read at`, { current });
    return;
  }
  const want = tag(ifMatch);
  if (!current) throw new HttpError(412, `${what} does not exist`, { current: null });
  if (want !== "*" && want !== current) throw new HttpError(412, `${what} changed since it was read`, { current });
}

function parseDoc(body, what) {
  let doc;
  try {
    doc = yaml.parse(body.toString("utf8"), { uniqueKeys: true });
  } catch (err) {
    throw invalid([`${what}: not YAML: ${err.message.split("\n")[0]}`]);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw invalid([`${what}: not a YAML mapping`]);
  return doc;
}

// A model's directory as the snapshot has it: 404 when there is none, 422
// when it is not v2.
function modelDir(snap, model) {
  if (!MODEL.test(model)) throw new HttpError(404, `no model ${model}`);
  const dir = snap.dirs.get(model);
  if (!dir?.metaRel) throw new HttpError(404, `no model ${model}`);
  if (!isV2(dir.meta)) throw invalid([`models/${model}/metadata.yaml: not ${V2} -- only v2 models are written here`]);
  return dir;
}

const fileDigest = (snap, rel) => {
  const oid = snap.tree.get(rel);
  return oid ? digest(snap.blob(oid)) : null;
};

// The problems with doc as the next revision of the variant at rel: its
// identity, and that it raises the version above the variant's last revision
// -- a deleted one's too, as a history continues through a delete -- while
// changing more than that.
function variantProblems(snap, rel, model, id, doc) {
  const problems = [];
  const at = (s) => `${rel}: ${s}`;
  if (doc.apiVersion !== V2) problems.push(at(`apiVersion: want ${V2}`));
  if (doc.kind !== "Variant") problems.push(at("kind: want Variant"));
  if (doc.model !== model) problems.push(at(`model: ${JSON.stringify(doc.model)} is not ${model}, the model it is written to`));
  if (doc.id !== id) problems.push(at(`id: ${JSON.stringify(doc.id)} is not ${id}, the file it is written to`));
  if (typeof doc.version !== "string" || !parseVersion(doc.version)) {
    problems.push(at(`version: ${JSON.stringify(doc.version)} is not a semver version, such as "1.0.0"`));
    return problems;
  }
  const last = snap.revisions.get(rel)?.revisions.at(-1);
  if (last) {
    const strip = ({ version, ...rest }) => rest;
    if (!(compareVersions(doc.version, String(last.doc.version)) > 0)) {
      problems.push(at(`version: ${doc.version} does not raise ${last.doc.version}, the last revision's -- send ${next(last.doc.version)} or above`));
    } else if (isDeepStrictEqual(strip(doc), strip(last.doc))) {
      problems.push(at(`version ${doc.version} changes nothing else from ${last.doc.version}`));
    }
  }
  return problems;
}

// The patch release after v, as a 422 suggests it.
function next(v) {
  const p = parseVersion(v);
  if (!p) return "a higher version";
  return p.pre.length ? p.core.join(".") : `${p.core[0]}.${p.core[1]}.${p.core[2] + 1}`;
}

// A catalog is initialized once it has catalog.yaml. Until then -- an empty
// repository, or one without it -- the only write it takes is POST init.
const initialized = (snap) => snap.tree.has("catalog.yaml");

function mustBeInitialized(snap) {
  if (!initialized(snap)) throw new HttpError(409, "the catalog is not initialized: POST api/v2/init first");
}

// POST init: the template's files (template.js), each one the repository
// does not have yet -- a file it has is its own, and stays.
function initialize(snap, { files, message }) {
  if (initialized(snap)) throw new HttpError(409, "the catalog is initialized: it has a catalog.yaml");
  const changes = new Map([...files].filter(([rel]) => !snap.has(rel)));
  return { rel: "catalog.yaml", created: true, changes, message: message || "Initialize the catalog" };
}

// catalog.yaml's settings, model-catalog's (schema/catalog.schema.json):
// where the catalog is served (site), where its old revisions are fetched
// (raw, as <raw><commit>/<path>), its repository (repo). Each an http(s) URL
// with no credentials in it -- a catalog's own server or git host may well be
// plain http -- its trailing slash as written: the index puts the one each
// needs (catalog.js). Nothing checks site against what routes to the server:
// the catalog says, the deployment routes.
const URL_ = /^https?:\/\/[^/@\s]+(\/\S*)?$/;
const SETTINGS = { site: URL_, raw: URL_, repo: URL_ };

function settingsProblems(rel, doc) {
  const problems = [];
  if (doc.apiVersion !== "catalog.swiss/v1") problems.push(`${rel}: apiVersion: want catalog.swiss/v1`);
  for (const [key, value] of Object.entries(doc)) {
    if (key === "apiVersion") continue;
    const s = SETTINGS[key];
    if (!s) problems.push(`${rel}: ${key}: not a setting (${Object.keys(SETTINGS).join(", ")})`);
    else if (typeof value !== "string" || !s.test(value))
      problems.push(`${rel}: ${key}: ${JSON.stringify(value)} is not an http(s) URL with no credentials in it`);
  }
  return problems;
}

// PUT catalog: replaces catalog.yaml, at its digest. The index follows it at
// once: its site and raw are the catalog's.
function putSettings(snap, { body, ifMatch, message }) {
  mustBeInitialized(snap);
  const rel = "catalog.yaml";
  const current = fileDigest(snap, rel);
  if (current === digest(body)) return { unchanged: true, rel };
  if (ifMatch == null) throw new HttpError(428, `${rel}: send If-Match with the digest it was read at`, { current });
  precondition(current, { ifMatch }, rel);
  const problems = settingsProblems(rel, parseDoc(body, rel));
  if (problems.length) throw invalid(problems);
  return { rel, changes: new Map([[rel, body]]), message: message || "catalog: settings" };
}

// PUT models/<model>/variants/<id>: adds the variant file, or replaces it.
function putVariant(snap, { model, id, body, ifMatch, ifNoneMatch, message }) {
  mustBeInitialized(snap);
  const dir = modelDir(snap, model);
  const rel = `models/${model}/${id}.yaml`;
  if (!ID.test(id) || id === "metadata") throw new HttpError(404, `no variant ${id}: not a variant file's name`);
  const current = fileDigest(snap, rel);
  // The same bytes again, as a retry sends them: nothing to commit, whatever
  // it was read at.
  if (current === digest(body)) return { unchanged: true, rel };
  precondition(current, { ifMatch, ifNoneMatch }, rel);
  if (current && !dir.variants.some((v) => v.rel === rel)) throw invalid([`${rel}: not a v2 variant file, so not one to replace here`]);
  const doc = parseDoc(body, rel);
  const problems = variantProblems(snap, rel, model, id, doc);
  if (problems.length) throw invalid(problems);
  return {
    rel,
    created: !current,
    changes: new Map([[rel, body]]),
    message: message || `${model}/${id}: ${current ? "" : "add "}${doc.version}`,
  };
}

// DELETE models/<model>/variants/<id>. Its history stays, and raw/ keeps
// serving its revisions: a deploy pinned to one still finds it.
function deleteVariant(snap, { model, id, ifMatch, message }) {
  mustBeInitialized(snap);
  const dir = modelDir(snap, model);
  const rel = `models/${model}/${id}.yaml`;
  const current = fileDigest(snap, rel);
  if (!current || !dir.variants.some((v) => v.rel === rel)) throw new HttpError(404, `no variant ${model}/${id}`);
  if (ifMatch == null) throw new HttpError(428, `${rel}: send If-Match with the digest it was read at`, { current });
  precondition(current, { ifMatch }, rel);
  const problems = [];
  if (dir.meta.defaultVariant === id) problems.push(`models/${model}/metadata.yaml: defaultVariant is ${id} -- name another first`);
  (Array.isArray(dir.meta.tuning) ? dir.meta.tuning : []).forEach((t, i) => {
    for (const key of ["baseline", "optimized"]) {
      if (String(t?.[key] ?? "").split("@")[0] === id) problems.push(`models/${model}/metadata.yaml: tuning[${i}].${key} names ${id}`);
    }
  });
  if (dir.variants.length === 1) problems.push(`${rel}: the model's last variant -- a model has at least one`);
  if (problems.length) throw invalid(problems);
  return { rel, changes: new Map([[rel, null]]), message: message || `${model}/${id}: delete` };
}

function metadataProblems(rel, name, meta, ids) {
  const problems = [];
  if (meta.apiVersion !== V2) problems.push(`${rel}: apiVersion: want ${V2}`);
  if (meta.name !== name) problems.push(`${rel}: name: ${JSON.stringify(meta.name)} is not ${name}, its directory`);
  if (meta.defaultVariant !== undefined && !ids.includes(meta.defaultVariant)) {
    problems.push(`${rel}: defaultVariant: ${JSON.stringify(meta.defaultVariant)} is not a variant of ${name}`);
  }
  return problems;
}

// PUT models/<model>/metadata: replaces a model's metadata.yaml.
function putMetadata(snap, { model, body, ifMatch, message }) {
  mustBeInitialized(snap);
  const dir = modelDir(snap, model);
  const rel = dir.metaRel;
  const current = fileDigest(snap, rel);
  if (current === digest(body)) return { unchanged: true, rel };
  if (ifMatch == null) throw new HttpError(428, `${rel}: send If-Match with the digest it was read at`, { current });
  precondition(current, { ifMatch }, rel);
  const meta = parseDoc(body, rel);
  const problems = metadataProblems(
    rel,
    model,
    meta,
    dir.variants.map((v) => v.doc.id),
  );
  if (problems.length) throw invalid(problems);
  return { rel, changes: new Map([[rel, body]]), message: message || `${model}: metadata` };
}

// POST models: a new model, its metadata.yaml and its first variants, in one
// commit -- a model has a variant from its first commit on.
function createModel(snap, { metadata, variants, message }) {
  mustBeInitialized(snap);
  if (typeof metadata !== "string" || !Array.isArray(variants) || !variants.length || variants.some((v) => typeof v !== "string")) {
    throw new HttpError(400, 'want JSON {"metadata": "<metadata.yaml>", "variants": ["<variant YAML>", ...]}');
  }
  const meta = parseDoc(Buffer.from(metadata), "metadata");
  const name = meta.name;
  if (typeof name !== "string" || !MODEL.test(name)) throw invalid([`metadata: name: ${JSON.stringify(name)} is not a model name (${MODEL.source})`]);
  if (snap.dirs.has(name)) throw new HttpError(409, `models/${name}/ exists`);
  const rel = `models/${name}/metadata.yaml`;
  const changes = new Map([[rel, Buffer.from(metadata)]]);
  const problems = [];
  const ids = [];
  variants.forEach((text, i) => {
    const doc = parseDoc(Buffer.from(text), `variants[${i}]`);
    const id = doc.id;
    if (typeof id !== "string" || !ID.test(id) || id === "metadata") {
      problems.push(`variants[${i}]: id: ${JSON.stringify(id)} is not a variant file's name (${ID.source}, not metadata)`);
      return;
    }
    if (ids.includes(id)) problems.push(`variants[${i}]: id: ${id} is given twice`);
    ids.push(id);
    const vrel = `models/${name}/${id}.yaml`;
    problems.push(...variantProblems(snap, vrel, name, id, doc));
    changes.set(vrel, Buffer.from(text));
  });
  problems.unshift(...metadataProblems(rel, name, meta, ids));
  if (problems.length) throw invalid(problems);
  return { rel, created: true, model: name, changes, message: message || `${name}: add model` };
}

module.exports = { HttpError, initialized, initialize, putSettings, settingsProblems, putVariant, deleteVariant, putMetadata, createModel, tag };

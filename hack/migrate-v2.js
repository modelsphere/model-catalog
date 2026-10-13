#!/usr/bin/env node
// Move a model to schema v2, from its latest v1 version file. v1 files stay.
//
//   node hack/migrate-v2.js <model>... [--dry-run]
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs, isDeepStrictEqual } = require("util");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const { root, modelsDir, readYaml, versionFiles, variantFiles, compareVersions, latestOf, schemaOf, V2 } = require("./lib/catalog");

const STRINGIFY = { lineWidth: 0 };

function migrate(name) {
  const dir = path.join(modelsDir, name);
  const metaPath = path.join(dir, "metadata.yaml");
  if (!fs.existsSync(metaPath)) throw new Error(`models/${name}/: no such model`);
  const meta = YAML.parseDocument(fs.readFileSync(metaPath, "utf8"));
  if (schemaOf(meta.toJS()) === "v2") throw new Error(`${name}: already on v2`);
  if (variantFiles(name).length) throw new Error(`${name}: already has v2 variant files`);

  const docs = new Map(versionFiles(name).map((rel) => [rel, readYaml(path.join(root, rel))]));
  if (docs.size === 0) throw new Error(`${name}: no version files`);
  const byVersion = new Map([...docs.values()].map((d) => [String(d.version), d]));
  const latest = latestOf([...byVersion.keys()].sort(compareVersions));
  const from = [...docs].find(([, d]) => String(d.version) === latest)[0];
  const text = fs.readFileSync(path.join(root, from), "utf8");
  const version = YAML.parseDocument(text);
  const variants = version.get("variants", true).items;
  const servedName = version.get("servedName");

  const heading = version.contents.items[0]?.key.commentBefore;
  const out = new Map();
  const taken = new Set(fs.readdirSync(dir));
  for (const item of variants) {
    const id = item.get("id");
    if (id === "metadata") throw new Error(`${name}: variant id metadata is the model's own file; rename the variant first`);
    if (taken.has(`${id}.yaml`)) throw new Error(`${name}: models/${name}/${id}.yaml exists already`);
    const doc = new YAML.Document({ apiVersion: V2, kind: "Variant", model: name });
    doc.contents.items[0].key.commentBefore = [heading, item.commentBefore].filter(Boolean).join("\n") || undefined;
    // Moved nodes keep their comments and quoting.
    const own = item.items.filter((p) => p.key.value !== "default");
    doc.contents.items.push(own.find((p) => p.key.value === "id"));
    doc.set("version", latest);
    if (servedName != null) doc.set("servedName", servedName);
    doc.contents.items.push(...own.filter((p) => p.key.value !== "id"));
    const body = doc.toString(STRINGIFY);
    const { apiVersion, kind, model, version: v, servedName: served, ...rest } = YAML.parse(body);
    const { default: _, ...was } = item.toJSON();
    if (!isDeepStrictEqual(rest, was) || served !== (servedName ?? undefined)) throw new Error(`${name}: ${id} would not migrate unchanged`);
    out.set(`models/${name}/${id}.yaml`, body);
  }

  // A tuning entry carries over only if its variants are unchanged since measured.
  const plain = (v) => byVersion.get(latest).variants.find((x) => x.id === v);
  meta.set("apiVersion", V2);
  const def = byVersion.get(latest).variants.find((v) => v.default === true);
  if (def) {
    const at = meta.contents.items.findIndex((p) => ["tuning", "source"].includes(p.key.value));
    const pair = meta.createPair("defaultVariant", def.id);
    if (at < 0) meta.contents.items.push(pair);
    else meta.contents.items.splice(at, 0, pair);
  }
  const tuning = meta.get("tuning", true);
  for (const [i, entry] of (tuning?.items ?? []).entries()) {
    const measured = byVersion.get(String(entry.get("version")));
    for (const key of ["baseline", "optimized"]) {
      const id = entry.get(key);
      const was = measured?.variants.find((v) => v.id === id);
      if (!was || !isDeepStrictEqual(was, plain(id))) {
        throw new Error(
          `${name}: tuning[${i}] measured ${id} in ${entry.get("version")}, and ${latest} ${plain(id) ? "changed" : "dropped"} it: ` +
            "v2 has no revision of what was measured. Re-measure the latest, or remove the entry, then migrate",
        );
      }
      entry.set(key, `${id}@${latest}`);
    }
  }
  out.set(`models/${name}/metadata.yaml`, meta.toString(STRINGIFY));
  return { from, files: out };
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
  if (positionals.length === 0) throw new Error("usage: node hack/migrate-v2.js <model> [<model>...] [--dry-run]");
  const plans = positionals.map((name) => ({ name, ...migrate(name) }));
  if (values["dry-run"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-v2-"));
    for (const { files } of plans) {
      for (const [rel, body] of files) {
        const now = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(now), { recursive: true });
        fs.writeFileSync(now, body);
        const was = path.join(root, rel);
        const r = spawnSync("git", ["diff", "--no-index", "--", fs.existsSync(was) ? was : "/dev/null", now], { encoding: "utf8" });
        process.stdout.write(r.stdout.replaceAll(`${tmp.slice(1)}/`, "").replaceAll(`${root.slice(1)}/`, ""));
      }
    }
    fs.rmSync(tmp, { recursive: true });
  } else {
    for (const { files } of plans) for (const [rel, body] of files) fs.writeFileSync(path.join(root, rel), body);
  }
  for (const { name, from, files } of plans) {
    console.error(`${name}: ${files.size - 1} variant files from ${path.basename(from)}${values["dry-run"] ? " (dry run: nothing written)" : ""}`);
  }
  const lineage = plans.map(({ name, from }) => `${name}@${readYaml(path.join(root, from)).version}`).join(", ");
  if (!values["dry-run"])
    console.error(`commit as one change, e.g.: git commit -m "migrate ${plans.map((p) => p.name).join(", ")} to schema v2 (from ${lineage})"`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { migrate };

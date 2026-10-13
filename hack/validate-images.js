#!/usr/bin/env node
// Check every image the catalog names can be pulled anonymously, by tag and by
// any digest it pins, and that each tuned pair's perf report measured the
// builds its two variants run. Each image is logged as ok, warning (its tag
// has moved off a pinned digest that is still pullable) or error. Registries
// are asked through crane, which npm run tools:install pins.
//
//   npm run validate:images                           # the whole catalog
//   npm run validate:images -- models/x/x-1.0.0.yaml  # only these files
//   npm run validate:images -- --base origin/master   # only what a branch adds or changes
//   npm run validate:images -- --match-digest         # and each pinned digest is what its tag resolves to now
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const YAML = require("yaml");
const { spawnSync } = require("node:child_process");
const { root, modelNames, versionFiles, variantFiles, kindOf, schemaOf, historiesOf } = require("./lib/catalog");
const { checkImage, reportMismatches, changedVersionFiles } = require("./lib/images");

function parse(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: "string" }, "match-digest": { type: "boolean", default: false } },
  });
  const { base, "match-digest": matchDigest } = values;
  const files = positionals.map((file) => path.relative(root, path.resolve(file)).split(path.sep).join("/"));
  if (base && files.length) throw new Error("choose --base REF or explicit files, not both");
  if (base) return { files: changedVersionFiles(root, base), matchDigest };
  const versions = modelNames().flatMap((name) => [...versionFiles(name), ...variantFiles(name)]);
  if (!files.length) return { files: versions, matchDigest };
  const unknown = files.filter((f) => !versions.includes(f));
  if (unknown.length) throw new Error(`not a model version or variant file: ${unknown.join(", ")}`);
  return { files, matchDigest };
}

async function main() {
  const { files, matchDigest } = parse(process.argv.slice(2));
  if (files.length === 0) {
    console.log("no version or variant files to check");
    return 0;
  }

  const docs = new Map(files.map((file) => [file, YAML.parse(fs.readFileSync(path.join(root, file), "utf8"))]));
  const variantsOf = (doc) => (kindOf(doc) === "variant" ? [doc] : (doc?.variants ?? []));

  // Each distinct image once, however many variants share it.
  const uses = new Map();
  for (const [file, doc] of docs) {
    for (const v of variantsOf(doc)) {
      if (!v?.image?.repository) continue;
      const key = JSON.stringify([v.image.repository, String(v.image.tag ?? "latest"), v.image.digest ?? ""]);
      if (!uses.has(key)) uses.set(key, []);
      uses.get(key).push({ file, id: v.id });
    }
  }

  const results = new Map();
  const keys = [...uses.keys()];
  // A few at a time: enough to be quick, few enough not to trip rate limits.
  for (let i = 0; i < keys.length; i += 4) {
    const batch = keys.slice(i, i + 4);
    await Promise.all(
      batch.map(async (key) => {
        const [repository, tag, digest] = JSON.parse(key);
        results.set(key, await checkImage({ repository, tag, digest }, { matchDigest }));
      }),
    );
    for (const key of batch) console.log(`${results.get(key).level.padEnd(7)} ${results.get(key).message}`);
  }

  const byFile = new Map();
  const note = (file, line) => {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(line);
  };
  for (const [key, { level, message }] of results) {
    if (level === "error") for (const { file, id } of uses.get(key)) note(file, `${id}: ${message}`);
  }

  // Tuned pairs of the selected versions. A missing report or variant is
  // validate:schema's to report.
  let reports = 0;
  let histories;
  const measured = (name, ref) => {
    const [id, version] = String(ref ?? "").split("@");
    const rel = `models/${name}/${id}.yaml`;
    const now = docs.get(rel) ?? (fs.existsSync(path.join(root, rel)) ? YAML.parse(fs.readFileSync(path.join(root, rel), "utf8")) : undefined);
    if (String(now?.version) === version) return now;
    histories ??= historiesOf();
    const commit = histories.get(rel)?.revisions.find((r) => r.version === version)?.commit;
    const r = commit && spawnSync("git", ["show", `${commit}:${rel}`], { cwd: root, encoding: "utf8" });
    return r?.status === 0 ? YAML.parse(r.stdout) : undefined;
  };
  for (const name of new Set([...docs.keys()].map((file) => file.split("/")[1]))) {
    const meta = `models/${name}/metadata.yaml`;
    const metadata = YAML.parse(fs.readFileSync(path.join(root, meta), "utf8"));
    const v2 = schemaOf(metadata) === "v2";
    (metadata?.tuning ?? []).forEach((t, i) => {
      const doc = [...docs].find(([file, d]) => file.split("/")[1] === name && String(d?.version) === String(t?.version))?.[1];
      const variant = (key) => (v2 ? measured(name, t?.[key]) : doc?.variants?.find((v) => v?.id === t?.[key]));
      if (v2 && ![t?.baseline, t?.optimized].some((ref) => docs.has(`models/${name}/${String(ref ?? "").split("@")[0]}.yaml`))) return;
      const [b, o] = [variant("baseline"), variant("optimized")];
      const html = path.join(root, "models", name, String(t?.report ?? ""));
      if (!t?.report || !b?.image || !o?.image || !fs.existsSync(html)) return;
      reports++;
      const image = (v) => `${v.image.repository}:${v.image.tag ?? "latest"}`;
      for (const m of reportMismatches(fs.readFileSync(html, "utf8"), { baseline: image(b), optimized: image(o) })) {
        note(meta, `tuning[${i}] (${t.report}): ${m}`);
      }
    });
  }
  [...byFile.keys()].sort().forEach((file, i) => {
    if (i) console.error("");
    console.error(file);
    for (const line of byFile.get(file)) console.error(`  ${line}`);
  });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const count = (level) => [...results.values()].filter((r) => r.level === level).length;
  const errors = count("error");
  const bad = [...byFile.keys()].filter((f) => f.endsWith("metadata.yaml")).reduce((n, f) => n + byFile.get(f).length, 0);
  console.log(
    `${plural(keys.length, "image")} in ${plural(files.length, "file")}: ${count("ok")} ok, ${plural(count("warning"), "warning")}, ${plural(errors, "error")}`,
  );
  console.log(`${reports} perf report${reports === 1 ? "" : "s"} checked against their variants' images, ${bad} mismatch${bad === 1 ? "" : "es"}`);
  return errors || bad ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(2);
  },
);

#!/usr/bin/env node
// Check every image the catalog names can be pulled anonymously, and that each
// tuned pair's perf report measured the builds its two variants run.
//
//   npm run validate:images                           # the whole catalog
//   npm run validate:images -- models/x/x-1.0.0.yaml  # only these files
//   npm run validate:images -- --base origin/master   # only what a branch adds or changes
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const {root, modelNames, versionFiles} = require("./lib/catalog");
const {imageProblem, reportMismatches, changedVersionFiles} = require("./lib/images");

function select(args) {
  const files = [];
  let base = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--base: missing argument");
      base = args[++i];
    } else if (args[i].startsWith("-")) throw new Error(`unknown option ${args[i]}`);
    else files.push(path.relative(root, path.resolve(args[i])).split(path.sep).join("/"));
  }
  if (base && files.length) throw new Error("choose --base REF or explicit files, not both");
  if (base) return changedVersionFiles(root, base);
  const versions = modelNames().flatMap((name) => versionFiles(name));
  if (!files.length) return versions;
  const unknown = files.filter((f) => !versions.includes(f));
  if (unknown.length) throw new Error(`not a model version file: ${unknown.join(", ")}`);
  return files;
}

async function main() {
  const files = select(process.argv.slice(2));
  if (files.length === 0) {
    console.log("no version files to check");
    return 0;
  }

  const docs = new Map(files.map((file) => [file, YAML.parse(fs.readFileSync(path.join(root, file), "utf8"))]));

  // Each distinct image once, however many variants share it.
  const uses = new Map();
  for (const [file, doc] of docs) {
    for (const v of doc.variants ?? []) {
      if (!v?.image?.repository) continue;
      const key = JSON.stringify([v.image.repository, String(v.image.tag ?? "latest"), v.image.digest ?? ""]);
      if (!uses.has(key)) uses.set(key, []);
      uses.get(key).push({file, id: v.id});
    }
  }

  const tokens = new Map();
  const problems = new Map();
  const keys = [...uses.keys()];
  // A few at a time: enough to be quick, few enough not to trip rate limits.
  for (let i = 0; i < keys.length; i += 4) {
    await Promise.all(keys.slice(i, i + 4).map(async (key) => {
      const [repository, tag, digest] = JSON.parse(key);
      const problem = await imageProblem({repository, tag, digest}, {tokens});
      if (problem) problems.set(key, problem);
    }));
  }

  const byFile = new Map();
  const note = (file, line) => {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(line);
  };
  for (const [key, problem] of problems) {
    for (const {file, id} of uses.get(key)) note(file, `${id}: ${problem}`);
  }

  // Tuned pairs of the selected versions. A missing report or variant is
  // validate:schema's to report.
  let reports = 0;
  for (const name of new Set([...docs.keys()].map((file) => file.split("/")[1]))) {
    const meta = `models/${name}/metadata.yaml`;
    const tuning = YAML.parse(fs.readFileSync(path.join(root, meta), "utf8"))?.tuning ?? [];
    tuning.forEach((t, i) => {
      const doc = [...docs].find(([file, d]) => file.split("/")[1] === name && String(d?.version) === String(t?.version))?.[1];
      const variant = (id) => doc?.variants?.find((v) => v?.id === id);
      const [b, o] = [variant(t?.baseline), variant(t?.optimized)];
      const html = path.join(root, "models", name, String(t?.report ?? ""));
      if (!t?.report || !b?.image || !o?.image || !fs.existsSync(html)) return;
      reports++;
      const image = (v) => `${v.image.repository}:${v.image.tag ?? "latest"}`;
      for (const m of reportMismatches(fs.readFileSync(html, "utf8"), {baseline: image(b), optimized: image(o)})) {
        note(meta, `tuning[${i}] (${t.report}): ${m}`);
      }
    });
  }
  [...byFile.keys()].sort().forEach((file, i) => {
    if (i) console.error("");
    console.error(file);
    for (const line of byFile.get(file)) console.error(`  ${line}`);
  });
  const ok = keys.length - problems.size;
  const bad = [...byFile.keys()].filter((f) => f.endsWith("metadata.yaml")).reduce((n, f) => n + byFile.get(f).length, 0);
  console.log(`${ok} of ${keys.length} images publicly pullable, in ${files.length} version file${files.length === 1 ? "" : "s"}`);
  console.log(`${reports} perf report${reports === 1 ? "" : "s"} checked against their variants' builds, ${bad} mismatch${bad === 1 ? "" : "es"}`);
  return problems.size || bad ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(2);
});

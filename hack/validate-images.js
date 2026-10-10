#!/usr/bin/env node
// Check every image the catalog names can be pulled anonymously.
//
//   npm run validate:images                           # the whole catalog
//   npm run validate:images -- models/x/x-1.0.0.yaml  # only these files
//   npm run validate:images -- --base origin/master   # only what a branch adds or changes
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const {root, modelNames, versionFiles} = require("./lib/catalog");
const {imageProblem, changedVersionFiles} = require("./lib/images");

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

  // Each distinct image once, however many variants share it.
  const uses = new Map();
  for (const file of files) {
    for (const v of YAML.parse(fs.readFileSync(path.join(root, file), "utf8")).variants ?? []) {
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
  for (const [key, problem] of problems) {
    for (const {file, id} of uses.get(key)) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(`${id}: ${problem}`);
    }
  }
  [...byFile.keys()].sort().forEach((file, i) => {
    if (i) console.error("");
    console.error(file);
    for (const line of byFile.get(file)) console.error(`  ${line}`);
  });
  const ok = keys.length - problems.size;
  console.log(`${ok} of ${keys.length} images publicly pullable, in ${files.length} version file${files.length === 1 ? "" : "s"}`);
  return problems.size ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(2);
});

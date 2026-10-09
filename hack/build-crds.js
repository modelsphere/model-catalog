#!/usr/bin/env node
"use strict";

// Build the kubeconform CRD schemas the way npm install builds node_modules.
// crds.json pins each CRD to a commit; crds-lock.json records the sha256
// of what each pin holds. A lock in step with crds.json is honored, and
// different bytes are refused; a missing or stale lock is written afresh.
// --locked (CI) refuses to rewrite the lock instead, like npm ci.
//   node hack/build-crds.js [--locked] [DIR]
const fs = require("node:fs");
const path = require("node:path");
const {root} = require("./lib/catalog");
const {buildSchemas} = require("./lib/crd-schema");
const config = require("../schema/crds/config.json");
const {sources} = require("../schema/crds/crds.json");

const lockFile = path.join(root, "schema/crds/crds-lock.json");
const objectMetaUrl = `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${config.kubernetesSchemaCommit}/` +
  `v${config.kubernetesVersion}-standalone-strict/_definitions.json`;

function pins(list) {
  return JSON.stringify(list.map(({repository, commit, path: file, kind, group}) => [repository, commit, file, kind, group]));
}

async function main(args) {
  const locked = args.includes("--locked");
  const rest = args.filter((arg) => arg !== "--locked");
  if (rest.length > 1 || rest.some((arg) => arg.startsWith("-"))) throw new Error("usage: build-crds.js [--locked] [DIR]");
  const text = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null;
  const lock = text && JSON.parse(text);
  const current = lock?.objectMeta?.url === objectMetaUrl && pins(lock.sources) === pins(sources);
  const stale = `${path.relative(root, lockFile)} is out of date; run npm run helm:build-crds and commit it`;
  if (!current && locked) throw new Error(stale);
  const built = current ? await buildSchemas(lock.sources, lock.objectMeta) : await buildSchemas(sources, {url: objectMetaUrl});
  const next = JSON.stringify({objectMeta: built.objectMeta, sources: built.records}, null, 2) + "\n";
  if (next !== text) {
    if (locked) throw new Error(stale);
    fs.writeFileSync(lockFile, next);
    console.log(`Updated ${path.relative(root, lockFile)}`);
  }
  if (!rest.length) return;
  const output = path.resolve(rest[0]);
  for (const [file, body] of built.files) {
    fs.mkdirSync(path.dirname(path.join(output, file)), {recursive: true});
    fs.writeFileSync(path.join(output, file), body);
  }
  console.log(`Built ${built.files.size} CRD schemas in ${output}`);
}

main(process.argv.slice(2)).catch((err) => {console.error(err.message); process.exitCode = 1;});

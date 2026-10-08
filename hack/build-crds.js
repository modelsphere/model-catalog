#!/usr/bin/env node
"use strict";

// Build the kubeconform CRD schemas from the lock into DIR. Every source is
// downloaded at its locked commit and must match its recorded sha256.
//   node hack/build-crds.js [--lock schema/helm/provenance.json] DIR
const fs = require("node:fs");
const path = require("node:path");
const {root} = require("./lib/catalog");
const {CONVERTER_VERSION, buildSchemas} = require("./lib/crd-schema");

async function main(args) {
  let lock = path.join(root, "schema/helm/provenance.json");
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lock" && args[i + 1]) lock = args[++i];
    else rest.push(args[i]);
  }
  if (rest.length !== 1 || rest[0].startsWith("-")) throw new Error("usage: build-crds.js [--lock FILE] DIR");
  const provenance = JSON.parse(fs.readFileSync(lock, "utf8"));
  if (provenance.converterVersion !== CONVERTER_VERSION) {
    throw new Error(`${lock}: converter ${provenance.converterVersion}, want ${CONVERTER_VERSION}; run npm run helm:update-crds`);
  }
  const {files} = await buildSchemas(provenance.sources, provenance.objectMeta);
  const locked = provenance.sources.flatMap((source) => source.schemas.map((schema) => schema.file)).sort();
  if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(locked)) {
    throw new Error(`${lock}: built schemas differ from the locked list; run npm run helm:update-crds`);
  }
  const output = path.resolve(rest[0]);
  for (const [file, body] of files) {
    fs.mkdirSync(path.dirname(path.join(output, file)), {recursive: true});
    fs.writeFileSync(path.join(output, file), body);
  }
  console.log(`Built ${files.size} CRD schemas in ${output}`);
}

main(process.argv.slice(2)).catch((err) => {console.error(err.message); process.exitCode = 1;});

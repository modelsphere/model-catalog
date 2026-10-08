#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const YAML = require("yaml");
const {root} = require("./lib/catalog");
const {CONVERTER_VERSION, assertCrdSource, crdSchemas, objectMetaSchema} = require("./lib/crd-schema");
const config = require("../schema/helm/config.json");
const sources = require("../schema/helm/sources.json").sources;

async function main() {
  if (config.converterVersion !== CONVERTER_VERSION) throw new Error("converter version mismatch");
  const output = path.join(root, "schema/helm/crds");
  const files = new Map();
  const records = [];
  const metadataUrl = `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${config.kubernetesSchemaCommit}/` +
    `v${config.kubernetesVersion}-standalone-strict/_definitions.json`;
  const metadataResponse = await fetch(metadataUrl, {signal: AbortSignal.timeout(60000)});
  if (!metadataResponse.ok) throw new Error(`${metadataUrl}: HTTP ${metadataResponse.status}`);
  const metadataBody = await metadataResponse.text();
  const metadata = objectMetaSchema(JSON.parse(metadataBody).definitions);
  // Download and convert everything before replacing the generated directory.
  for (const source of sources) {
    if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new Error("source must use a full commit SHA");
    const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = await response.text();
    const schemas = YAML.parseAllDocuments(body).flatMap((doc) => {
      if (doc.errors.length) throw doc.errors[0];
      const crd = doc.toJS();
      if (!crd) return [];
      assertCrdSource(source, crd);
      return crdSchemas(crd, metadata);
    });
    if (!schemas.length) throw new Error(`${url}: no served schemas`);
    for (const {file, schema} of schemas) {
      if (files.has(file)) throw new Error(`duplicate schema ${file}`);
      files.set(file, JSON.stringify(schema, null, 2) + "\n");
    }
    records.push({...source, url, sha256: crypto.createHash("sha256").update(body).digest("hex"),
      schemas: schemas.map(({file, group, version, kind}) => ({file, group, version, kind}))});
  }
  fs.rmSync(output, {recursive: true, force: true});
  for (const [file, body] of files) {
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, body);
    console.log(`Generated schema/helm/crds/${file}`);
  }
  fs.writeFileSync(path.join(root, "schema/helm/provenance.json"),
    JSON.stringify({converterVersion: CONVERTER_VERSION,
      objectMeta: {url: metadataUrl, sha256: crypto.createHash("sha256").update(metadataBody).digest("hex")},
      sources: records}, null, 2) + "\n");
}

main().catch((err) => {console.error(err.message); process.exitCode = 1;});

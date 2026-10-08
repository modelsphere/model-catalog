#!/usr/bin/env node
"use strict";

// Refresh the CRD lock: download every source at the commit sources.json pins,
// check it converts, and record its sha256 and schemas in provenance.json.
// Schemas are not committed; hack/build-crds.js builds them from this lock.
const fs = require("node:fs");
const path = require("node:path");
const {root} = require("./lib/catalog");
const {CONVERTER_VERSION, buildSchemas} = require("./lib/crd-schema");
const config = require("../schema/helm/config.json");
const sources = require("../schema/helm/sources.json").sources;

async function main() {
  if (config.converterVersion !== CONVERTER_VERSION) throw new Error("converter version mismatch");
  const objectMeta = {url: `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${config.kubernetesSchemaCommit}/` +
    `v${config.kubernetesVersion}-standalone-strict/_definitions.json`};
  const lock = await buildSchemas(sources, objectMeta);
  fs.writeFileSync(path.join(root, "schema/helm/provenance.json"),
    JSON.stringify({converterVersion: CONVERTER_VERSION, objectMeta: lock.objectMeta, sources: lock.records}, null, 2) + "\n");
  for (const record of lock.records) {
    for (const schema of record.schemas) console.log(`Locked ${schema.file} from ${record.repository}@${record.commit}`);
  }
}

main().catch((err) => {console.error(err.message); process.exitCode = 1;});

#!/usr/bin/env node
// Regenerate index.json from models/<name>/. See buildIndex in lib/catalog.js.
"use strict";

const fs = require("fs");
const path = require("path");
const { root, buildIndex, serializeIndex } = require("./lib/catalog");

let index;
try {
  index = buildIndex();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
fs.writeFileSync(path.join(root, "index.json"), serializeIndex(index));
const versions = index.models.reduce((n, m) => n + m.versions.length, 0);
console.log(`index.json: ${index.count} models, ${versions} versions`);

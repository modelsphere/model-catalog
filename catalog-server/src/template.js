"use strict";
// What POST api/v2/init commits to an empty catalog: every file under a
// template directory (template/ here, or the config's repository.template),
// at the same path. {{site}} and {{repo}} in a file are filled in; a line
// with one left empty is left out, so an unset setting is not written as an
// empty one.

const fs = require("fs");
const path = require("path");

const BUILT_IN = path.join(__dirname, "../template");

// The template's files: path -> bytes, with values filled in.
function templateFiles(dir, values) {
  const files = new Map();
  const walk = (at) => {
    for (const e of fs.readdirSync(path.join(dir, at), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = at ? `${at}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) files.set(rel, fill(fs.readFileSync(path.join(dir, rel), "utf8"), values));
    }
  };
  walk("");
  if (!files.has("catalog.yaml")) throw new Error(`${dir}: a template needs a catalog.yaml`);
  return files;
}

function fill(text, values) {
  const lines = text.split("\n").flatMap((line) => {
    let empty = false;
    const out = line.replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!values[k]) empty = true;
      return values[k] ?? "";
    });
    return empty ? [] : [out];
  });
  return Buffer.from(lines.join("\n"));
}

module.exports = { templateFiles, BUILT_IN };

"use strict";
// What the catalog server serves, built from models/: index-v2.json, its
// variant files and their histories, which the web app renders from; and the
// v1 catalog swiss reads (index.json and the version files it names), kept as
// published.
//
// server/index.js serves this live; the site build (web/vite.config.mts)
// writes it out as static files beside the pages.

const fs = require("fs");
const path = require("path");
const { root, readYaml, buildIndex, serializeIndex, buildIndexV2, checkIndexV2, historyPath } = require("../hack/lib/catalog");

// Perf reports, at models/<name>/<report>: those index-v2.json lists as linkable.
function copyReports(index, outDir) {
  let files = 0;
  for (const m of index.models) {
    for (const report of m.reports) {
      const rel = `models/${m.name}/${report}`;
      fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(outDir, rel));
      files++;
    }
  }
  return files;
}

// The catalog itself, published beside the pages: index.json and every
// version file it names, at the paths it names -- swiss fetches entries
// relative to index.json.
//
// A published version is immutable: a deploy recorded its digest. The index
// live at catalog.yaml's site is what consumers hold, so it is the baseline: a
// version it lists must still be here, byte for byte. REWRITES says what to do
// when one is not:
//
//   refuse  fail the build (the default)
//   warn    report it and build anyway (pull requests: the live site is master's)
//   allow   publish it: a deliberate in-place edit, deployed by hand
//
// PUBLISHED_INDEX points the baseline elsewhere: a URL, a file, or "none".
async function publishedIndex() {
  const from = process.env.PUBLISHED_INDEX || new URL("index.json", readYaml(path.join(root, "catalog.yaml")).site).href;
  if (from === "none") return null;
  if (!/^https?:\/\//.test(from)) return JSON.parse(fs.readFileSync(from, "utf8"));
  const res = await fetch(from);
  if (res.status === 404) return null; // nothing published yet
  if (!res.ok) {
    throw new Error(`${from}: ${res.status} -- cannot check published versions are unchanged; PUBLISHED_INDEX=none skips the check`);
  }
  return res.json();
}

// A published version is found again as swiss finds it: by its model and
// version, then its digest. Its path is only where it is fetched from, so a
// version file moved with its bytes unchanged (its directory renamed to its
// model's name) is a move, listed but not a rewrite.
function rewritesOf(published, index) {
  const now = new Map(index.models.flatMap((m) => m.versions.map((v) => [`${m.name}@${v.version}`, v])));
  const rewrites = [];
  const moves = [];
  for (const m of published?.models ?? []) {
    for (const v of m.versions) {
      const cur = now.get(`${m.name}@${v.version}`);
      if (!cur) rewrites.push(`${v.path}: published, now deleted -- deprecate the model instead`);
      else if (cur.digest !== v.digest) rewrites.push(`${v.path}: published, now edited -- publish a new version instead`);
      else if (cur.path !== v.path) moves.push(`${v.path}: moved to ${cur.path}, unchanged`);
    }
  }
  return { rewrites, moves };
}

// The index to publish, once checked against the published one: throws when
// REWRITES refuses what changed.
async function checkedIndex() {
  const index = buildIndex();
  const mode = process.env.REWRITES || "refuse";
  if (!["refuse", "warn", "allow"].includes(mode)) throw new Error(`REWRITES=${mode}: want refuse, warn or allow`);
  const { rewrites, moves } = rewritesOf(await publishedIndex(), index);
  if (moves.length) console.log(moves.join("\n"));
  if (rewrites.length && mode !== "allow") {
    const text = rewrites.join("\n");
    if (mode === "refuse") throw new Error(`${text}\n(REWRITES=allow publishes them: a deliberate in-place edit)`);
    console.warn(`${text}\n(warn only: a deploy refuses these unless run with REWRITES=allow)`);
  }
  return { index, rewrites: mode === "allow" ? rewrites.length : 0 };
}

function publishCatalog(index, outDir) {
  let files = 0;
  for (const m of index.models) {
    for (const v of m.versions) {
      fs.mkdirSync(path.dirname(path.join(outDir, v.path)), { recursive: true });
      fs.copyFileSync(path.join(root, v.path), path.join(outDir, v.path));
      files++;
    }
  }
  fs.writeFileSync(path.join(outDir, "index.json"), serializeIndex(index));
  return { models: index.models.length, files };
}

// index-v2.json and its histories; throws when they fail their checks.
function checkedIndexV2() {
  const built = buildIndexV2();
  const problems = checkIndexV2(built);
  if (problems.length) throw new Error(problems.join("\n"));
  return built;
}

// index-v2.json, the v2 variant files and every history.json.
function publishV2(outDir) {
  const { index, histories } = checkedIndexV2();
  fs.writeFileSync(path.join(outDir, "index-v2.json"), serializeIndex(index));
  let files = 0;
  for (const v of index.models.flatMap((m) => m.variants)) {
    fs.mkdirSync(path.dirname(path.join(outDir, v.path)), { recursive: true });
    fs.copyFileSync(path.join(root, v.path), path.join(outDir, v.path));
    files++;
  }
  for (const [rel, h] of histories) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, historyPath(rel)), JSON.stringify(h, null, 2) + "\n");
  }
  return { index, files, histories: histories.size };
}

// Everything beside the pages, as a build writes it into outDir: index-v2.json
// with its variant files and histories, the perf reports it lists, and the v1
// catalog (index.json and its version files), from checkedIndex. Returns a
// line saying what it wrote.
function writeSiteData(outDir, { index, rewrites }) {
  const v2 = publishV2(outDir);
  const reports = copyReports(v2.index, outDir);
  const published = publishCatalog(index, outDir);
  // GitHub Pages serves the tree as it is.
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  return (
    `site/: ${v2.index.count} models, ${v2.files} variant files, ${v2.histories} histories, ${reports} perf HTML; ` +
    `index.json: ${published.models} models, ${published.files} version files` +
    (rewrites ? `, ${rewrites} rewritten in place (REWRITES=allow)` : "")
  );
}

module.exports = { checkedIndex, checkedIndexV2, rewritesOf, writeSiteData, buildIndex, serializeIndex };

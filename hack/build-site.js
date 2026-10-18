#!/usr/bin/env node
// npm run build:site: the site GitHub Pages serves, in site/ -- the web app
// as npm run build:web built it (dist/web/), at catalog.yaml's site path, and
// the catalog beside it as static files: what server/ serves live.
//
// site/
//   index.html                 the page; its copies below let each route
//   models.html                  load directly: GitHub Pages has no
//   variants.html                fallback for a single page app
//   models/<name>/index.html
//   404.html
//   assets/, logo.png, icon.png, element/
//                              the rest of dist/web/
//   index-v2.json              what the page renders from, built from models/
//                              and git history
//   models/<name>/<id>.yaml    every variant file it names, and its
//   models/<name>/<id>.history.json
//   models/<name>/*.html       perf reports, copied from the repo
//   index.json                 the v1 index swiss reads, built from models/
//   models/<name>/*.yaml       every version file it names
//
// PUBLISHED_INDEX and REWRITES say how to treat an edited published version
// (server/data.js): one it refuses fails the build before site/ is written.
"use strict";

const fs = require("fs");
const path = require("path");
const { root, readYaml, modelNames } = require("./lib/catalog");
const { fillBase } = require("./lib/pages");
const { checkedIndex, writeSiteData } = require("../server/data");

const web = path.join(root, "dist/web");
const out = path.join(root, "site");

// dist/web/ into site/, base in place of the mark.
function copyWeb(from, to, base) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const [src, dst] = [path.join(from, e.name), path.join(to, e.name)];
    if (e.isDirectory()) copyWeb(src, dst, base);
    else fs.writeFileSync(dst, fillBase(e.name, fs.readFileSync(src), base));
  }
}

async function main() {
  if (!fs.existsSync(path.join(web, "index.html"))) throw new Error("dist/web/: not built -- npm run build:web first");
  const published = await checkedIndex();
  const base = new URL(readYaml(path.join(root, "catalog.yaml")).site).pathname;
  fs.rmSync(out, { recursive: true, force: true });
  copyWeb(web, out, base);
  const summary = writeSiteData(out, published);
  const page = fs.readFileSync(path.join(out, "index.html"));
  // The pages and the catalog share one tree, so a page never replaces a
  // file the catalog put there.
  for (const route of ["models.html", "variants.html", "404.html", ...modelNames().map((dir) => `models/${dir}/index.html`)]) {
    const file = path.join(out, route);
    if (fs.existsSync(file)) throw new Error(`site/${route}: the catalog has a file where a page goes`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, page);
  }
  console.log(summary);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

"use strict";
// What the catalog server serves, built from models/: the catalog itself
// (index.json and the version files it names, which swiss reads) and
// catalog.json, which the web app renders from. index.json does not yet carry
// all the app shows (images, served names, commit-pinned source links); once
// its schema does, catalog.json goes.
//
// server/index.js serves this live; the site build (web/vite.config.mts)
// writes it out as static files beside the pages.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDocument, LineCounter } = require("yaml");
const { root, modelsDir, readYaml, modelNames, versionFiles, compareVersions, latestOf, buildIndex, serializeIndex, buildIndexV2, checkIndexV2, historyPath, schemaOf, legacyTuning } = require("../hack/lib/catalog");
const { reportProblem } = require("../hack/lib/report");

// The GitHub repository the version files live in: the one being built in CI,
// else package.json's.
function sourceRepo() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const url = (pkg.repository && pkg.repository.url) || "";
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// Permalinks to a version file and to each of its variants, by id: the file as
// of the last commit that touched it, with the variant's lines highlighted.
// Lines come from that commit's copy, so local edits do not shift them. No
// links when the file is not committed (or there is no git).
function variantSources(repo, rel) {
  const sha = repo && (git("log", "-1", "--format=%H", "--", rel) || "").trim();
  const text = sha && git("show", `${sha}:${rel}`);
  if (!text) return { file: null, variants: {} };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const seq = doc.get("variants", true);
  const out = {};
  for (const item of (seq && seq.items) || []) {
    const id = item.get && item.get("id");
    if (!id || !item.range) continue;
    const [start, end] = item.range;
    const from = lc.linePos(start).line;
    const to = lc.linePos(Math.max(start, end - 1)).line;
    out[id] = `${repo}/blob/${sha}/${encodePath(rel)}#L${from}-L${to}`;
  }
  return { file: `${repo}/blob/${sha}/${encodePath(rel)}`, variants: out };
}

// Where each variant sits in its version file, by id: its first and last
// line, and the column its fields start at (past "  - "). The model page cuts
// a variant's configuration from the published file with these.
function variantLines(rel) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const seq = doc.get("variants", true);
  const out = {};
  for (const item of (seq && seq.items) || []) {
    const id = item.get && item.get("id");
    if (!id || !item.range) continue;
    const start = lc.linePos(item.range[0]);
    const end = lc.linePos(Math.max(item.range[0], item.range[1] - 1));
    out[id] = { from: start.line, to: end.line, indent: start.col - 1 };
  }
  return { servedName: doc.get("servedName") || null, variants: out };
}

function requiresSummary(req) {
  if (!req) return "";
  let gpus = req.gpus != null ? `${req.gpus} GPU` + (req.gpus === 1 ? "" : "s") : null;
  // requires.gpus is per pod; a multi-node group needs gpus x nodes in total.
  if (gpus && req.nodes > 1) gpus += ` × ${req.nodes} nodes`;
  const topo = req.topology && req.topology !== "single-node" ? req.topology : null;
  const product = Array.isArray(req.gpuProduct) ? req.gpuProduct.join(", ") : null;
  const vendor = req.vendor && req.vendor !== "nvidia" ? req.vendor : null;
  return [gpus, topo, product, vendor].filter(Boolean).join(" · ");
}

// Vendor names as swiss's console shows them.
const VENDOR_NAMES = { nvidia: "NVIDIA", ascend: "Ascend", cambricon: "Cambricon", hygon: "Hygon", amd: "AMD" };

function vendorName(vendor) {
  return VENDOR_NAMES[vendor] || vendor;
}

// Short labels for the hardware filter: NVIDIA-H100-80GB-HBM3 -> H100,
// NVIDIA-RTX-6000D -> RTX-6000D. NVIDIA cards go bare; another vendor's card
// reads "<Vendor> <model>" (Ascend-910B3 -> Ascend 910B3), or stays as is when
// it names the vendor elsewhere.
function hardwareLabels(req) {
  if (!req) return [];
  const vendor = req.vendor || "nvidia";
  const products = Array.isArray(req.gpuProduct) ? req.gpuProduct : [];
  if (products.length === 0) return [vendor === "nvidia" ? "any GPU" : vendorName(vendor)];
  return products.map((p) => {
    const m = String(p).match(/(?:^|-)([A-Z]{1,2}\d{2,4}[A-Z]?)(?=-|$)/i);
    const card = m ? m[1].toUpperCase() : String(p).replace(/^NVIDIA-/i, "");
    if (vendor === "nvidia") return card;
    const model = card.replace(new RegExp(`^${vendor}-`, "i"), "");
    if (model === card && card.toLowerCase().includes(vendor.toLowerCase())) return card;
    return `${vendorName(vendor)} ${model}`;
  });
}

// Compact hardware line for a variant: "8 × H100", "8 × GPU × 2 nodes".
function hardwareShort(req) {
  if (!req || req.gpus == null) return "";
  const hasProducts = Array.isArray(req.gpuProduct) && req.gpuProduct.length > 0;
  const vendor = req.vendor && req.vendor !== "nvidia" ? vendorName(req.vendor) : "GPU";
  let s = `${req.gpus} × ${hasProducts ? hardwareLabels(req).join(" / ") : vendor}`;
  if (req.nodes > 1) s += ` × ${req.nodes} nodes`;
  return s;
}

// A variant's role, by id, from the model's recorded tuning. swiss's web
// (web/src/lib/catalog.ts) reads the same field by the same rules.
function variantRole(id, tuning) {
  const isOptimized = tuning.some((t) => t.optimized === id);
  return { isOptimized, isBaseline: !isOptimized && tuning.some((t) => t.baseline === id) };
}

function formatUplift(pct) {
  return `${pct < 0 ? "" : "+"}${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

// variants[].link is only schema-checked as a URI, which admits javascript:.
function safeLink(link) {
  return typeof link === "string" && /^https?:\/\//i.test(link) ? link : null;
}

function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// Whether the site may link a report: any other is left out with a warning.
// validate:schema fails on the same ones.
function linkable(rel) {
  const problem = reportProblem(path.join(root, rel));
  if (problem) console.warn(`${rel}: ${problem} -- not linked`);
  return !problem;
}

// The catalog as the pages read it, from models/: every model, its versions
// newest first, and what the pages derive from them -- hardware labels,
// variant roles, the pair each version shows, source permalinks.
function loadCatalog() {
  const models = [];
  const repo = sourceRepo();
  for (const name of modelNames()) {
    const dir = path.join(modelsDir, name);
    const metaPath = path.join(dir, "metadata.yaml");
    if (!fs.existsSync(metaPath)) throw new Error(`${dir}: missing metadata.yaml`);
    const meta = readYaml(metaPath);
    const htmlFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".html"))
      .sort();
    const reports = htmlFiles
      .filter((f) => linkable(`models/${name}/${f}`))
      .map((f) => ({
        file: f,
        path: `models/${name}/${f}`,
        title: f.replace(/\.html$/i, ""),
      }));
    // A tuning entry whose report is skipped keeps its numbers; only the link goes.
    const linked = new Set(reports.map((r) => r.file));
    const tuning = ((schemaOf(meta) === "v2" ? legacyTuning(meta.tuning) : meta.tuning) ?? []).map((t) => {
      if (!t || !t.report || linked.has(t.report)) return t;
      if (!htmlFiles.includes(t.report)) linkable(`models/${name}/${t.report}`);
      return { ...t, report: undefined };
    });

    const versions = [];
    for (const rel of versionFiles(name)) {
      const doc = readYaml(path.join(root, rel));
      const raw = doc.variants || [];
      const sources = variantSources(repo, rel);
      const lines = variantLines(rel);
      // Schema: the first variant is the default when none is marked.
      const defaultIdx = Math.max(0, raw.findIndex((v) => v.default));
      const variants = raw.map((v, i) => {
        const { isBaseline, isOptimized } = variantRole(v.id, tuning);
        return {
          id: v.id,
          engine: v.engine,
          default: i === defaultIdx,
          description: v.description || null,
          link: safeLink(v.link),
          source: sources.variants[v.id] || null,
          chart: v.chart || null,
          image: v.image || null,
          lines: lines.variants[v.id] || null,
          requires: v.requires || null,
          requiresSummary: requiresSummary(v.requires),
          hardware: hardwareLabels(v.requires),
          hardwareShort: hardwareShort(v.requires),
          isBaseline,
          isOptimized,
        };
      });
      versions.push({
        version: doc.version,
        path: rel,
        source: sources.file,
        servedName: doc.servedName || null,
        variants,
      });
    }
    versions.sort((a, b) => compareVersions(a.version, b.version));
    if (versions.length === 0) throw new Error(`${dir}: no version files`);
    const newest = latestOf(versions.map((v) => v.version));
    const latest = versions.find((v) => v.version === newest);
    const comparison = comparisonFor(name, tuning, latest);

    models.push({
      name: meta.name || name,
      dir: name,
      displayName: meta.displayName || meta.name || name,
      description: meta.description || null,
      family: meta.family || null,
      tags: meta.tags || [],
      deprecated: !!meta.deprecated,
      // deprecated may be `true` or a string giving the reason.
      deprecatedReason: typeof meta.deprecated === "string" ? meta.deprecated : null,
      source: meta.source || null,
      latest: latest.version,
      versions: versions
        .slice()
        .reverse()
        .map((v) => ({ ...v, variantCount: v.variants.length })),
      reports,
      comparison,
      // Every recorded pair, for the model page: tuning binds to the
      // optimized variant, and each names its own baseline.
      tuning: tuning.map((t) => tuningEntry(name, t)),
    });
  }
  return {
    apiVersion: "catalog.swiss/v1",
    generatedBy: "npm run build:site",
    count: models.length,
    models,
  };
}

function tuningEntry(name, t) {
  const pct = typeof t.uplift === "number" ? t.uplift : null;
  return {
    version: String(t.version),
    baselineId: t.baseline,
    optimizedId: t.optimized,
    upliftPct: pct,
    upliftLabel: pct == null ? null : formatUplift(pct),
    report: t.report ? `models/${name}/${t.report}` : null,
    reportFile: t.report || null,
    workloads: Array.isArray(t.workloads)
      ? t.workloads.map((w) => ({ name: String(w.name), upliftPct: w.uplift, upliftLabel: formatUplift(w.uplift) }))
      : [],
  };
}

// The pair shown for a version. A recorded pair must name variants that
// version has; among those, one measured on it wins, then one whose tuned
// variant is the default. The number may have been measured on an earlier
// version whose variants were carried forward, so the version travels with it.
function comparisonFor(name, tuning, version) {
  const ids = new Set(version.variants.map((v) => v.id));
  const fits = tuning.filter((t) => ids.has(t.baseline) && ids.has(t.optimized));
  const def = version.variants.find((v) => v.default);
  const t =
    fits.find((x) => String(x.version) === String(version.version)) ||
    fits.find((x) => def && x.optimized === def.id) ||
    fits[0];
  if (!t) return null;
  const e = tuningEntry(name, t);
  // The model's one number -- badge, table, sort and summary: its best
  // workload, or the headline when the benchmark recorded none.
  const best = e.workloads.reduce((b, w) => (b && b.upliftPct >= w.upliftPct ? b : w), null);
  const bestPct = best ? best.upliftPct : e.upliftPct;
  return {
    ...e,
    bestPct,
    bestLabel: bestPct == null ? null : formatUplift(bestPct),
    bestWorkload: best ? best.name : null,
  };
}

// Perf reports, at the paths catalog.json names.
function copyReports(catalog, outDir) {
  for (const m of catalog.models) {
    for (const r of m.reports) {
      const dest = path.join(outDir, r.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(root, r.path), dest);
    }
  }
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
  return { models: index.count, files, histories: histories.size };
}

// Everything beside the pages, as a build writes it into outDir: catalog.json,
// the perf reports, and the catalog (index.json and its version files), from
// checkedIndex. Returns a line saying what it wrote.
function writeSiteData(outDir, { index, rewrites }) {
  const catalog = loadCatalog();
  fs.writeFileSync(path.join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  copyReports(catalog, outDir);
  const published = publishCatalog(index, outDir);
  const v2 = publishV2(outDir);
  // GitHub Pages serves the tree as it is.
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  const variants = catalog.models.reduce((n, m) => n + m.versions.find((v) => v.version === m.latest).variants.length, 0);
  return (
    `site/: ${catalog.count} models, ${variants} variants, ` +
    `${catalog.models.filter((m) => m.comparison).length} optimized-vs-baseline, ` +
    `${catalog.models.reduce((n, m) => n + m.reports.length, 0)} perf HTML; ` +
    `catalog: ${published.models} models, ${published.files} version files` +
    (rewrites ? `, ${rewrites} rewritten in place (REWRITES=allow)` : "") +
    `; index-v2: ${v2.models} models, ${v2.files} variant files, ${v2.histories} histories`
  );
}

module.exports = { loadCatalog, checkedIndex, checkedIndexV2, rewritesOf, writeSiteData, buildIndex, serializeIndex };

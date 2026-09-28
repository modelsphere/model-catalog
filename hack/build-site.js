#!/usr/bin/env node
/**
 * Build a static GitHub Pages site from models/ (not from committed index.json).
 *
 * Output: site/
 *   index.html
 *   catalog.json          — derived catalog for the page
 *   assets/site.css
 *   models/<name>/*.html  — perf reports copied from the repo
 *
 * Optimized-vs-baseline is inferred from variant ids / descriptions; uplift
 * percentages are parsed from the optimized variant's description when present.
 * Perf HTML is discovered as models/<name>/*.html (and variants[].link when set).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const root = path.resolve(__dirname, "..");
const modelsDir = path.join(root, "models");
const outDir = path.join(root, "site");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readYaml(p) {
  return yaml.parse(fs.readFileSync(p, "utf8"));
}

function semverKey(v) {
  const [core, pre] = String(v).split("-");
  const nums = core.split(".").map((x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { nums, pre: pre || "" };
}

function cmpVersion(a, b) {
  const A = semverKey(a);
  const B = semverKey(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  }
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return A.pre.localeCompare(B.pre);
}

function requiresSummary(req) {
  if (!req) return "";
  const gpus = req.gpus != null ? `${req.gpus} GPU` + (req.gpus === 1 ? "" : "s") : null;
  const nodes = req.nodes && req.nodes > 1 ? `${req.nodes} nodes` : null;
  const topo = req.topology && req.topology !== "single-node" ? req.topology : null;
  const product = Array.isArray(req.gpuProduct) ? req.gpuProduct.join(", ") : null;
  const vendor = req.vendor && req.vendor !== "nvidia" ? req.vendor : null;
  return [gpus, nodes, topo, product, vendor].filter(Boolean).join(" · ");
}

function classifyVariant(v) {
  const id = (v.id || "").toLowerCase();
  const desc = (v.description || "").toLowerCase();
  const isBaseline =
    id.includes("baseline") ||
    /\bbaseline\b/.test(desc);
  const isOptimized =
    id.includes("optimized") ||
    id.includes("optimised") ||
    /\b(optimized|optimised|tuned by)\b/.test(desc);
  return { isBaseline, isOptimized };
}

function parseUplift(description) {
  if (!description) return null;
  // "+121% on the tuning benchmark vs the baseline"
  // "+44% on the tuning benchmark"
  // "+44.2%"
  const m = description.match(/\+(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  return { pct: Number(m[1]), raw: `+${m[1]}%` };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadCatalog() {
  const models = [];
  for (const name of fs.readdirSync(modelsDir).sort()) {
    const dir = path.join(modelsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const metaPath = path.join(dir, "metadata.yaml");
    if (!fs.existsSync(metaPath)) {
      console.error(`${dir}: missing metadata.yaml`);
      process.exit(1);
    }
    const meta = readYaml(metaPath);
    const reports = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map((f) => ({
        file: f,
        path: `models/${name}/${f}`,
        title: f.replace(/\.html$/i, ""),
      }));

    const versions = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") || f === "metadata.yaml") continue;
      const doc = readYaml(path.join(dir, f));
      const variants = (doc.variants || []).map((v) => {
        const { isBaseline, isOptimized } = classifyVariant(v);
        return {
          id: v.id,
          engine: v.engine,
          default: !!v.default,
          description: v.description || null,
          link: v.link || null,
          requires: v.requires || null,
          requiresSummary: requiresSummary(v.requires),
          isBaseline,
          isOptimized,
          uplift: isOptimized ? parseUplift(v.description) : null,
        };
      });
      versions.push({
        version: doc.version,
        path: `models/${name}/${f}`,
        servedName: doc.servedName || null,
        variants,
      });
    }
    versions.sort((a, b) => cmpVersion(a.version, b.version));
    if (versions.length === 0) {
      console.error(`${dir}: no version files`);
      process.exit(1);
    }
    const latest = versions[versions.length - 1];
    const comparison = summarizeComparison(latest.variants);

    models.push({
      name: meta.name || name,
      displayName: meta.displayName || meta.name || name,
      description: meta.description || null,
      family: meta.family || null,
      tags: meta.tags || [],
      deprecated: !!meta.deprecated,
      source: meta.source || null,
      latest: latest.version,
      versions: versions
        .slice()
        .reverse()
        .map((v) => ({
          version: v.version,
          path: v.path,
          variantCount: v.variants.length,
          variants: v.variants.map((x) => ({
            id: x.id,
            engine: x.engine,
            default: x.default,
            description: x.description,
            link: x.link,
            requiresSummary: x.requiresSummary,
            isBaseline: x.isBaseline,
            isOptimized: x.isOptimized,
            uplift: x.uplift,
          })),
        })),
      reports,
      comparison,
    });
  }
  return {
    apiVersion: "catalog.swiss/v1",
    generatedBy: "hack/build-site.js",
    count: models.length,
    models,
  };
}

function summarizeComparison(variants) {
  const baselines = variants.filter((v) => v.isBaseline);
  const optimizeds = variants.filter((v) => v.isOptimized);
  if (baselines.length === 0 || optimizeds.length === 0) {
    return null;
  }
  const base = baselines[0];
  // Prefer the default optimized, else first optimized.
  const opt =
    optimizeds.find((v) => v.default) || optimizeds[0];
  const uplift = opt.uplift;
  return {
    baselineId: base.id,
    optimizedId: opt.id,
    baselineRequires: base.requiresSummary,
    optimizedRequires: opt.requiresSummary,
    upliftPct: uplift ? uplift.pct : null,
    upliftLabel: uplift ? uplift.raw : null,
    summary: uplift
      ? `Optimized ${uplift.raw} vs baseline`
      : "Optimized variant present (no % in description)",
    baselineDescription: base.description,
    optimizedDescription: opt.description,
  };
}

function renderIndex(catalog) {
  const rows = catalog.models
    .map((m) => {
      const latest = m.versions[0];
      const variantBits = latest.variants
        .map((v) => {
          const flags = [];
          if (v.default) flags.push("default");
          if (v.isBaseline) flags.push("baseline");
          if (v.isOptimized) flags.push("optimized");
          const flagHtml = flags.length
            ? ` <span class="tags">${flags
                .map((f) => `<span class="tag tag-${f}">${f}</span>`)
                .join("")}</span>`
            : "";
          const req = v.requiresSummary
            ? `<div class="muted">${escapeHtml(v.requiresSummary)}</div>`
            : "";
          return `<div class="variant"><code>${escapeHtml(v.id)}</code>${flagHtml}${req}</div>`;
        })
        .join("");

      let cmpHtml = `<span class="muted">—</span>`;
      if (m.comparison) {
        const c = m.comparison;
        const uplift = c.upliftLabel
          ? `<div class="uplift">${escapeHtml(c.upliftLabel)}</div>`
          : "";
        cmpHtml = `<div class="cmp">
          ${uplift}
          <div class="cmp-line"><span class="label">baseline</span> <code>${escapeHtml(
            c.baselineId
          )}</code></div>
          <div class="muted">${escapeHtml(c.baselineRequires || "")}</div>
          <div class="cmp-line"><span class="label">optimized</span> <code>${escapeHtml(
            c.optimizedId
          )}</code></div>
          <div class="muted">${escapeHtml(c.optimizedRequires || "")}</div>
        </div>`;
      }

      let reportHtml = `<span class="muted">—</span>`;
      const links = [];
      for (const r of m.reports) {
        links.push(
          `<a href="${escapeHtml(r.path)}">${escapeHtml(r.file)}</a>`
        );
      }
      // Also surface absolute/relative variant links that look like reports.
      for (const v of latest.variants) {
        if (!v.link) continue;
        const label = v.id + " link";
        links.push(
          `<a href="${escapeHtml(v.link)}" rel="noopener">${escapeHtml(
            label
          )}</a>`
        );
      }
      if (links.length) {
        reportHtml = `<div class="reports">${links
          .map((a) => `<div>${a}</div>`)
          .join("")}</div>`;
      }

      const family = m.family
        ? escapeHtml(m.family)
        : `<span class="muted">—</span>`;
      const deprecated = m.deprecated
        ? ` <span class="tag tag-deprecated">deprecated</span>`
        : "";

      return `<tr>
        <td>
          <div class="model-name">${escapeHtml(m.displayName)}${deprecated}</div>
          <div class="muted"><code>${escapeHtml(m.name)}</code> · v${escapeHtml(
        m.latest
      )}</div>
          ${
            m.description
              ? `<div class="desc">${escapeHtml(m.description)}</div>`
              : ""
          }
        </td>
        <td>${family}</td>
        <td class="variants">${variantBits || `<span class="muted">—</span>`}</td>
        <td>${cmpHtml}</td>
        <td>${reportHtml}</td>
      </tr>`;
    })
    .join("\n");

  const withCmp = catalog.models.filter((m) => m.comparison).length;
  const withReports = catalog.models.filter((m) => m.reports.length > 0).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model Catalog</title>
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<header class="wrap">
  <p class="eyebrow">modelsphere / model-catalog</p>
  <h1>Model catalog</h1>
  <p class="lede">
    How each model should be served — variants, hardware, and where an optimized
    build beats the baseline. Perf reports are the AutoTune HTML already checked
    into <code>models/</code>.
  </p>
  <p class="stats">
    <span><strong>${catalog.count}</strong> models</span>
    <span><strong>${withCmp}</strong> with optimized vs baseline</span>
    <span><strong>${withReports}</strong> with perf reports</span>
  </p>
</header>
<main class="wrap">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Family</th>
          <th>Variants (latest)</th>
          <th>Optimized vs baseline</th>
          <th>Perf report</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <section class="notes">
    <h2>Notes</h2>
    <ul>
      <li>This page is built from <code>models/*/metadata.yaml</code> and version YAMLs — not from committed <code>index.json</code>.</li>
      <li>Optimized vs baseline is detected from variant ids/descriptions containing <code>baseline</code> / <code>optimized</code> (or “Tuned by…”); the uplift % is parsed from the optimized description when present.</li>
      <li>Perf reports: every <code>models/&lt;name&gt;/*.html</code> is copied into the site and linked here. <code>variants[].link</code> is also shown when set.</li>
    </ul>
  </section>
</main>
<footer class="wrap">
  <p class="muted">Generated by <code>hack/build-site.js</code>. Machine API remains <code>index.json</code> on the default branch.</p>
</footer>
</body>
</html>
`;
}

const CSS = `:root {
  --bg: #0f1419;
  --panel: #171d25;
  --text: #e7ecf3;
  --muted: #9aa7b8;
  --line: #2a3442;
  --accent: #6ee7b7;
  --accent-dim: #34d399;
  --warn: #fbbf24;
  --baseline: #93c5fd;
  --optimized: #6ee7b7;
  --deprecated: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  line-height: 1.45;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 1.5rem 1.25rem; }
header.wrap { padding-top: 2.5rem; padding-bottom: 0.5rem; }
.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.75rem;
  color: var(--muted);
  margin: 0 0 0.5rem;
}
h1 { font-size: 2rem; font-weight: 650; margin: 0 0 0.75rem; letter-spacing: -0.02em; }
.lede { color: var(--muted); max-width: 62ch; margin: 0 0 1.25rem; }
.stats { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; color: var(--muted); font-size: 0.95rem; margin: 0 0 0.5rem; }
.stats strong { color: var(--accent); font-weight: 650; }
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}
table { width: 100%; border-collapse: collapse; min-width: 860px; }
th, td {
  text-align: left;
  vertical-align: top;
  padding: 0.9rem 1rem;
  border-bottom: 1px solid var(--line);
}
th {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
  background: rgba(255,255,255,0.02);
}
tr:last-child td { border-bottom: none; }
.model-name { font-weight: 600; margin-bottom: 0.2rem; }
.desc { color: var(--muted); font-size: 0.9rem; margin-top: 0.45rem; max-width: 36ch; }
.muted { color: var(--muted); font-size: 0.85rem; }
code {
  font-family: var(--mono);
  font-size: 0.82em;
  background: rgba(255,255,255,0.05);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.variant { margin-bottom: 0.65rem; }
.variant:last-child { margin-bottom: 0; }
.tags { margin-left: 0.35rem; }
.tag {
  display: inline-block;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.12rem 0.4rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  margin-right: 0.25rem;
}
.tag-default { color: var(--warn); border-color: rgba(251,191,36,0.35); }
.tag-baseline { color: var(--baseline); border-color: rgba(147,197,253,0.35); }
.tag-optimized { color: var(--optimized); border-color: rgba(110,231,183,0.35); }
.tag-deprecated { color: var(--deprecated); border-color: rgba(248,113,113,0.4); }
.uplift {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--accent-dim);
  margin-bottom: 0.4rem;
}
.cmp-line { margin-top: 0.35rem; }
.cmp-line .label {
  display: inline-block;
  min-width: 5.2rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.reports a { color: var(--accent); text-decoration: none; }
.reports a:hover { text-decoration: underline; }
.notes { margin-top: 2rem; color: var(--muted); }
.notes h2 { color: var(--text); font-size: 1.1rem; margin-bottom: 0.5rem; }
.notes ul { padding-left: 1.2rem; }
.notes li { margin-bottom: 0.4rem; }
footer { padding-bottom: 3rem; }
`;

function copyReports(catalog) {
  for (const m of catalog.models) {
    for (const r of m.reports) {
      const src = path.join(root, r.path);
      const dest = path.join(outDir, r.path);
      mkdirp(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }
}

function main() {
  const catalog = loadCatalog();
  rmrf(outDir);
  mkdirp(path.join(outDir, "assets"));
  fs.writeFileSync(path.join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "assets/site.css"), CSS);
  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex(catalog));
  // Helpful for project Pages paths / local preview.
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  copyReports(catalog);
  console.log(
    `site/: ${catalog.count} models, ` +
      `${catalog.models.filter((m) => m.comparison).length} optimized-vs-baseline, ` +
      `${catalog.models.reduce((n, m) => n + m.reports.length, 0)} perf HTML`
  );
}

main();

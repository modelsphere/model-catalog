#!/usr/bin/env node
/**
 * Build the GitHub Pages site: the page and the catalog swiss reads, both from
 * models/, so the site's URL is a catalog location.
 *
 * Output: site/
 *   index.html
 *   catalog.json          — derived catalog for the page
 *   assets/site.css
 *   models/<name>/*.html  — perf reports copied from the repo
 *   index.json            — the index, built from models/
 *   models/<name>/*.yaml  — every version file it names
 *
 * Optimized-vs-baseline pairs and their uplift come from `tuning` in each
 * model's metadata.yaml. Perf HTML is discovered as models/<name>/*.html (and
 * variants[].link when set).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDocument, LineCounter } = require("yaml");
const {
  root,
  modelsDir,
  readYaml,
  modelNames,
  versionFiles,
  compareVersions,
  latestOf,
  buildIndex,
  serializeIndex,
} = require("./lib/catalog");
const { reportProblem } = require("./lib/report");

const outDir = path.join(root, "site");

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

// A version file as the model page shows it: servedName, and per variant id
// its parsed fields and its own lines of the file, dedented.
function versionDetail(rel) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const lines = text.split("\n");
  const seq = doc.get("variants", true);
  const variants = {};
  for (const item of (seq && seq.items) || []) {
    const id = item.get && item.get("id");
    if (!id || !item.range) continue;
    const start = lc.linePos(item.range[0]);
    const end = lc.linePos(Math.max(item.range[0], item.range[1] - 1));
    const indent = start.col - 1; // past "  - "
    const own = lines.slice(start.line - 1, end.line);
    own[0] = " ".repeat(indent) + own[0].slice(indent);
    variants[id] = {
      raw: item.toJSON(),
      yaml: own.map((l) => l.slice(indent)).join("\n").replace(/\s+$/, ""),
    };
  }
  return { servedName: doc.get("servedName") || null, variants };
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
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

// NVIDIA's cards first, then other vendors', then "any GPU". Every other
// vendor's label carries its name, so the label alone says whose card it is.
function gpuGroup(label) {
  if (label === "any GPU") return 2;
  const l = label.toLowerCase();
  return Object.keys(VENDOR_NAMES).some((v) => v !== "nvidia" && l.includes(v)) ? 1 : 0;
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

// hardwareShort as HTML, each GPU name highlighted: "8 × <H100>". Labels are
// only GPU names when the variant names products; "any GPU" stays plain.
function hardwareHtml(v) {
  let html = escapeHtml(v.hardwareShort);
  for (const label of v.hardware || []) {
    if (label === "any GPU") continue;
    const e = escapeHtml(label);
    html = html.replace(e, `<span class="gpu hue-${gpuHue(label)}">${e}</span>`);
  }
  return html;
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Whether the site may link a report: any other is left out with a warning.
// validate:schema fails on the same ones.
function linkable(rel) {
  const problem = reportProblem(path.join(root, rel));
  if (problem) console.warn(`${rel}: ${problem} -- not linked`);
  return !problem;
}

function loadCatalog() {
  const models = [];
  const repo = sourceRepo();
  for (const name of modelNames()) {
    const dir = path.join(modelsDir, name);
    const metaPath = path.join(dir, "metadata.yaml");
    if (!fs.existsSync(metaPath)) {
      console.error(`${dir}: missing metadata.yaml`);
      process.exit(1);
    }
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
    const tuning = (Array.isArray(meta.tuning) ? meta.tuning : []).map((t) => {
      if (!t || !t.report || linked.has(t.report)) return t;
      if (!htmlFiles.includes(t.report)) linkable(`models/${name}/${t.report}`);
      return { ...t, report: undefined };
    });

    const versions = [];
    for (const rel of versionFiles(name)) {
      const doc = readYaml(path.join(root, rel));
      const raw = doc.variants || [];
      const sources = variantSources(repo, rel);
      const detail = versionDetail(rel);
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
          yaml: detail.variants[v.id] ? detail.variants[v.id].yaml : null,
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
    if (versions.length === 0) {
      console.error(`${dir}: no version files`);
      process.exit(1);
    }
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
        .map((v) => ({
          version: v.version,
          path: v.path,
          source: v.source,
          servedName: v.servedName,
          variantCount: v.variants.length,
          variants: v.variants.map((x) => ({
            id: x.id,
            engine: x.engine,
            default: x.default,
            description: x.description,
            link: x.link,
            source: x.source,
            chart: x.chart,
            image: x.image,
            yaml: x.yaml,
            requiresSummary: x.requiresSummary,
            hardware: x.hardware,
            hardwareShort: x.hardwareShort,
            isBaseline: x.isBaseline,
            isOptimized: x.isOptimized,
          })),
        })),
      reports,
      comparison,
      // Every recorded pair, for the model page: tuning binds to the
      // optimized variant, and each names its own baseline.
      tuning: tuning.map((t) => tuningEntry(name, t)),
    });
  }
  return {
    apiVersion: "catalog.swiss/v1",
    generatedBy: "hack/build-site.js",
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

// What an uplift number means, for tooltips. Workload names are the report's:
// input + output tokens per request.
const UPLIFT_HELP =
  "Throughput of the tuned variant over its baseline, from the tuning benchmark. " +
  "Workloads are input + output tokens per request, e.g. 50k + 1.5k.";

// Per-model facts the page filters, sorts and summarizes on. Embedded in the
// page as JSON so filtering works from file:// too, without fetching catalog.json.
function facetsOf(m) {
  const latest = m.versions[0];
  const text = [
    m.name,
    m.displayName,
    m.description,
    m.family,
    m.source && m.source.hf,
    ...m.tags,
    ...latest.variants.flatMap((v) => [v.id, v.engine, v.description, ...v.hardware]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    name: m.name,
    family: m.family,
    tags: m.tags,
    // One entry per variant, so the summary can count variants per engine.
    engines: latest.variants.map((v) => v.engine),
    hardware: [...new Set(latest.variants.flatMap((v) => v.hardware))].sort(),
    hasCmp: !!m.comparison,
    uplift: m.comparison ? m.comparison.bestPct : null,
    deprecated: m.deprecated,
    text,
  };
}

// byUplift, computeSummary, renderSummary and escapeHtml run at build time for
// the static page and again in the browser (serialized into site.js) for the
// filtered view, so they must stay self-contained.

// The default order: best improvement first, models without one last.
function byUplift(a, b) {
  return (
    (b.uplift == null ? -Infinity : b.uplift) - (a.uplift == null ? -Infinity : a.uplift) ||
    a.name.localeCompare(b.name)
  );
}

function computeSummary(models) {
  const engines = {};
  const uplifts = [];
  let variants = 0;
  let pairs = 0;
  let deprecated = 0;
  for (const m of models) {
    variants += m.engines.length;
    if (m.deprecated) deprecated++;
    if (m.hasCmp) pairs++;
    if (m.uplift != null) uplifts.push({ name: m.name, pct: m.uplift });
    for (const e of m.engines) engines[e] = (engines[e] || 0) + 1;
  }
  uplifts.sort((a, b) => a.pct - b.pct);
  const n = uplifts.length;
  const median =
    n === 0
      ? null
      : n % 2
        ? uplifts[(n - 1) / 2].pct
        : (uplifts[n / 2 - 1].pct + uplifts[n / 2].pct) / 2;
  return {
    models: models.length,
    deprecated,
    variants,
    engines,
    pairs,
    median,
    worst: n ? uplifts[0] : null,
    best: n ? uplifts[n - 1] : null,
  };
}

function renderSummary(s) {
  const pct = (x) => "+" + (Math.round(x * 10) / 10).toFixed(1) + "%";
  const counts = (o) =>
    Object.keys(o)
      .sort((a, b) => o[b] - o[a] || a.localeCompare(b))
      .map((k) => `${escapeHtml(k)} ${o[k]}`)
      .join(" · ");
  const stat = (label, value, sub, cls) =>
    `<div class="stat"><div class="stat-label">${label}</div>` +
    `<div class="stat-value${cls ? " " + cls : ""}">${value}</div>` +
    `<div class="stat-sub">${sub || ""}</div></div>`;
  return [
    stat("Models", s.models, s.deprecated ? `${s.deprecated} deprecated` : ""),
    stat("Variants", s.variants, counts(s.engines)),
    stat(
      "Optimized pairs",
      s.pairs,
      s.models ? `${Math.round((s.pairs / s.models) * 100)}% of models` : ""
    ),
    stat(
      "Median improvement",
      s.median == null ? "—" : pct(s.median),
      s.median == null ? "" : `${pct(s.worst.pct)} to ${pct(s.best.pct)}`,
      s.median == null ? "" : "pos"
    ),
    stat(
      "Best improvement",
      s.best ? pct(s.best.pct) : "—",
      s.best ? escapeHtml(s.best.name) : "",
      s.best ? "pos" : ""
    ),
  ].join("");
}

// Browser entry point for filtering. Serialized into assets/site.js, so it may
// only use the shared functions above and DOM APIs.
function clientMain() {
  const root = document.documentElement;
  const data = JSON.parse(document.getElementById("catalog-data").textContent);
  const form = document.getElementById("filters");
  const results = document.getElementById("results");
  const empty = document.getElementById("empty");
  const count = document.getElementById("result-count");
  const summary = document.getElementById("summary");
  const fields = ["q", "family", "engine", "hardware", "tag", "hidedep", "sort", "view"];
  const defaults = { sort: "uplift", view: "table" };

  // The card list and the table carry one node per model, keyed by data-i.
  const views = ["models", "table-rows"].map((id) => {
    const el = document.getElementById(id);
    const nodes = [];
    for (const n of el.querySelectorAll(":scope > [data-i]")) nodes[Number(n.dataset.i)] = n;
    return { el, nodes };
  });

  const byName = (a, b) => a.name.localeCompare(b.name);
  const sorters = {
    name: byName,
    uplift: byUplift,
    // Models without a family sort last.
    family: (a, b) =>
      !a.family - !b.family || (a.family || "").localeCompare(b.family || "") || byName(a, b),
  };
  const sortDir = { name: "ascending", family: "ascending", uplift: "descending" };

  // A lone radio is an element, not a RadioNodeList, and its value is its
  // value attribute whether checked or not.
  function getField(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "radio") return el.checked ? el.value : "";
    return el.value;
  }

  function setField(el, v) {
    if (el.type === "checkbox") el.checked = v === "1";
    else if (el.type === "radio") el.checked = el.value === v;
    else if (v != null && (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === v))) el.value = v;
  }

  function readState() {
    const st = {};
    for (const k of fields) {
      const el = form.elements[k];
      if (el) st[k] = getField(el);
    }
    return st;
  }

  function writeState(params) {
    for (const k of fields) {
      const el = form.elements[k];
      if (el) setField(el, params.get(k));
    }
  }

  function matches(m, st) {
    const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => m.text.includes(t))) return false;
    if (st.family && m.family !== st.family) return false;
    if (st.engine && !m.engines.includes(st.engine)) return false;
    if (st.hardware && !m.hardware.includes(st.hardware)) return false;
    if (st.tag && !m.tags.includes(st.tag)) return false;
    if (st.hidedep && m.deprecated) return false;
    return true;
  }

  let hardware = "";

  function apply() {
    const st = readState();
    hardware = st.hardware;
    const sorter = sorters[st.sort] || sorters[defaults.sort];
    const order = data.map((_, i) => i).sort((a, b) => sorter(data[a], data[b]));
    const visible = data.map((m) => matches(m, st));
    for (const { el, nodes } of views) {
      for (const i of order) {
        nodes[i].hidden = !visible[i];
        el.appendChild(nodes[i]);
      }
    }
    const shown = order.filter((i) => visible[i]).map((i) => data[i]);

    root.dataset.view = st.view === "cards" ? "cards" : "table";
    for (const th of document.querySelectorAll("th[data-sort-col]")) {
      if (th.dataset.sortCol === st.sort) th.setAttribute("aria-sort", sortDir[st.sort]);
      else th.removeAttribute("aria-sort");
    }
    empty.hidden = shown.length > 0;
    count.textContent =
      shown.length === data.length
        ? `${data.length} models`
        : `${shown.length} of ${data.length} models`;
    summary.innerHTML = renderSummary(computeSummary(shown));

    const params = new URLSearchParams();
    for (const k of fields) {
      const v = st[k];
      if (v === true) params.set(k, "1");
      else if (v && v !== defaults[k]) params.set(k, v);
    }
    const qs = params.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  // The <head> boot script already picked the view from the URL or storage.
  form.elements.view.value = root.dataset.view === "cards" ? "cards" : "table";
  writeState(new URLSearchParams(location.search));
  form.hidden = false;
  form.addEventListener("input", apply);
  form.addEventListener("change", (e) => {
    if (e.target.name === "view") {
      try {
        localStorage.setItem("view", e.target.value);
      } catch (err) {
        // Storage unavailable: the view still applies for this visit.
      }
    }
    apply();
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  // A GPU toggle is a radio: clicking the selected one clears the filter.
  // Clicking an already-checked radio fires click but no change.
  form.addEventListener("click", (e) => {
    const r = e.target;
    if (r.name === "hardware" && r.type === "radio" && r.value === hardware) {
      r.checked = false;
      apply();
    }
  });
  // Reset clears the filters but keeps the view. The reset event fires before
  // the controls are reset.
  form.addEventListener("reset", () => {
    const view = form.elements.view.value;
    setTimeout(() => {
      form.elements.view.value = view;
      apply();
    });
  });

  results.addEventListener("click", (e) => {
    // Tag and family chips set the matching filter.
    const chip = e.target.closest("[data-filter]");
    if (chip) {
      setField(form.elements[chip.dataset.filter], chip.dataset.value);
      apply();
      form.scrollIntoView({ block: "nearest" });
      return;
    }
    // Table headers set the sort.
    const sort = e.target.closest("[data-sort]");
    if (sort) {
      form.elements.sort.value = sort.dataset.sort;
      apply();
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = document.activeElement;
    if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) {
      e.preventDefault();
      form.elements.q.focus();
    } else if (e.key === "Escape" && t === form.elements.q && t.value) {
      t.value = "";
      apply();
    }
  });

  apply();
}

// Theme button: cycles system -> light -> dark. The choice is stored per
// browser; the boot script in <head> applies it before first paint.
// Browser entry point for a model page: a GPU tag shows only the variants
// that run on it. Serialized into assets/model.js, so it must stay
// self-contained.
function modelMain() {
  const form = document.getElementById("gpu-select");
  const count = document.getElementById("variant-count");
  if (!form || !count) return;
  const radios = [...form.querySelectorAll('input[name="hardware"]')];
  const variants = [...document.querySelectorAll("article.vd[data-gpus]")];
  const total = variants.length;
  const noun = total === 1 ? "variant" : "variants";
  let selected = "";

  function apply() {
    const r = radios.find((x) => x.checked);
    selected = r ? r.value : "";
    let shown = 0;
    for (const a of variants) {
      a.hidden = selected !== "" && !a.dataset.gpus.split("|").includes(selected);
      if (!a.hidden) shown++;
    }
    count.textContent = selected ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
    const qs = selected ? `?hardware=${encodeURIComponent(selected)}` : "";
    history.replaceState(null, "", location.pathname + qs + location.hash);
  }

  const want = new URLSearchParams(location.search).get("hardware");
  for (const r of radios) r.checked = r.value === want;
  form.addEventListener("change", apply);
  form.addEventListener("submit", (e) => e.preventDefault());
  // Clicking the selected GPU clears it; an already-checked radio fires click
  // but no change.
  form.addEventListener("click", (e) => {
    if (e.target.name === "hardware" && e.target.value === selected) {
      e.target.checked = false;
      apply();
    }
  });
  if (want) apply();
}

function themeMain() {
  const btn = document.getElementById("theme-toggle");
  const root = document.documentElement;
  const modes = ["system", "light", "dark"];
  const current = () => root.dataset.theme || "system";
  function show() {
    const m = current();
    for (const icon of btn.querySelectorAll("[data-icon]")) icon.hidden = icon.dataset.icon !== m;
    btn.querySelector(".theme-label").textContent = m[0].toUpperCase() + m.slice(1);
    btn.title = `Theme: ${m} (click to change)`;
  }
  btn.addEventListener("click", () => {
    const next = modes[(modes.indexOf(current()) + 1) % modes.length];
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch (e) {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
    show();
  });
  btn.hidden = false;
  show();
}

// Applies the stored theme and the chosen view (URL first, then storage)
// before first paint. Without JS neither is set: system theme, table view.
const BOOT_SCRIPT =
  "<script>try{var d=document.documentElement,t=localStorage.getItem(\"theme\");" +
  "if(t===\"light\"||t===\"dark\")d.dataset.theme=t;" +
  "var v=new URLSearchParams(location.search).get(\"view\")||localStorage.getItem(\"view\");" +
  "if(v===\"cards\")d.dataset.view=v}catch(e){}</script>";

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  system: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  light: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
  ),
  dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  external: svg(
    '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
  ),
  report: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  cards: svg('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.5h18M3 14.5h18M9 9.5V20"/>'),
};

// Where to go to deploy, under each page's title: modelsphere is the complete
// deployment solution.
function deployRef(subject) {
  return (
    `<p class="deploy-ref">Deploying ${subject}? Start with ` +
    `<a href="https://github.com/modelsphere/modelsphere" target="_blank" rel="noopener"><code>modelsphere/modelsphere</code>${ICONS.external}</a>, ` +
    `the complete deployment solution.</p>`
  );
}

function themeButton() {
  return `<button type="button" id="theme-toggle" class="theme-toggle" hidden>
      <span data-icon="system">${ICONS.system}</span><span data-icon="light" hidden>${
        ICONS.light
      }</span><span data-icon="dark" hidden>${ICONS.dark}</span>
      <span class="theme-label">System</span>
    </button>`;
}

// Whether the id adds nothing to the display name: the name lowercased, with
// spaces and slashes as dashes (DeepSeek-V4-Flash -> deepseek-v4-flash). The
// lists then show the id only as a tooltip.
function idIsDisplayName(m) {
  const slug = m.displayName
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === m.name;
}

// Each model's page, relative to the catalog page.
function modelHref(m) {
  return `models/${encodeURIComponent(m.dir)}/index.html`;
}

// The hardware filter: one toggle per GPU, grouped by gpuGroup, most first
// within a group. Radios, so one GPU at a time; clicking the selected one
// clears it. counts is per GPU; what says what is counted, for the tooltip.
function gpuToggles(counts, what) {
  const labels = Object.keys(counts).sort(
    (a, b) => gpuGroup(a) - gpuGroup(b) || counts[b] - counts[a] || a.localeCompare(b)
  );
  return `<fieldset class="gpu-filter">
        <legend class="sr-only">GPU</legend>
        <span class="gpu-filter-label" aria-hidden="true">GPU</span>
        ${labels
          .map(
            (h) =>
              `<label class="toggle tint hue-${gpuHue(h)}" title="${what} ${escapeHtml(h)}">` +
              `<input type="radio" name="hardware" value="${escapeHtml(h)}">` +
              `${escapeHtml(h)}<span class="gpu-n">${counts[h]}</span></label>`
          )
          .join("\n        ")}
      </fieldset>`;
}

function countBy(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

function renderOptions(values, allLabel) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return (
    `<option value="">${escapeHtml(allLabel)}</option>` +
    Object.keys(counts)
      .sort((a, b) => a.localeCompare(b))
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts[v]})</option>`)
      .join("")
  );
}

// --- pieces shared by the card and table views ---

// Tag colors. The tags in use get a fixed hue; any other tag gets one picked
// from its name, so a new tag is colored and stays the same color. swiss's web
// (web/src/lib/catalog.ts) keeps the same table.
const TAG_HUES = {
  chat: "blue",
  reasoning: "purple",
  "tool-use": "green",
  moe: "orange",
  "speculative-decoding": "red",
  "long-context": "yellow",
  "multi-node": "grey",
  vision: "green",
  fp4: "orange",
  fallback: "grey",
};
// Sonokai's accents, the order an unlisted tag or GPU hashes into.
const HUES = ["blue", "purple", "green", "orange", "red", "yellow"];

// Each GPU keeps one color wherever it appears: toolbar filter, table tags,
// hardware lines. Fixed, so a filter never repaints the others; an unlisted
// GPU gets a stable hue from its name.
const GPU_HUES = {
  A100: "yellow",
  A800: "yellow",
  H20: "red",
  H100: "blue",
  H200: "yellow",
  H800: "green",
  B200: "red",
  B300: "purple",
  "RTX-6000D": "orange",
  "Ascend 910B3": "red",
  "any GPU": "grey",
};

function gpuHue(label) {
  return GPU_HUES[label] || tagHue(label);
}

function tagHue(tag) {
  if (TAG_HUES[tag]) return TAG_HUES[tag];
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function chip(filter, value) {
  // Family chips stay neutral, so a family never reads as a tag; GPU names
  // wear the same highlight as in hardware lines.
  const cls =
    filter === "tag"
      ? `chip hue-${tagHue(value)}`
      : filter === "hardware"
        ? `chip chip-gpu hue-${gpuHue(value)}`
        : "chip";
  return `<button type="button" class="${cls}" data-filter="${filter}" data-value="${escapeHtml(
    value
  )}" title="Filter by ${filter}: ${escapeHtml(value)}">${escapeHtml(value)}</button>`;
}

function deprecatedBadge(m) {
  if (!m.deprecated) return "";
  const title = m.deprecatedReason ? ` title="${escapeHtml(m.deprecatedReason)}"` : "";
  return `<span class="badge badge-deprecated"${title}>deprecated</span>`;
}

// Default variant first; the rest keep file order.
function orderedVariants(m) {
  return m.versions[0].variants.slice().sort((a, b) => Number(b.default) - Number(a.default));
}

// id and badges on one line. The id links to the variant's source, pinned to
// a commit, when there is one.
function variantLine(v, cls) {
  const badges = [];
  if (v.default) badges.push("default");
  if (v.isOptimized) badges.push("optimized");
  if (v.isBaseline) badges.push("baseline");
  const id = v.source
    ? `<a class="variant-id variant-src" href="${escapeHtml(v.source)}" target="_blank" rel="noopener" title="Source on GitHub, pinned to commit ${escapeHtml(
        v.source.split("/blob/")[1].slice(0, 7)
      )}">${escapeHtml(v.id)}</a>`
    : `<span class="variant-id">${escapeHtml(v.id)}</span>`;
  return `<div class="${cls}">${id}${badges.map((b) => `<span class="badge badge-${b}">${b}</span>`).join("")}</div>`;
}

// A model's reports in its variants' order, each with its link text: the
// label alone for one report; for several, the GPUs of the variant each
// measured, or its file name when those do not tell them apart. A report
// measured on an earlier version than the latest says which.
function reportLinks(m, label) {
  const variants = orderedVariants(m);
  const all = m.versions.flatMap((ver) => ver.variants);
  const items = m.reports.map((r) => {
    const t = m.tuning.find((x) => x.reportFile === r.file);
    const v = t && all.find((x) => x.id === t.optimizedId);
    const at = v ? variants.findIndex((x) => x.id === v.id) : -1;
    return {
      r,
      older: t && t.version !== m.latest ? t.version : null,
      hw: v && v.hardware.length ? v.hardware.join(" / ") : null,
      at: at < 0 ? Infinity : at,
    };
  });
  const distinct = items.every((x) => x.hw && items.filter((y) => y.hw === x.hw).length === 1);
  return items
    .sort((a, b) => a.at - b.at)
    .map(({ r, older, hw }) => ({
      r,
      title: escapeHtml(older ? `${r.file}, measured on v${older}` : r.file),
      text:
        (items.length < 2 ? label : distinct ? `${escapeHtml(hw)} ${label.toLowerCase()}` : escapeHtml(r.title)) +
        olderTag(older),
    }));
}

function olderTag(version) {
  return version ? `<span class="link-ver">v${escapeHtml(version)}</span>` : "";
}

// Perf reports, then any variants[].link.
function modelLinks(m, cls, reportLabel) {
  const links = reportLinks(m, reportLabel).map(
    ({ r, title, text }) =>
      `<a class="${cls}" href="${escapeHtml(encodePath(r.path))}" title="${title}">${ICONS.report}${text}</a>`
  );
  for (const v of m.versions[0].variants) {
    if (!v.link) continue;
    links.push(
      `<a class="${cls}" href="${escapeHtml(v.link)}" target="_blank" rel="noopener">${
        ICONS.external
      }${escapeHtml(v.id)}</a>`
    );
  }
  return links;
}

function renderCard(m, i, scale) {
  const variants = orderedVariants(m)
    .map((v) => {
      // Cards are narrow, so hardware leads the description line instead of
      // wrapping onto a line of its own.
      const hw = v.hardwareShort
        ? `<span class="variant-hw-inline" title="${escapeHtml(v.requiresSummary)}">${hardwareHtml(v)}</span>`
        : "";
      const desc = v.description ? escapeHtml(v.description) : "";
      const sub =
        hw || desc
          ? `<div class="variant-desc clamp"${desc ? ` title="${desc}"` : ""}>${hw}${
              hw && desc ? " · " : ""
            }${desc}</div>`
          : "";
      const bar = improvementBar(m, v, scale, "v-imp");
      return `<li class="variant">${
        bar ? `<div class="variant-top">${variantLine(v, "variant-line")}${bar}</div>` : variantLine(v, "variant-line")
      }${sub}</li>`;
    })
    .join("");
  const links = modelLinks(m, "btn", "Perf report");

  return `<article class="model" data-i="${i}">
    <div class="model-head">
      <div>
        <h2 class="model-title"><a class="model-link" href="${modelHref(m)}" title="${escapeHtml(m.name)}">${escapeHtml(
          m.displayName
        )}</a> ${deprecatedBadge(m)}</h2>
        <div class="model-meta">
          ${idIsDisplayName(m) ? "" : `<code>${escapeHtml(m.name)}</code>`}
          ${m.family ? chip("family", m.family) : ""}
        </div>
      </div>
    </div>
    <div class="model-body">
      <div class="model-info">
        ${m.description ? `<p class="desc clamp" title="${escapeHtml(m.description)}">${escapeHtml(m.description)}</p>` : ""}
      </div>
      <div class="model-variants">
        <ul class="variants" aria-label="Variants">${variants}</ul>
        ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      </div>
    </div>
  </article>`;
}

// An optimized variant's best result in the latest version, over its pairs and
// their workloads; null for any other variant.
function variantBest(m, id) {
  let best = null;
  for (const t of tuningFor(m, m.latest, id)) {
    const rows = t.workloads.length ? t.workloads : [{ name: null, upliftPct: t.upliftPct, upliftLabel: t.upliftLabel }];
    for (const w of rows) {
      if (w.upliftPct != null && (!best || w.upliftPct > best.upliftPct)) best = { ...w, t, of: rows.length };
    }
  }
  return best;
}

// An optimized variant's bar and best number, drawn against the catalog's
// best result; null for any other variant.
function improvementBar(m, v, scale, cls) {
  const b = variantBest(m, v.id);
  if (!b) return null;
  const width = Math.max(0, Math.min(100, (b.upliftPct / scale) * 100));
  const title =
    (b.of > 1 ? `Best of ${b.of} workloads: ` : "") +
    `${b.upliftLabel}${b.name ? ` at ${b.name} tokens` : ""}, ${v.id} vs ${b.t.baselineId}, measured on v${b.t.version}. ` +
    UPLIFT_HELP;
  return `<div class="imp ${cls}" title="${escapeHtml(title)}"><span class="imp-track"><span class="imp-fill" style="width:${width.toFixed(
    1
  )}%"></span></span><span class="imp-val">${escapeHtml(b.upliftLabel)}</span></div>`;
}

// The table's improvement cell: one row per variant line, so each optimized
// variant's bar sits on its own line and the rest stay blank.
function improvementCell(m, scale) {
  const bars = orderedVariants(m).map((v) => improvementBar(m, v, scale, "t-imp-row"));
  return bars.some(Boolean)
    ? bars.map((b) => b || `<div class="t-imp-row" aria-hidden="true"></div>`).join("")
    : null;
}

// Compact view: no descriptions (the description is the name's tooltip).
function renderRow(m, i, scale) {
  const none = `<span class="none">—</span>`;
  const links = modelLinks(m, "t-link", "Report");
  const title = ` title="${escapeHtml(m.description ? `${m.name} — ${m.description}` : m.name)}"`;
  return `<tr data-i="${i}">
        <td>
          <div class="t-name"${title}><a class="model-link" href="${modelHref(m)}">${escapeHtml(m.displayName)}</a> ${deprecatedBadge(m)}</div>
          ${idIsDisplayName(m) ? "" : `<div class="t-meta"><code>${escapeHtml(m.name)}</code></div>`}
          <div class="t-gpus">${[...new Set(m.versions[0].variants.flatMap((v) => v.hardware))]
            .sort((a, b) => gpuGroup(a) - gpuGroup(b) || a.localeCompare(b))
            .map((h) => chip("hardware", h))
            .join("")}</div>
        </td>
        <td>${m.family ? chip("family", m.family) : none}</td>
        <td class="t-variants">${orderedVariants(m).map((v) => variantLine(v, "t-variant")).join("")}</td>
        <td class="num">${improvementCell(m, scale) || none}</td>
        <td>${links.length ? `<div class="t-links">${links.join("")}</div>` : none}</td>
      </tr>`;
}

function renderIndex(catalog) {
  const facets = catalog.models.map(facetsOf);
  // Ship the default order; data-i keeps each node's place in the data.
  const order = facets.map((_, i) => i).sort((a, b) => byUplift(facets[a], facets[b]));
  const hasDeprecated = facets.some((f) => f.deprecated);
  // Every bar in the table is drawn against the catalog's best result.
  const scale =
    Math.max(0, ...catalog.models.flatMap((m) => m.versions[0].variants.map((v) => (variantBest(m, v.id) || {}).upliftPct || 0))) || 1;
  // Keep "</script>" in descriptions from closing the data block.
  const dataJson = JSON.stringify(facets).replace(/</g, "\\u003c");
  const sortTh = (col, label, cls, title, sub) =>
    `<th scope="col" data-sort-col="${col}"${col === "uplift" ? ` aria-sort="descending"` : ""}${cls ? ` class="${cls}"` : ""}${
      title ? ` title="${escapeHtml(title)}"` : ""
    }>` +
    `<button type="button" class="sort-btn" data-sort="${col}">${label}<span class="sort-ind" aria-hidden="true"></span></button>` +
    (sub ? `<span class="th-sub">${escapeHtml(sub)}</span>` : "") +
    `</th>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Model Catalog</title>
${BOOT_SCRIPT}
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<header class="site-header">
  <div class="wrap header-row">
    <div>
      <p class="eyebrow">modelsphere / model-catalog</p>
      <h1>Model catalog</h1>
      ${deployRef("these models")}
    </div>
    ${themeButton()}
  </div>
</header>
<main class="wrap">
  <section id="summary" class="summary" aria-label="Summary" aria-live="polite">
${renderSummary(computeSummary(facets))}
  </section>
  <form id="filters" class="toolbar" role="search" hidden>
    <div class="toolbar-row">
      <label class="search">
        <span class="sr-only">Search models</span>
        <input type="search" name="q" placeholder="Search models, variants, hardware…" autocomplete="off">
        <kbd aria-hidden="true">/</kbd>
      </label>
      <label><span class="sr-only">Family</span>
        <select name="family">${renderOptions(facets.map((f) => f.family).filter(Boolean), "All families")}</select>
      </label>
      <label><span class="sr-only">Engine</span>
        <select name="engine">${renderOptions(facets.flatMap((f) => [...new Set(f.engines)]), "All engines")}</select>
      </label>
      <label><span class="sr-only">Tag</span>
        <select name="tag">${renderOptions(facets.flatMap((f) => f.tags), "All tags")}</select>
      </label>
    </div>
    <div class="toolbar-row">
      ${hasDeprecated ? `<label class="toggle tint tint-bad"><input type="checkbox" name="hidedep">Hide deprecated</label>` : ""}
      <span class="toolbar-spacer"></span>
      <p id="result-count" class="result-count" aria-live="polite"></p>
      <label><span class="sr-only">Sort by</span>
        <select name="sort">
          <option value="uplift">Sort by improvement</option>
          <option value="name">Sort by name</option>
          <option value="family">Sort by family</option>
        </select>
      </label>
      <fieldset class="segmented">
        <legend class="sr-only">View</legend>
        <label title="Card view"><input type="radio" name="view" value="cards">${ICONS.cards}<span>Cards</span></label>
        <label title="Table view"><input type="radio" name="view" value="table" checked>${ICONS.table}<span>Table</span></label>
      </fieldset>
    </div>
    <div class="toolbar-row">
      ${gpuToggles(countBy(facets.flatMap((f) => f.hardware)), "Models with a variant for")}
      <span class="toolbar-spacer"></span>
      <button type="reset" class="link-btn">Reset</button>
    </div>
  </form>
  <div id="results">
    <div id="models" class="models">
${order.map((i) => renderCard(catalog.models[i], i, scale)).join("\n")}
    </div>
    <div class="table-view table-wrap">
      <table class="models-table">
        <thead>
          <tr>
            ${sortTh("name", "Model")}
            ${sortTh("family", "Family")}
            <th scope="col">Variants (latest)</th>
            ${sortTh("uplift", "Improvement vs baseline", "num", UPLIFT_HELP, "best workload")}
            <th scope="col">Links</th>
          </tr>
        </thead>
        <tbody id="table-rows">
${order.map((i) => renderRow(catalog.models[i], i, scale)).join("\n")}
        </tbody>
      </table>
    </div>
  </div>
  <p id="empty" class="empty" hidden>No models match these filters.</p>
</main>
<footer class="wrap">
  <p>Generated from <code>models/</code> by <code>hack/build-site.js</code>. This site is also the catalog swiss reads: <a href="index.json">index.json</a>.</p>
</footer>
<script type="application/json" id="catalog-data">${dataJson}</script>
<script src="assets/site.js"></script>
</body>
</html>
`;
}

// ---- Model page: models/<name>/index.html ----
//
// Every version and every variant in full. Tuning binds to the optimized
// variant: a model may have several, each against its own baseline, so each
// optimized variant carries its own results.

const anchorOf = (version, id) => `v${version}-${id}`;

// The pairs shown on an optimized variant in a version: those measured on that
// version, else -- a tuned variant carried forward unchanged -- those of the
// newest earlier version that measured it.
function tuningFor(m, version, id) {
  const mine = m.tuning.filter((t) => t.optimizedId === id);
  const same = mine.filter((t) => t.version === String(version));
  if (same.length) return same;
  const earlier = mine
    .filter((t) => compareVersions(t.version, version) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return earlier.length ? earlier.filter((t) => t.version === earlier[0].version) : [];
}

// A pair's baseline: linked when this version has it -- a pair carried from
// an earlier version may name one this version dropped.
function baselineRef(ver, t) {
  const code = `<code>${escapeHtml(t.baselineId)}</code>`;
  return ver.variants.some((v) => v.id === t.baselineId)
    ? `<a href="#${escapeHtml(anchorOf(ver.version, t.baselineId))}">${code}</a>`
    : code;
}

// One bar per workload, drawn against the model's largest result so bars
// compare across its variants. The best row is bold; a regression draws no bar.
//   50k + 1.5k  ██████████  +64.2%
//   8k + 1k     █            +7.6%
function tuningBars(t, scale) {
  const rows = t.workloads.length
    ? t.workloads
    : t.upliftPct == null
      ? []
      : [{ name: "headline", upliftPct: t.upliftPct, upliftLabel: t.upliftLabel }];
  const best = Math.max(...rows.map((w) => w.upliftPct));
  return `<div class="tn-bars" title="${escapeHtml(UPLIFT_HELP)}">${rows
    .map((w) => {
      const width = Math.max(0, Math.min(100, (w.upliftPct / scale) * 100));
      return `<div class="tn-row${w.upliftPct === best ? " tn-best" : ""}"><span class="tn-label">${escapeHtml(
        w.name
      )}</span><span class="tn-track"><span class="tn-fill" style="width:${width.toFixed(
        1
      )}%"></span></span><span class="tn-val">${escapeHtml(w.upliftLabel)}</span></div>`;
    })
    .join("")}</div>`;
}

function tuningBlock(m, ver, t, scale) {
  const older = t.version !== ver.version ? t.version : null;
  const report = t.reportFile
    ? `<a class="tn-report" href="${escapeHtml(encodeURIComponent(t.reportFile))}"${
        older ? ` title="Measured on v${escapeHtml(older)}"` : ""
      }>${ICONS.report}Perf report${olderTag(older)}</a>`
    : "";
  return `<div class="tn">
          <div class="tn-head"><span>Improvement vs ${baselineRef(ver, t)}<span class="tn-sub"> · per workload, in + out tokens</span></span>${report}</div>
          ${tuningBars(t, scale)}
        </div>`;
}

function fact(label, value) {
  return value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : "";
}

function variantDetail(m, ver, v, scale) {
  const badges = [];
  if (v.default) badges.push("default");
  if (v.isOptimized) badges.push("optimized");
  if (v.isBaseline) badges.push("baseline");
  const chart = v.chart && v.chart.name ? `<code>${escapeHtml(v.chart.name)}${v.chart.version ? ` ${escapeHtml(v.chart.version)}` : ""}</code>` : "";
  const image =
    v.image && v.image.repository
      ? `<code>${escapeHtml(v.image.repository)}${v.image.tag ? `:${escapeHtml(v.image.tag)}` : ""}</code>`
      : "";
  const pairs = tuningFor(m, ver.version, v.id);
  // Optimized variants of this version measured against this one.
  const against = ver.variants.filter((o) => tuningFor(m, ver.version, o.id).some((t) => t.baselineId === v.id));
  const source = v.source
    ? `<a class="btn btn-sm" href="${escapeHtml(v.source)}" target="_blank" rel="noopener" title="Pinned to commit ${escapeHtml(
        v.source.split("/blob/")[1].slice(0, 7)
      )}">${ICONS.external}Source</a>`
    : "";
  const link = v.link
    ? `<a class="btn btn-sm" href="${escapeHtml(v.link)}" target="_blank" rel="noopener">${ICONS.external}Link</a>`
    : "";
  return `<article class="vd" id="${escapeHtml(anchorOf(ver.version, v.id))}" data-gpus="${escapeHtml(v.hardware.join("|"))}">
        <div class="vd-head">
          <h3 class="vd-id"><a href="#${escapeHtml(anchorOf(ver.version, v.id))}">${escapeHtml(v.id)}</a></h3>
          ${badges.map((b) => `<span class="badge badge-${b}">${b}</span>`).join("")}
          <span class="vd-actions">${link}${source}</span>
        </div>
        ${v.description ? `<p class="vd-desc">${escapeHtml(v.description)}</p>` : ""}
        <dl class="vd-facts">
          ${fact("Engine", escapeHtml(v.engine || ""))}
          ${fact("Hardware", v.hardwareShort ? `${hardwareHtml(v)}<span class="vd-faint"> · ${escapeHtml(v.requiresSummary)}</span>` : "")}
          ${fact("Chart", chart)}
          ${fact("Image", image)}
        </dl>
        ${pairs.map((t) => tuningBlock(m, ver, t, scale)).join("")}
        ${
          against.length
            ? `<p class="vd-baseline">Baseline for ${against
                .map((o) => `<a href="#${escapeHtml(anchorOf(ver.version, o.id))}"><code>${escapeHtml(o.id)}</code></a>`)
                .join(", ")}</p>`
            : ""
        }
        ${v.yaml ? `<details class="vd-config"><summary>Configuration</summary><pre><code>${escapeHtml(v.yaml)}</code></pre></details>` : ""}
      </article>`;
}

// The latest version only: what a deploy gets. Earlier versions stay in git
// and index.json.
function versionSection(m, ver, scale) {
  // Default first; the rest keep file order, as on the catalog page.
  const variants = ver.variants.slice().sort((a, b) => Number(b.default) - Number(a.default));
  return `<section class="ver" id="v${escapeHtml(ver.version)}">
      <div class="ver-head">
        <h2>Variants</h2>
        <span class="ver-meta"><span id="variant-count">${ver.variants.length} variant${ver.variants.length === 1 ? "" : "s"}</span>${
          ver.servedName ? ` · served as <code>${escapeHtml(ver.servedName)}</code>` : ""
        }</span>
        ${
          ver.source
            ? `<a class="ver-src" href="${escapeHtml(ver.source)}" target="_blank" rel="noopener">${ICONS.external}${escapeHtml(
                ver.path.split("/").pop()
              )}</a>`
            : ""
        }
      </div>
      <div class="ver-body">
      ${variants.map((v) => variantDetail(m, ver, v, scale)).join("\n      ")}
      </div>
    </section>`;
}

function renderModelPage(m) {
  const latest = m.versions.find((v) => v.version === m.latest);
  const shown = latest.variants.flatMap((v) => tuningFor(m, latest.version, v.id));
  const all = shown.flatMap((t) => (t.workloads.length ? t.workloads.map((w) => w.upliftPct) : [t.upliftPct]));
  const scale = Math.max(0, ...all.filter((x) => x != null)) || 1;
  const home = "../../index.html";
  const filterLink = (field, value, cls) =>
    `<a class="${cls}" href="${home}?${field}=${encodeURIComponent(value)}" title="All models with ${field} ${escapeHtml(
      value
    )}">${escapeHtml(value)}</a>`;
  const hf = m.source && m.source.hf;
  const reports = reportLinks(m, "Perf report").map(
    ({ r, title, text }) =>
      `<a class="btn" href="${escapeHtml(encodeURIComponent(r.file))}" title="${title}">${ICONS.report}${text}</a>`
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(m.displayName)} · Model Catalog</title>
${BOOT_SCRIPT}
<link rel="stylesheet" href="../../assets/site.css">
</head>
<body class="mp-page">
<header class="site-header">
  <div class="wrap header-row">
    <div>
      <p class="eyebrow"><a href="${home}">model-catalog</a> / ${escapeHtml(m.name)}</p>
      <h1>${escapeHtml(m.displayName)} ${deprecatedBadge(m)}</h1>
      ${deployRef("this model")}
    </div>
    ${themeButton()}
  </div>
</header>
<main class="wrap mp">
  <section class="mp-about">
    <div class="model-meta">
      <code>${escapeHtml(m.name)}</code>
      ${m.family ? filterLink("family", m.family, "chip") : ""}
      ${
        hf
          ? `<a href="https://huggingface.co/${escapeHtml(hf)}" target="_blank" rel="noopener"><code>${escapeHtml(hf)}</code></a>${
              m.source.revision ? ` @ <code>${escapeHtml(m.source.revision)}</code>` : ""
            }`
          : ""
      }
    </div>
    ${m.tags.length ? `<div class="mp-tags">${m.tags.map((t) => filterLink("tag", t, `chip hue-${tagHue(t)}`)).join("")}</div>` : ""}
    ${m.deprecatedReason ? `<p class="mp-dep">Deprecated: ${escapeHtml(m.deprecatedReason)}</p>` : ""}
    ${m.description ? `<p class="mp-desc">${escapeHtml(m.description)}</p>` : ""}
    <form id="gpu-select">
      ${gpuToggles(countBy(latest.variants.flatMap((v) => [...new Set(v.hardware)])), "Variants for")}
    </form>
    ${reports.length ? `<div class="links">${reports.join("")}</div>` : ""}
  </section>
  ${versionSection(m, latest, scale)}
</main>
<footer class="wrap">
  <p>Generated from <code>models/${escapeHtml(m.dir)}/</code> by <code>hack/build-site.js</code>.</p>
</footer>
<script src="../../assets/theme.js"></script>
<script src="../../assets/model.js"></script>
</body>
</html>
`;
}

const SITE_JS =
  [escapeHtml, byUplift, computeSummary, renderSummary, clientMain, themeMain]
    .map((f) => f.toString())
    .join("\n\n") + "\n\nthemeMain();\nclientMain();\n";

const THEME_JS = themeMain.toString() + "\n\nthemeMain();\n";

const MODEL_JS = modelMain.toString() + "\n\nmodelMain();\n";

// Colors are Sonokai's (github.com/sainnhe/sonokai, default style), tuned for
// high contrast. Against the panel: text >= 15:1, muted >= 7:1, faint >= 4.5:1
// on the page too, control borders >= 3:1, and every colored text (links,
// improvement, labels' ink, selected or not) >= 7:1.
//
// Dark mode uses Sonokai's darkest steps as surfaces (black page, bg_dim
// panel) and its hues as they are, lightened only where short of 7:1 (red,
// orange, purple); labels color their text with the hue.
//
// Sonokai is dark-only. Light mode inks with its black; labels keep Sonokai's
// own hues but put them in the wash and border, with ink near the text color,
// since the hues stepped dark enough for text turn olive and brown. The few
// colored texts (links, improvement, deprecated) are clean dark blue, green
// and red at 7:1.
//
// --tint-* set how the label preset mixes, per mode (see .tint below).
const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #181819;
  --panel: #222327;
  --panel-2: #2c2e34;
  --text: #fafafb;
  --muted: #a8aeba;
  --faint: #858a96;
  --line: #414550;
  --line-strong: #666d7d;
  --accent: #76cce0;
  --accent-soft: rgba(118, 204, 224, 0.16);
  --ok: #9ed072;
  --bad: #ff89a4;
  --shadow: none;
  --tint-ink-pct: 85%;
  --tint-wash-pct: 8%;
  --tint-line-pct: 50%;
  --tint-line-base: var(--line);
  --tint-firm-pct: 100%;
  --tint-hover-pct: 14%;
  --tint-sel-ink-pct: 65%;
  --tint-sel-wash-pct: 16%;
  --hue-red: #ff89a4;
  --hue-orange: #f49761;
  --hue-yellow: #e7c664;
  --hue-green: #9ed072;
  --hue-blue: #76cce0;
  --hue-purple: #b7a1f7;
  --hue-grey: #a8aeba;
`;

const CSS = `:root {
  color-scheme: light;
  --bg: #f0f0f2;
  --panel: #ffffff;
  --panel-2: #f3f3f5;
  --text: #181819;
  --muted: #545863;
  --faint: #676c77;
  --line: #cccccd;
  --line-strong: #7f8490;
  --accent: #0058ad;
  --accent-soft: rgba(0, 88, 173, 0.09);
  --ok: #046727;
  --bad: #a92238;
  --shadow: 0 1px 2px rgba(24, 24, 25, 0.06), 0 1px 3px rgba(24, 24, 25, 0.08);
  --hue-red: #fc5d7c;
  --hue-orange: #f39660;
  --hue-yellow: #e7c664;
  --hue-green: #9ed072;
  --hue-blue: #76cce0;
  --hue-purple: #b39df3;
  --hue-grey: #7f8490;
  --tint-ink-pct: 25%;
  --tint-wash-pct: 22%;
  --tint-line-pct: 60%;
  --tint-line-base: var(--text);
  --tint-firm-pct: 40%;
  --tint-hover-pct: 30%;
  --tint-sel-ink-pct: 20%;
  --tint-sel-wash-pct: 40%;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
:root[data-theme="dark"] {${DARK_TOKENS}}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--mono); font-size: 0.86em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.wrap { max-width: 1600px; margin: 0 auto; padding: 0 16px; }
@media (min-width: 720px) { .wrap { padding: 0 24px; } }
@media (min-width: 1200px) { .wrap { padding: 0 40px; } }

.site-header { padding: 2.25rem 0 1.25rem; }
.header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.eyebrow {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 0.35rem;
}
h1 { font-size: clamp(1.6rem, 3vw, 2.1rem); line-height: 1.15; letter-spacing: -0.02em; margin: 0; font-weight: 700; }
.deploy-ref { margin: 0.6rem 0 0; font-size: 0.92rem; color: var(--muted); }
.deploy-ref a { white-space: nowrap; font-weight: 650; }
.deploy-ref svg { width: 0.85em; height: 0.85em; margin-left: 0.2em; vertical-align: -0.05em; }
.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  color: var(--muted);
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  flex-shrink: 0;
}
.theme-toggle:hover { color: var(--text); border-color: var(--line-strong); }
.theme-toggle[hidden], [data-icon][hidden] { display: none; }
.theme-toggle [data-icon]:not([hidden]) { display: inline-flex; }
.theme-toggle svg { width: 16px; height: 16px; }

.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin: 0 0 1rem;
}
.stat {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0.8rem 1rem;
  box-shadow: var(--shadow);
  min-width: 0;
}
.stat-label { font-size: 0.78rem; color: var(--muted); }
.stat-value { font-size: 1.45rem; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.stat-value.pos { color: var(--ok); }
.stat-sub { font-size: 0.78rem; color: var(--faint); overflow-wrap: anywhere; min-height: 1.2em; }

.toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem 0;
  margin-bottom: 0.5rem;
  background: var(--bg);
  background: color-mix(in srgb, var(--bg) 90%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
.toolbar[hidden] { display: none; }
.toolbar-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.toolbar-spacer { flex: 1 1 auto; }
.search { position: relative; flex: 1 1 280px; }
.search kbd {
  position: absolute;
  right: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  font: 0.72rem var(--mono);
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 0.3rem;
  pointer-events: none;
}
.search input:focus + kbd, .search input:not(:placeholder-shown) + kbd { display: none; }
.toolbar input[type="search"], .toolbar select {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 0.45rem 0.7rem;
  font: inherit;
  font-size: 0.9rem;
  min-height: 38px;
  max-width: 100%;
}
.toolbar input[type="search"] { width: 100%; }
.toolbar select { cursor: pointer; }
.toolbar input[type="search"]:hover, .toolbar select:hover { border-color: var(--line-strong); }
.toolbar input:focus-visible, .toolbar select:focus-visible { outline-offset: 0; border-color: var(--accent); }
.toggle {
  display: inline-flex;
  align-items: center;
  padding: 0.35rem 0.75rem;
  min-height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
  font-size: 0.85rem;
  cursor: pointer;
  user-select: none;
}
.toggle:hover { color: var(--text); border-color: var(--line-strong); }
.toggle input { position: absolute; opacity: 0; pointer-events: none; }
.toggle:has(input:checked) { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.toggle:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The GPU filter row: a label, then one tinted toggle per GPU. */
.gpu-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.gpu-filter-label {
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text);
  margin-right: 0.3rem;
}
/* One color preset for every colored label -- toggles, chips, badges, GPU
   names. An element only picks a hue (--hue); the preset mixes ink, wash and
   border from it by the mode's --tint-* amounts (dark: colored ink on a
   faint wash; light: near-text ink on a clear pastel wash). Interactive ones
   deepen on hover; a selected toggle deepens further, firms its border and
   adds a check. */
.tint, .chip, .badge, .gpu {
  --tint-ink: color-mix(in oklab, var(--hue) var(--tint-ink-pct), var(--text));
  --tint-wash: color-mix(in oklab, var(--hue) var(--tint-wash-pct), var(--panel));
  --tint-line: color-mix(in oklab, var(--hue) var(--tint-line-pct), var(--tint-line-base));
  --tint-firm: color-mix(in oklab, var(--hue) var(--tint-firm-pct), var(--tint-line-base));
  color: var(--tint-ink);
  background: var(--tint-wash);
  border: 1px solid var(--tint-line);
}
.toggle.tint:hover, .chip:hover {
  color: var(--tint-ink);
  background: color-mix(in oklab, var(--hue) var(--tint-hover-pct), var(--panel));
  border-color: var(--tint-firm);
}
/* Toggles: GPU ones take the GPU's hue; hide-deprecated red. */
.tint-bad { --hue: var(--hue-red); }
.toggle.tint {
  gap: 0.35rem;
  font-weight: 500;
  transition: background-color 0.15s, border-color 0.15s, box-shadow 0.15s;
}
/* Selected: a deeper wash, so the ink leans further toward the text color to
   stay at 7:1; the firm border, weight and check carry the state. */
.toggle.tint:has(input:checked) {
  color: color-mix(in oklab, var(--hue) var(--tint-sel-ink-pct), var(--text));
  font-weight: 600;
  background: color-mix(in oklab, var(--hue) var(--tint-sel-wash-pct), var(--panel));
  border-color: var(--tint-firm);
  box-shadow: inset 0 0 0 1px var(--tint-firm);
}
.toggle.tint:has(input:checked)::before {
  content: "";
  width: 0.55em;
  height: 0.3em;
  margin: 0 0.05em 0.2em 0;
  border-left: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(-45deg);
}
.toggle.tint:has(input:focus-visible) { outline-color: var(--tint-firm); }
.gpu-n { font-size: 0.74rem; font-weight: 500; opacity: 0.85; font-variant-numeric: tabular-nums; }
.result-count { font-size: 0.85rem; color: var(--muted); margin: 0 0.25rem; font-variant-numeric: tabular-nums; }
.link-btn {
  background: none;
  border: 0;
  color: var(--muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.4rem 0.35rem;
}
.link-btn:hover { color: var(--text); text-decoration: underline; }

/* 3 per row on wide screens, 2 on medium, 1 on phones. */
.models {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 1rem;
}
.model {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 1.1rem 1.25rem;
  min-width: 0;
}
.model[hidden] { display: none; }
.model-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.model-title { font-size: 1.1rem; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.model-title .badge { vertical-align: 2px; margin-left: 0.25rem; }
.model-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.6rem;
  margin-top: 0.2rem;
  font-size: 0.84rem;
  color: var(--muted);
}
.model-body { display: flex; flex-direction: column; gap: 0.9rem; flex: 1; margin-top: 0.75rem; }
/* Content stays top-aligned; links sit at the bottom so a row's buttons line up. */
.model-variants { display: flex; flex-direction: column; flex: 1; }
.clamp { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.desc { margin: 0; color: var(--muted); font-size: 0.9rem; -webkit-line-clamp: 3; line-clamp: 3; }
/* Chips: the preset in a neutral hue (family) unless a hue-* class gives
   one (tags, GPUs). */
.chip {
  --hue: var(--hue-grey);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
  border-radius: 6px;
  padding: 0.05rem 0.55rem;
  cursor: pointer;
  white-space: nowrap;
}
.chip-gpu { font-weight: 600; }
.t-gpus { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.35rem; }
.t-gpus:empty { display: none; }
.hue-red { --hue: var(--hue-red); }
.hue-orange { --hue: var(--hue-orange); }
.hue-yellow { --hue: var(--hue-yellow); }
.hue-green { --hue: var(--hue-green); }
.hue-blue { --hue: var(--hue-blue); }
.hue-purple { --hue: var(--hue-purple); }
.hue-grey { --hue: var(--hue-grey); }
.variants { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; }
.variant { padding: 0.6rem 0.8rem; }
.variant + .variant { border-top: 1px solid var(--line); }
.variant-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.45rem; }
.variant-id { font-family: var(--mono); font-size: 0.84rem; overflow-wrap: anywhere; margin-right: 0.15rem; }
a.variant-src { color: inherit; text-decoration: underline dotted var(--line-strong); text-underline-offset: 3px; }
a.variant-src:hover { color: var(--accent); text-decoration-color: currentColor; }
.variant-desc { font-size: 0.8rem; color: var(--faint); margin-top: 0.2rem; -webkit-line-clamp: 2; line-clamp: 2; }
/* Badges: the preset, a hue per role. DEFAULT and BASELINE step back to a
   quiet outline -- still 7:1 text, no wash, a hairline border -- so
   OPTIMIZED (and DEPRECATED) carry the color. */
.badge {
  --hue: var(--hue-grey);
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 5px;
  padding: 0 0.4rem;
}
.badge-optimized { --hue: var(--hue-green); }
.badge-deprecated { --hue: var(--hue-red); }
.badge-default, .badge-baseline { color: var(--muted); background: transparent; border-color: var(--line); }
.links { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: auto; padding-top: 0.75rem; }
.variant-hw-inline { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
/* GPU names stand out from the rest of a hardware line. */
.gpu { display: inline-block; font-weight: 600; line-height: 1.3; padding: 0 0.4em; border-radius: 5px; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.84rem;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text);
  background: var(--panel);
}
.btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.empty {
  margin: 0;
  padding: 3rem 1rem;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line-strong);
  border-radius: 14px;
}
/* View switch: the <head> boot script sets data-view; without JS, the table shows. */
html:not([data-view="cards"]) .models { display: none; }
html[data-view="cards"] .table-view { display: none; }
.segmented {
  display: inline-flex;
  gap: 2px;
  margin: 0;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  min-width: 0;
}
.segmented label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 32px;
  padding: 0 0.6rem;
  border-radius: 6px;
  font-size: 0.84rem;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.segmented label:hover { color: var(--text); }
.segmented input { position: absolute; opacity: 0; pointer-events: none; }
.segmented label:has(input:checked) { background: var(--accent-soft); color: var(--accent); }
.segmented label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.segmented svg { width: 15px; height: 15px; }

.table-wrap {
  overflow-x: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
}
.models-table { width: 100%; min-width: 820px; border-collapse: collapse; font-size: 0.88rem; }
.models-table th {
  text-align: left;
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  padding: 0.6rem 1rem;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
}
.models-table td { padding: 0.7rem 1rem; vertical-align: top; border-bottom: 1px solid var(--line); }
.models-table tbody tr:last-child td { border-bottom: 0; }
.models-table tbody tr:hover { background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.models-table .num { text-align: right; }
.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.sort-btn:hover, th[aria-sort] .sort-btn { color: var(--text); }
.sort-ind { display: inline-block; width: 0.7em; }
th[aria-sort="ascending"] .sort-ind::after { content: "↑"; }
th[aria-sort="descending"] .sort-ind::after { content: "↓"; }
.t-name { font-weight: 600; }
.t-name .badge { vertical-align: 1px; margin-left: 0.2rem; }
.t-meta { margin-top: 0.1rem; font-size: 0.8rem; color: var(--muted); }
.models-table td:first-child { min-width: 200px; }
.t-variant { display: flex; align-items: center; gap: 0.45rem; white-space: nowrap; }
/* Improvement rows mirror the variant lines, so a bar sits on its variant's line. */
.t-variant, .t-imp-row { height: 1.45rem; }
.t-variant + .t-variant, .t-imp-row + .t-imp-row { margin-top: 0.35rem; }
/* Improvement bar: one hue, anchored left, rounded at the data end; the number
   in text ink beside it. */
.imp { display: grid; grid-template-columns: 72px minmax(4.6em, auto); justify-content: end; align-items: center; column-gap: 0.6rem; }
.imp-track { height: 8px; border-radius: 0 4px 4px 0; background: var(--panel-2); overflow: hidden; }
.imp-fill { display: block; height: 100%; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--ok); }
.imp-val { font-size: 0.86rem; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; color: var(--text); }
.variant-top { display: flex; align-items: flex-start; gap: 0.5rem 0.75rem; }
.variant-top .variant-line { flex: 1; min-width: 0; }
.v-imp { flex-shrink: 0; height: 1.35rem; grid-template-columns: 56px minmax(4.4em, auto); }
.t-variant .variant-id { font-size: 0.82rem; }
a.model-link { color: inherit; }
a.model-link:hover { color: var(--accent); }

/* Model page */
.eyebrow a { color: inherit; }
/* Header, content and footer share one narrower column. */
.mp-page .wrap { max-width: 1180px; }
.mp { display: grid; gap: 1rem; }
.mp-about { display: grid; gap: 0.75rem; }
.mp-about .model-meta { margin-top: 0; }
.mp-about .links { margin-top: 0; padding-top: 0; }
.mp-desc { margin: 0; color: var(--muted); max-width: 72ch; }
.mp-dep { margin: 0; color: var(--bad); font-size: 0.9rem; }
.mp-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
a.chip:hover { text-decoration: none; }
.ver { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: var(--shadow); }
.ver-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.75rem;
  padding: 0.9rem 1.1rem;
  border-bottom: 1px solid var(--line);
}
.ver-head h2 { font-size: 1.05rem; margin: 0; font-variant-numeric: tabular-nums; }
.ver-meta { font-size: 0.84rem; color: var(--muted); }
.ver-src { margin-left: auto; display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.84rem; }
.ver-src svg, .tn-report svg { width: 14px; height: 14px; flex-shrink: 0; }
.ver-body { display: grid; }
.vd { padding: 1rem 1.1rem; scroll-margin-top: 1rem; }
.vd:not([hidden]) ~ .vd:not([hidden]) { border-top: 1px solid var(--line); }
.vd:target { background: var(--accent-soft); }
.vd-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; }
.vd-id { margin: 0; font-family: var(--mono); font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; }
.vd-id a { color: inherit; }
.vd-actions { margin-left: auto; display: flex; gap: 0.4rem; }
.btn-sm { padding: 0.2rem 0.55rem; font-size: 0.8rem; }
.vd-desc { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.9rem; }
.vd-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.5rem 1.25rem;
  margin: 0.75rem 0 0;
}
.vd-facts dt { font-size: 0.72rem; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }
.vd-facts dd { margin: 0.1rem 0 0; font-size: 0.86rem; overflow-wrap: anywhere; }
.vd-faint { color: var(--faint); }
.vd-baseline { margin: 0.75rem 0 0; font-size: 0.86rem; color: var(--muted); }
.tn { margin-top: 0.85rem; padding: 0.75rem 0.85rem; border: 1px solid var(--line); border-radius: 10px; }
.tn-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.3rem 1rem; font-size: 0.88rem; }
.tn-sub { color: var(--faint); font-size: 0.8rem; }
.tn-report { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.84rem; }
/* The version an older report was measured on, beside its link. */
.link-ver { font-size: 0.74em; font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums; }
/* Rows share the container's columns, so labels, bars and digits line up.
   Bars are one hue, anchored left, rounded at the data end. */
.tn-bars {
  display: grid;
  grid-template-columns: auto minmax(60px, 320px) minmax(4.6em, auto);
  justify-content: start;
  align-items: center;
  column-gap: 0.75rem;
  row-gap: 0.35rem;
  margin-top: 0.6rem;
}
.tn-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
.tn-label { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
.tn-track { height: 8px; border-radius: 0 4px 4px 0; background: var(--panel-2); overflow: hidden; }
.tn-fill { display: block; height: 100%; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--ok); }
.tn-val { font-size: 0.88rem; font-variant-numeric: tabular-nums; text-align: right; color: var(--text); }
.tn-best .tn-val { font-weight: 700; }
.vd-config { margin-top: 0.85rem; }
.vd-config > summary { cursor: pointer; font-size: 0.86rem; color: var(--muted); }
.vd-config pre {
  margin: 0.5rem 0 0;
  padding: 0.75rem 0.9rem;
  max-height: 32rem;
  overflow: auto;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.5;
}
.th-sub { display: block; font-size: 0.68rem; font-weight: 400; color: var(--faint); margin-top: 0.1rem; }
.t-links { display: grid; gap: 0.2rem; justify-items: start; }
.t-link { display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
.t-link svg { width: 14px; height: 14px; flex-shrink: 0; }
.none { color: var(--faint); }
/* footer.wrap, so .wrap's padding shorthand does not zero these. */
footer.wrap { padding-top: 2.5rem; padding-bottom: 3rem; font-size: 0.84rem; color: var(--faint); }
.nowrap { white-space: nowrap; }
footer p { margin: 0; }
@media (max-width: 560px) {
  .site-header { padding-top: 1.5rem; }
  .summary {
    grid-auto-flow: column;
    grid-template-columns: none;
    grid-auto-columns: minmax(132px, 40%);
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scroll-padding: 0 16px;
    scrollbar-width: none;
    margin: 0 -16px 1rem;
    padding: 0 16px 2px;
  }
  .summary::-webkit-scrollbar { display: none; }
  .stat { scroll-snap-align: start; padding: 0.7rem 0.85rem; }
  .model { padding: 1rem; }
  .theme-label { display: none; }
  .toolbar select { flex: 1 1 calc(50% - 0.25rem); }
  .toolbar-row > label:not(.search):not(.toggle) { flex: 1 1 calc(50% - 0.25rem); display: flex; }
  .toolbar-row > label:not(.search):not(.toggle) select { flex: 1; }
  .toolbar-spacer { display: none; }
}
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

// The catalog itself, published beside the page: index.json and every version
// file it names, at the paths it names -- swiss fetches entries relative to
// index.json.
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

function rewritesOf(published, index) {
  const now = new Map(index.models.flatMap((m) => m.versions.map((v) => [v.path, v.digest])));
  const out = [];
  for (const m of published?.models ?? []) {
    for (const v of m.versions) {
      if (!now.has(v.path)) out.push(`${v.path}: published, now deleted -- deprecate the model instead`);
      else if (now.get(v.path) !== v.digest) out.push(`${v.path}: published, now edited -- publish a new version instead`);
    }
  }
  return out;
}

async function publishCatalog() {
  const index = buildIndex();
  const mode = process.env.REWRITES || "refuse";
  if (!["refuse", "warn", "allow"].includes(mode)) throw new Error(`REWRITES=${mode}: want refuse, warn or allow`);
  const rewrites = rewritesOf(await publishedIndex(), index);
  if (rewrites.length && mode !== "allow") {
    const text = rewrites.join("\n");
    if (mode === "refuse") throw new Error(`${text}\n(REWRITES=allow publishes them: a deliberate in-place edit)`);
    console.warn(`${text}\n(warn only: a deploy refuses these unless run with REWRITES=allow)`);
  }
  let files = 0;
  for (const m of index.models) {
    for (const v of m.versions) {
      mkdirp(path.dirname(path.join(outDir, v.path)));
      fs.copyFileSync(path.join(root, v.path), path.join(outDir, v.path));
      files++;
    }
  }
  fs.writeFileSync(path.join(outDir, "index.json"), serializeIndex(index));
  return { models: index.models.length, files, rewrites: mode === "allow" ? rewrites.length : 0 };
}

async function main() {
  const catalog = loadCatalog();
  rmrf(outDir);
  mkdirp(path.join(outDir, "assets"));
  // Variants' YAML is for the model pages only; catalog.json stays small.
  fs.writeFileSync(
    path.join(outDir, "catalog.json"),
    JSON.stringify(catalog, (k, v) => (k === "yaml" ? undefined : v), 2) + "\n"
  );
  fs.writeFileSync(path.join(outDir, "assets/site.css"), CSS);
  fs.writeFileSync(path.join(outDir, "assets/site.js"), SITE_JS);
  fs.writeFileSync(path.join(outDir, "assets/theme.js"), THEME_JS);
  fs.writeFileSync(path.join(outDir, "assets/model.js"), MODEL_JS);
  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex(catalog));
  for (const m of catalog.models) {
    mkdirp(path.join(outDir, "models", m.dir));
    fs.writeFileSync(path.join(outDir, "models", m.dir, "index.html"), renderModelPage(m));
  }
  // Helpful for project Pages paths / local preview.
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  copyReports(catalog);
  let published;
  try {
    published = await publishCatalog();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(
    `site/: ${catalog.count} models, ` +
      `${catalog.models.filter((m) => m.comparison).length} optimized-vs-baseline, ` +
      `${catalog.models.reduce((n, m) => n + m.reports.length, 0)} perf HTML; ` +
      `catalog: ${published.models} models, ${published.files} version files` +
      (published.rewrites ? `, ${published.rewrites} rewritten in place (REWRITES=allow)` : "")
  );
}

main();

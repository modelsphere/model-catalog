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

const outDir = path.join(root, "site");

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

// Short labels for the hardware filter: NVIDIA-H100-80GB-HBM3 -> H100.
function hardwareLabels(req) {
  if (!req) return [];
  const vendor = req.vendor || "nvidia";
  const products = Array.isArray(req.gpuProduct) ? req.gpuProduct : [];
  if (products.length === 0) return [vendor === "nvidia" ? "any GPU" : vendor];
  return products.map((p) => {
    const m = String(p).match(/(?:^|-)([A-Z]{1,2}\d{2,4}[A-Z]?)(?=-|$)/i);
    return m ? m[1].toUpperCase() : String(p);
  });
}

// Compact hardware line for a variant: "8 × H100", "8 × GPU × 2 nodes".
function hardwareShort(req) {
  if (!req || req.gpus == null) return "";
  const hasProducts = Array.isArray(req.gpuProduct) && req.gpuProduct.length > 0;
  const vendor = req.vendor && req.vendor !== "nvidia" ? req.vendor : "GPU";
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadCatalog() {
  const models = [];
  for (const name of modelNames()) {
    const dir = path.join(modelsDir, name);
    const metaPath = path.join(dir, "metadata.yaml");
    if (!fs.existsSync(metaPath)) {
      console.error(`${dir}: missing metadata.yaml`);
      process.exit(1);
    }
    const meta = readYaml(metaPath);
    const tuning = Array.isArray(meta.tuning) ? meta.tuning : [];
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
    for (const rel of versionFiles(name)) {
      const doc = readYaml(path.join(root, rel));
      const raw = doc.variants || [];
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
          variantCount: v.variants.length,
          variants: v.variants.map((x) => ({
            id: x.id,
            engine: x.engine,
            default: x.default,
            description: x.description,
            link: x.link,
            requiresSummary: x.requiresSummary,
            hardware: x.hardware,
            hardwareShort: x.hardwareShort,
            isBaseline: x.isBaseline,
            isOptimized: x.isOptimized,
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
  const pct = typeof t.uplift === "number" ? t.uplift : null;
  return {
    baselineId: t.baseline,
    optimizedId: t.optimized,
    upliftPct: pct,
    upliftLabel: pct == null ? null : formatUplift(pct),
    version: String(t.version),
    report: t.report ? `models/${name}/${t.report}` : null,
    workloads: Array.isArray(t.workloads)
      ? t.workloads.map((w) => ({ name: String(w.name), upliftPct: w.uplift, upliftLabel: formatUplift(w.uplift) }))
      : [],
  };
}

// What an uplift number means, for tooltips. Workload names are the report's:
// input + output tokens per request.
const UPLIFT_HELP =
  "Throughput of the tuned variant over its baseline, from the tuning benchmark. " +
  "Workloads are input + output tokens per request, e.g. 50k + 1.5k.";

// The workloads to draw: the report's, or the headline alone when the
// benchmark recorded none.
function workloadsOf(c) {
  if (c.workloads.length) return c.workloads;
  return c.upliftPct == null ? [] : [{ name: "", upliftPct: c.upliftPct, upliftLabel: c.upliftLabel }];
}

// The largest result in the catalog: every bar is drawn against it, so bars
// compare across models as well as within one.
function upliftScale(models) {
  const all = models.flatMap((m) => (m.comparison ? workloadsOf(m.comparison).map((w) => w.upliftPct) : []));
  return Math.max(0, ...all) || 1;
}

// One bar per workload: workload, bar, number. Rows share their columns
// (subgrid), so labels, bars and digits line up. The headline row's number is
// bold; a regression draws no bar. "Tokens" is said once, by the caller.
//   50k + 1.5k  ██████████  +64.2%
//   8k + 1k     █            +7.6%
function workloadBars(c, scale) {
  const rows = workloadsOf(c).map((w) => {
    const width = Math.max(0, Math.min(100, (w.upliftPct / scale) * 100));
    const head = w.upliftPct === c.upliftPct ? " wl-head" : "";
    const title = `${w.upliftLabel}${w.name ? ` at ${w.name} tokens` : ""}: ${c.optimizedId} vs ${c.baselineId}, measured on v${c.version}`;
    return `<div class="wl-row${head}" title="${escapeHtml(title)}"><span class="wl-label">${escapeHtml(
      w.name
    )}</span><span class="wl-track"><span class="wl-fill" style="width:${width.toFixed(1)}%"></span></span><span class="wl-val">${escapeHtml(
      w.upliftLabel
    )}</span></div>`;
  });
  return `<div class="wl-bars">${rows.join("")}</div>`;
}

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
    uplift: m.comparison ? m.comparison.upliftPct : null,
    reports: m.reports.length,
    deprecated: m.deprecated,
    text,
  };
}

// computeSummary, renderSummary and escapeHtml run at build time for the
// static page and again in the browser (serialized into site.js) for the
// filtered view, so they must stay self-contained.
function computeSummary(models) {
  const engines = {};
  const hardware = {};
  const uplifts = [];
  let variants = 0;
  let reports = 0;
  let pairs = 0;
  let deprecated = 0;
  for (const m of models) {
    variants += m.engines.length;
    reports += m.reports;
    if (m.deprecated) deprecated++;
    if (m.hasCmp) pairs++;
    if (m.uplift != null) uplifts.push({ name: m.name, pct: m.uplift });
    for (const e of m.engines) engines[e] = (engines[e] || 0) + 1;
    for (const h of m.hardware) hardware[h] = (hardware[h] || 0) + 1;
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
    hardware,
    reports,
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
    stat("Perf reports", s.reports, ""),
    stat("Hardware", Object.keys(s.hardware).length, counts(s.hardware)),
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
  const fields = ["q", "family", "engine", "hardware", "tag", "cmp", "reports", "hidedep", "sort", "view"];
  const defaults = { sort: "name", view: "table" };

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
    uplift: (a, b) =>
      (b.uplift == null ? -Infinity : b.uplift) - (a.uplift == null ? -Infinity : a.uplift) ||
      byName(a, b),
    // Models without a family sort last.
    family: (a, b) =>
      !a.family - !b.family || (a.family || "").localeCompare(b.family || "") || byName(a, b),
  };
  const sortDir = { name: "ascending", family: "ascending", uplift: "descending" };

  function readState() {
    const st = {};
    for (const k of fields) {
      const el = form.elements[k];
      if (el) st[k] = el.type === "checkbox" ? el.checked : el.value;
    }
    return st;
  }

  function writeState(params) {
    for (const k of fields) {
      const el = form.elements[k];
      if (!el) continue;
      const v = params.get(k);
      if (el.type === "checkbox") el.checked = v === "1";
      else if (v != null && (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === v)))
        el.value = v;
    }
  }

  function matches(m, st) {
    const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => m.text.includes(t))) return false;
    if (st.family && m.family !== st.family) return false;
    if (st.engine && !m.engines.includes(st.engine)) return false;
    if (st.hardware && !m.hardware.includes(st.hardware)) return false;
    if (st.tag && !m.tags.includes(st.tag)) return false;
    if (st.cmp && !m.hasCmp) return false;
    if (st.reports && !m.reports) return false;
    if (st.hidedep && m.deprecated) return false;
    return true;
  }

  function apply() {
    const st = readState();
    const sorter = sorters[st.sort] || sorters.name;
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
      form.elements[chip.dataset.filter].value = chip.dataset.value;
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
  reasoning: "violet",
  "tool-use": "teal",
  moe: "orange",
  "speculative-decoding": "pink",
  "long-context": "amber",
  "multi-node": "indigo",
  vision: "green",
  fp4: "cyan",
  fallback: "slate",
};
const HUES = ["blue", "violet", "teal", "orange", "pink", "amber", "indigo", "green", "cyan", "slate"];

function tagHue(tag) {
  if (TAG_HUES[tag]) return TAG_HUES[tag];
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function chip(filter, value) {
  // Family chips stay neutral, so a family never reads as a tag.
  const cls = filter === "tag" ? `chip hue-${tagHue(value)}` : "chip";
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

// id, badges and (unless the caller places it elsewhere) hardware on one line.
function variantLine(v, cls, withHardware = true) {
  const badges = [];
  if (v.default) badges.push("default");
  if (v.isOptimized) badges.push("optimized");
  if (v.isBaseline) badges.push("baseline");
  const hw = withHardware && v.hardwareShort
    ? `<span class="variant-hw" title="${escapeHtml(v.requiresSummary)}">${escapeHtml(
        v.hardwareShort
      )}</span>`
    : "";
  return `<div class="${cls}"><span class="variant-id">${escapeHtml(v.id)}</span>${badges
    .map((b) => `<span class="badge badge-${b}">${b}</span>`)
    .join("")}${hw}</div>`;
}

function upliftBadge(c, cls) {
  const results = c.workloads.map((w) => `${w.upliftLabel} at ${w.name} tokens`).join(", ");
  const title = escapeHtml(
    `${c.optimizedId} vs ${c.baselineId}, measured on v${c.version}${results ? `: ${results}` : ""}. ${UPLIFT_HELP}`
  );
  const label = c.upliftLabel ? escapeHtml(c.upliftLabel) : "optimized";
  return `<span class="${cls}" title="${title}">${label}</span>`;
}

// Perf reports, then any variants[].link.
function modelLinks(m, cls, reportLabel) {
  const links = m.reports.map(
    (r) =>
      `<a class="${cls}" href="${escapeHtml(encodePath(r.path))}" title="${escapeHtml(r.file)}">${
        ICONS.report
      }${m.reports.length > 1 ? escapeHtml(r.title) : reportLabel}</a>`
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
        ? `<span class="variant-hw-inline" title="${escapeHtml(v.requiresSummary)}">${escapeHtml(
            v.hardwareShort
          )}</span>`
        : "";
      const desc = v.description ? escapeHtml(v.description) : "";
      const sub =
        hw || desc
          ? `<div class="variant-desc clamp"${desc ? ` title="${desc}"` : ""}>${hw}${
              hw && desc ? " · " : ""
            }${desc}</div>`
          : "";
      return `<li class="variant">${variantLine(v, "variant-line", false)}${sub}</li>`;
    })
    .join("");
  const uplift = m.comparison
    ? `<div class="uplift-box">${upliftBadge(m.comparison, "uplift")}<div class="uplift-sub">vs baseline${
        m.comparison.version !== m.latest ? ` · v${escapeHtml(m.comparison.version)}` : ""
      }</div></div>`
    : "";
  const links = modelLinks(m, "btn", "Perf report");

  return `<article class="model" data-i="${i}">
    <div class="model-head">
      <div>
        <h2 class="model-title">${escapeHtml(m.displayName)} ${deprecatedBadge(m)}</h2>
        <div class="model-meta">
          <code>${escapeHtml(m.name)}</code>
          <span>v${escapeHtml(m.latest)}</span>
          ${m.family ? chip("family", m.family) : ""}
        </div>
      </div>
      ${uplift}
    </div>
    <div class="model-body">
      <div class="model-info">
        ${
          m.comparison
            ? `<div class="workloads"><div class="workloads-cap" title="${escapeHtml(
                UPLIFT_HELP
              )}">Per workload · in + out tokens</div>${workloadBars(m.comparison, scale)}</div>`
            : ""
        }
        ${m.description ? `<p class="desc clamp" title="${escapeHtml(m.description)}">${escapeHtml(m.description)}</p>` : ""}
        ${m.tags.length ? `<div class="chips">${m.tags.map((t) => chip("tag", t)).join("")}</div>` : ""}
      </div>
      <div class="model-variants">
        <ul class="variants" aria-label="Variants">${variants}</ul>
        ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      </div>
    </div>
  </article>`;
}

// Compact view: no descriptions (the description is the name's tooltip).
function renderRow(m, i, scale) {
  const none = `<span class="none">—</span>`;
  const links = modelLinks(m, "t-link", "Report");
  const title = m.description ? ` title="${escapeHtml(m.description)}"` : "";
  return `<tr data-i="${i}">
        <td>
          <div class="t-name"${title}>${escapeHtml(m.displayName)} ${deprecatedBadge(m)}</div>
          <div class="t-meta"><code>${escapeHtml(m.name)}</code> · v${escapeHtml(m.latest)}</div>
        </td>
        <td>${m.family ? chip("family", m.family) : none}</td>
        <td class="t-tags">${m.tags.length ? `<div class="chips">${m.tags.map((t) => chip("tag", t)).join("")}</div>` : none}</td>
        <td class="t-variants">${orderedVariants(m).map((v) => variantLine(v, "t-variant")).join("")}</td>
        <td class="num">${
          m.comparison
            ? workloadBars(m.comparison, scale) +
              (m.comparison.version !== m.latest
                ? `<div class="wl-ver">measured on v${escapeHtml(m.comparison.version)}</div>`
                : "")
            : none
        }</td>
        <td>${links.length ? `<div class="t-links">${links.join("")}</div>` : none}</td>
      </tr>`;
}

function renderIndex(catalog) {
  const facets = catalog.models.map(facetsOf);
  const hasDeprecated = facets.some((f) => f.deprecated);
  const scale = upliftScale(catalog.models);
  // Keep "</script>" in descriptions from closing the data block.
  const dataJson = JSON.stringify(facets).replace(/</g, "\\u003c");
  const sortTh = (col, label, cls, title, sub) =>
    `<th scope="col" data-sort-col="${col}"${cls ? ` class="${cls}"` : ""}${
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
    </div>
    <button type="button" id="theme-toggle" class="theme-toggle" hidden>
      <span data-icon="system">${ICONS.system}</span><span data-icon="light" hidden>${
        ICONS.light
      }</span><span data-icon="dark" hidden>${ICONS.dark}</span>
      <span class="theme-label">System</span>
    </button>
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
      <label><span class="sr-only">Hardware</span>
        <select name="hardware">${renderOptions(facets.flatMap((f) => f.hardware), "All hardware")}</select>
      </label>
      <label><span class="sr-only">Tag</span>
        <select name="tag">${renderOptions(facets.flatMap((f) => f.tags), "All tags")}</select>
      </label>
    </div>
    <div class="toolbar-row">
      <label class="toggle"><input type="checkbox" name="cmp">Optimized vs baseline</label>
      <label class="toggle"><input type="checkbox" name="reports">Has perf report</label>
      ${hasDeprecated ? `<label class="toggle"><input type="checkbox" name="hidedep">Hide deprecated</label>` : ""}
      <span class="toolbar-spacer"></span>
      <p id="result-count" class="result-count" aria-live="polite"></p>
      <label><span class="sr-only">Sort by</span>
        <select name="sort">
          <option value="name">Sort by name</option>
          <option value="uplift">Sort by improvement</option>
          <option value="family">Sort by family</option>
        </select>
      </label>
      <fieldset class="segmented">
        <legend class="sr-only">View</legend>
        <label title="Card view"><input type="radio" name="view" value="cards">${ICONS.cards}<span>Cards</span></label>
        <label title="Table view"><input type="radio" name="view" value="table" checked>${ICONS.table}<span>Table</span></label>
      </fieldset>
      <button type="reset" class="link-btn">Reset</button>
    </div>
  </form>
  <div id="results">
    <div id="models" class="models">
${catalog.models.map((m, i) => renderCard(m, i, scale)).join("\n")}
    </div>
    <div class="table-view table-wrap">
      <table class="models-table">
        <thead>
          <tr>
            ${sortTh("name", "Model")}
            ${sortTh("family", "Family")}
            <th scope="col" class="t-tags">Tags</th>
            <th scope="col">Variants (latest)</th>
            ${sortTh("uplift", "Improvement vs baseline", "num", UPLIFT_HELP, "per workload · in + out tokens")}
            <th scope="col">Links</th>
          </tr>
        </thead>
        <tbody id="table-rows">
${catalog.models.map((m, i) => renderRow(m, i, scale)).join("\n")}
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

const SITE_JS =
  [escapeHtml, computeSummary, renderSummary, clientMain, themeMain]
    .map((f) => f.toString())
    .join("\n\n") + "\n\nthemeMain();\nclientMain();\n";

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0f1216;
  --panel: #161a20;
  --panel-2: #1e232b;
  --text: #e6e9ee;
  --muted: #9ba5b3;
  --faint: #737d8b;
  --line: #262c35;
  --line-strong: #37404c;
  --accent: #7ea9ff;
  --accent-soft: rgba(126, 169, 255, 0.14);
  --ok: #52d08f;
  --ok-soft: rgba(82, 208, 143, 0.13);
  --warn: #f0b955;
  --warn-soft: rgba(240, 185, 85, 0.14);
  --info: #aab6ca;
  --info-soft: rgba(170, 182, 202, 0.12);
  --bad: #ff8080;
  --bad-soft: rgba(255, 128, 128, 0.13);
  --shadow: none;
  --hue-blue: #93c5fd;
  --hue-violet: #c4b5fd;
  --hue-teal: #5eead4;
  --hue-orange: #fdba74;
  --hue-pink: #f9a8d4;
  --hue-amber: #fcd34d;
  --hue-indigo: #a5b4fc;
  --hue-green: #86efac;
  --hue-cyan: #67e8f9;
  --hue-slate: #cbd5e1;
`;

const CSS = `:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-2: #f0f2f5;
  --text: #1b2230;
  --muted: #586374;
  --faint: #7f8998;
  --line: #e3e7ec;
  --line-strong: #cdd4dd;
  --accent: #2a66d9;
  --accent-soft: rgba(42, 102, 217, 0.09);
  --ok: #157a48;
  --ok-soft: rgba(21, 122, 72, 0.1);
  --warn: #9a5a00;
  --warn-soft: rgba(196, 122, 0, 0.12);
  --info: #4a5a73;
  --info-soft: rgba(74, 90, 115, 0.1);
  --bad: #b93434;
  --bad-soft: rgba(185, 52, 52, 0.1);
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.05);
  --hue-blue: #1d4ed8;
  --hue-violet: #6d28d9;
  --hue-teal: #0f766e;
  --hue-orange: #c2410c;
  --hue-pink: #be185d;
  --hue-amber: #a16207;
  --hue-indigo: #4338ca;
  --hue-green: #15803d;
  --hue-cyan: #0e7490;
  --hue-slate: #475569;
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
.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--muted);
  border-radius: 999px;
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
  border: 1px solid var(--line);
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
  border: 1px solid var(--line);
  border-radius: 999px;
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
.uplift-box { text-align: right; flex-shrink: 0; }
.uplift {
  display: inline-block;
  font-size: 1.05rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--ok);
  background: var(--ok-soft);
  border-radius: 8px;
  padding: 0.12rem 0.55rem;
}
.uplift-sub { font-size: 0.74rem; color: var(--faint); margin-top: 0.15rem; }
.model-body { display: flex; flex-direction: column; gap: 0.9rem; flex: 1; margin-top: 0.75rem; }
/* Content stays top-aligned; links sit at the bottom so a row's buttons line up. */
.model-variants { display: flex; flex-direction: column; flex: 1; }
.clamp { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.desc { margin: 0; color: var(--muted); font-size: 0.9rem; -webkit-line-clamp: 3; line-clamp: 3; }
.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.65rem; }
.model-info .chips:first-child { margin-top: 0; }
.chip {
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
  background: var(--panel-2);
  color: var(--muted);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.05rem 0.55rem;
  cursor: pointer;
  white-space: nowrap;
}
.chip:hover { color: var(--text); border-color: var(--line-strong); }
.chip[class*="hue-"] {
  color: var(--hue);
  background: var(--panel-2);
  background: color-mix(in srgb, var(--hue) 12%, transparent);
}
.chip[class*="hue-"]:hover {
  color: var(--hue);
  border-color: color-mix(in srgb, var(--hue) 45%, transparent);
}
.hue-blue { --hue: var(--hue-blue); }
.hue-violet { --hue: var(--hue-violet); }
.hue-teal { --hue: var(--hue-teal); }
.hue-orange { --hue: var(--hue-orange); }
.hue-pink { --hue: var(--hue-pink); }
.hue-amber { --hue: var(--hue-amber); }
.hue-indigo { --hue: var(--hue-indigo); }
.hue-green { --hue: var(--hue-green); }
.hue-cyan { --hue: var(--hue-cyan); }
.hue-slate { --hue: var(--hue-slate); }
.variants { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; }
.variant { padding: 0.6rem 0.8rem; }
.variant + .variant { border-top: 1px solid var(--line); }
.variant-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.45rem; }
.variant-id { font-family: var(--mono); font-size: 0.84rem; overflow-wrap: anywhere; margin-right: 0.15rem; }
.variant-hw {
  margin-left: auto;
  padding-left: 0.5rem;
  font-size: 0.82rem;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.variant-desc { font-size: 0.8rem; color: var(--faint); margin-top: 0.2rem; -webkit-line-clamp: 2; line-clamp: 2; }
.badge {
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 600;
  line-height: 1.6;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 5px;
  padding: 0 0.4rem;
}
.badge-default { color: var(--warn); background: var(--warn-soft); }
.badge-optimized { color: var(--ok); background: var(--ok-soft); }
.badge-baseline { color: var(--info); background: var(--info-soft); }
.badge-deprecated { color: var(--bad); background: var(--bad-soft); }
.links { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: auto; padding-top: 0.75rem; }
.variant-hw-inline { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.84rem;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--line);
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
  border: 1px solid var(--line);
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
.t-variants { min-width: 360px; }
.t-tags { min-width: 190px; max-width: 280px; }
.t-tags .chips { margin-top: 0; }
.models-table td:first-child { min-width: 200px; }
/* Tags are searchable and filterable; the column only shows when there is room. */
@media (max-width: 1359px) { .t-tags { display: none; } }
.t-variant { display: flex; align-items: center; gap: 0.45rem; white-space: nowrap; }
.t-variant + .t-variant { margin-top: 0.35rem; }
.t-variant .variant-id { font-size: 0.82rem; }
/* Workload bars: rows share the container's columns, so labels, bars and
   digits line up. Bars are one hue, anchored left, rounded at the data end. */
.wl-bars {
  display: grid;
  grid-template-columns: auto minmax(56px, 1fr) minmax(4.6em, auto);
  align-items: center;
  column-gap: 0.6rem;
  row-gap: 0.3rem;
}
.wl-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
.wl-label { font-family: var(--mono); font-size: 0.76rem; color: var(--muted); white-space: nowrap; }
.wl-track { height: 8px; border-radius: 0 4px 4px 0; background: var(--panel-2); overflow: hidden; }
.wl-fill { display: block; height: 100%; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--ok); }
.wl-val { font-size: 0.86rem; font-variant-numeric: tabular-nums; text-align: right; color: var(--text); }
.wl-head .wl-val { font-weight: 700; }
.wl-ver { margin-top: 0.3rem; font-size: 0.76rem; color: var(--muted); text-align: right; }
.models-table .wl-bars { grid-template-columns: auto 64px minmax(4.6em, auto); width: max-content; margin-left: auto; text-align: left; }
.th-sub { display: block; font-size: 0.68rem; font-weight: 400; color: var(--faint); margin-top: 0.1rem; }
.t-links { display: grid; gap: 0.2rem; justify-items: start; }
.t-link { display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
.t-link svg { width: 14px; height: 14px; flex-shrink: 0; }
.none { color: var(--faint); }
/* footer.wrap, so .wrap's padding shorthand does not zero these. */
footer.wrap { padding-top: 2.5rem; padding-bottom: 3rem; font-size: 0.84rem; color: var(--faint); }
.nowrap { white-space: nowrap; }
.workloads { margin: 0 0 0.75rem; }
.workloads-cap { font-size: 0.72rem; color: var(--faint); margin-bottom: 0.35rem; }
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
  fs.writeFileSync(path.join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "assets/site.css"), CSS);
  fs.writeFileSync(path.join(outDir, "assets/site.js"), SITE_JS);
  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex(catalog));
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

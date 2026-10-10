#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {styleText, stripVTControlCharacters} = require("node:util");
const YAML = require("yaml");
const {root, compareVersions, isPrerelease} = require("./lib/catalog");
const {command, selectFiles, kubeconformArgs, failureLines, parseVersions} = require("./lib/helm-validation");
const config = require("../schema/crds/config.json");

function options(args) {
  const opts = {files: [], chartMode: "latest", output: path.join(root, "artifacts/helm-validation")};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--base", "--output", "--chart-mode"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg}: missing argument`);
      opts[arg === "--chart-mode" ? "chartMode" : arg.slice(2)] = args[++i];
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if (opts.base && opts.files.length) throw new Error("choose --base REF or explicit files, not both");
  // Nothing narrows it: every version file.
  opts.all = !opts.base && !opts.files.length;
  opts.output = path.resolve(root, opts.output);
  if (!["latest", "declared"].includes(opts.chartMode)) throw new Error("--chart-mode must be latest or declared");
  return opts;
}

function main(opts, {repositoryRoot = root, runCommand = command} = {}) {
  const root = repositoryRoot;
  fs.mkdirSync(opts.output, {recursive: true});
  // Each invocation has isolated Helm settings and a fresh repository snapshot.
  const runDir = fs.mkdtempSync(path.join(opts.output, "run-"));
  const chartMode = opts.chartMode ?? "latest";
  const summary = {config, chartMode, files: [], results: []};
  const writeSummary = () => {
    const body = JSON.stringify(summary, null, 2) + "\n";
    fs.writeFileSync(path.join(opts.output, "summary.json"), body);
    fs.writeFileSync(path.join(runDir, "summary.json"), body);
  };
  const log = (message = "") => {
    console.log(message);
    fs.appendFileSync(path.join(runDir, "validation.log"), stripVTControlCharacters(message) + "\n");
  };
  // Color only a terminal; validation.log stays plain.
  const paint = (format, text) => styleText(format, text, {stream: process.stdout});
  const marks = {pass: paint("green", "✓"), fail: paint("red", "✗"), warn: paint("yellow", "!"), skip: paint("dim", "-")};
  // Paths as a terminal in the working directory can open them.
  const shown = (file) => {
    const relative = path.relative(process.cwd(), file);
    return relative.startsWith("..") ? file : relative;
  };
  // One line stays beside its label; more go indented beneath it.
  const detail = (indent, label, text) => {
    const pad = " ".repeat(indent);
    const lines = Array.isArray(text) ? text : text.split("\n");
    if (lines.length === 1) return log(`${pad}${label} ${lines[0]}`);
    log(`${pad}${label}`);
    for (const line of lines) log(`${pad}  ${line}`);
  };
  // A variant's line: its status, the chart it was checked against and what
  // it declares; then why it warned, was skipped or failed.
  const report = (record, variant, width, problems, dir) => {
    const mark = record.skipped ? marks.skip : !record.ok ? marks.fail : record.warning ? marks.warn : marks.pass;
    const {chart} = record;
    const declared = variant.chart?.version;
    let line = `  ${mark} ${String(variant.id).padEnd(width)}  `;
    if (chart) {
      const resolved = [declared, chart.version].includes(chart.declaredVersion) ? "" : ` → ${chart.declaredVersion}`;
      line += `${chart.name}@${chart.version} ${paint("dim", `· declared ${declared}${resolved}`)}`;
    } else line += `${variant.chart?.name} ${declared}`;
    log(line);
    if (record.warning) {
      log(`      ${paint("yellow", `${record.warning}; ${record.skipped ? "its legacy chart cannot be rendered here" :
        "its values are still checked against the latest chart"}`)}`);
    }
    for (const [stage, lines] of problems) detail(6, paint("red", `${stage}:`), lines);
    if (problems.length) log(`      ${paint("dim", `logs: ${shown(dir)}`)}`);
  };
  const bin = (name) => {
    const installed = path.join(root, ".cache/helm-validation/bin", name);
    return fs.existsSync(installed) ? installed : name;
  };
  const env = {...process.env, HELM_CONFIG_HOME: path.join(runDir, "helm/config"),
    HELM_CACHE_HOME: path.join(runDir, "helm/cache"), HELM_DATA_HOME: path.join(runDir, "helm/data"),
    HELM_PLUGINS: path.join(runDir, "helm/plugins")};
  const invoke = (tool, args, dir, stage, options = {}) => {
    const result = runCommand(tool, args, {cwd: root, env, ...options});
    fs.writeFileSync(path.join(dir, `${stage}.log`), result.log);
    return result;
  };
  const requireSuccess = (result, stage) => {
    if (!result.ok) throw new Error(`${stage}: ${result.log}`);
    return result.stdout;
  };
  try {
    if (!["latest", "declared"].includes(chartMode)) throw new Error("chartMode must be latest or declared");
    log(paint("bold", `Helm validation: chart mode ${chartMode}, Kubernetes ${config.kubernetesVersion}`));
    const selection = selectFiles(root, opts);
    const added = new Set(selection.added);
    Object.assign(summary, selection, {runDirectory: path.relative(root, runDir)});
    const count = selection.files.length;
    log(`Selected ${count} version file${count === 1 ? "" : "s"}: ${selection.reason}` +
      `${selection.mergeBase ? ` (${selection.mergeBase})` : ""}`);
    if (!count) {
      log("No model version configuration changes (无版本配置变更).");
      return true;
    }
    log();
    for (const [name, args] of [["helm", ["version", "--short"]], ["kubeconform", ["-v"]]]) {
      const version = requireSuccess(invoke(bin(name), args, runDir, `${name}-version`), "tools").trim();
      if (!new RegExp(`^v${config[`${name}Version`].replaceAll(".", "\\.")}(?:\\+|$)`).test(version)) {
        throw new Error(`${name}: expected ${config[`${name}Version`]}, got ${version}; run npm run helm:install`);
      }
    }
    // CRD schemas are not committed: build them from the lock for this run,
    // which must not rewrite it.
    const schemaDir = path.join(runDir, "crds");
    // Several downloads, each allowed minutes: outlast them rather than kill the build.
    const built = requireSuccess(invoke(process.execPath, [path.join(__dirname, "build-crds.js"), "--locked", schemaDir], runDir, "crds",
      {timeout: 30 * 60 * 1000}), "crds");
    // Each schema is <group>/<kind>_<version>.json: the API versions Helm may render.
    const apis = fs.readdirSync(schemaDir).flatMap((group) => fs.readdirSync(path.join(schemaDir, group))
      .map((file) => `${group}/${file.slice(file.lastIndexOf("_") + 1, -".json".length)}`));
    log(paint("bold", "CRD schemas"));
    for (const line of built.split("\n").filter(Boolean)) log(`  ${line}`);
    log(`  Used by helm template, told these APIs exist (--api-versions): ${[...new Set(apis)].join(", ")}`);
    log(`  Used by kubeconform, checking custom resources against ` +
      `${shown(schemaDir)}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json`);
    log();
    const schemaCache = path.join(runDir, "schema-cache");
    fs.mkdirSync(schemaCache);
    requireSuccess(invoke(bin("helm"), ["repo", "add", "catalog", config.chartRepository], runDir, "chart-repository"), "chart-repository");
    const index = YAML.parse(fs.readFileSync(path.join(env.HELM_CACHE_HOME, "repository/catalog-index.yaml"), "utf8"));
    const requests = new Map();
    const resolutions = new Map();
    const packages = new Map();
    const chartDir = path.join(runDir, "charts");
    fs.mkdirSync(chartDir);
    function resolveChart(name, constraint, dir, stage, stableOnly = false) {
      const key = JSON.stringify([name, constraint, stableOnly]);
      if (!resolutions.has(key)) {
        const search = invoke(bin("helm"), ["search", "repo", `catalog/${name}`, "--versions", "--version", constraint, "--output", "json"], dir, stage);
        // Helm searches descriptions as well as names. Retain its version order
        // and require an exact name; latest checks never select prereleases.
        const matches = JSON.parse(requireSuccess(search, stage)).filter((m) =>
          m.name === `catalog/${name}` && (!stableOnly || !isPrerelease(m.version)));
        if (!matches.length) throw new Error(`chart.version: no published ${name} matches ${JSON.stringify(constraint)}${stableOnly ? " (stable releases only)" : ""}`);
        resolutions.set(key, matches[0].version);
      }
      return resolutions.get(key);
    }
    function chartFor(chart, dir) {
      const requestKey = JSON.stringify(chart);
      if (requests.has(requestKey)) {
        const cached = requests.get(requestKey);
        if (cached instanceof Error) throw cached;
        return cached;
      }
      try {
        const minimum = config.minimumChartVersions[chart.name];
        if (!minimum) throw new Error(`chart.name: unsupported chart ${chart.name}`);
        // Keep deployment declarations resolvable even when rendering against
        // latest. A missing declared release must still fail CI; one below the
        // minimum fails a new version only (see the variant loop).
        const declaredVersion = resolveChart(chart.name, chart.version, dir, "declared-chart-resolution");
        const legacy = compareVersions(declaredVersion, minimum) < 0;
        if (legacy && chartMode === "declared") {
          // Its chart renders API groups with no schema here: nothing to render.
          const pkg = {name: chart.name, declaredVersion, minimum, legacy};
          requests.set(requestKey, pkg);
          return pkg;
        }
        const selectionConstraint = chartMode === "latest" ? `>=${minimum}` : chart.version;
        const actualVersion = chartMode === "latest" ?
          resolveChart(chart.name, selectionConstraint, dir, "latest-chart-resolution", true) : declaredVersion;
        const key = `${chart.name}@${actualVersion}`;
        if (!packages.has(key)) {
          requireSuccess(invoke(bin("helm"), ["pull", `catalog/${chart.name}`, "--version", actualVersion, "--destination", chartDir], dir, "chart-download"), "chart-download");
          const archive = path.join(chartDir, `${chart.name}-${actualVersion}.tgz`);
          const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
          const published = index.entries[chart.name]?.find((entry) => entry.version === actualVersion);
          if (!published?.digest || digest !== published.digest) throw new Error(`chart-download: ${key}: repository digest mismatch`);
          const members = requireSuccess(invoke("tar", ["-tzf", archive], dir, "chart-package"), "chart-package").split("\n");
          if (!members.includes(`${chart.name}/values.schema.json`)) throw new Error(`${key}: published package is missing values.schema.json`);
          const metadata = YAML.parse(requireSuccess(invoke(bin("helm"), ["show", "chart", archive], dir, "chart-metadata"), "chart-metadata"));
          if (metadata.name !== chart.name || metadata.version !== actualVersion) throw new Error(`${key}: package metadata mismatch`);
          packages.set(key, {archive, name: chart.name, actualVersion, digest: `sha256:${digest}`});
        }
        const pkg = {...packages.get(key), declaredVersion, selectionConstraint, minimum, legacy};
        requests.set(requestKey, pkg);
        return pkg;
      } catch (err) {
        requests.set(requestKey, err);
        throw err;
      }
    }
    for (const file of selection.files) {
      log(paint("bold", file));
      let variants;
      try { variants = parseVersions(path.join(root, file)); }
      catch (err) {
        detail(2, `${marks.fail} ${paint("red", "parse:")}`, err.message);
        summary.results.push({file, stage: "parse", ok: false, error: err.message});
        continue;
      }
      const width = Math.max(...variants.map((variant) => String(variant.id).length));
      for (const [index, variant] of variants.entries()) {
        const hash = crypto.createHash("sha256").update(file).digest("hex").slice(0, 12);
        const dir = path.join(runDir, `${path.basename(file)}-${hash}`, variant.id);
        fs.mkdirSync(dir, {recursive: true});
        const record = {file, variant: variant.id, variantIndex: index, declaredChart: variant.chart,
          artifacts: path.relative(root, dir), stages: {}, ok: false};
        summary.results.push(record);
        const problems = [];
        let stage = "values";
        try {
          // JSON, not YAML: Helm reads YAML 1.1, where an unquoted on, no or yes is a boolean.
          const valuesFile = path.join(dir, "values.json");
          fs.writeFileSync(valuesFile, JSON.stringify(variant.values ?? {}, null, 2) + "\n");
          stage = "chart";
          const pkg = chartFor(variant.chart, dir);
          if (pkg.legacy) {
            const below = `${pkg.name} ${pkg.declaredVersion} is below the required minimum ${pkg.minimum}`;
            if (added.has(file)) throw new Error(`chart.version: ${below}`);
            // A published version keeps its chart; rewriting it to pass would
            // change the digest every existing deploy recorded.
            record.warning = `published version declares ${below}`;
            if (!pkg.archive) {
              record.skipped = true;
              continue;
            }
          }
          record.chart = {name: pkg.name, version: pkg.actualVersion, digest: pkg.digest,
            mode: chartMode, declaredVersion: pkg.declaredVersion, selectionConstraint: pkg.selectionConstraint};
          fs.writeFileSync(path.join(dir, "chart.json"), JSON.stringify(record.chart, null, 2) + "\n");
          const shared = ["--values", path.join(root, "schema/crds/ci-values.yaml"), "--values", valuesFile,
            "--kube-version", config.kubernetesVersion];
          // Run both stages even when lint fails: template can expose separate failures.
          stage = "lint";
          const lint = invoke(bin("helm"), ["lint", pkg.archive, "--strict", ...shared], dir, "lint");
          record.stages.lint = lint.ok;
          if (!lint.ok) problems.push(["lint", failureLines(lint)]);
          stage = "template";
          const template = invoke(bin("helm"), ["template", "catalog-ci", pkg.archive, "--namespace", "ci", ...shared,
            ...apis.flatMap((api) => ["--api-versions", api])], dir, "template");
          record.stages.template = template.ok;
          if (!template.ok) problems.push(["template", failureLines(template)]);
          const rendered = path.join(dir, "rendered.yaml");
          fs.writeFileSync(rendered, template.stdout);
          if (template.ok) {
            // An empty render must not turn a broken chart into a successful check.
            stage = "template";
            const docs = YAML.parseAllDocuments(template.stdout);
            if (docs.some((d) => d.errors.length) || !docs.some((d) => d.toJS()?.kind)) {
              record.stages.template = false;
              throw new Error("no Kubernetes resources or malformed rendered YAML");
            }
            stage = "kubeconform";
            const kube = invoke(bin("kubeconform"), kubeconformArgs(config, schemaDir, schemaCache, rendered), dir, "kubeconform");
            record.stages.kubeconform = kube.ok;
            if (!kube.ok) problems.push(["kubeconform", failureLines(kube)]);
          }
          record.ok = ["lint", "template", "kubeconform"].every((name) => record.stages[name] === true);
        } catch (err) {
          record.error = err.message;
          record.stage = stage;
          fs.writeFileSync(path.join(dir, "error.log"), `[${stage}] ${err.message}\n`);
          problems.push([stage, err.message.split("\n")]);
        } finally {
          report(record, variant, width, problems, dir);
        }
      }
    }
    const failed = summary.results.filter((r) => !r.ok && !r.skipped);
    const skipped = summary.results.filter((r) => r.skipped).length;
    const warned = summary.results.filter((r) => r.ok && r.warning).length;
    if (packages.size) {
      log();
      log(paint("bold", "Charts"));
      const width = Math.max(...[...packages.keys()].map((key) => key.length));
      for (const [key, pkg] of packages) log(`  ${key.padEnd(width)}  ${pkg.digest}`);
    }
    if (failed.length) {
      log();
      log(paint("bold", "Failed"));
      for (const r of failed) {
        const stages = new Set([...Object.keys(r.stages ?? {}).filter((name) => r.stages[name] === false), ...(r.stage ? [r.stage] : [])]);
        log(`  ${marks.fail} ${r.file}${r.variant ? ` :: ${r.variant}` : ""} ${paint("dim", `(${[...stages].join(", ")})`)}`);
      }
    }
    const passed = summary.results.length - failed.length - skipped;
    log();
    log(paint(failed.length ? "red" : "green", `${summary.results.length} checks: ` +
      `${passed} passed${warned ? ` (${warned} with warnings)` : ""}, ${failed.length} failed${skipped ? `, ${skipped} skipped` : ""}`));
    log(`Artifacts: ${shown(runDir)}`);
    return failed.length === 0;
  } catch (err) {
    summary.error = err.message;
    detail(0, `${marks.fail} ${paint("red", "setup:")}`, err.message);
    return false;
  } finally { writeSummary(); }
}

if (require.main === module) {
  try { process.exitCode = main(options(process.argv.slice(2))) ? 0 : 1; }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = {options, main};

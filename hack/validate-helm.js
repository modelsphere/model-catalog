#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const YAML = require("yaml");
const {root} = require("./lib/catalog");
const {command, selectFiles, variantValues, kubeconformArgs, parseVersions} = require("./lib/helm-validation");
const config = require("../schema/helm/config.json");

function options(args) {
  const opts = {files: [], output: path.join(root, "artifacts/helm-validation")};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") opts.all = true;
    else if (["--base", "--output"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg}: missing argument`);
      opts[arg.slice(2)] = args[++i];
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if ([Boolean(opts.all), Boolean(opts.base), Boolean(opts.files.length)].filter(Boolean).length > 1) {
    throw new Error("choose one of --all, --base REF, or explicit files");
  }
  opts.output = path.resolve(root, opts.output);
  return opts;
}

function main(opts, {repositoryRoot = root, runCommand = command} = {}) {
  const root = repositoryRoot;
  fs.mkdirSync(opts.output, {recursive: true});
  // Each invocation has isolated Helm settings and a fresh repository snapshot.
  const runDir = fs.mkdtempSync(path.join(opts.output, "run-"));
  const summary = {config, files: [], results: []};
  const writeSummary = () => {
    const body = JSON.stringify(summary, null, 2) + "\n";
    fs.writeFileSync(path.join(opts.output, "summary.json"), body);
    fs.writeFileSync(path.join(runDir, "summary.json"), body);
  };
  const log = (message) => {
    console.log(message);
    fs.appendFileSync(path.join(runDir, "validation.log"), message + "\n");
  };
  const bin = (name) => {
    const installed = path.join(root, ".cache/helm-validation/bin", name);
    return fs.existsSync(installed) ? installed : name;
  };
  const env = {...process.env, HELM_CONFIG_HOME: path.join(runDir, "helm/config"),
    HELM_CACHE_HOME: path.join(runDir, "helm/cache"), HELM_DATA_HOME: path.join(runDir, "helm/data"),
    HELM_PLUGINS: path.join(runDir, "helm/plugins")};
  const invoke = (tool, args, dir, stage) => {
    const result = runCommand(tool, args, {cwd: root, env});
    fs.writeFileSync(path.join(dir, `${stage}.log`), result.log);
    return result;
  };
  const requireSuccess = (result, stage) => {
    if (!result.ok) throw new Error(`${stage}: ${result.log}`);
    return result.stdout;
  };
  try {
    const selection = selectFiles(root, opts);
    Object.assign(summary, selection, {runDirectory: path.relative(root, runDir)});
    log(`Selection: ${selection.reason}${selection.mergeBase ? ` (${selection.mergeBase})` : ""}`);
    if (!selection.files.length) {
      log("No model version configuration changes (无版本配置变更).");
      return true;
    }
    log(`Validating ${selection.files.length} version files; Kubernetes ${config.kubernetesVersion}.`);
    for (const [name, args] of [["helm", ["version", "--short"]], ["kubeconform", ["-v"]]]) {
      const version = requireSuccess(invoke(bin(name), args, runDir, `${name}-version`), "tools").trim();
      if (!new RegExp(`^v${config[`${name}Version`].replaceAll(".", "\\.")}(?:\\+|$)`).test(version)) {
        throw new Error(`${name}: expected ${config[`${name}Version`]}, got ${version}; run npm run helm:install`);
      }
    }
    const schemaDir = path.join(root, "schema/helm/crds");
    const provenance = JSON.parse(fs.readFileSync(path.join(root, "schema/helm/provenance.json"), "utf8"));
    if (provenance.converterVersion !== config.converterVersion) throw new Error("CRD converter version mismatch");
    const apis = [...new Set(provenance.sources.flatMap((source) => source.schemas.map((s) => `${s.group}/${s.version}`)))];
    const schemaCache = path.join(runDir, "schema-cache");
    fs.mkdirSync(schemaCache);
    requireSuccess(invoke(bin("helm"), ["repo", "add", "catalog", config.chartRepository], runDir, "chart-repository"), "chart-repository");
    const index = YAML.parse(fs.readFileSync(path.join(env.HELM_CACHE_HOME, "repository/catalog-index.yaml"), "utf8"));
    const requests = new Map();
    const packages = new Map();
    const chartDir = path.join(runDir, "charts");
    fs.mkdirSync(chartDir);
    function chartFor(chart, dir) {
      const requestKey = JSON.stringify(chart);
      if (requests.has(requestKey)) {
        const cached = requests.get(requestKey);
        if (cached instanceof Error) throw cached;
        return cached;
      }
      try {
        const search = invoke(bin("helm"), ["search", "repo", `catalog/${chart.name}`, "--versions", "--version", chart.version, "--output", "json"], dir, "chart-resolution");
        // Helm searches descriptions as well as names. Restrict its results to
        // the exact declared chart, retaining Helm's version precedence.
        const matches = JSON.parse(requireSuccess(search, "chart-resolution")).filter((m) => m.name === `catalog/${chart.name}`);
        if (!matches.length) throw new Error(`chart.version: no published ${chart.name} matches ${JSON.stringify(chart.version)}`);
        const actualVersion = matches[0].version;
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
        const pkg = packages.get(key);
        requests.set(requestKey, pkg);
        return pkg;
      } catch (err) {
        requests.set(requestKey, err);
        throw err;
      }
    }
    for (const file of selection.files) {
      let variants;
      try { variants = parseVersions(path.join(root, file)); }
      catch (err) {
        log(`FAIL ${file} [parse]: ${err.message}`);
        summary.results.push({file, stage: "parse", ok: false, error: err.message});
        continue;
      }
      for (const [index, variant] of variants.entries()) {
        const label = `${file} :: ${variant.id} (variants[${index}])`;
        const hash = crypto.createHash("sha256").update(file).digest("hex").slice(0, 12);
        const dir = path.join(runDir, `${path.basename(file)}-${hash}`, variant.id);
        fs.mkdirSync(dir, {recursive: true});
        const record = {file, variant: variant.id, variantIndex: index, declaredChart: variant.chart,
          artifacts: path.relative(root, dir), stages: {}, ok: false};
        summary.results.push(record);
        let stage = "values";
        try {
          const {values, injected} = variantValues(variant);
          record.injectedRouteConfig = injected;
          if (injected) log(`${label}: supplying absent values.modelRoute.nginx.outputConfigMap=ci/openresty-conf`);
          const valuesFile = path.join(dir, "values.yaml");
          fs.writeFileSync(valuesFile, YAML.stringify(values));
          stage = "chart";
          const pkg = chartFor(variant.chart, dir);
          record.chart = {name: pkg.name, version: pkg.actualVersion, digest: pkg.digest};
          log(`${label}: chart ${pkg.name}@${pkg.actualVersion} ${pkg.digest}`);
          fs.writeFileSync(path.join(dir, "chart.json"), JSON.stringify(record.chart, null, 2) + "\n");
          const shared = ["--values", valuesFile, "--kube-version", config.kubernetesVersion];
          // Run both stages even when lint fails: template can expose separate failures.
          stage = "lint";
          const lint = invoke(bin("helm"), ["lint", pkg.archive, "--strict", ...shared], dir, "lint");
          record.stages.lint = lint.ok;
          if (!lint.ok) log(`FAIL ${label} [lint]:\n${lint.log}`);
          stage = "template";
          const template = invoke(bin("helm"), ["template", "catalog-ci", pkg.archive, "--namespace", "ci", ...shared,
            ...apis.flatMap((api) => ["--api-versions", api])], dir, "template");
          record.stages.template = template.ok;
          if (!template.ok) log(`FAIL ${label} [template]:\n${template.log}`);
          const rendered = path.join(dir, "rendered.yaml");
          fs.writeFileSync(rendered, template.stdout);
          if (template.ok) {
            // An empty render must not turn a broken chart into a successful check.
            stage = "template";
            const docs = YAML.parseAllDocuments(template.stdout);
            if (docs.some((d) => d.errors.length) || !docs.some((d) => d.toJS()?.kind)) {
              record.stages.template = false;
              throw new Error("template: no Kubernetes resources or malformed rendered YAML");
            }
            stage = "kubeconform";
            const kube = invoke(bin("kubeconform"), kubeconformArgs(config, schemaDir, schemaCache, rendered), dir, "kubeconform");
            record.stages.kubeconform = kube.ok;
            if (!kube.ok) log(`FAIL ${label} [kubeconform]:\n${kube.log}`);
          }
          record.ok = ["lint", "template", "kubeconform"].every((name) => record.stages[name] === true);
          if (record.ok) log(`PASS ${label}`);
        } catch (err) {
          record.error = err.message;
          record.stage = stage;
          fs.writeFileSync(path.join(dir, "error.log"), `[${stage}] ${err.message}\n`);
          log(`FAIL ${label} [${stage}]: ${err.message}`);
        }
      }
    }
    const failed = summary.results.filter((r) => !r.ok).length;
    log(`${summary.results.length} checks: ${summary.results.length - failed} passed, ${failed} failed. Artifacts: ${runDir}`);
    return failed === 0;
  } catch (err) {
    summary.error = err.message;
    log(`FAIL [setup]: ${err.message}`);
    return false;
  } finally { writeSummary(); }
}

if (require.main === module) {
  try { process.exitCode = main(options(process.argv.slice(2))) ? 0 : 1; }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = {options, main};

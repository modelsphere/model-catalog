"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const YAML = require("yaml");

function isVersionFile(file) {
  return /^models\/[^/]+\/[^/]+\.ya?ml$/.test(file) && !/\/metadata\.ya?ml$/.test(file);
}

function affectsValidator(file) {
  return file.startsWith("schema/crds/") ||
    /^hack\/(validate-helm|install-helm-tools|build-crds)(\.integration)?\.(js|test\.js)$/.test(file) ||
    /^hack\/lib\/(helm-validation|crd-schema|download|catalog)(\.test)?\.js$/.test(file) ||
    ["package.json", "package-lock.json", ".github/workflows/lint.yml"].includes(file);
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options});
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {stdout, stderr, ok: result.status === 0 && !result.error,
    log: `$ ${bin} ${args.map((a) => JSON.stringify(a)).join(" ")}\n${stdout}${stderr}` +
      (result.error ? `\n${result.error.message}\n` : "") + `\nexit: ${result.status}, signal: ${result.signal ?? "none"}\n`};
}

function git(root, args) {
  const result = command("git", args, {cwd: root});
  if (!result.ok) throw new Error(result.log);
  return result.stdout;
}

function allVersionFiles(root) {
  function walk(dir) {
    return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap((entry) => {
      const file = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(file) : isVersionFile(file) ? [file] : [];
    });
  }
  return walk("models").sort();
}

// Keep both sides of renames for validator-change detection. NUL delimiters
// preserve filenames with whitespace; missing old/deleted model paths are excluded.
// `added` lists the new versions, held to the chart minimum: a published version
// keeps the chart it was published with. Explicit files are checked as new.
function selectFiles(root, {all = false, base = "origin/HEAD", files = []} = {}) {
  if (all) return {files: allVersionFiles(root), added: [], reason: "--all"};
  if (files.length) {
    const selected = files.map((file) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/"));
    if (selected.some((file) => !isVersionFile(file) || !fs.existsSync(path.join(root, file)))) {
      throw new Error("explicit files must be existing model version YAMLs under models/");
    }
    const unique = [...new Set(selected)].sort();
    return {files: unique, added: unique, reason: "explicit files"};
  }
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const tokens = git(root, ["diff", "--name-status", "-z", "--find-renames", mergeBase, "HEAD"]).split("\0");
  const changed = [];
  const added = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    changed.push(tokens[i++]);
    if (/^[RC]/.test(status)) changed.push(tokens[i++]);
    if (/^[ARC]/.test(status)) added.push(changed.at(-1));
  }
  const versions = (list) => [...new Set(list.filter((file) => isVersionFile(file) && fs.existsSync(path.join(root, file))))].sort();
  if (changed.some(affectsValidator)) {
    return {files: allVersionFiles(root), added: versions(added), reason: "validator/dependency/schema changes", mergeBase};
  }
  return {files: versions(changed), added: versions(added), reason: `changes since merge-base with ${base}`, mergeBase};
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function variantValues(variant) {
  const values = variant.values === undefined ? {} : structuredClone(variant.values);
  if (!isObject(values)) throw new Error("variants[].values: must be an object");
  let injected = false;
  if (values.modelRoute === undefined) values.modelRoute = {};
  if (isObject(values.modelRoute)) {
    if (values.modelRoute.nginx === undefined) values.modelRoute.nginx = {};
    if (isObject(values.modelRoute.nginx) && !Object.hasOwn(values.modelRoute.nginx, "outputConfigMap")) {
      values.modelRoute.nginx.outputConfigMap = "ci/openresty-conf";
      injected = true;
    }
  }
  return {values, injected};
}

function kubeconformArgs(config, schemaDir, cacheDir, rendered) {
  // Local schemas use the FULL group. Native schemas also enforce apiVersion
  // and kind enums, so a similarly named unknown CR cannot pass as a native kind.
  return ["-strict", "-summary", "-verbose", "-output", "json", "-kubernetes-version", config.kubernetesVersion,
    "-cache", cacheDir,
    "-schema-location", `${schemaDir}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json`,
    "-schema-location", `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${config.kubernetesSchemaCommit}/` +
      "{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json", rendered];
}

function parseVersions(file) {
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(doc?.variants) || !doc.variants.length) throw new Error("variants: expected a nonempty array");
  const ids = new Set();
  for (const [index, variant] of doc.variants.entries()) {
    if (!isObject(variant) || typeof variant.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(variant.id)) {
      throw new Error(`variants[${index}].id: invalid variant id`);
    }
    if (ids.has(variant.id)) throw new Error(`variants[${index}].id: duplicate ${variant.id}`);
    ids.add(variant.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(variant.chart?.name ?? "") ||
        typeof variant.chart?.version !== "string" || !variant.chart.version.trim()) {
      throw new Error(`variants[${index}].chart: expected name and version constraint`);
    }
  }
  return doc.variants;
}

module.exports = {command, selectFiles, isVersionFile, affectsValidator, variantValues, kubeconformArgs, parseVersions};

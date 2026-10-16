"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("yaml");
const { schemaValidator, compareVersions } = require("./catalog");
const schemaFor = schemaValidator();
const validateVersion = schemaFor("version.schema.json");
const validateVariant = schemaFor("variant.schema.json");
const isV2 = (doc) => doc.apiVersion === "catalog.swiss/v2";

function check(ok, message) {
  if (!ok) throw new Error(message);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  }
  return value;
}
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const bytesHash = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
function filesAt(ref) {
  check(/^[a-f0-9]{40}$/.test(ref), "Expected a full commit SHA");
  return git("ls-tree", "-r", "--name-only", ref, "--", "models")
    .trim()
    .split("\n")
    .filter((p) => /^models\/[^/]+\/[^/]+\.yaml$/.test(p) && !p.endsWith("/metadata.yaml"));
}
function readAt(ref, file) {
  // Read blobs, never check out or execute PR-controlled files (including symlinks).
  check(git("ls-tree", ref, "--", file).startsWith("100644 blob "), `Not a regular file: ${file}`);
  return git("show", `${ref}:${file}`);
}
function documentsAt(ref) {
  return filesAt(ref).map((file) => {
    const text = readAt(ref, file);
    const doc = yaml.parse(text);
    check((isV2(doc) ? validateVariant : validateVersion)(doc), `Version schema failed: ${file}`);
    return { file, doc, catalog_sha256: bytesHash(text) };
  });
}
function validationEntries(row, manifest, rows = [row]) {
  if (isV2(row.doc)) return validationEntriesV2(row, manifest, rows);
  check(manifest?.schema_version === 1 && Array.isArray(manifest.variants), "Invalid validation.json schema");
  check(manifest.catalog_file === row.file.split("/").at(-1), "validation.json names a different catalog file");
  check(
    /^[a-f0-9]{64}$/.test(manifest.catalog_sha256 || "") && manifest.catalog_sha256 === row.catalog_sha256,
    "Catalog YAML digest differs from validation.json; export both files again",
  );
  const ids = new Set(row.doc.variants.map((v) => v.id));
  const entries = new Map();
  for (const entry of manifest.variants) {
    check(ids.has(entry.variant_id) && !entries.has(entry.variant_id), "Unknown or duplicate validation variant");
    check(typeof entry.track_slug === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(entry.track_slug), "Invalid original track slug");
    check(Number.isSafeInteger(entry.source_run_id) && entry.source_run_id > 0, "Invalid source run id");
    check(["baseline", "optimized"].includes(entry.role), "Invalid validation variant role");
    entries.set(entry.variant_id, entry);
  }
  return entries;
}
function validationEntriesV2(row, manifest, rows) {
  check(manifest?.schema_version === 2 && Array.isArray(manifest.variants), "Invalid validation.json schema");
  check(manifest.model === row.doc.model, "validation.json names a different model");
  const variants = new Map(rows.filter((r) => isV2(r.doc) && r.doc.model === manifest.model).map((r) => [r.doc.id, r]));
  const entries = new Map();
  for (const entry of manifest.variants) {
    const source = variants.get(entry.variant_id);
    check(source && !entries.has(entry.variant_id), "Unknown or duplicate validation variant");
    check(
      entry.file === `${source.doc.id}.yaml` && source.file === `models/${manifest.model}/${entry.file}`,
      "validation.json names a different variant file path",
    );
    check(entry.version === source.doc.version, "Variant version differs from validation.json");
    // Baseline Hub v2 hashes the parsed document, not YAML formatting or comments.
    check(
      /^[a-f0-9]{64}$/.test(entry.content_sha256 || "") && entry.content_sha256 === hash(source.doc),
      "Variant content digest differs from validation.json; export both files again",
    );
    check(typeof entry.track_slug === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(entry.track_slug), "Invalid original track slug");
    check(Number.isSafeInteger(entry.source_run_id) && entry.source_run_id > 0, "Invalid source run id");
    check(["baseline", "optimized"].includes(entry.role), "Invalid validation variant role");
    entries.set(entry.variant_id, entry);
  }
  return entries;
}
function signature(doc, variant) {
  const { id, default: preferred, description, link, ...config } = variant;
  return hash({ servedName: doc.servedName || doc.name, config });
}
function plan(base, head, readManifest) {
  const result = planV1(
    base.filter((r) => !isV2(r.doc)),
    head.filter((r) => !isV2(r.doc)),
    readManifest,
  );
  const old = new Map(base.map((row) => [row.file, row]));
  const manifests = new Map();
  for (const row of head.filter((r) => isV2(r.doc))) {
    const { file, doc } = row;
    check(file === `models/${doc.model}/${doc.id}.yaml`, `Wrong variant path: ${file}`);
    const previous = old.get(file);
    if (previous) {
      check(isV2(previous.doc), `Cannot replace a v1 version file with a v2 variant: ${file}`);
      if (hash(previous.doc) === hash(doc)) continue;
      check(compareVersions(doc.version, previous.doc.version) > 0, `Changed variant must raise version above ${previous.doc.version}: ${file}`);
    }
    const sidecar = `models/${doc.model}/${doc.model}.validation.json`;
    if (!manifests.has(sidecar)) manifests.set(sidecar, validationEntries(row, readManifest(sidecar), head));
    const entry = manifests.get(sidecar).get(doc.id);
    check(entry, `Missing validation entry: ${file}/${doc.id}`);
    if (entry.role === "baseline") continue;
    result.push({
      file,
      doc: { name: doc.model, servedName: doc.servedName },
      variant: doc,
      track: entry.track_slug,
      source_run_id: entry.source_run_id,
    });
  }
  return result;
}
function planV1(base, head, readManifest) {
  const published = new Map();
  for (const { doc } of base) {
    for (const v of doc.variants) {
      const key = `${doc.name}/${v.id}`;
      if (!published.has(key)) published.set(key, new Set());
      published.get(key).add(signature(doc, v));
    }
  }
  const oldFiles = new Map(base.map((row) => [row.file, hash(row.doc)]));
  const result = [];
  for (const row of head) {
    const { file, doc } = row;
    check(doc.apiVersion === "catalog.swiss/v1", `Invalid version document: ${file}`);
    check(file === `models/${doc.name}/${doc.name}-${doc.version}.yaml`, `Wrong version path: ${file}`);
    if (oldFiles.has(file)) {
      check(oldFiles.get(file) === hash(doc), `Published version is immutable: ${file}`);
      continue;
    }
    const ids = new Set();
    let entries;
    for (const variant of doc.variants) {
      check(!ids.has(variant.id), `Duplicate variant: ${file}/${variant.id}`);
      ids.add(variant.id);
      const old = published.get(`${doc.name}/${variant.id}`);
      if (old) {
        check(old.has(signature(doc, variant)), `Changed existing variant ${variant.id}: assign a new id`);
        continue; // A copied baseline is not a new variant.
      }
      entries ||= validationEntries(row, readManifest(file.replace(/\.yaml$/, ".validation.json")));
      const entry = entries.get(variant.id);
      check(entry, `Missing validation entry: ${file}/${variant.id}`);
      if (entry.role === "baseline") continue;
      result.push({ file, doc, variant, track: entry.track_slug, source_run_id: entry.source_run_id });
    }
  }
  return result;
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function convert(item) {
  const { doc, variant: v } = item;
  check(["sglang", "vllm"].includes(v.engine), "Unsupported engine");
  check(v.image?.repository && v.image?.tag, "An explicit engine image is required");
  // Baseline Hub submissions use the registered repository:tag reference.
  // Keep the export's digest in the document and its validation hash.
  const image = `${v.image.repository}:${v.image.tag}`;
  const values = v.values || {};
  for (const key of Object.keys(values.model || {})) {
    check(["contextLength", "mountPath", "hostPathType"].includes(key), `Unsupported model value: ${key}`);
  }
  // These are chart lifecycle / placement settings, outside this engine replay's scope.
  const supported = new Set([
    "model",
    "extraArgs",
    "env",
    "volumes",
    "volumeMounts",
    "lws",
    "modelCheck",
    "resources",
    "startupProbe",
    "readinessProbe",
    "livenessProbe",
    "progressDeadlineSeconds",
    "terminationGracePeriodSeconds",
    "lifecycle",
    "hangWatcher",
  ]);
  for (const key of Object.keys(values)) check(supported.has(key), `Unsupported chart value: ${key}`);
  const args = values.extraArgs || [];
  check(Array.isArray(args) && args.every((x) => typeof x === "string"), "extraArgs must be strings");
  const placement = /^(?:--(?:model(?:-path)?|served-model-name|host|port|nccl-port|dist-init-addr|nccl-init-addr|node-rank|nnodes))(?:=|$)/;
  check(!args.some((x) => placement.test(x)), "Placement flags must not override the original track");
  const context = values.model?.contextLength;
  const words = v.engine === "sglang" ? ["sglang", "serve", "--model-path", "/model"] : ["vllm", "serve", "/model"];
  words.push(...args);
  if (context) words.push(v.engine === "sglang" ? `--context-length=${context}` : `--max-model-len=${context}`);
  const extra_env = {};
  for (const env of values.env || []) {
    check(typeof env.name === "string" && Object.hasOwn(env, "value") && !env.valueFrom, "env.valueFrom is not supported");
    check(!Object.hasOwn(extra_env, env.name), `Duplicate env: ${env.name}`);
    extra_env[env.name] = String(env.value);
  }
  const volumes = new Map((values.volumes || []).map((v) => [v.name, v]));
  const extra_volumes = {};
  for (const mount of values.volumeMounts || []) {
    const volume = volumes.get(mount.name);
    check(volume && !mount.subPath && !mount.subPathExpr, `Unsupported mount: ${mount.name}`);
    if (volume.emptyDir && ["/dev/shm", "/root/.cache"].includes(mount.mountPath)) continue;
    check(volume.hostPath?.path && mount.mountPath && mount.mountPath !== "/model", `Unsupported volume: ${mount.name}`);
    check(!Object.hasOwn(extra_volumes, volume.hostPath.path), "Repeated host path cannot be represented");
    extra_volumes[volume.hostPath.path] = `${mount.mountPath}${mount.readOnly ? ":ro" : ""}`;
  }
  const nodes = v.requires.nodes || 1;
  check(Number.isInteger(nodes) && nodes > 0, "Invalid node count");
  check(!values.lws?.size || values.lws.size === nodes, "Node count differs from lws.size");
  check((v.requires.vendor || "nvidia") === "nvidia", "Only NVIDIA track replay is supported");
  return { image, command: words.map(quote).join(" "), extra_env, extra_volumes, machine_count: nodes };
}
const GPU_PRODUCTS = {
  A100: ["NVIDIA-A100-SXM4-80GB"],
  H100: ["NVIDIA-H100-80GB-HBM3"],
  H800: ["NVIDIA-H800"],
  B300: ["NVIDIA-B300-SXM6-AC"],
};
function verifyTrack(item, body, track) {
  check(!["draft", "retired"].includes(track.status), `Track ${item.track} does not accept submissions`);
  check(track.served_model_name === (item.doc.servedName || item.doc.name), "Original track serves a different model");
  check(
    track.images.some((i) => i.image === body.image && i.engine === item.variant.engine),
    `Image repository:tag and engine must be registered on track ${item.track}`,
  );
  const products = item.variant.requires.gpuProduct;
  check(
    products?.some((p) => GPU_PRODUCTS[track.gpu_type]?.includes(p)),
    "Catalog GPU product does not match original track",
  );
}
function verdict(submission) {
  if (["queued", "running"].includes(submission.status)) return "pending";
  if (submission.status !== "measured") return "failed";
  const m = submission.latest_measurement;
  return m?.passed === true && m.feasible !== false ? "passed" : "failed";
}

module.exports = { check, hash, bytesHash, git, readAt, documentsAt, plan, validationEntries, convert, verifyTrack, verdict };

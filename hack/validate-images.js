#!/usr/bin/env node
// Check every image the catalog names can be pulled anonymously, by tag and by
// any digest it pins, and that each tuned pair's perf report measured the
// builds its two variants run. Each image is logged as ok, warning (its tag
// has moved off a pinned digest that is still pullable) or error. Registries
// are asked through crane, which npm run tools:install pins.
//
//   npm run validate:images                           # the whole catalog
//   npm run validate:images -- models/x/x-1.0.0.yaml  # only these files
//   npm run validate:images -- --base origin/master   # only what a branch adds or changes
//   npm run validate:images -- --match-digest         # and each pinned digest is what its tag resolves to now
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const YAML = require("yaml");
const { spawnSync } = require("node:child_process");
const { root, modelNames, versionFiles, variantFiles, kindOf, schemaOf, historiesOf } = require("./lib/catalog");
const { checkImage, reportMismatches, changedVersionFiles } = require("./lib/images");
const { paint, marks, plural } = require("./lib/style");

function parse(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: "string" }, "match-digest": { type: "boolean", default: false } },
  });
  const { base, "match-digest": matchDigest } = values;
  const files = positionals.map((file) => path.relative(root, path.resolve(file)).split(path.sep).join("/"));
  if (base && files.length) throw new Error("choose --base REF or explicit files, not both");
  if (base) return { files: changedVersionFiles(root, base), matchDigest, reason: `changes since merge-base with ${base}` };
  const versions = modelNames().flatMap((name) => [...versionFiles(name), ...variantFiles(name)]);
  if (!files.length) return { files: versions, matchDigest, reason: "every version and variant file" };
  const unknown = files.filter((f) => !versions.includes(f));
  if (unknown.length) throw new Error(`not a model version or variant file: ${unknown.join(", ")}`);
  return { files, matchDigest, reason: "explicit files" };
}

async function main() {
  const { files, matchDigest, reason } = parse(process.argv.slice(2));
  console.log(
    paint("bold", `Image validation: pulled anonymously by tag and pinned digest${matchDigest ? ", each pinned digest matching its tag" : ""}`),
  );
  console.log(`Selected ${plural(files.length, "version or variant file")}: ${reason}`);
  if (files.length === 0) {
    console.log("No model version or variant configuration changes (无版本配置变更).");
    return 0;
  }

  const docs = new Map(files.map((file) => [file, YAML.parse(fs.readFileSync(path.join(root, file), "utf8"))]));
  const variantsOf = (doc) => (kindOf(doc) === "variant" ? [doc] : (doc?.variants ?? []));

  // Each distinct image once, however many variants share it.
  const uses = new Map();
  for (const [file, doc] of docs) {
    for (const v of variantsOf(doc)) {
      if (!v?.image?.repository) continue;
      const key = JSON.stringify([v.image.repository, String(v.image.tag ?? "latest"), v.image.digest ?? ""]);
      if (!uses.has(key)) uses.set(key, []);
      uses.get(key).push({ file, id: v.id });
    }
  }

  const results = new Map();
  const keys = [...uses.keys()];
  const refOf = (key) => {
    const [repository, tag, digest] = JSON.parse(key);
    return `${repository}:${tag}${digest ? `@${digest}` : ""}`;
  };
  const failed = [];
  console.log();
  console.log(paint("bold", "Images"));
  // A few at a time: enough to be quick, few enough not to trip rate limits.
  for (let i = 0; i < keys.length; i += 4) {
    const batch = keys.slice(i, i + 4);
    await Promise.all(
      batch.map(async (key) => {
        const [repository, tag, digest] = JSON.parse(key);
        results.set(key, await checkImage({ repository, tag, digest }, { matchDigest }));
      }),
    );
    // An image's line: its status and reference, then what was found. A
    // warning or failure goes beneath it, with the variants a failure blocks.
    for (const key of batch) {
      const { level, message } = results.get(key);
      const ref = refOf(key);
      const found = message.startsWith(`${ref}: `) ? message.slice(ref.length + 2) : message;
      if (level === "ok") {
        console.log(`  ${marks.pass} ${ref}  ${paint("dim", found)}`);
      } else if (level === "warning") {
        console.log(`  ${marks.warn} ${ref}`);
        console.log(`      ${paint("yellow", found)}`);
      } else {
        failed.push(ref);
        console.log(`  ${marks.fail} ${ref}`);
        console.log(`      ${paint("red", found)}`);
        console.log(
          `      ${paint(
            "dim",
            `used by ${uses
              .get(key)
              .map(({ file, id }) => `${file} :: ${id}`)
              .join(", ")}`,
          )}`,
        );
      }
    }
  }

  // Tuned pairs of the selected versions. A missing report or variant is
  // validate:schema's to report.
  const checked = [];
  let histories;
  const measured = (name, ref) => {
    const [id, version] = String(ref ?? "").split("@");
    const rel = `models/${name}/${id}.yaml`;
    const now = docs.get(rel) ?? (fs.existsSync(path.join(root, rel)) ? YAML.parse(fs.readFileSync(path.join(root, rel), "utf8")) : undefined);
    if (String(now?.version) === version) return now;
    histories ??= historiesOf();
    const commit = histories.get(rel)?.revisions.find((r) => r.version === version)?.commit;
    const r = commit && spawnSync("git", ["show", `${commit}:${rel}`], { cwd: root, encoding: "utf8" });
    return r?.status === 0 ? YAML.parse(r.stdout) : undefined;
  };
  for (const name of new Set([...docs.keys()].map((file) => file.split("/")[1]))) {
    const meta = `models/${name}/metadata.yaml`;
    const metadata = YAML.parse(fs.readFileSync(path.join(root, meta), "utf8"));
    const v2 = schemaOf(metadata) === "v2";
    (metadata?.tuning ?? []).forEach((t, i) => {
      const doc = [...docs].find(([file, d]) => file.split("/")[1] === name && String(d?.version) === String(t?.version))?.[1];
      const variant = (key) => (v2 ? measured(name, t?.[key]) : doc?.variants?.find((v) => v?.id === t?.[key]));
      if (v2 && ![t?.baseline, t?.optimized].some((ref) => docs.has(`models/${name}/${String(ref ?? "").split("@")[0]}.yaml`))) return;
      const [b, o] = [variant("baseline"), variant("optimized")];
      const html = path.join(root, "models", name, String(t?.report ?? ""));
      if (!t?.report || !b?.image || !o?.image || !fs.existsSync(html)) return;
      const image = (v) => `${v.image.repository}:${v.image.tag ?? "latest"}`;
      const mismatches = reportMismatches(fs.readFileSync(html, "utf8"), { baseline: image(b), optimized: image(o) });
      checked.push({ label: `${meta} tuning[${i}]`, report: t.report, mismatches });
    });
  }
  if (checked.length) {
    console.log();
    console.log(paint("bold", "Perf reports, against their variants' images"));
  }
  for (const { label, report, mismatches } of checked) {
    console.log(`  ${mismatches.length ? marks.fail : marks.pass} ${label}  ${paint("dim", report)}`);
    for (const m of mismatches) console.log(`      ${paint("red", m)}`);
    if (mismatches.length) failed.push(label);
  }
  if (failed.length) {
    console.log();
    console.log(paint("bold", "Failed"));
    for (const name of failed) console.log(`  ${marks.fail} ${name}`);
  }
  const count = (level) => [...results.values()].filter((r) => r.level === level).length;
  const [warned, errors] = [count("warning"), count("error")];
  const bad = checked.filter((c) => c.mismatches.length).length;
  console.log();
  console.log(
    paint(
      errors ? "red" : "green",
      `${plural(keys.length, "image")} in ${plural(files.length, "file")}: ` +
        `${keys.length - errors} passed${warned ? ` (${warned} with warnings)` : ""}, ${errors} failed`,
    ),
  );
  console.log(paint(bad ? "red" : "green", `${plural(checked.length, "perf report")}: ${checked.length - bad} passed, ${bad} failed`));
  return errors || bad ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`${marks.fail} ${paint("red", "setup:")} ${err.message}`);
    process.exit(2);
  },
);

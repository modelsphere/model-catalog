#!/usr/bin/env node
// Schema-check this catalog.
"use strict"

const fs = require("fs")
const path = require("path")
// "2020" is the JSON Schema draft these files declare (2020-12), not the
// package's age. require("ajv") speaks draft-07; this entry point is Ajv 8.
const Ajv2020 = require("ajv/dist/2020")
const addFormats = require("ajv-formats")
const YAML = require("yaml")
const {root, modelsDir, modelNames, versionFiles} = require("./lib/catalog")
const {reportProblem} = require("./lib/report")

const metadataFiles = modelNames()
  .map((name) => path.join(modelsDir, name, "metadata.yaml"))
  .filter((file) => fs.existsSync(file))
const versionFilePaths = modelNames().flatMap((name) => versionFiles(name).map((rel) => path.join(root, rel)))

const checks = [
  {
    schema: "schema/catalog.schema.json",
    files: fs.existsSync(path.join(root, "catalog.yaml")) ? [path.join(root, "catalog.yaml")] : [],
    missing: "catalog.yaml: missing -- it names where the site is published",
  },
  {
    schema: "schema/metadata.schema.json",
    files: metadataFiles,
  },
  {
    schema: "schema/version.schema.json",
    files: versionFilePaths,
  },
]

function pointer(instancePath) {
  if (!instancePath) return ""
  let out = ""
  for (const raw of instancePath.split("/").slice(1)) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (/^\d+$/.test(part)) out += `[${part}]`
    else out += (out ? "." : "") + part
  }
  return out
}

function shown(value) {
  if (value === undefined || (value !== null && typeof value === "object")) return ""
  const text = JSON.stringify(value)
  const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text
  return ` (got ${clipped})`
}

function detail(err) {
  const params = err.params || {}
  const got = shown(err.data)
  switch (err.keyword) {
    case "required":
      return `missing required property ${JSON.stringify(params.missingProperty)}`
    case "additionalProperties":
      return `unexpected property ${JSON.stringify(params.additionalProperty)}`
    case "enum":
      return `must be one of ${params.allowedValues.map((v) => JSON.stringify(v)).join(" | ")}${got}`
    case "const":
      return `must be ${JSON.stringify(params.allowedValue)}${got}`
    case "format":
      return `must be a ${params.format}${got}`
    case "pattern":
      // The chart.version pattern is a generated grammar nobody reads.
      if (err.instancePath.endsWith("/chart/version")) {
        return `must be a chart version or a range, e.g. 0.8.0, ">=0.8.0", "^0.8.0"${got}`
      }
      return `must match /${params.pattern}/${got}`
    case "type":
      return `must be ${[].concat(params.type).join(" or ")}${got}`
    default:
      return `${err.message}${got}`
  }
}

// "if" only repeats the then-branch failure already listed below it.
function meaningful(errors) {
  const kept = errors.filter((err) => err.keyword !== "if")
  return kept.length > 0 ? kept : errors
}

function report(rel, lines) {
  if (report.started) console.error("")
  report.started = true
  console.error(rel)
  for (const line of lines) console.error(`  ${line}`)
}

// strictTypes rejects draft 2020-12 that the spec allows: a union type, and
// keywords such as minimum without a sibling type. Keep the other strict checks.
// verbose puts the failing value on each error.
const ajv = new Ajv2020({allErrors: true, strict: true, strictTypes: false, verbose: true})
addFormats(ajv)

let failed = false
for (const check of checks) {
  if (check.files.length === 0) {
    console.error(check.missing ?? `${check.schema}: no files`)
    failed = true
    continue
  }
  let validate
  try {
    validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, check.schema), "utf8")))
  } catch (err) {
    console.error(`${check.schema}: ${err.message}`)
    process.exit(1)
  }
  for (const file of check.files) {
    const rel = path.relative(root, file)
    let data
    try {
      data = YAML.parse(fs.readFileSync(file, "utf8"))
    } catch (err) {
      const at = err.linePos?.[0]
      const where = at ? `line ${at.line}:${at.col}: ` : ""
      report(rel, `${where}${err.message}`.split("\n"))
      failed = true
      continue
    }
    if (validate(data)) continue
    failed = true
    report(rel, meaningful(validate.errors).map((err) => {
      const at = pointer(err.instancePath)
      const text = detail(err)
      return at ? `${at}: ${text}` : text
    }))
  }
}

// What the schema cannot see: a variant id is unique within its version. A
// deploy, a tuning entry and validate:helm all name a variant by it.
for (const file of versionFilePaths) {
  let variants
  try {
    variants = YAML.parse(fs.readFileSync(file, "utf8"))?.variants
  } catch {
    continue // a parse error is already reported above
  }
  if (!Array.isArray(variants)) continue
  const ids = variants.map((v) => v?.id)
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (twice.length > 0) {
    failed = true
    report(path.relative(root, file), twice.map((id) => `variants: id ${JSON.stringify(id)} is used twice`))
  }
}

// What the schema cannot see: a tuning pair must name a published version of
// its model, two different variants of that version, and a report that exists;
// and a variant named as tuned must have its result recorded. swiss does not
// check any of it -- tuning is display only, and a mistake in it must not stop
// a catalog loading for deploys -- so it is caught here instead.
for (const meta of metadataFiles) {
  let tuning
  try {
    tuning = YAML.parse(fs.readFileSync(meta, "utf8"))?.tuning
  } catch {
    continue // a parse error is already reported above
  }
  // Not a list is a schema error, reported above; a model with none still
  // gets the recorded-result check below.
  if (!Array.isArray(tuning)) tuning = []

  const dir = path.dirname(meta)
  const published = new Map()
  for (const rel of versionFiles(path.basename(dir))) {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(root, rel), "utf8"))
      if (doc?.version) published.set(String(doc.version), new Set((doc.variants ?? []).map((v) => v?.id)))
    } catch {
      // reported by the schema check above
    }
  }

  const lines = []

  // A variant whose id names it optimized (the naming convention: an
  // "optimized" segment, as in sglang-tp8-h100-optimized) must be recorded as
  // the optimized side of some tuning entry, or the sites show the model as
  // untuned. Any version's entry will do: a tuned variant carried into a later
  // version unchanged is shown with the number it was measured with.
  const recorded = new Set(tuning.map((t) => t?.optimized))
  const missing = new Map()
  for (const [version, ids] of published) {
    for (const id of ids) {
      if (typeof id !== "string" || !/(^|-)optimi[sz]ed(-|$)/.test(id) || recorded.has(id)) continue
      missing.set(id, [...(missing.get(id) ?? []), version])
    }
  }
  for (const [id, versions] of missing) {
    lines.push(
      `variant ${JSON.stringify(id)} (${versions.sort().join(", ")}) is named optimized but has no tuning entry; ` +
        `add one to tuning with optimized: ${id}, its baseline, and the uplift`
    )
  }

  tuning.forEach((t, i) => {
    if (!t || typeof t !== "object") return
    const at = `tuning[${i}]`
    const ids = published.get(String(t.version))
    if (!ids) {
      lines.push(`${at}.version: ${JSON.stringify(t.version)} is not a published version of this model`)
    } else {
      for (const key of ["baseline", "optimized"]) {
        if (t[key] !== undefined && !ids.has(t[key])) {
          lines.push(`${at}.${key}: version ${t.version} has no variant ${JSON.stringify(t[key])}`)
        }
      }
    }
    if (t.baseline !== undefined && t.baseline === t.optimized) {
      lines.push(`${at}: baseline and optimized are the same variant`)
    }
    if (typeof t.report === "string" && !fs.existsSync(path.join(dir, t.report))) {
      lines.push(`${at}.report: no file ${JSON.stringify(t.report)} beside metadata.yaml`)
    }
    const names = Array.isArray(t.workloads) ? t.workloads.map((w) => w?.name) : []
    for (const name of new Set(names.filter((n, j) => names.indexOf(n) !== j))) {
      lines.push(`${at}.workloads: ${JSON.stringify(name)} is listed twice`)
    }
  })
  if (lines.length > 0) {
    failed = true
    report(path.relative(root, meta), lines)
  }
}

// The site links every HTML file beside a model's metadata and skips one it
// cannot show. Here that is an error, so a broken report gets fixed rather
// than quietly going missing from the site.
for (const name of modelNames()) {
  const dir = path.join(modelsDir, name)
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
    const problem = reportProblem(path.join(dir, file))
    if (problem) {
      failed = true
      report(path.relative(root, path.join(dir, file)), [problem])
    }
  }
}

process.exit(failed ? 1 : 0)

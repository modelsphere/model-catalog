#!/usr/bin/env node
// Schema-check this catalog. Paths are fixed: the script is not shared.
"use strict"

const fs = require("fs")
const path = require("path")
// "2020" is the JSON Schema draft these files declare (2020-12), not the
// package's age. require("ajv") speaks draft-07; this entry point is Ajv 8.
const Ajv2020 = require("ajv/dist/2020")
const addFormats = require("ajv-formats")
const YAML = require("yaml")

const root = path.join(__dirname, "..")

function modelFiles(match) {
  const out = []
  for (const name of fs.readdirSync(path.join(root, "models"))) {
    const dir = path.join(root, "models", name)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (match(file)) out.push(path.join(dir, file))
    }
  }
  return out.sort()
}

const checks = [
  {
    schema: "schema/metadata.schema.json",
    files: modelFiles((file) => file === "metadata.yaml"),
  },
  {
    schema: "schema/version.schema.json",
    // Same set as models/*/*-*.yaml: version files, not metadata.yaml.
    files: modelFiles((file) => file.endsWith(".yaml") && file.includes("-")),
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
    console.error(`${check.schema}: no files`)
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

process.exit(failed ? 1 : 0)

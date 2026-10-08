"use strict";

const crypto = require("node:crypto");
const YAML = require("yaml");
const {download} = require("./download");

// Versioned with the repository; changing this contract requires regeneration.
const CONVERTER_VERSION = "catalog-crd-schema-v1";

function assertCrdSource(source, crd) {
  if (source.repository.startsWith("modelsphere/") && !source.group?.endsWith(".modelsphere.dev")) {
    throw new Error(`${source.repository}: Modelsphere CRDs must use a .modelsphere.dev API group`);
  }
  if (crd?.kind !== "CustomResourceDefinition" || crd.spec?.names?.kind !== source.kind || crd.spec?.group !== source.group) {
    throw new Error(`expected CRD ${source.group}/${source.kind}, got ${crd?.spec?.group}/${crd?.spec?.names?.kind}`);
  }
}

function convertSchema(input) {
  if (typeof input === "boolean") return input;
  const schema = structuredClone(input);
  for (const key of ["properties", "patternProperties", "definitions", "$defs"]) {
    if (schema[key]) {
      schema[key] = Object.fromEntries(Object.entries(schema[key]).map(([k, v]) => [k, convertSchema(v)]));
    }
  }
  for (const key of ["items", "additionalProperties", "not", "contains", "if", "then", "else"]) {
    if (schema[key] && typeof schema[key] === "object") {
      schema[key] = Array.isArray(schema[key]) ? schema[key].map(convertSchema) : convertSchema(schema[key]);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key]) schema[key] = schema[key].map(convertSchema);
  }
  // Close defined objects, including objects inside arrays. Explicit map schemas
  // and Kubernetes' preserve-unknown-fields escape hatch must remain open.
  if (schema.properties && schema.additionalProperties === undefined) {
    schema.additionalProperties = schema["x-kubernetes-preserve-unknown-fields"] === true;
  }
  if (schema["x-kubernetes-int-or-string"] || schema.format === "int-or-string") {
    schema.type = ["integer", "string"];
    delete schema.format;
  }
  if (schema.nullable === true) {
    delete schema.nullable;
    return {anyOf: [schema, {type: "null"}]};
  }
  delete schema.nullable;
  return schema;
}

function objectMetaSchema(definitions) {
  const name = "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta";
  const used = {};
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const prefix = "#/definitions/";
      if (!value.$ref.startsWith(prefix)) throw new Error(`unexpected metadata reference ${value.$ref}`);
      const key = value.$ref.slice(prefix.length);
      if (!Object.hasOwn(used, key)) {
        if (!definitions[key]) throw new Error(`missing metadata definition ${key}`);
        used[key] = definitions[key];
        visit(used[key]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  const schema = {$ref: `#/definitions/${name}`};
  visit(schema);
  return {schema, definitions: used};
}

function crdSchemas(crd, metadata = {schema: {type: "object"}, definitions: {}}) {
  if (crd?.kind !== "CustomResourceDefinition") throw new Error("expected a CustomResourceDefinition");
  const {group, names, versions} = crd.spec;
  return versions.filter((v) => v.served).map((v) => {
    if (!v.schema?.openAPIV3Schema) throw new Error(`${group}/${v.name}/${names.kind}: missing OpenAPI schema`);
    const schema = convertSchema(v.schema.openAPIV3Schema);
    schema.$schema = "http://json-schema.org/draft-07/schema#";
    schema.properties ??= {};
    schema.properties.apiVersion = {type: "string", enum: [`${group}/${v.name}`]};
    schema.properties.kind = {type: "string", enum: [names.kind]};
    // The API server supplies ObjectMeta even when the CRD omits metadata or
    // leaves it as type: object. Use the same pinned Kubernetes schema as native resources.
    schema.properties.metadata = structuredClone(metadata.schema);
    if (Object.keys(metadata.definitions).length) schema.definitions = structuredClone(metadata.definitions);
    schema.required = [...new Set([...(schema.required ?? []), "apiVersion", "kind", "metadata"])];
    schema.additionalProperties = false;
    return {group, version: v.name, kind: names.kind, schema, file: `${group}/${names.kind.toLowerCase()}_${v.name}.json`};
  });
}

// A source carrying a sha256 is locked: different bytes are refused, not converted.
async function fetchPinned({url, sha256}) {
  const bytes = await download(url);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 && digest !== sha256) throw new Error(`${url}: sha256 ${digest}, locked ${sha256}`);
  return {body: bytes.toString("utf8"), sha256: digest};
}

// Download CRD sources at their pinned commits and convert every served version.
// Returns the schema files and the records that lock them.
async function buildSchemas(sources, objectMeta) {
  const meta = await fetchPinned(objectMeta);
  const metadata = objectMetaSchema(JSON.parse(meta.body).definitions);
  const files = new Map();
  const records = [];
  for (const source of sources) {
    if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new Error("source must use a full commit SHA");
    const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
    const {body, sha256} = await fetchPinned({url, sha256: source.sha256});
    const schemas = YAML.parseAllDocuments(body).flatMap((doc) => {
      if (doc.errors.length) throw doc.errors[0];
      const crd = doc.toJS();
      if (!crd) return [];
      assertCrdSource(source, crd);
      return crdSchemas(crd, metadata);
    });
    if (!schemas.length) throw new Error(`${url}: no served schemas`);
    for (const {file, schema} of schemas) {
      if (files.has(file)) throw new Error(`duplicate schema ${file}`);
      files.set(file, JSON.stringify(schema, null, 2) + "\n");
    }
    records.push({...source, url, sha256, schemas: schemas.map(({file, group, version, kind}) => ({file, group, version, kind}))});
  }
  return {files, objectMeta: {url: objectMeta.url, sha256: meta.sha256}, records};
}

module.exports = {CONVERTER_VERSION, assertCrdSource, convertSchema, crdSchemas, objectMetaSchema, buildSchemas};

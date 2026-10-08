"use strict";

// Versioned with the repository; changing this contract requires regeneration.
const CONVERTER_VERSION = "catalog-crd-schema-v1";

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

module.exports = {CONVERTER_VERSION, convertSchema, crdSchemas, objectMetaSchema};

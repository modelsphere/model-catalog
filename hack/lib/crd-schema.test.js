"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const {assertCrdSource, convertSchema, crdSchemas, objectMetaSchema} = require("./crd-schema");

const compile = (schema) => new Ajv({strict: false}).compile(schema);

test("Modelsphere sources require their own API groups; external CRDs retain upstream groups", () => {
  const source = {repository: "modelsphere/llm-operator", group: "autoscaling.modelsphere.dev", kind: "LLMScaler"};
  const crd = {kind: "CustomResourceDefinition", spec: {group: source.group, names: {kind: source.kind}}};
  assert.doesNotThrow(() => assertCrdSource(source, crd));
  assert.throws(() => assertCrdSource(source, {...crd, spec: {...crd.spec, group: "autoscaling.4pd.io"}}), /expected CRD/);
  assert.throws(() => assertCrdSource({...source, group: "autoscaling.4pd.io"}, crd), /must use a .modelsphere.dev/);
  assert.throws(() => assertCrdSource(source, {...crd, spec: {...crd.spec, names: {kind: "Wrong"}}}), /expected CRD/);
  const external = {repository: "kubernetes-sigs/lws", group: "leaderworkerset.x-k8s.io", kind: "LeaderWorkerSet"};
  assert.doesNotThrow(() => assertCrdSource(external,
    {kind: "CustomResourceDefinition", spec: {group: external.group, names: {kind: external.kind}}}));
});

test("strictness descends into array items while preserving typed maps and free objects", () => {
  const validate = compile(convertSchema({type: "object", properties: {
    env: {type: "array", items: {type: "object", properties: {name: {type: "string"}}, required: ["name"]}},
    labels: {type: "object", additionalProperties: {type: "string"}},
    free: {type: "object", "x-kubernetes-preserve-unknown-fields": true, properties: {known: {type: "string"}}}
  }}));
  assert(validate({env: [{name: "A"}], labels: {"example.com/key": "yes"}, free: {arbitrary: {nested: true}}}));
  assert(!validate({env: [{name: "A", typo: true}]}));
  assert(!validate({labels: {key: 1}}));
  assert(!validate({free: {known: 1}}));
});

test("IntOrString and nullable fields retain valid Kubernetes values", () => {
  const validate = compile(convertSchema({type: "object", properties: {
    port: {"x-kubernetes-int-or-string": true, anyOf: [{type: "integer"}, {type: "string"}]},
    otherPort: {format: "int-or-string"},
    optional: {type: "string", enum: ["yes"], nullable: true}
  }}));
  assert(validate({port: 80, otherPort: "http", optional: null}));
  assert(validate({port: "http", otherPort: 80, optional: "yes"}));
  assert(!validate({port: false}));
  assert(!validate({optional: "no"}));
});

test("CRD conversion publishes only served versions and enforces full GVK", () => {
  const schemas = crdSchemas({kind: "CustomResourceDefinition", spec: {
    group: "example.dev", names: {kind: "Example"}, versions: [
      {name: "v1", served: true, schema: {openAPIV3Schema: {type: "object", properties: {metadata: {type: "object"}}}}},
      {name: "v2", served: false}
    ]
  }});
  assert.deepEqual(schemas.map((s) => s.file), ["example.dev/example_v1.json"]);
  const validate = compile(schemas[0].schema);
  assert(validate({apiVersion: "example.dev/v1", kind: "Example", metadata: {name: "test"}}));
  assert(!validate({apiVersion: "other.dev/v1", kind: "Example", metadata: {}}));
  assert(!validate({apiVersion: "example.dev/v1", kind: "Wrong", metadata: {}}));
  assert(!validate({apiVersion: "example.dev/v1", kind: "Example"}));
});

test("implicit metadata is supplied even for CRDs that omit it, with transitive references", () => {
  const name = "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta";
  const metadata = objectMetaSchema({
    [name]: {type: "object", additionalProperties: false, properties: {
      name: {type: "string"}, labels: {$ref: "#/definitions/Labels"}
    }},
    Labels: {type: "object", additionalProperties: {type: "string"}},
    Unused: {type: "number"}
  });
  assert.equal(metadata.definitions.Unused, undefined);
  const [result] = crdSchemas({kind: "CustomResourceDefinition", spec: {
    group: "example.dev", names: {kind: "Example"}, versions: [{name: "v1", served: true,
      schema: {openAPIV3Schema: {type: "object", properties: {spec: {type: "object"}}}}}]
  }}, metadata);
  const validate = compile(result.schema);
  assert(validate({apiVersion: "example.dev/v1", kind: "Example", metadata: {name: "x", labels: {key: "value"}}}));
  assert(!validate({apiVersion: "example.dev/v1", kind: "Example", metadata: {typo: true}}));
  assert(!validate({apiVersion: "example.dev/v1", kind: "Example", metadata: {labels: {key: 1}}}));
});

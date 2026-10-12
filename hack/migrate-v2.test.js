"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const YAML = require("yaml");
const { modelNames, readYaml, root, schemaOf, schemaValidator } = require("./lib/catalog");
const { migrate } = require("./migrate-v2");

test("every v1 model migrates to files the v2 schemas accept, its variants unchanged", () => {
  const schema = schemaValidator();
  const v1 = modelNames().filter((name) => schemaOf(readYaml(`${root}/models/${name}/metadata.yaml`)) === "v1");
  assert.ok(v1.length > 0);
  for (const name of v1) {
    const { files } = migrate(name);
    for (const [rel, body] of files) {
      const doc = YAML.parse(body);
      const validate = schema(rel.endsWith("/metadata.yaml") ? "metadata.v2.schema.json" : "variant.schema.json");
      assert.ok(validate(doc), `${rel}: ${JSON.stringify(validate.errors)}`);
      if (!rel.endsWith("/metadata.yaml")) assert.equal(rel, `models/${name}/${doc.id}.yaml`);
    }
    const latest = YAML.parse([...files.values()][0]).version;
    const was = (readYaml(`${root}/models/${name}/metadata.yaml`).tuning ?? []).map((t) => ({ ...t, baseline: `${t.baseline}@${latest}`, optimized: `${t.optimized}@${latest}` }));
    assert.deepEqual(YAML.parse(files.get(`models/${name}/metadata.yaml`)).tuning ?? [], was, `${name}: tuning`);
  }
});

test("a model already on v2 is not migrated again", () => {
  const v2 = modelNames().find((name) => schemaOf(readYaml(`${root}/models/${name}/metadata.yaml`)) === "v2");
  if (v2) assert.throws(() => migrate(v2), /already on v2/);
});

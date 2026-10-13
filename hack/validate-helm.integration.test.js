"use strict";

// Explicit, network-backed acceptance suite: npm run test:helm:integration.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const { root } = require("./lib/catalog");
const { main } = require("./validate-helm");
const { command, kubeconformArgs } = require("./lib/helm-validation");
const config = require("../schema/crds/config.json");

for (const chartMode of ["latest", "declared"]) {
  test(`released charts (${chartMode}): fixed and range versions, LWS, defaults and invalid configurations`, { timeout: 240000 }, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-acceptance-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    fs.mkdirSync(path.join(temp, "models/fixtures"), { recursive: true });
    fs.mkdirSync(path.join(temp, "schema"));
    fs.symlinkSync(path.join(root, "schema/crds"), path.join(temp, "schema/crds"), "dir");
    fs.symlinkSync(path.join(root, ".cache"), path.join(temp, ".cache"), "dir");
    // Fixtures are inline v2 variant files, one variant each, named by id: the
    // catalog's own models are validate:helm's to check, not this test's.
    function write(doc) {
      fs.writeFileSync(path.join(temp, `models/fixtures/${doc.id}.yaml`), YAML.stringify(doc));
    }
    const variant = (id, chart, { requires = { gpus: 1, topology: "single-node" }, values } = {}) => ({
      apiVersion: "catalog.swiss/v2",
      kind: "Variant",
      model: "fixtures",
      id,
      version: "1.0.0",
      engine: chart.name,
      chart,
      requires,
      values,
    });
    const sglang = (version) => ({ name: "sglang", version });
    const vllm = (version) => ({ name: "vllm", version });
    // What a single-node variant commonly sets.
    const served = {
      model: { hostPathType: "Directory", contextLength: "" },
      extraArgs: ["--tp-size=4", "--enable-cache-report"],
      env: [{ name: "NVIDIA_DISABLE_REQUIRE", value: "1" }],
      volumes: [{ name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "32Gi" } }],
      volumeMounts: [{ name: "dshm", mountPath: "/dev/shm" }],
      resources: { requests: { "ephemeral-storage": "16Gi" }, limits: { "ephemeral-storage": "16Gi" } },
      // The chart refuses a startup budget (180 x 30s) the rollout deadline does not clear.
      progressDeadlineSeconds: 7200,
      startupProbe: { httpGet: { path: "/health", port: "http" }, periodSeconds: 30, failureThreshold: 180 },
      terminationGracePeriodSeconds: 3600,
    };
    write(variant("valid-range", sglang(">=0.8.0"), { requires: { gpus: 4, topology: "single-node" }, values: served }));
    // Pinned to the minimum: the oldest chart a new variant may declare.
    write(variant("valid-fixed", sglang(config.minimumChartVersions.sglang), { requires: { gpus: 4, topology: "single-node" }, values: served }));
    write(
      variant("valid-vllm-fixed", vllm(config.minimumChartVersions.vllm), {
        requires: { gpus: 8, topology: "single-node" },
        values: {
          model: { maxLen: "32768", mountPath: "/model" },
          extraArgs: ["--tensor-parallel-size=8", "--enable-prefix-caching"],
          env: [{ name: "NVIDIA_DISABLE_REQUIRE", value: "1" }],
        },
      }),
    );
    write(
      variant("valid-lws", sglang(">=0.8.0"), {
        requires: { gpus: 8, nodes: 2, topology: "lws", rdma: true },
        values: {
          model: { mountPath: "/model", hostPathType: "Directory", contextLength: "" },
          lws: { enabled: true, size: 2 },
          extraArgs: ["--tp=8", "--pp-size=2", "--dist-timeout=1800"],
          env: [
            { name: "NCCL_IB_DISABLE", value: "0" },
            { name: "NCCL_SOCKET_IFNAME", value: "eth0" },
          ],
          resources: { limits: { "rdma/hca_shared": "1" } },
        },
      }),
    );
    write(variant("valid-defaults", sglang(">=0.8.0")));
    const invalids = [
      ["bad-key", { unkownField: true }, "lint"],
      ["bad-type", { service: { port: "bad" } }, "lint"],
      ["bad-env", { env: [{ name: "TEST", value: "x", misspelled: true }] }, "kubeconform"],
      ["bad-volume", { volumes: [{ name: "bad", emptyDir: { misspelled: true } }] }, "kubeconform"],
      ["bad-resources", { resources: { requsets: { cpu: "1" } } }, "kubeconform"],
      ["bad-crd", { sloRequirement: { extraSpec: { unknownSpecField: true } } }, "kubeconform"],
      ["bad-template", { sloRequirement: { extraSpec: { serviceId: "duplicate" } } }, "template"],
      ["bad-explicit-route", { modelRoute: { nginx: { outputConfigMap: "" } } }, "template"],
    ];
    for (const [id, values] of invalids) write(variant(id, sglang(">=0.8.0"), { values }));
    write(variant("bad-resolution", sglang("9999.0.0")));
    write(variant("bad-legacy-chart", sglang("0.7.1")));
    const output = path.join(temp, "artifacts");
    // Explicit files are new versions, so the legacy fixture must fail the minimum.
    const files = fs.readdirSync(path.join(temp, "models/fixtures")).map((name) => `models/fixtures/${name}`);
    assert.equal(main({ files, output, chartMode }, { repositoryRoot: temp }), false);
    const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
    // A setup failure also returns false: every fixture must have been checked.
    assert.equal(summary.error, undefined);
    assert.deepEqual(summary.results.map((r) => r.file).sort(), [...files].sort());
    for (const result of summary.results.filter((r) => path.basename(r.file).startsWith("valid-"))) {
      assert.equal(result.ok, true, `${result.file}: ${JSON.stringify(result)}`);
      const expected = {
        LLMScaler: "autoscaling.modelsphere.dev/v1alpha1",
        LLMSLORequirement: "inference.modelsphere.dev/v1alpha1",
        ModelRoute: "routing.modelsphere.dev/v1alpha1",
      };
      const rendered = YAML.parseAllDocuments(fs.readFileSync(path.join(temp, result.artifacts, "rendered.yaml"), "utf8"));
      for (const doc of rendered) {
        const resource = doc.toJS();
        if (expected[resource?.kind]) assert.equal(resource.apiVersion, expected[resource.kind], result.file);
      }
    }
    const lws = summary.results.find((r) => r.file.endsWith("valid-lws.yaml"));
    const kinds = YAML.parseAllDocuments(fs.readFileSync(path.join(temp, lws.artifacts, "rendered.yaml"), "utf8")).map((d) => d.toJS()?.kind);
    assert.ok(kinds.includes("LeaderWorkerSet"), `valid-lws renders ${kinds.join(", ")}`);
    const fixed = summary.results.find((r) => r.file.endsWith("valid-fixed.yaml"));
    const vllmFixed = summary.results.find((r) => r.file.endsWith("valid-vllm-fixed.yaml"));
    assert.equal(fixed.chart.declaredVersion, "0.8.0");
    assert.equal(vllmFixed.chart.declaredVersion, "0.5.0");
    if (chartMode === "declared") {
      assert.equal(fixed.chart.version, "0.8.0");
      assert.equal(vllmFixed.chart.version, "0.5.0");
    } else {
      // Inspect the same snapshot Helm searched, rather than hardcoding today's latest.
      const index = YAML.parse(fs.readFileSync(path.join(temp, summary.runDirectory, "helm/cache/repository/catalog-index.yaml"), "utf8"));
      const { compareVersions, isPrerelease } = require("./lib/catalog");
      for (const [name, pin] of [
        ["sglang", fixed],
        ["vllm", vllmFixed],
      ]) {
        const latest = index.entries[name]
          .filter((e) => !isPrerelease(e.version) && compareVersions(e.version, config.minimumChartVersions[name]) >= 0)
          .sort((a, b) => compareVersions(b.version, a.version))[0].version;
        assert.equal(pin.chart.version, latest);
        assert(summary.results.filter((r) => r.ok && r.chart.name === name).every((r) => r.chart.version === latest));
      }
    }
    for (const [name, , stage] of invalids) {
      const result = summary.results.find((r) => r.file.endsWith(`${name}.yaml`));
      assert.equal(result.ok, false, name);
      assert.equal(result.stages[stage], false, `${name}: ${JSON.stringify(result)}`);
    }
    assert.match(summary.results.find((r) => r.file.endsWith("bad-resolution.yaml")).error, /no published/);
    assert.match(summary.results.find((r) => r.file.endsWith("bad-legacy-chart.yaml")).error, /below the required minimum/);
    // Verify the exact production kubeconform invocation fails for unknown GVKs,
    // even if their kind resembles an existing native resource or known CRD.
    const cache = path.join(temp, "schema-cache");
    fs.mkdirSync(cache);
    for (const [apiVersion, kind] of [
      ["unknown.example/v1", "Unknown"],
      ["wrong.example/v1", "ModelRoute"],
      ["routing.modelsphere.dev/v9", "ModelRoute"],
      ["apps.wrong.example/v1", "Deployment"],
      ["autoscaling.4pd.io/v1alpha1", "LLMScaler"],
      ["inference.x-k8s.io/v1alpha1", "LLMSLORequirement"],
      ["routing.gpucluster.io/v1alpha1", "ModelRoute"],
    ]) {
      const rendered = path.join(temp, "unknown.yaml");
      fs.writeFileSync(rendered, YAML.stringify({ apiVersion, kind, metadata: { name: "unknown" } }));
      const result = command(
        path.join(root, ".cache/bin/kubeconform"),
        kubeconformArgs(config, path.join(temp, summary.runDirectory, "crds"), cache, rendered),
      );
      assert.equal(result.ok, false, `${apiVersion}/${kind}`);
    }
  });
}

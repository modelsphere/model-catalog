# Helm validation schemas

`npm run validate:helm` checks every variant in selected model version YAMLs.
By default it downloads the **latest stable released** chart for each engine
from the official repository, lets Helm merge the chart defaults with
`variant.values`, runs `helm lint --strict` and
`helm template`, then runs `kubeconform -strict`. It never ignores missing
schemas. It does not build dependencies: the dependency charts in the released
package are the ones being checked.

## Reproduce locally

Use Node.js 24 (CI's version), `git`, and `tar`. macOS and Linux on AMD64/ARM64
are supported by the installer. Versions and archive SHA-256 checksums are in
[`config.json`](config.json).

```sh
npm ci
npm run helm:install
npm run validate:helm -- --base origin/master
npm run validate:helm -- --all
npm run validate:helm -- --all --chart-mode declared
npm run validate:helm -- models/glm5.3/glm5.3-1.0.1.yaml
npm run test:helm
npm run test:helm:integration
```

Without a selector, the base is `origin/HEAD`. `--base` compares committed HEAD
with the common ancestor of that ref and HEAD. Local uncommitted version edits
can be checked with explicit file paths or `--all`. Added/modified version
YAMLs and rename destinations are checked; deleted versions are excluded.
Metadata, reports, and documentation alone select no files. Changes to the
validator, its tests, dependency manifests, workflow, or this schema directory
select every version. All variants are checked, regardless of `default`.

Only absent `values.modelRoute.nginx.outputConfigMap` is supplied with
`ci/openresty-conf`, with a log message. Explicit empty, null, or invalid values
are preserved. No feature is disabled to make validation pass. Missing `values`
means chart defaults plus that route placeholder.

The repository index is freshly fetched once per invocation. The default
`--chart-mode latest` (also explicitly used in CI) selects the newest stable
release of `sglang >=0.8.0` or `vllm >=0.5.0` in that snapshot. Prereleases are
excluded. Future stable releases, including new minor or major versions, are
automatically selected on subsequent runs. All selected variants of the same
engine use the same release, even when their YAML pins an older chart or imposes
an upper bound. The latest selection is never reused across invocations.

Helm separately resolves the YAML declaration and checks that its selected
release meets the configured minimum. A missing, invalid or obsolete declared
release still fails the check. The YAML declaration continues to control
deployment; latest-mode validation checks forward compatibility and does not
change that declaration. `--chart-mode declared` renders the actual release
selected by the YAML constraint, for deployment compatibility and reproduction.
No matching latest release or a failed latest download causes a failure, with
no fallback to the declared chart.

Each selected package is downloaded once and checked against the repository
index's SHA-256 digest. Every variant records the validation mode, original
declaration, resolved declaration version, validation chart version, selection
constraint and package digest. This checks the selected release at run time;
it does not guarantee all historical or future releases are compatible.

The default artifact directory is `artifacts/helm-validation/`; override it with
`--output DIR`. `summary.json` identifies files, variants, actual chart versions,
mode, resolved declaration versions, stage results and per-variant artifact
directories. Each invocation has a fresh `run-*` directory with extracted values,
rendered manifests, tool logs, downloaded
charts, a schema cache and isolated Helm settings. CI uploads these artifacts
even on failure. Helm and kubeconform errors retain field paths.

## Schema sources and updates

[`sources.json`](sources.json) locks upstream CRDs to full commit SHAs.
[`provenance.json`](provenance.json) records source URLs, source hashes, served
versions and generated filenames. Modelsphere-owned CRDs use only
`routing.modelsphere.dev`, `autoscaling.modelsphere.dev` and
`inference.modelsphere.dev`. Each source declares its expected group and kind;
the generator rejects a mismatched CRD or a Modelsphere source whose group does
not end in `.modelsphere.dev`.

Catalog chart declarations use `sglang` version `0.8.0` or newer and `vllm`
version `0.5.0` or newer, the first releases using these groups. Fixed pins remain
fixed, and version ranges retain their form with the new minimum. Legacy
`autoscaling.4pd.io` and `inference.x-k8s.io` schemas are removed; resources from
old charts fail validation rather than being rewritten or accepted through aliases.
External CRDs retain their upstream groups: `leaderworkerset.x-k8s.io` for
LeaderWorkerSet and `monitoring.coreos.com` for ServiceMonitor.

Deployments using the old groups need the corresponding controllers, CRDs,
RBAC and resource objects migrated together. Existing objects under an old API
group do not automatically become objects under the new group. This catalog
change deliberately updates published version declarations; the Pages workflow
requires `allow_rewrites` when publishing those changes.

The converter is repository-versioned as `catalog-crd-schema-v1` in
[`hack/lib/crd-schema.js`](../../hack/lib/crd-schema.js), using the YAML parser
locked in `package-lock.json`. It converts all served versions, adds strictness
recursively to defined objects (including array items), preserves explicitly
typed maps and `x-kubernetes-preserve-unknown-fields`, handles nullable schemas
and Kubernetes `IntOrString`, and enforces full API group, version and kind.
Kubernetes supplies `metadata` implicitly for custom resources; the converter
adds the same pinned strict Kubernetes `ObjectMeta` and its required definitions
to each CRD schema, including CRDs that omit it.

Native Kubernetes schemas use the configured `1.36.3` baseline and a pinned
`yannh/kubernetes-json-schema` commit. Helm uses the same version baseline.
Schema checking requires no cluster. Downloading tools, charts, and native
schemas requires public network access; CRD schemas are committed locally.

To update a source, edit its commit/path in `sources.json` (and the Kubernetes
commit/version in `config.json` when needed), then regenerate and verify:

```sh
npm run helm:update-schemas
npm run test:helm
npm run test:helm:integration
npm run validate:helm -- --all
npm run validate:helm -- --all --chart-mode declared
```

Review generated changes together with provenance. Changes to conversion rules
must regenerate the schemas; bump the converter version when changing an
already deployed conversion contract. Tool updates must also update archive
checksums in `config.json`.

The acceptance suite runs both latest and declared modes. It checks GLM's fixed
and ranged chart declarations, a fixed vLLM release, both Gemma variants, an LWS
deployment, default values, misspelled
fields, incorrect types, invalid Kubernetes nesting, invalid CRD fields, template errors, no matching
release, legacy chart rejection, and unknown/mismatched GVKs. Rendered custom
resources must use the canonical Modelsphere groups. Unit tests additionally
cover selection, future stable releases beyond fixed pins, prerelease exclusion,
package reuse, missing latest releases, download failures, a missing chart values
schema, empty renders and failure propagation.

## Rollout and limits

The initial full-catalog run exposed a deadline/startup budget mismatch in the
`sglang-tp2-h100` variants of Qwen 3.6 versions `1.0.0` and `1.1.0`:
`progressDeadlineSeconds: 2000` was below the startup probe budget,
`180 × 30 = 5400` seconds. Both values have been deliberately corrected to
`7200`, matching this model's other variants and leaving 1800 seconds beyond
the probe budget. No validator exception is needed for these configurations.

After this workflow is merged and its check has run, add **`validate-helm`** to
the target branch's required status checks in GitHub branch protection/rulesets.
The job runs on every PR, without workflow path filters, so the required check
also completes for documentation-only PRs.

This is offline compatibility validation of values and resource schemas. It
does not execute CEL, admission webhooks, or controller business logic, and
does not verify model paths, image pulls, engine arguments, or GPU execution.
Chart fields without constraints that never render cannot be fully checked here;
fix those constraints in the chart repository rather than duplicating the chart
contract in this catalog.

References: [Helm schema validation](https://helm.sh/docs/v3/topics/charts/#schema-files),
[kubeconform custom schemas](https://github.com/yannh/kubeconform#customresourcedefinition-crd-support),
[kubeconform limits](https://github.com/yannh/kubeconform#limits-of-kubeconform-validation).

# Helm validation schemas

`npm run validate:helm` checks every variant in selected model version YAMLs.
It downloads **released** charts from the official repository, lets Helm merge
the chart defaults with `variant.values`, runs `helm lint --strict` and
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

The repository index is fetched once per invocation. Helm resolves the declared
version constraint, and each resolved chart package is downloaded once and
checked against the index's SHA-256 digest. Every variant records the declared
constraint, resolved version and digest. Version ranges check the currently
selected release; they do not guarantee all past or future matching releases.

The default artifact directory is `artifacts/helm-validation/`; override it with
`--output DIR`. `summary.json` identifies files, variants, actual chart versions,
stage results and per-variant artifact directories. Each invocation has a fresh
`run-*` directory with extracted values, rendered manifests, tool logs, downloaded
charts, a schema cache and isolated Helm settings. CI uploads these artifacts
even on failure. Helm and kubeconform errors retain field paths.

## Schema sources and updates

[`sources.json`](sources.json) locks upstream CRDs to full commit SHAs.
[`provenance.json`](provenance.json) records source URLs, source hashes, served
versions and generated filenames. Both historical and current API groups are
included for `LLMScaler` and `LLMSLORequirement`: chart `0.7.1` uses the older
groups, while later releases use `modelsphere.dev`.

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
```

Review generated changes together with provenance. Changes to conversion rules
must regenerate the schemas; bump the converter version when changing an
already deployed conversion contract. Tool updates must also update archive
checksums in `config.json`.

The acceptance suite checks GLM's fixed and ranged chart declarations, both
Gemma variants, an LWS deployment, default values, misspelled fields, incorrect
types, invalid Kubernetes nesting, invalid CRD fields, template errors, no matching
release, and unknown/mismatched GVKs. Unit tests additionally cover selection,
download failures, a missing chart values schema, empty renders and failure
propagation.

## Rollout and limits

The initial full-catalog run checked 43 variants: 41 passed and two existing
Qwen configurations failed Helm's template check. Their published YAMLs are
intentionally preserved; the gate has no exception for these failures.

| Version file | Variant | Declared / resolved chart | Existing failure |
| --- | --- | --- | --- |
| `models/qwen3.6-35b-a3b/qwen3.6-35b-a3b-1.0.0.yaml` | `sglang-tp2-h100` | `0.7.1` / `0.7.1` | `values.progressDeadlineSeconds: 2000` is below the startup probe budget, `180 × 30 = 5400` seconds. |
| `models/qwen3.6-35b-a3b/qwen3.6-35b-a3b-1.1.0.yaml` | `sglang-tp2-h100` | `>=0.7.1` / `0.8.10` | The same deadline/startup budget mismatch. |

Consequently, this validator's introduction and subsequent changes that trigger
full-catalog validation will fail until those historical incompatibilities are
resolved. PRs that change other version configurations validate only their
selected files. The real acceptance suite passes independently of these two
historical failures. The resolved range version above records the initial run
and may change on future runs.

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

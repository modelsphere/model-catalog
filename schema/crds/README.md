# Helm validation

`npm run validate:helm` renders every variant of the selected model versions
with a released chart and checks the result: `helm lint --strict`,
`helm template`, then `kubeconform -strict` against the Kubernetes and CRD
schemas. CI runs it on every PR as the `validate-helm` job.

## Run it

Needs Node.js 24, `git`, `tar` and network access. Downloads honor
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.

```sh
npm ci
npm run helm:install                                   # pinned helm and kubeconform
npm run validate:helm                                  # every version file
npm run validate:helm -- --base origin/master          # what a branch changes
npm run validate:helm -- models/glm5.3/glm5.3-1.0.1.yaml
npm run validate:helm -- --chart-mode declared
npm run test:helm
npm run test:helm:integration                          # against released charts
```

Results go to `artifacts/helm-validation/`: `summary.json`, plus a `run-*`
directory holding each variant's values, rendered manifests and tool logs.

## What is checked

- **Versions**: those changed since the base. A change to the validator, this
  directory or the dependencies checks every version.
- **Chart**: `--chart-mode latest` (the default, and CI's) renders the newest
  stable chart at or above the minimum; `declared` renders the release the
  YAML's `chart.version` resolves to.
- **Minimum chart version**: set in `config.json` (sglang 0.8.0, vllm 0.5.0, the
  first releases on the `*.modelsphere.dev` API groups). A new version below it
  fails. A published version below it only warns, or is skipped in declared mode:
  published versions are never rewritten.
- **Values**: each variant's values, layered over
  [`ci-values.yaml`](ci-values.yaml), which stands in for a deploy's site profile.

## Files

| File | Holds |
| --- | --- |
| [`config.json`](config.json) | tool versions and checksums, Kubernetes version, chart repository, minimum chart versions |
| [`ci-values.yaml`](ci-values.yaml) | values a site profile supplies, which CI has no site for |
| [`crds.json`](crds.json) | the CRDs to validate against, each pinned to an upstream commit |
| [`crds-lock.json`](crds-lock.json) | the sha256 of each pinned CRD and the schemas it yields; written by `build-crds` |

## CRD schemas

The schemas are not committed. `npm run helm:build-crds [-- DIR]` downloads each
CRD in `crds.json` and converts it into a strict kubeconform schema
([`hack/lib/crd-schema.js`](../../hack/lib/crd-schema.js)). It works like
`npm install`: a lock in step with `crds.json` is honored, and a download whose
bytes differ from it is refused; a missing or stale lock is rewritten. With
`--locked` it fails instead, like `npm ci`. That is how `validate:helm` builds
them, into its run directory.

To change a CRD or the Kubernetes version, edit `crds.json` or `config.json`,
then:

```sh
npm run helm:build-crds   # rewrites crds-lock.json; commit it
npm run validate:helm
npm run validate:helm -- --chart-mode declared
```

## Limits

This checks values and resource schemas offline. It does not run CEL,
admission webhooks or controllers, and does not check images, model paths or
GPUs.

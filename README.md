# swiss-catalog

[![catalog](https://img.shields.io/badge/catalog-modelsphere.github.io%2Fmodel--catalog-6E40C9)](https://modelsphere.github.io/model-catalog/)
[![lints](https://github.com/modelsphere/model-catalog/actions/workflows/lint.yml/badge.svg)](https://github.com/modelsphere/model-catalog/actions/workflows/lint.yml)
[![pages](https://github.com/modelsphere/model-catalog/actions/workflows/pages.yml/badge.svg?branch=master)](https://github.com/modelsphere/model-catalog/actions/workflows/pages.yml)
[![License](https://img.shields.io/github/license/modelsphere/model-catalog)](LICENSE)
[![stars](https://img.shields.io/github/stars/modelsphere/model-catalog?style=flat&logo=github)](https://github.com/modelsphere/model-catalog/stargazers)

The models [Swiss](https://github.com/modelsphere/swiss) can deploy, and **how to serve
each one**: engine, image, flags, the GPUs it needs, and a tuned variant where
we have one. Nothing here says *where* a model runs; that belongs to each site's
private profile.

## Get started

**Browse** <https://modelsphere.github.io/model-catalog/>, rebuilt on every push
to `master`. Each model lists its variants, the GPUs they need, the tuned
variant's improvement over its baseline, and the perf report behind it. Filters
live in the URL, so a view can be shared, e.g.
[models on B300](https://modelsphere.github.io/model-catalog/?hardware=B300).

**Use it with swiss.** The site is also the catalog swiss reads (`index.json`):

```sh
swiss catalog list --catalog https://modelsphere.github.io/model-catalog/
```

```yaml
# swissd site profile
catalogs:
  - name: public
    url: https://modelsphere.github.io/model-catalog/
    default: true
```

To try this checkout instead, serve it locally (needs `npm install` and `python3`):

```sh
./hack/serve.sh                                   # http://127.0.0.1:8000
swiss plan --catalog http://127.0.0.1:8000 --model qwen3.6-35b-a3b   # also needs a site profile
```

## Add a model or variant

```
models/<name>/
  metadata.yaml            what the model IS: source.hf, displayName, description,
                           family, tags, tuning results. Editable.
  <name>-<version>.yaml    how it is SERVED: servedName, variants. Immutable once published.
  *-report.html            perf reports, linked from tuning
```

1. Start from the closest model: `models/qwen3.6-35b-a3b` (single node) or
   `models/kimi-k2.5` (multi-node, lws).

   ```sh
   npm install                  # also installs the pre-commit hook (validate:schema)
   cp -r models/qwen3.6-35b-a3b models/my-model
   ```

2. Keep one version file, renamed `my-model-1.0.0.yaml`, and delete the copied
   reports and `tuning`. Set `name: my-model` there and in `metadata.yaml`: the
   name and version inside a file must match its directory and filename.
3. Edit `metadata.yaml` for the model and the version file for how it is served.
4. Check and preview, then open a pull request:

   ```sh
   npm run validate:schema
   npm run helm:install && npm run validate:helm -- models/my-model/my-model-1.0.0.yaml
   PUBLISHED_INDEX=none npm run build:site   # open site/index.html
   ```

**A new variant, or a fix to a published one, is a new version file**
(`my-model-1.0.1.yaml`): deploys pin a version and its sha256. Editing a
published file in place needs a manual Pages run with *allow rewrites*.

What a variant needs to know:

| field | rule |
| --- | --- |
| `id` | unique in the version; an id with an `optimized` segment must have a `tuning` entry |
| `default` | at most one variant per version |
| `requires.gpus` | per pod; `nodes` + `topology: lws` for multi-node, with `values.lws.size` equal to `nodes` |
| `requires.vendor` | `nvidia` (default), `ascend`, `cambricon`, `hygon` or `amd`; one vendor per variant |
| `requires.gpuProduct` | canonical card names, any one matches: the `nvidia.com/gpu.product` value for NVIDIA (`NVIDIA-H100-80GB-HBM3`), `<Vendor>-<model>` otherwise (`Ascend-910B3`). swiss maps names to each cluster's node labels |
| `chart.version` | exact (`0.8.0`) or a [semver range](https://github.com/Masterminds/semver#checking-version-constraints), quoted (`">=0.8.0"`, `"^0.8.0"`) |
| `values` | chart values. Site-specific keys (namespace, host paths, registry, route ConfigMaps) are refused by the schema |

**Tuned?** Record the result in `metadata.yaml` and put the report beside it:

```yaml
tuning:
  - version: 1.0.0                       # a published version
    baseline: sglang-tp8-h100-baseline   # variant ids in that version
    optimized: sglang-tp8-h100-optimized
    uplift: 58.0                         # headline % over the baseline
    workloads:                           # optional: every workload measured
      - name: 50k + 1.5k                 # shown as "Agentic"
        uplift: 58.0
      - name: 8k + 1k                    # shown as "Long-Context QA"
        uplift: 23.4
    report: my-model-h100-report.html
```

A report must be a complete HTML document whose embedded JSON parses.
`validate:schema` fails on a missing, empty or invalid one; the site skips
linking it.

## Development

| command | does |
| --- | --- |
| `npm run validate:schema` | schemas, tuning references, report HTML (pre-commit and CI) |
| `npm run test:lib` | tests for `hack/lib` |
| `npm run helm:install` | pinned Helm and kubeconform, once |
| `npm run validate:helm -- <file>` | render a version's variants against the charts (`--chart-mode declared` for what a deploy uses) |
| `npm run build:site` | the site and `index.json` into `site/` |
| `npm test` | `hack/validate.sh`: naming and layout checks (needs `yq`) |
| `./hack/serve.sh` | rebuild `index.json` and serve the tree |

Needs Node.js 24.

- **CI.** `lints` runs on pull requests: `validate:schema`, `test:lib`, and
  `validate-helm` on changed version files against the latest stable charts
  ([Helm validation](schema/crds/README.md)). `pages` builds the site on pull
  requests and deploys it on push to `master`.
- **`index.json` is generated, not committed.** It is a pure function of
  `models/` and `catalog.yaml`, with no timestamp, so the same tree gives the
  same catalog ref in swiss.
- **Published versions don't change.** `hack/validate.sh` refuses edits to a
  committed version file, and the Pages build compares against the live
  `index.json`:

  | `REWRITES` | when | does |
  | --- | --- | --- |
  | `refuse` | push to `master` | fails the deploy |
  | `warn` | pull request | reports it |
  | `allow` | manual run with *allow rewrites* | publishes the in-place edit |

  `PUBLISHED_INDEX=<url|file|none>` changes what the build compares against;
  `none` builds offline.
- **swissd refuses an `index.json` field it does not know.** A new field must
  be understood by every swissd reading this catalog before it merges.

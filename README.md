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

**Browse** <https://modelsphere.github.io/model-catalog/>, rebuilt on every push to `master`.
The front page, **Deployment Recipe**, lists every variant on its own, to compare them across models; in the table,
the Model and Hardware headers filter on any number of values. [Models](https://modelsphere.github.io/model-catalog/models.html)
lists each model with its variants, the GPUs they need, the tuned variant's improvement over its baseline, and the perf report behind it.
Filters live in the URL, so a view can be shared, e.g.
[recipes on B300, fewest GPUs first](https://modelsphere.github.io/model-catalog/?hardware=B300&sort=gpus) or
[models on B300](https://modelsphere.github.io/model-catalog/models.html?hardware=B300).

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

To try this checkout instead, serve it locally with the catalog server (needs `npm install`):

```sh
npm run serve                                     # http://127.0.0.1:8000
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
   npm run tools:install && npm run validate:helm -- models/my-model/my-model-1.0.0.yaml
   npm run validate:images -- models/my-model/my-model-1.0.0.yaml
   npm run dev:site                          # preview at http://localhost:5173/model-catalog/
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
| `image` | on a public registry, pullable without a login |
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
      - name: 50k + 1.5k                 # shown as "Agent long-context"
        uplift: 58.0
      - name: 8k + 1k                    # shown as "Document QA"
        uplift: 23.4
    report: my-model-h100-report.html
```

A report must be a complete HTML document whose embedded JSON parses. `validate:schema` fails on a missing, empty or invalid one; the site skips
linking it. The images it records must be the two variants' own (registry, repository and tag), which `validate:images` checks.

## Schema v2

One file per variant, edited in place ([#30](https://github.com/modelsphere/model-catalog/issues/30)).

```
models/<name>/
  metadata.yaml   apiVersion: catalog.swiss/v2   schema/metadata.v2.schema.json
  <id>.yaml       one variant                    schema/variant.schema.json
```

```yaml
# models/kimi-k3/sglang-tp8-pp4-6000d.yaml
apiVersion: catalog.swiss/v2
kind: Variant
model: kimi-k3
id: sglang-tp8-pp4-6000d
version: 1.0.5                     # semver, raised on every change
servedName: kimi-k3
engine: sglang
chart: { name: sglang, version: ">=0.7.0" }
requires: { gpus: 8, nodes: 4, topology: lws, gpuProduct: [NVIDIA-RTX-6000D] }
values: { ... }
```

```yaml
# models/kimi-k3/metadata.yaml
apiVersion: catalog.swiss/v2
name: kimi-k3
source: { hf: moonshotai/Kimi-K3 }
defaultVariant: sglang-tp8-b300-optimized     # replaces a variant's default: true
tuning:
  - version: 1.0.4                            # legacy: the v1 version measured, kept for index.json
    baseline: sglang-tp8-b300-baseline@1.0.5  # <id>@<version> measured
    optimized: sglang-tp8-b300-optimized@1.0.5
    uplift: 57.6
    report: kimi-k3-1.0.4-b300-report.html
```

- A deploy pins commit, path and sha256; `history.json` maps each version to its commit.
- Published: `index-v2.json` (`schema/index-v2.schema.json`) and `models/<name>/<id>.history.json`.
- Migrate a model: `node hack/migrate-v2.js <model> [--dry-run]`.

## Development

| command | does |
| --- | --- |
| `npm run validate:schema` | schemas, naming and layout, tuning references, report HTML (pre-commit and CI) |
| `npm test` | every unit test: the catalog library, the Helm validator, the catalog server, and the site's types and tests (`npm run test:web` for the site alone) |
| `npm run tools:install` | pinned Helm, kubeconform and crane, once |
| `npm run validate:helm` | render every variant against the charts (`--chart-mode declared` for what a deploy uses) |
| `npm run validate:images` | (needs `tools:install`, for crane) every image is publicly pullable without a login, by tag and by any pinned `digest`, and every perf report measured its variants' builds<br> a tag that has moved off its pinned digest is a warning; `--match-digest` makes it an error |
| `npm run validate` | `validate:schema`, `validate:helm` and `validate:images` |
| `npm run dev:site` | the site at <http://localhost:5173/model-catalog/>, live from `models/` |
| `npm run build:site` | the site into `site/`: both model-catalog pages and index files served for swiss |
| `npm run serve` | the catalog server: `index-v2.json`, `index.json`, the variant and version files, histories and reports, live from `models/` |

`validate:helm` and `validate:images` check every version file; pass files, or
`--base REF` for what a branch changes, to narrow them.

Needs Node.js 24.

- **Backend and frontend, one GitHub Pages site.**
- **`index.json` is generated, not committed.** It is a pure function of `models/` and `catalog.yaml`, with no timestamp, so the same tree gives the same catalog ref in swiss.
- **Published versions don't change.** The Pages build compares every version file against the live `index.json`,
  by model and version as swiss looks it up; one moved with its bytes unchanged is listed, not a rewrite. An edit or a deletion:

  | `REWRITES` | when | does |
  | --- | --- | --- |
  | `refuse` | push to `master` | fails the deploy |
  | `warn` | pull request | reports it |
  | `allow` | manual run with *allow rewrites* | publishes the in-place edit |

  `PUBLISHED_INDEX=<url|file|none>` changes what the build compares against; `none` builds offline.
- **swissd refuses an `index.json` field it does not know.** A new field must be understood by every swissd reading this catalog before it merges.

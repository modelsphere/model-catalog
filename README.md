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
the Model and Hardware headers filter on any number of values. Each model's page shows its variants in full, with
the tuned variant's improvement over its baseline, the perf report behind it, and each variant's revision history.
Filters live in the URL, so a view can be shared, e.g.
[recipes on B300, fewest GPUs first](https://modelsphere.github.io/model-catalog/?hardware=B300&sort=gpus).

 [swiss](https://github.com/modelsphere/swiss) deploys from this catalog, reading it at the site's address.
 It is the deployment backend of [ModelSphere](https://github.com/modelsphere/modelsphere), with [Console](https://github.com/modelsphere/console) as its web portal;
 see ModelSphere to get started.

## Add a model or variant

One file per variant, edited in place

```
models/<name>/      named after metadata.yaml's name
  metadata.yaml     what the model IS: source.hf, displayName, description,   schema/metadata.v2.schema.json
                    family, tags, defaultVariant, tuning results
  <id>.yaml         how one variant is SERVED, named after its id            schema/variant.schema.json
  *-report.html     perf reports, linked from tuning
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
displayName: Kimi K3
family: kimi
source: { hf: moonshotai/Kimi-K3 }
defaultVariant: sglang-tp8-b300-optimized     # the first variant file when absent
```

1. Start from the closest model: `models/qwen3.6-35b-a3b` (single node) or
   `models/kimi-k2.5` (multi-node, lws).

   ```sh
   npm install                  # also installs the pre-commit hook (validate:schema)
   mkdir models/my-model
   cp models/qwen3.6-35b-a3b/metadata.yaml models/qwen3.6-35b-a3b/sglang-tp2-h100.yaml models/my-model/
   ```

2. Set `name: my-model` in `metadata.yaml` and `model: my-model` in each variant file, drop the copied
   `tuning`, and start each variant at `version: 1.0.0`. A variant file is named after its `id`.
3. Edit `metadata.yaml` for the model and each variant file for how it is served.
4. Check and preview, then open a pull request:

   ```sh
   npm run validate:schema
   npm run tools:install && npm run validate:helm -- models/my-model/sglang-tp2-h100.yaml
   npm run validate:images -- models/my-model/sglang-tp2-h100.yaml
   npm run dev:site                          # preview at http://localhost:5173/model-catalog/
   ```

**Change a variant in place, and raise its `version`** with every change; a raised version must change something
else too. Git keeps every revision: a deploy pins a variant by commit, path and sha256, and the variant's
`history.json` maps each version to the commit that released it. A version's release date is that commit's date,
so it is not in the file. To retire a variant, publish it with `deprecated: true` (or a reason), then delete
the file in a later change.

What a variant needs to know:

| field | rule |
| --- | --- |
| `id` | unique in the model, and the file's name; an id with an `optimized` segment must have a `tuning` entry |
| `version` | semver, raised on every change to the file |
| `requires.gpus` | per pod; `nodes` + `topology: lws` for multi-node, with `values.lws.size` equal to `nodes` |
| `requires.vendor` | `nvidia` (default), `ascend`, `cambricon`, `hygon` or `amd`; one vendor per variant |
| `requires.gpuProduct` | canonical card names, any one matches: the `nvidia.com/gpu.product` value for NVIDIA (`NVIDIA-H100-80GB-HBM3`), `<Vendor>-<model>` otherwise (`Ascend-910B3`). swiss maps names to each cluster's node labels |
| `image` | on a public registry, pullable without a login |
| `chart.version` | exact (`0.8.0`) or a [semver range](https://github.com/Masterminds/semver#checking-version-constraints), quoted (`">=0.8.0"`, `"^0.8.0"`). A new or changed variant's must resolve to a release at or above the chart's minimum in `schema/crds/config.json` |
| `values` | chart values. Site-specific keys (namespace, host paths, registry, route ConfigMaps) are refused by the schema |
| `deprecated` | `true` or a reason: the variant is on its way out |
| `replaces` | the id of a variant this one renames or supersedes |

**Tuned?** Record the result in `metadata.yaml`, naming the variant versions measured, and put the report beside it:

```yaml
tuning:
  - baseline: sglang-tp8-h100-baseline@1.0.0    # <id>@<version> measured
    optimized: sglang-tp8-h100-optimized@1.0.0
    uplift: 58.0                                # headline % over the baseline
    workloads:                                  # optional: every workload measured
      - name: 50k + 1.5k                        # shown as "Agent long-context"
        uplift: 58.0
      - name: 8k + 1k                           # shown as "Document QA"
        uplift: 23.4
    report: my-model-h100-report.html
```

A measured version may be older than the variant's current one: the site shows the newest result for each tuned variant.
A report must be a complete HTML document whose embedded JSON parses. `validate:schema` fails on a missing, empty or invalid one; the site skips
linking it. The images it records must be the two variants' own (registry, repository and tag), which `validate:images` checks.

## Development

| command | does |
| --- | --- |
| `npm run validate:schema` | schemas, naming and layout, version raises, tuning references, report HTML (pre-commit and CI)<br> without `--base`, version raises over every variant's whole history; `--skip-version-bump` leaves them out |
| `npm test` | every unit test: the catalog library, the Helm validator, the catalog server, and the site's types and tests (`npm run test:web` for the site alone) |
| `npm run tools:install` | pinned Helm, kubeconform and crane, once |
| `npm run validate:helm` | render every variant against the charts (`--chart-mode declared` for what a deploy uses) |
| `npm run validate:images` | (needs `tools:install`, for crane) every image is publicly pullable without a login, by tag and by any pinned `digest`, and every perf report measured its variants' builds<br> a tag that has moved off its pinned digest is a warning; `--match-digest` makes it an error |
| `npm run validate` | `validate:schema`, `validate:helm` and `validate:images` |
| `npm run dev:site` | the site at <http://localhost:5173/model-catalog/>, live from `models/`; `CATALOG=<url>` reads another server, such as a `catalog-server` (editing on) |
| `npm run build:web` | the web app into `dist/web/`: the pages and the `<model-catalog>` element, for any server to serve under any path |
| `npm run build:site` | `build:web`, then `site/` for GitHub Pages (`hack/build-site.js`): `dist/web/` at `/model-catalog/`, with `index-v2.json`, every variant file and its `history.json`, and the perf reports beside it; `npm run preview:site` serves it |
| `npm run serve` | the catalog server: the same files, live from `models/` |

`validate:helm` and `validate:images` check every variant file; pass files, or
`--base REF` for what a branch changes, to narrow them.

Needs Node.js 24, and a full git clone (`fetch-depth: 0` in CI): versions, release dates and histories come from git.

- **Backend and frontend, one GitHub Pages site.**
- **`index-v2.json` is generated, not committed** (`schema/index-v2.schema.json`). It is a function of `models/`,
  `catalog.yaml` and their git history, with no timestamp, so the same commit gives the same catalog.
- **`history.json` is generated too**: `models/<name>/<id>.history.json`, every revision of a variant file, newest first.

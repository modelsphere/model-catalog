# swiss-catalog

![GitHub License](https://img.shields.io/github/license/:modelsphere/model-catalog)


The models [Swiss](https://github.com/modelsphere/swiss) can deploy, and **how to serve
each one**: engine, image, flags, the GPUs it needs, and a tuned variant where
we have one. Nothing here says *where* a model runs; that belongs to each site's
private profile.

**Browse the catalog: <https://modelsphere.github.io/model-catalog/>**

## Get started

| You want to… | Start here |
| --- | --- |
| Find a model and see what hardware it needs | [Browse the catalog](#browse-the-catalog) |
| Try a model with `swiss` | [Use the catalog with swiss](#use-the-catalog-with-swiss) |
| Add a model, or publish a new version | [Add a model](#add-a-model) |
| Understand why the catalog is shaped this way | [Versions are immutable](#versions-are-immutable) and the sections after it |

### Browse the catalog

<https://modelsphere.github.io/model-catalog/> lists every model in this repo
and is rebuilt on each push to `master`. For each model it shows:

- its variants, and the GPUs each one needs (`8 × H100`, `8 × GPU × 2 nodes`)
- which variant is the default
- how much faster the tuned variant is than the baseline, and the perf report
  behind that number

You can search, filter by family, engine, hardware or tag, sort by uplift, and
switch between a table and cards. Filters are kept in the URL, so a view can be
shared. For example:
[every model with a tuned variant, biggest uplift first](https://modelsphere.github.io/model-catalog/?cmp=1&sort=uplift).

### Use the catalog with swiss

`swiss` and `swissd` read the catalog through `index.json`. The published
catalog is the site itself, <https://modelsphere.github.io/model-catalog/>:

```sh
swiss catalog list --catalog https://modelsphere.github.io/model-catalog/
```

or, in a swissd site profile:

```yaml
catalogs:
  - name: public
    url: https://modelsphere.github.io/model-catalog/
    default: true
```

A deploy records the model version and the sha256 of its file, so it can be
reproduced months later: a published version never changes. To point swiss at
this checkout instead (needs `yq`, `jq` and `python3`):

```sh
./hack/serve.sh                                      # http://127.0.0.1:8000
swiss catalog list --catalog http://127.0.0.1:8000
swiss plan --catalog http://127.0.0.1:8000 --model glm5.1
```

`swiss plan` renders a real deploy, so it also needs a site profile (namespace,
model paths, registry mirror). That lives outside this repo.

### Add a model

You need Node.js. Start from the closest existing model:

```sh
npm install                          # schema checker, plus a pre-commit hook that runs it
cp -r models/glm5.1 models/my-model  # or models/kimi-k2.5 for a multi-node model
```

1. In `models/my-model/`, rename the version file to `my-model-1.0.0.yaml`, and
   set `name: my-model` in it and in `metadata.yaml`.
2. Edit `metadata.yaml` for what the model *is* (Hugging Face repo, display
   name, description, tags), and the version file for how it is *served*
   (image, engine flags, GPUs).
3. Check it, and preview the catalog page:

   ```sh
   npm run validate:schema   # the same check CI runs
   npm run build:site        # then open site/index.html
   ```

4. Open a pull request. Leave `index.json` alone: CI rejects a PR that changes
   it, and it is regenerated on `master` after merge.

If you tuned it, record the result as `tuning` in `metadata.yaml`; see
[GitHub Pages](#github-pages). A published version never changes. To fix one,
add `my-model-1.0.1.yaml` instead of editing it. Every field is described in
[docs/authoring.md](docs/authoring.md).

## Development

```
index.json                    generated, the published surface
catalog.yaml                  catalog-wide settings: where the site is published
schema/metadata.schema.json   what a model is
schema/version.schema.json    what a version and its variants are
models/<name>/metadata.yaml         shared by every version, editable
models/<name>/<name>-<version>.yaml one version and its variants, immutable
docs/authoring.md             schema reference, and how to add a model
hack/build-index.sh           regenerate index.json
hack/build-site.js            build the GitHub Pages site into site/
hack/validate.sh              CI
hack/serve.sh                 serve it over HTTP, for local development
```

A published catalog is a static site, and `./hack/serve.sh` is the smallest
thing that behaves like one: it rebuilds the index, then serves the tree.

## Versions are immutable

A model publishes versions, like a package: `models/qwen3.6-35b-a3b/qwen3.6-35b-a3b-1.2.0.yaml`,
named the way helm names a chart archive. A deploy
pins one or takes the latest, and records **the version and a sha256 of the entry
file**. `index.json` carries that digest, and a consumer refuses an entry whose
bytes no longer match it.

Nothing parses that filename back apart. Model names carry dots and hyphens, so
`qwen3.6-35b-a3b-glm-5-1.0.0.yaml` has no unambiguous split — and both
`qwen3.6-35b-a3b` and `qwen3.6-35b-a3b-glm-5` are published here. The document
declares its own `name` and `version`; the filename is checked against them, not
read for them.

So a published version is frozen. Fix a mistake by publishing `1.2.1`, never by
editing `1.2.0` — a rewritten version silently changes what every existing deploy
would recompose to, which is exactly what the digest exists to catch.
`hack/validate.sh` refuses a commit that edits an already-published file.

## Chart versions

`variants[].chart.version` is one chart version or a range, in helm's constraint
syntax. A range is how a chart fix reaches a published model version without
publishing a new one.

| `chart.version` | means |
| --- | --- |
| `0.7.1` | exactly 0.7.1 |
| `">=0.7.1"` | 0.7.1 or newer (quoted: a bare `>` starts a YAML block scalar) |
| `"^0.7.1"` | 0.7.x from 0.7.1; in 0.x, a minor bump is the breaking one |
| `">=0.7.1 <0.9.0"` | both |

A deploy still pins: swissd records the one version the range resolved to (the
newest in range, or one the operator picks) and an upgrade keeps it until asked
to move. Prereleases match only a range that names one.

## What belongs here

A model, and the variants it can be served as. A **variant** is a hardware and
parallelism decision: `--tp-size=8` on an 8-GPU B300 node is one variant, the
same weights at `--tp-size=2` on two GPUs is another. The fields that distinguish
them (`extraArgs`, `requires.gpus`, `lws.size`) only ever move together, so they
are one object. A form that let someone pick TP8 and a 2-GPU node independently
would eventually be used to do exactly that, and the failure arrives forty
minutes later as an OOM in a log nobody is watching.

## What does not belong here, and cannot be written

This repo is public. A namespace, a host path, a registry mirror or a route
ConfigMap is not public information, and is not the same for two readers — so
those keys are absent from the schema, not merely discouraged:

| layer | owns | lives in |
| --- | --- | --- |
| **catalog** | model identity, parallelism, engine flags, probes | here |
| **site profile** | `model.localPath`, `cache.hostPath`, registry rewrite, `scaler.serverAddress`, `modelRoute.*.outputConfigMap`, namespace | the private charts repo, next to `deploys/` |
| **deploy form** | `replicaCount`, `scaler.*`, scheduling, `modelRoute.*`, `cart.*`, `sloRequirement.*` | `swiss` flags, or the web UI |

Both schemas are closed (`additionalProperties: false`) for the entry's own
fields. `variants[].values` is the exception: it is chart values, any object,
because restating the chart's schema here would be a second copy to keep in step.

Probes are here, not in the deploy form, because cold-load time is a property of
the model: 1.9 TiB over two nodes is a 40-minute load, and a default
`failureThreshold: 3` kills it after 45 seconds with no error anywhere.

## Adding a model

The steps are under [Get started](#add-a-model), and every field is described
in [docs/authoring.md](docs/authoring.md). The name and version inside a version
file must match its directory and filename.

`index.json` is generated but committed, so what consumers fetch is the reviewed
artifact rather than something built on demand. Pull requests change `models/`
only; `index.json` is regenerated with `./hack/build-index.sh` on `master`
after merge, and CI rejects a PR that touches it. It carries no build timestamp:
a committed generated file has to produce an empty diff when nothing changed, or
the staleness check in `validate.sh` cannot tell fresh from stale.

Needs `yq` and `jq`, plus `check-jsonschema` or `npm install` (`hack/validate-schema.js`). `npm install` installs a pre-commit hook that runs the Node schema check.

## Not settled

- **Signing.** Pinning by SHA and requiring a chart digest covers accidents, not
  a compromised repo.
- **Image digests.** `image.digest` is accepted but unused; nothing resolves tags
  to digests yet, so a moved tag still moves.
- **`servedName` is treated as a model property**, but the fallback release
  serves Qwen under the name `kimi` so callers do not change. That is a deploy
  decision wearing a catalog field; see the note in
  `../swiss/docs/swiss-design.md`.

## Layout

```
models/<name>/
  metadata.yaml              what the model IS: source.hf, displayName,
                             description, family, tags, license, and
                             measured tuning results
  <name>-<version>.yaml      how it is SERVED: servedName, variants
```

| file | holds | mutable |
| --- | --- | --- |
| `metadata.yaml` | model identity and description, shared by every version | yes — inlined into `index.json` and never fetched by a consumer |
| `<name>-<version>.yaml` | the serving config: engine image, flags, probes, hardware | no — consumers pin the version and verify its sha256 |

`source.hf` is in metadata because a different repo id is a different model, not
a new version of this one. Editing it cannot change an already-deployed release
— that plan carries the resolved `model.localPath` — it changes the catalog ref,
which the reconciliation view reports, and shows up in the next diff.

A version file carrying its own `source:` is refused: the split is enforced, not
a convention.

## Accelerator vendors

`requires.vendor` names the brand a variant is built for, defaulting to
`nvidia`. It decides the extended resource the pod requests and the node label
its product is published under — not merely which card matches.

| vendor | resource | product label |
| --- | --- | --- |
| `nvidia` | `nvidia.com/gpu` | `nvidia.com/gpu.product` |
| `ascend` | `huawei.com/Ascend910` | `accelerator/huawei-ascend910` |
| `cambricon` | `cambricon.com/mlu` | `cambricon.com/mlu.product` |
| `hygon` | `hygon.com/dcu` | `hygon.com/dcu.product` |
| `amd` | `amd.com/gpu` | `amd.com/gpu.device-id` |

The mapping lives in swiss, not here: a public catalog should not carry
Kubernetes resource strings, and every site would otherwise repeat the same
well-known table.

One vendor per variant. A CANN build of an engine is a different image with
different `extraArgs` than a CUDA build, so a model that runs on both publishes
two variants — `sglang-tp8-b300` and `sglang-tp8-910b` — and the deploy form
picks one. `gpuProduct` then narrows within the declared vendor.

## GitHub Pages

The [catalog site](#browse-the-catalog) is built by `hack/build-site.js` and
deployed by `.github/workflows/pages.yml` on every push to `master`. Pull
requests build it without deploying. It is two things at one URL:

- **the page**, built from `models/`, so it shows a model as soon as it merges;
- **the catalog** swiss reads: the committed `index.json`, byte for byte, and
  every version file it names, at the same paths. Each file is checked against
  the digest `index.json` published, so an edited or deleted published version
  fails the build rather than being served. A model merged since `index.json`
  was last regenerated is on the page but not yet in the catalog; the deploy
  warns until `./hack/build-index.sh` is run on `master` and committed.

```sh
npm ci
npm run build:site   # writes site/; open site/index.html to preview
```

Every `models/<name>/*.html` perf report is copied into the site and linked from
its model. A tuned pair, and how much faster it is, is declared in the model's
`metadata.yaml`:

```yaml
tuning:
  - version: 1.0.0                       # a published version
    baseline: sglang-tp8-h100-baseline   # variant ids in that version
    optimized: sglang-tp8-h100-optimized
    uplift: 58.0                         # headline: % over the baseline
    workloads:                           # optional: every workload measured
      - name: 50k + 1.5k
        uplift: 58.0
      - name: 8k + 1k
        uplift: 23.4
    report: deepseek-v4-flash-0731-h100-report.html   # beside metadata.yaml
```

`uplift` is the number the site leads with; when the benchmark ran several
workloads, list them all under `workloads` and the site shows the rest beside it.
`tuning` lives in `metadata.yaml` rather than the version file because nothing
composes from it: re-measuring is an edit, not a new version.
`npm run validate:schema` checks that the version is published, both ids are
variants of it, and the report exists, and it fails when a variant named
`…-optimized` has no `tuning` entry, so a tuned pair cannot be left
unrecorded. The site reads this field only; variant ids and descriptions are
not parsed for it.

Every entry names its `report`, and that is the tuned variant's link: the site
serves it at `<site>models/<name>/<report>`, where `site` comes from
`catalog.yaml`. `index.json` carries both `site` and each model's `tuning`, so a
consumer such as swiss builds the link itself. No variant carries it: a version
file is immutable once published, and would have to name a page that does not
exist until the site is deployed.

swissd refuses an index with a field it does not know. A field added to
`index.json` -- `site` and `tuning` among them -- has to be understood by every
swissd reading this catalog before `index.json` is regenerated with it.


# swiss-catalog

Public model catalog for [Swiss](../swiss/docs/swiss-design.md). One entry per model,
describing **how that model should be served** — and nothing about where.

A consumer (`swiss`, `swissd`) fetches `index.json` to list models, then one
`entry.yaml` when a model is opened, always **pinned to a commit SHA**. A catalog
that moves under a deploy is a supply-chain surface, and the SHA is what makes a
deploy reproducible six months later.

```
index.json                    generated, the published surface
schema/metadata.schema.json   what a model is
schema/version.schema.json    what a version and its variants are
models/<name>/metadata.yaml         shared by every version, editable
models/<name>/<name>-<version>.yaml one version and its variants, immutable
docs/authoring.md             schema reference, and how to add a model
hack/build-index.sh           regenerate index.json
hack/validate.sh              CI
hack/serve.sh                 serve it over HTTP, for local development
```

A published catalog is a static site. `./hack/serve.sh` is the smallest thing
that behaves like one -- it rebuilds the index, then serves the tree:

```sh
./hack/serve.sh                 # http://127.0.0.1:8000
swiss catalog list --catalog http://127.0.0.1:8000
```

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

1. `models/<name>/<name>-<version>.yaml`, with `name:` and `version:` inside
   matching the directory and the filename — see `models/glm5.1/` for a
   single-node model, `models/kimi-k2.5/` for multi-node. Add
   `models/<name>/metadata.yaml` if the model is new.
2. `./hack/build-index.sh`
3. `./hack/validate.sh`
4. Commit both the entry and `index.json`.

`index.json` is generated but committed, so what consumers fetch is the reviewed
artifact rather than something built on demand. It carries no build timestamp:
a committed generated file has to produce an empty diff when nothing changed, or
the staleness check in `validate.sh` cannot tell fresh from stale.

Needs `yq` and `jq`, plus `check-jsonschema` or `ajv` for validation.

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
                             description, family, tags, license
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

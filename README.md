# swiss-catalog

Public model catalog for [Swiss](../swiss/docs/swiss-design.md). One entry per model,
describing **how that model should be served** — and nothing about where.

A consumer (`swiss`, `swissd`) fetches `index.json` to list models, then one
`entry.yaml` when a model is opened, always **pinned to a commit SHA**. A catalog
that moves under a deploy is a supply-chain surface, and the SHA is what makes a
deploy reproducible six months later.

```
index.json                    generated, the published surface
schema/entry.schema.json      what an entry is
models/<name>/entry.yaml      one model
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

`schema/entry.schema.json` is closed (`additionalProperties: false`) at every
level, so it is also the ownership check — there is no second linter that could
disagree with it.

Three keys are rejected inside `values` because they already have a spelling
elsewhere in the same file, and two spellings drift: `image` (use the variant's
`image`), `model.name` (use `servedName`), `model.gpus` (use `requires.gpus`).
The charts take the same line with `nvidia.com/gpu`, refusing a second spelling
rather than letting one quietly win.

Probes are here, not in the deploy form, because cold-load time is a property of
the model: 1.9 TiB over two nodes is a 40-minute load, and a default
`failureThreshold: 3` kills it after 45 seconds with no error anywhere.

## Adding a model

1. `models/<name>/entry.yaml` — see `models/qwen3.6-35b-a3b/entry.yaml` for the
   two-engine case, `models/kimi-k2.5/entry.yaml` for multi-node.
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
- **Sizes and probe thresholds** in the example entries are illustrative. Measure
  them on real hardware before trusting either.

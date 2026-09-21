#!/usr/bin/env bash
# Regenerate index.json from models/<name>/. Commit the result.
#
# index.json is the published surface: a client fetches one file to render the
# marketplace, and only pulls a version once a model is opened. It is generated
# rather than hand-written, and committed rather than built on demand, so that
# what a consumer fetches is the reviewed artifact.
#
# Each version carries a sha256 of its file. That digest is the lock: a consumer
# records it with the deploy and refuses the version later if the bytes changed,
# which is what makes "pinned to 1.2.0" mean something in a repo anyone can push
# to. There is deliberately no build timestamp -- a committed generated file must
# produce an empty diff when nothing changed.
#
# metadata.yaml is inlined here and never fetched by a consumer, which is what
# lets it stay editable: it holds no value a deploy renders, so it needs no
# digest and no version bump.
set -euo pipefail
cd "$(dirname "$0")/.."

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

for dir in models/*/; do
  meta="$dir/metadata.yaml"
  [ -e "$meta" ] || { echo "$dir: no metadata.yaml" >&2; exit 1; }

  for f in "$dir"*-*.yaml; do
    [ -e "$f" ] || continue
    yq -o=json "$f" | jq -c \
      --arg path "$f" \
      --arg digest "sha256:$(sha256 "$f")" \
      --argjson meta "$(yq -o=json "$meta")" '{
        name, version, path: $path, digest: $digest,
        displayName: $meta.displayName, description: $meta.description,
        family: $meta.family, tags: $meta.tags, deprecated: $meta.deprecated,
        source: { hf: $meta.source.hf, revision: $meta.source.revision, sizeGiB: $meta.source.sizeGiB },
        variants: [.variants[] | {id, engine, default, description, chart, requires}]
      } | del(.. | nulls)'
  done
done | jq -s '
  [ group_by(.name)[]
    | sort_by(.version | split(".") | map(tonumber? // 0)) as $vs
    | ($vs | last) as $newest
    | {
        name: $newest.name,
        displayName: $newest.displayName, description: $newest.description,
        family: $newest.family, tags: $newest.tags, deprecated: $newest.deprecated,
        source: $newest.source,
        latest: $newest.version,
        versions: [ $vs | reverse | .[] | {version, path, digest, variants} ]
      }
    | del(.. | nulls) ]
  | { apiVersion: "catalog.swiss/v1", count: length, models: . }
' > index.json

echo "index.json: $(jq -r '.count' index.json) models, $(jq -r '[.models[].versions | length] | add' index.json) versions"

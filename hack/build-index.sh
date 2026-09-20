#!/usr/bin/env bash
# Regenerate index.json from models/<name>-<version>.yaml. Commit the result.
#
# index.json is the published surface: a client fetches one file to render the
# marketplace, and only pulls an entry once a model is opened. It is generated
# rather than hand-written, and committed rather than built on demand, so that
# what a consumer fetches is the reviewed artifact.
#
# Each version carries a sha256 of its file. That digest is the lock: a consumer
# records it with the deploy and refuses the entry later if the bytes changed,
# which is what makes "pinned to 1.2.0" mean something in a repo anyone can push
# to. There is deliberately no build timestamp -- a committed generated file must
# produce an empty diff when nothing changed.
#
# The filename is never parsed back into a name and a version: both are read from
# the document. Model names carry dots and hyphens, so splitting
# qwen3.6-35b-a3b-1.0.0.yaml is guesswork the file itself can answer.
set -euo pipefail
cd "$(dirname "$0")/.."

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

for f in models/*.yaml; do
  [ -e "$f" ] || continue
  yq -o=json "$f" | jq -c --arg path "$f" --arg digest "sha256:$(sha256 "$f")" '{
    name, displayName, description, family, tags, deprecated,
    source: { hf: .source.hf, sizeGiB: .source.sizeGiB },
    version, path: $path, digest: $digest,
    variants: [.variants[] | {id, engine, default, description, chart, requires}]
  } | del(.. | nulls)'
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

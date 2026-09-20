#!/usr/bin/env bash
# Regenerate index.json from models/*/entry.yaml. Commit the result.
#
# index.json is the published surface: a client fetches one file to render the
# marketplace, and only pulls an entry.yaml once a model is opened. It is
# generated rather than hand-written, and committed rather than built on demand,
# so that what a consumer fetches is the reviewed artifact -- the same reasoning
# as `rendered/` in the charts repo.
#
# There is deliberately no build timestamp in it: a generated file that is
# committed must produce an empty diff when nothing changed, or `check` below
# cannot tell a stale index from a fresh one.
set -euo pipefail
cd "$(dirname "$0")/.."

for f in models/*/entry.yaml; do
  yq -o=json "$f" | jq --arg path "$f" '{
    name, displayName, description, family, tags, deprecated,
    source: { hf: .source.hf, sizeGiB: .source.sizeGiB },
    variants: [ .variants[] | { id, engine, default, description, chart, requires } ],
    path: $path
  } | del(.. | nulls)'
done | jq -s '{ apiVersion: "catalog.swiss/v1", count: length, models: . }' > index.json

echo "index.json: $(jq -r '.count' index.json) models, $(jq '[.models[].variants|length]|add' index.json) variants"

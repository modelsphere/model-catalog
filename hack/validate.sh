#!/usr/bin/env bash
# Validate every entry against schema/entry.schema.json, then check index.json
# is not stale. This is the whole of CI for this repo.
#
# The schema is closed at every level, so it does double duty: it checks shape,
# and it is what rejects a site-owned or deploy-owned key in a public catalog
# (a namespace, a host path, a registry, replicaCount, anything under scaler,
# modelRoute or cart). There is no separate ownership linter -- an extra rule
# that could disagree with the schema is worse than no extra rule.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v check-jsonschema >/dev/null; then
  validate() { check-jsonschema --schemafile schema/entry.schema.json "$@"; }
elif command -v ajv >/dev/null; then
  validate() { for f in "$@"; do yq -o=json "$f" > "/tmp/$(basename "$(dirname "$f")").json"; done
               ajv validate -s schema/entry.schema.json --spec=draft2020 -d "/tmp/*.json"; }
else
  echo "need check-jsonschema (pipx install check-jsonschema) or ajv (npm i -g ajv-cli)" >&2
  exit 1
fi

validate models/*/entry.yaml

# Cross-entry rules the schema cannot see, because each file is validated alone.
dupes=$(yq -r '.name' models/*/entry.yaml | sort | uniq -d)
[ -z "$dupes" ] || { echo "duplicate model names: $dupes" >&2; exit 1; }

for f in models/*/entry.yaml; do
  d=$(yq -r '[.variants[].id] | .[]' "$f" | sort | uniq -d)
  [ -z "$d" ] || { echo "$f: duplicate variant ids: $d" >&2; exit 1; }
  n=$(yq -r '[.variants[] | select(.default == true)] | length' "$f")
  [ "$n" -le 1 ] || { echo "$f: $n variants marked default, at most one allowed" >&2; exit 1; }
  # lws.size and requires.nodes describe the same group. A disagreement hangs the
  # group at rendezvous instead of failing, so it is caught here.
  bad=$(yq -r '[.variants[] | select(.values.lws.enabled == true)
                | select(.values.lws.size != .requires.nodes) | .id] | join(",")' "$f")
  [ -z "$bad" ] || { echo "$f: lws.size != requires.nodes in: $bad" >&2; exit 1; }
done

./hack/build-index.sh >/dev/null
if ! git diff --quiet -- index.json; then
  echo "index.json is stale -- run ./hack/build-index.sh and commit" >&2
  git --no-pager diff --stat -- index.json
  exit 1
fi
echo "ok"

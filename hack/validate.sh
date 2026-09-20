#!/usr/bin/env bash
# Validate every published version against schema/entry.schema.json, then check
# index.json is not stale. This is the whole of CI for this repo.
#
# The schema is closed at every level, so it does double duty: it checks shape,
# and it is what rejects a site-owned or deploy-owned key in a public catalog
# (a namespace, a host path, a registry, replicaCount, anything under scaler,
# modelRoute or cart). There is no separate ownership linter -- an extra rule
# that could disagree with the schema is worse than no extra rule.
set -euo pipefail
cd "$(dirname "$0")/.."

entries=(models/*.yaml)

if command -v check-jsonschema >/dev/null; then
  check-jsonschema --schemafile schema/entry.schema.json "${entries[@]}"
elif command -v ajv >/dev/null; then
  for f in "${entries[@]}"; do yq -o=json "$f" > "/tmp/$(basename "$f" .yaml).json"; done
  ajv validate -s schema/entry.schema.json --spec=draft2020 -d "/tmp/*.json"
else
  echo "need check-jsonschema (pipx install check-jsonschema) or ajv (npm i -g ajv-cli)" >&2
  exit 1
fi

for f in "${entries[@]}"; do
  name="$(yq -r '.name' "$f")"
  version="$(yq -r '.version' "$f")"

  # Built from the document, never parsed out of the filename: model names carry
  # dots and hyphens, so qwen3.6-35b-a3b-glm-5-1.0.0.yaml has no unambiguous
  # split -- and both qwen3.6-35b-a3b and qwen3.6-35b-a3b-glm-5 are published.
  want="models/${name}-${version}.yaml"
  [ "$f" = "$want" ] || { echo "$f: declares $name $version, so it must be named $want" >&2; exit 1; }

  d="$(yq -r '[.variants[].id] | .[]' "$f" | sort | uniq -d)"
  [ -z "$d" ] || { echo "$f: duplicate variant ids: $d" >&2; exit 1; }

  n="$(yq -r '[.variants[] | select(.default == true)] | length' "$f")"
  [ "$n" -le 1 ] || { echo "$f: $n variants marked default, at most one allowed" >&2; exit 1; }

  # lws.size and requires.nodes describe the same group. A disagreement hangs the
  # group at rendezvous instead of failing, so it is caught here.
  bad="$(yq -r '[.variants[] | select(.values.lws.enabled == true)
                 | select(.values.lws.size != .requires.nodes) | .id] | join(",")' "$f")"
  [ -z "$bad" ] || { echo "$f: lws.size != requires.nodes in: $bad" >&2; exit 1; }
done

./hack/build-index.sh >/dev/null
if ! git diff --quiet -- index.json; then
  echo "index.json is stale -- run ./hack/build-index.sh and commit" >&2
  git --no-pager diff --stat -- index.json
  exit 1
fi

# A published version is immutable: consumers pin it and verify its digest. A
# change to one already committed is a rewritten release, and the digest is how a
# consumer finds out -- loudly, at deploy time. Catch it here instead.
for f in $(git diff --name-only HEAD -- 'models/*.yaml' 2>/dev/null || true); do
  if git cat-file -e "HEAD:$f" 2>/dev/null; then
    echo "$f was published already; publish a new version instead of editing it" >&2
    exit 1
  fi
done

echo "ok"

#!/usr/bin/env bash
# Validate every model directory, then check index.json is not stale. This is
# the whole of CI for this repo.
#
set -euo pipefail
cd "$(dirname "$0")/.."

metas=(models/*/metadata.yaml)
versions=(models/*/*-*.yaml)

schema_check() {
  local schema="$1"; shift
  if command -v check-jsonschema >/dev/null; then
    check-jsonschema --schemafile "$schema" "$@"
  elif command -v ajv >/dev/null; then
    local tmp; tmp="$(mktemp -d)"
    for f in "$@"; do yq -o=json "$f" > "$tmp/$(echo "$f" | tr / _).json"; done
    ajv validate -s "$schema" --spec=draft2020 -d "$tmp/*.json"
  else
    echo "need check-jsonschema (pipx install check-jsonschema) or ajv (npm i -g ajv-cli)" >&2
    exit 1
  fi
}

schema_check schema/metadata.schema.json "${metas[@]}"
schema_check schema/version.schema.json "${versions[@]}"

for meta in "${metas[@]}"; do
  dir="$(dirname "$meta")"
  name="$(yq -r '.name' "$meta")"
  [ "$dir" = "models/$name" ] || { echo "$meta: declares $name, so it must live in models/$name" >&2; exit 1; }
done

for f in "${versions[@]}"; do
  dir="$(dirname "$f")"
  name="$(yq -r '.name' "$f")"
  version="$(yq -r '.version' "$f")"

  # Built from the document, never parsed out of the filename: model names carry
  # dots and hyphens, so glm5.1-1.0.0.yaml has no unambiguous split.
  want="$dir/${name}-${version}.yaml"
  [ "$f" = "$want" ] || { echo "$f: declares $name $version, so it must be named $want" >&2; exit 1; }
  [ "$dir" = "models/$name" ] || { echo "$f: declares $name, so it must live in models/$name" >&2; exit 1; }

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

# Every model directory must have at least one published version, or it is an
# empty shell the index will silently skip.
for dir in models/*/; do
  count="$(find "$dir" -maxdepth 1 -name '*-*.yaml' | wc -l | tr -d ' ')"
  [ "$count" -gt 0 ] || { echo "$dir: no version files" >&2; exit 1; }
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
#
# metadata.yaml is deliberately not covered: it is inlined into index.json, never
# fetched by a consumer, and holds nothing a deploy renders.
for f in $(git diff --name-only HEAD -- 'models/*/*-*.yaml' 2>/dev/null || true); do
  if git cat-file -e "HEAD:$f" 2>/dev/null; then
    echo "$f was published already; publish a new version instead of editing it" >&2
    exit 1
  fi
done

echo "ok"

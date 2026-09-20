#!/usr/bin/env bash
# Serve this catalog over HTTP, the way a published one is served: index.json at
# the root, entries at the paths it names. For local development -- a real
# catalog is a static site, and this is the smallest thing that behaves like one.
#
#   ./hack/serve.sh            # http://127.0.0.1:8000
#   ./hack/serve.sh 9000
#   swiss catalog list --catalog http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")/.."

port="${1:-8000}"
./hack/build-index.sh >/dev/null   # never serve a stale index

echo "catalog: http://127.0.0.1:${port}/  ($(jq -r .count index.json) models)"
exec python3 -m http.server "$port" --bind 127.0.0.1

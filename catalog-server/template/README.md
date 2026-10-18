# Model catalog

A [swiss](https://github.com/modelsphere/model-catalog) model catalog, schema v2. A catalog-server serves it and
edits it: every change made there is a commit here, by whoever made it.

| path | is |
| --- | --- |
| `catalog.yaml` | the catalog's settings |
| `models/<name>/metadata.yaml` | a model: what it is, its default recipe, its tuning |
| `models/<name>/<id>.yaml` | one recipe of it (a variant): how to serve it. Each change raises its `version` |
| `models/<name>/*.html` | perf reports, linked from its tuning |

A change pushed here directly is served too, after the server's next sync. Versions, release dates and each
recipe's history come from this repository's history: never rewrite it.

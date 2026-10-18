# catalog-server

A swiss model catalog of your own, served from its git repository and written to over HTTP. It serves
schema v2 only: `index-v2.json`, the variant files it names, each variant's `history.json`, and old revisions at
`raw/<commit>/`, at the same paths as [model-catalog](https://github.com/modelsphere/model-catalog)'s published site, so swiss and the web app read
it the same way. The catalog is a git repository in a local directory, and every write is a commit there.

The repository is laid out like model-catalog: `catalog.yaml`, and `models/<name>/` with a `metadata.yaml`
(`apiVersion: catalog.swiss/v2`) and one `<id>.yaml` per variant. Models whose `metadata.yaml` is v1 are left out, and
v1 version files are not served.

## Run it

Its settings are one YAML file, [`catalog-server.example.yaml`](catalog-server.example.yaml), which has every
setting and what it does. Copy it, and set at least where the catalog is:

```yaml
# catalog-server.yaml
publicUrl: https://catalog.example.com/
repository:
  dir: /data/catalog # a local directory: the catalog's git repository
committer:
  name: Catalog Bot
  email: catalog-bot@example.com
tokensFile: tokens.yaml # who may write: see Tokens below
```

```sh
npm ci && npm start                              # ./catalog-server.yaml
node src/main.js --config /etc/catalog-server/config.yaml
```

In a container, the image reads `/etc/catalog-server/config.yaml`; a relative path in it, like `tokens.yaml`, is
from that directory:

```sh
docker build -t catalog-server .
docker run -d -p 8000:8000 -v catalog:/data \
  -v "$PWD/catalog-server.yaml:/etc/catalog-server/config.yaml:ro" \
  -v "$PWD/tokens.yaml:/etc/catalog-server/tokens.yaml:ro" \
  catalog-server
```

A setting it does not know, or one of the wrong type, stops the server with what is wrong, rather than being
ignored.

### Start from nothing

A catalog can start as an empty directory, such as a newly mounted volume, or none at all. The server leaves
`repository.dir` as it is and serves an empty catalog; until the catalog is initialized, it takes no writes (`409`).
Initializing it makes `repository.dir` a bare git repository and commits the template's files to it, and from then on
it is edited like any other:

```sh
curl -s https://catalog.example.com/api/v2/init                        # {"initialized": false, "commit": null}
curl -s -X POST https://catalog.example.com/api/v2/init \
  -H "Authorization: Bearer $TOKEN" -d '{"repo": "https://git.example.com/ml/catalog"}'
# {"commit": "…", "initialized": true, "files": ["README.md", "catalog.yaml"]}
```

The template is [`template/`](template): a `catalog.yaml`, naming `publicUrl` as its `site` and the `repo` given as
its repository (each left out when unset), and a `README.md` saying what the repository is. `repository.template`
in the config points to a directory of your own instead: every file in it is committed, `{{site}}` and `{{repo}}`
filled in. A catalog is initialized once it has a `catalog.yaml`; a repository that already has models but no
`catalog.yaml` is initialized around them, and a file it already has is never replaced.

### Try it locally

On a throwaway copy of model-catalog, with the web app editing it. From the model-catalog checkout:

```sh
git clone --bare . /tmp/catalog-test
cat > catalog-server/catalog-server.yaml <<'YAML'
repository:
  dir: /tmp/catalog-test # the catalog: writes commit here
  branch: master
tokensFile: tokens.yaml
YAML
cat > catalog-server/tokens.yaml <<'YAML'
- name: Your Name
  email: you@example.com
  token: local-dev-token-123456
YAML
npm --prefix catalog-server ci && npm --prefix catalog-server start      # http://127.0.0.1:8000
CATALOG=http://127.0.0.1:8000 npm run dev:site                           # in another terminal
```

At <http://localhost:5173/model-catalog/>, a model's recipes have **Edit**; the token is `local-dev-token-123456`.
`git --git-dir /tmp/catalog-test log master` shows what you committed. (Both files are git-ignored.) To have
the server serve the pages itself instead, `npm run build:web` and add `pagesDir: ../dist/web`.

`GET /healthz`, at the server's root, is 200 with the commit served, and says what went wrong last (a repository it could not
read) and which files it skipped (YAML that does not parse). It is 503 only before the first catalog is
read.

**swiss** reads it like the public catalog, in the site profile:

```yaml
catalogs:
  - name: internal
    url: https://catalog.example.com/ # publicUrl
    schemaVersion: v2
    default: true
```

## Write to it

```sh
T="Authorization: Bearer $TOKEN"
V=https://catalog.example.com/api/v2/models/deepseek-v4-flash/variants/sglang-tp4-6000d

curl -s -D headers "$V" -o v.yaml          # the file, and its digest as ETag
$EDITOR v.yaml                            # change it, and raise version
curl -s -X PUT "$V" -H "$T" -H "If-Match: $(grep -i ^etag headers | cut -d' ' -f2)" \
  -H "X-Commit-Message: tp4: mem fraction 0.86" --data-binary @v.yaml
```

| request                                     | does                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET api/v2/models/<name>/variants/<id>`    | the variant file, with its digest as `ETag`                                                                                                             |
| `PUT api/v2/models/<name>/variants/<id>`    | adds it (`If-None-Match: *`) or replaces it (`If-Match: <digest>`); the body is the YAML, kept byte for byte                                            |
| `DELETE api/v2/models/<name>/variants/<id>` | deletes it (`If-Match`), unless it is the `defaultVariant`, a tuning entry names it, or it is the model's last                                          |
| `GET`, `PUT api/v2/models/<name>/metadata`  | the model's `metadata.yaml`, replaced at its digest (`If-Match`)                                                                                        |
| `POST api/v2/models`                        | a new model, in one commit: `{"metadata": "<metadata.yaml>", "variants": ["<variant YAML>", ...]}`                                                      |
| `GET api/v2/`                               | what the server takes: `{"apiVersion": "catalog.swiss/v2", "write": <whether tokensFile is set>, "auth": "bearer"}`. The web app turns editing on by it |
| `GET api/v2/init`                           | whether the catalog is initialized: `{"initialized": <bool>, "commit": <its tip, or null>}`                                                             |
| `POST api/v2/init`                          | initializes it: commits the template's files, `{"repo": "<web URL>"}` optional. `409` once initialized ([start from nothing](#start-from-nothing))      |

Every write takes `?dryRun=true`, which checks it and answers with what it would serve, without committing, and
`X-Commit-Message`, or `?message=` for text a header cannot carry (default: `<model>/<id>: <version>`). It answers with the commit and the catalog's entry for what it
wrote: `{commit, path, model, id, version, digest, releaseDate, history}`.

### What a write goes through

1. **Who.** The bearer token names the author of the commit; the server is its committer.
2. **One at a time.** Writes and syncs take turns, so none plans on a branch another is moving.
3. **On the tip.** The server reads the branch first, so a push made to the repository meanwhile is no conflict.
4. **Seen what it replaces.** `If-Match` must be the file's current digest: `412` with the `current` one if not, `428`
   if an edit sends none. The same bytes sent again (a retry) are `200` and commit nothing.
5. **Identity.** YAML, `apiVersion: catalog.swiss/v2`, `kind: Variant`, `model` and `id` the ones in the path, in a v2
   model; a `metadata.yaml` names its directory, and its `defaultVariant` a variant it has.
6. **Versions.** `version` is semver and raises the variant's last revision, a deleted one's included, as its history
   goes on through a delete; and the change is more than the version. `422` lists every problem, with the version to
   send.
7. **Commit.** Built from git objects in a private index, on the tip: there is no working tree to leave half-written.
   The catalog at that commit is built, as it will be served.
8. **Move.** The branch moves to the commit only if it is still at the tip the commit was built on. If someone
   pushed to the repository meanwhile, `409`: read again and retry, and nothing moved.
9. **Serve.** The branch moves and the new catalog is swapped in whole: a read sees the commit before or after, never
   between. The new revision's release date is the commit's, and the one it replaced stays at
   `raw/<its commit>/models/<name>/<id>.yaml`, at the digest its history lists, for whatever is pinned to it.

The repository is a git repository like any other: clone it, inspect it, back it up. A change pushed to it directly
is served after the next sync (`repository.syncInterval`), a force-push too. To keep a copy on a git host, push from
it there, from a job of your own: the server talks to no remote.

What the server does not check is whether a variant is a good one: its JSON schema, its chart values, its images.
That is model-catalog's `validate`.

### Tokens

The `tokensFile` is YAML, read again whenever it changes, so a token is added or revoked without a restart:

```yaml
- name: Ada Lovelace
  email: ada@example.com
  sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 # printf %s "$TOKEN" | sha256sum
- name: CI
  email: ci@example.com
  token: a-token-of-16-characters-or-more
```

Reads need no token: put the server where only those who may read it can reach it.

## The web app

With `pagesDir` set to model-catalog's `npm run build:web` output (`../dist/web`), the server serves model-catalog's
web app beside the catalog, under `basePath`: the same pages as its GitHub Pages site, of this catalog. It is one app
for both; what it shows comes from the server it is served with:

| server                                                                                    | serves                                                                 | editing          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| model-catalog's `server/` (`npm run serve`, `dev:site`), and its snapshot on GitHub Pages | that checkout's catalog, read-only                                     | off              |
| catalog-server                                                                            | a catalog's git repository, and the write API: every write is a commit | on, with a token |

The app asks the server at `api/v2/` whether it takes writes; a static host has nothing there, so the app stays
read-only. Where it does, each recipe gets **Edit** and **Delete**, each model **New recipe** and **Edit model**, and
the front and models pages **New model** -- or, on an empty catalog, **Set up this catalog**. Each opens the file's
YAML, checks a change with the server before committing it, and says so when someone else changed the file first.
The token is asked for once, and kept for the tab, or the browser when remembered.

### Embed it

Another page, such as a console, can show the catalog with the `<model-catalog>` element: the recipes, the models
and each model's page, isolated in a shadow root. The server serves it with the pages (model-catalog's GitHub Pages
site serves one too, of the public catalog):

```html
<script type="module" src="https://catalog.example.com/element/model-catalog.js"></script>
<model-catalog path="/models/kimi-k2.5" theme="dark"></model-catalog>
```

| attribute  | does                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `src`      | the catalog's root; by default, where the script came from                                          |
| `path`     | the page it opens (`/`, `/?hardware=B300`, `/models.html`, `/models/<name>`); changing it navigates |
| `theme`    | `light`, `dark`, or `system` (the default)                                                          |
| `readonly` | no editing, even from a server that takes writes                                                    |

It fires `navigate` (`event.detail.path`) on every move, for a page that keeps the path in its own URL. A
ctrl-click or middle-click opens the catalog's own page. Editing works in it as on the site: the server answers
any origin, and a write needs a token all the same.

## Development

| command          | does                                                      |
| ---------------- | --------------------------------------------------------- |
| `npm test`       | the tests, against throwaway repositories (`node --test`) |
| `npm start`      | the server, with `./catalog-server.yaml`                  |
| `npm run format` | Prettier                                                  |

| file              | is                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `src/main.js`     | the start                                                                                   |
| `src/config.js`   | the config file: its settings, checked                                                      |
| `src/server.js`   | the HTTP routes                                                                             |
| `src/store.js`    | the snapshot served, and the write and sync that change it, one at a time                   |
| `src/writes.js`   | what each write changes, and the checks it must pass                                        |
| `src/catalog.js`  | the catalog at a commit: index-v2.json and the histories, as model-catalog's build has them |
| `src/git.js`      | the repository, through git plumbing: reading commits, writing one                          |
| `src/tokens.js`   | who may write                                                                               |
| `src/template.js` | what initializing an empty catalog commits: the files under `template/`                     |

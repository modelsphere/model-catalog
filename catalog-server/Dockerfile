# catalog-server with model-catalog's web app: one image that serves a schema
# v2 catalog from its git repository, its write API, and the pages and the
# <model-catalog> element that read and edit it.
#
# Built from the repository root, which holds the web app:
#
#   docker build -f catalog-server/Dockerfile -t catalog-server .
#   docker run -p 8000:8000 -v catalog:/data catalog-server
#
# Its settings are /etc/catalog-server/config.yaml (catalog-server.example.yaml).
# The one in the image (image.yaml) serves /data/catalog with the pages, and no
# one may write; mount your own over it, keeping pagesDir: /app/web, to set
# tokensFile:
#
#   docker run -p 8000:8000 -v catalog:/data \
#     -v ./catalog-server.yaml:/etc/catalog-server/config.yaml:ro \
#     -v ./tokens.yaml:/etc/catalog-server/tokens.yaml:ro \
#     catalog-server
#
# The catalog is not in the image: it is a git repository under /data, a
# volume: a bare clone you put there, or, when there is none, made there by
# setting the catalog up (POST api/v2/init).
#
# Dockerfile.dockerignore, beside this file, is what the build sees of the root.

# The web app: model-catalog's npm run build:web, into dist/web/. It needs the
# app, the catalog server and library its config loads, and catalog.yaml --
# not models/, nor git history.
FROM node:24-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
# No install scripts: husky's sets up a git checkout's hooks, and there is none.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY catalog.yaml ./
COPY asserts/ asserts/
COPY hack/lib/ hack/lib/
COPY server/ server/
COPY web/ web/
RUN npm run build:web

# catalog-server's own dependencies, without its dev tools.
FROM node:24-slim AS server
WORKDIR /app
COPY catalog-server/package.json catalog-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-slim
# git for the catalog itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=server /app/node_modules/ node_modules/
COPY catalog-server/package.json ./
COPY catalog-server/src/ src/
COPY catalog-server/template/ template/
COPY --from=web /src/dist/web/ web/
COPY catalog-server/image.yaml /etc/catalog-server/config.yaml

RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "src/main.js", "--config", "/etc/catalog-server/config.yaml", "--healthcheck"]
CMD ["node", "src/main.js", "--config", "/etc/catalog-server/config.yaml"]

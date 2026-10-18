# catalog-server: a schema v2 model catalog, served from its git repository
# and written to over HTTP. Its settings are /etc/catalog-server/config.yaml
# (catalog-server.example.yaml). The catalog is not in the image: it is a git
# repository under /data, a volume: a bare clone you put there, or, when there
# is none, made there by setting the catalog up (POST api/v2/init).
#
#   docker build -t catalog-server .
#   docker run -p 8000:8000 -v catalog:/data \
#     -v ./catalog-server.yaml:/etc/catalog-server/config.yaml:ro \
#     -v ./tokens.yaml:/etc/catalog-server/tokens.yaml:ro \
#     catalog-server
#
# with repository.dir /data/catalog in the config, and tokensFile
# tokens.yaml (a path in it is from its directory).
FROM node:24-slim

# git for the catalog itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/ src/
COPY template/ template/

RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "src/main.js", "--config", "/etc/catalog-server/config.yaml", "--healthcheck"]
CMD ["node", "src/main.js", "--config", "/etc/catalog-server/config.yaml"]

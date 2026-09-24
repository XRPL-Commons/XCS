# Indexer image. Build context: the repository root.
# Only apps/indexer, db/ and config/ enter the image, so no workspace file is
# ever visible and the install needs no --ignore-workspace.
# Override with an immutable reference such as node:24-alpine@sha256:<digest>
# in release/deployment automation. The tag default keeps local builds ergonomic.
ARG XCS_NODE_IMAGE=node:24-alpine
FROM ${XCS_NODE_IMAGE} AS build

RUN npm install -g pnpm@10.34.4

WORKDIR /workspace
COPY apps/indexer ./apps/indexer
COPY db ./db
COPY config ./config

WORKDIR /workspace/apps/indexer
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Prune to production dependencies from the same lockfile.
RUN pnpm install --frozen-lockfile --prod

FROM ${XCS_NODE_IMAGE} AS runtime

ARG XCS_REVISION=unknown
ARG XCS_VERSION=0.0.0

LABEL org.opencontainers.image.title="XCS indexer" \
      org.opencontainers.image.description="XCS ledger indexer" \
      org.opencontainers.image.source="https://github.com/XRPL-Commons/XCS" \
      org.opencontainers.image.revision="${XCS_REVISION}" \
      org.opencontainers.image.version="${XCS_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
# The image carries db/migrations beside the built application, so the migrate
# and bootstrap bins work for any caller without extra environment.
ENV XCS_MIGRATIONS_DIR=/workspace/db/migrations

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/indexer/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/indexer/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/indexer/package.json ./package.json
COPY --chown=node:node db/migrations ./db/migrations
COPY --chown=node:node config ./config

USER node
CMD ["node", "dist/main.js"]

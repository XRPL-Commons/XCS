# One-shot database migration and role bootstrap job. Build context: repository root.
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
RUN pnpm install --frozen-lockfile --prod

FROM ${XCS_NODE_IMAGE} AS runtime

ARG XCS_REVISION=unknown
ARG XCS_VERSION=0.0.0

LABEL org.opencontainers.image.title="XCS database bootstrap" \
      org.opencontainers.image.description="XCS pre-deploy migrations and least-privilege roles" \
      org.opencontainers.image.source="https://github.com/XRPL-Commons/XCS" \
      org.opencontainers.image.revision="${XCS_REVISION}" \
      org.opencontainers.image.version="${XCS_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV XCS_MIGRATIONS_DIR=/workspace/db/migrations

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/indexer/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/indexer/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/indexer/package.json ./package.json
COPY --chown=node:node db/migrations ./db/migrations

USER node
CMD ["node", "dist/lib/db/bin/bootstrap.js"]

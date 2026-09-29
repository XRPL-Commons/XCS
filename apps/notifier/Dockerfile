# Administrator notification worker. Build context: the repository root.
# It compiles the notifier from apps/web so the worker and web service use the
# exact same mail delivery and database code.
ARG XCS_NODE_IMAGE=node:24-alpine
FROM ${XCS_NODE_IMAGE} AS build

RUN npm install -g pnpm@10.34.4

WORKDIR /workspace
COPY apps/web ./apps/web
COPY db ./db
COPY config ./config

WORKDIR /workspace/apps/web
RUN pnpm install --frozen-lockfile
RUN NODE_ENV=production pnpm build
RUN pnpm install --frozen-lockfile --prod

FROM ${XCS_NODE_IMAGE} AS runtime

ARG XCS_REVISION=unknown
ARG XCS_VERSION=0.0.0

LABEL org.opencontainers.image.title="XCS administrator notifier" \
      org.opencontainers.image.description="XCS administrator decision notification worker" \
      org.opencontainers.image.source="https://github.com/XRPL-Commons/XCS" \
      org.opencontainers.image.revision="${XCS_REVISION}" \
      org.opencontainers.image.version="${XCS_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/web/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/web/package.json ./package.json

USER node
CMD ["node", "dist/admin/admin-notifier.js"]

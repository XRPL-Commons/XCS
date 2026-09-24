# Web app image. Build context: the repository root.
# Only apps/web, db/ and config/ enter the image, so no workspace file is ever
# visible and the install needs no --ignore-workspace.
# Override with an immutable reference such as node:24-alpine@sha256:<digest>
# in release/deployment automation. The tag default keeps local builds ergonomic.
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

FROM ${XCS_NODE_IMAGE} AS runtime

ARG XCS_REVISION=unknown
ARG XCS_VERSION=0.0.0

LABEL org.opencontainers.image.title="XCS web" \
      org.opencontainers.image.description="XCS web application and /v1 read API" \
      org.opencontainers.image.source="https://github.com/XRPL-Commons/XCS" \
      org.opencontainers.image.revision="${XCS_REVISION}" \
      org.opencontainers.image.version="${XCS_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV NITRO_PORT=3000

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output
COPY --chown=node:node config ./config

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

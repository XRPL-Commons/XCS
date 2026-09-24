# Web app image. Build context: the repository root.
# Only apps/web, db/ and config/ enter the image, so no workspace file is ever
# visible and the install needs no --ignore-workspace.
FROM node:24-alpine AS build

RUN npm install -g pnpm@10.34.4

WORKDIR /workspace
COPY apps/web ./apps/web
COPY db ./db
COPY config ./config

WORKDIR /workspace/apps/web
RUN pnpm install --frozen-lockfile
RUN NODE_ENV=production pnpm build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV NITRO_PORT=3000

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output
COPY --chown=node:node config ./config

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

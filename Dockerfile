# Web app image for DigitalOcean App Platform (gh deploy-setup). Build context is the repo root.
# The Compose stack keeps using docker/Dockerfile.node for every service.
FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@10.34.4

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
COPY config ./config

RUN pnpm install --frozen-lockfile
# Builds @xcs-protocol/core and @xcs-protocol/sdk first, then the Nuxt output.
RUN NODE_ENV=production pnpm --filter "@xcs-protocol/web..." build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV NITRO_PORT=3000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

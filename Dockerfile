# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS dependency-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

FROM dependency-base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-pi-brace-expansion.mjs ./scripts/patch-pi-brace-expansion.mjs
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM dependency-base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-pi-brace-expansion.mjs ./scripts/patch-pi-brace-expansion.mjs
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PATH=/app/node_modules/.bin:$PATH \
    PORT=7860 \
    PUBLIC_HTTP_HOST=0.0.0.0 \
    PUBLIC_HTTP_PORT=7860 \
    INTERNAL_HTTP_HOST=127.0.0.1 \
    INTERNAL_HTTP_PORT=8788 \
    MODEL_BROKER_HOST=127.0.0.1 \
    MODEL_BROKER_PORT=8790 \
    MODEL_PROVIDER_POLICY=host-broker-only \
    DATA_ROOT=/data/feishu-agent-platform \
    PLATFORM_DATABASE_PATH=/data/feishu-agent-platform/platform.db \
    PLATFORM_CONFIG_ROOT=/app/config

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data /data/feishu-agent-platform

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node skills ./skills
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node docs ./docs
COPY --chown=node:node web ./web

VOLUME ["/data"]
USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

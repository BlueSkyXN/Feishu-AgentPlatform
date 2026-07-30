# syntax=docker/dockerfile:1.7
#
# Hugging Face Docker Space wrapper. Product runtime files are deliberately
# absent from this build context: the container installs the manifest-selected,
# immutable payload tarball from the private hfs-dist bucket at startup.

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
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
    PLATFORM_CONFIG_ROOT=/opt/app/config

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data /data/feishu-agent-platform \
    && install -d -o node -g node -m 0755 /opt/app

COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/fap-entrypoint.sh
COPY --chown=node:node docker/artifact-bootstrap.mjs /usr/local/lib/fap-artifact-bootstrap.mjs
RUN chmod 0755 /usr/local/bin/fap-entrypoint.sh /usr/local/lib/fap-artifact-bootstrap.mjs

VOLUME ["/data"]
USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7860/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/fap-entrypoint.sh"]

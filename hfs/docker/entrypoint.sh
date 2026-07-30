#!/usr/bin/env bash
# Hugging Face Space entrypoint: validate the persistent mount, install the
# manifest-selected immutable artifact, then start the platform.
set -euo pipefail

log() {
  printf '[fap-hfs] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 64
}

[ "${PORT:-7860}" = "7860" ] || fail "PORT must remain 7860 for this Docker Space"

: "${FAP_ARTIFACT_MANIFEST_HF_URI:?FAP_ARTIFACT_MANIFEST_HF_URI is required}"
: "${FAP_ARTIFACT_BEARER_TOKEN:?FAP_ARTIFACT_BEARER_TOKEN is required}"
: "${FAP_ARTIFACT_EXPECTED_SOURCE_REF:?FAP_ARTIFACT_EXPECTED_SOURCE_REF is required}"

if [ ! -d /data ] || [ -L /data ] || [ ! -w /data ]; then
  fail "persistent /data mount is missing, unsafe, or not writable"
fi

install_root="${FAP_ARTIFACT_INSTALL_ROOT:-/opt/app}"
marker="$install_root/.artifact-source-ref"
current=""
if [ -f "$marker" ]; then
  current="$(head -n 1 "$marker" 2>/dev/null || true)"
fi

if [ "$current" != "$FAP_ARTIFACT_EXPECTED_SOURCE_REF" ]; then
  log "installing artifact for source ${FAP_ARTIFACT_EXPECTED_SOURCE_REF}"
  node /usr/local/lib/fap-artifact-bootstrap.mjs
else
  log "artifact for source ${FAP_ARTIFACT_EXPECTED_SOURCE_REF} already installed"
fi

cd /opt/app
log "starting platform (public :${PUBLIC_HTTP_PORT:-7860})"
exec node dist/index.js

#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function domainStageFor(domains, subdomain) {
  const expectedHost = subdomain === 'pending' ? '' : `${subdomain}.hf.space`;
  const matching = expectedHost
    ? domains.find((domain) => [domain?.domain, domain?.host, domain?.url]
      .some((value) => typeof value === 'string' && value.includes(expectedHost)))
    : undefined;
  return nonEmptyString((matching ?? domains[0])?.stage, 'unknown');
}

export function evaluateSpaceRuntime(
  info,
  expectedSha,
  pausedSince = 0,
  now = Date.now(),
  pausedGraceMs = 120_000,
) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw new TypeError('Space info must be a JSON object');
  }
  if (typeof expectedSha !== 'string' || !expectedSha) {
    throw new TypeError('Expected Hugging Face SHA is required');
  }
  if (!Number.isFinite(pausedSince) || pausedSince < 0) {
    throw new TypeError('PAUSED start time must be a non-negative number');
  }
  if (!Number.isFinite(now) || now < 0) {
    throw new TypeError('Current time must be a non-negative number');
  }
  if (!Number.isFinite(pausedGraceMs) || pausedGraceMs < 1) {
    throw new TypeError('PAUSED grace period must be a positive number');
  }

  const runtimeEnvelope = info.runtime && typeof info.runtime === 'object'
    ? info.runtime
    : {};
  const runtime = runtimeEnvelope.raw && typeof runtimeEnvelope.raw === 'object'
    ? runtimeEnvelope.raw
    : runtimeEnvelope;
  const domains = Array.isArray(runtime.domains) ? runtime.domains : [];
  const repoSha = nonEmptyString(info.sha, 'pending');
  const runtimeSha = nonEmptyString(runtime.sha, 'pending');
  const stage = nonEmptyString(runtime.stage ?? runtimeEnvelope.stage, 'unknown');
  const subdomain = nonEmptyString(info.subdomain, 'pending');
  const subdomainValid = subdomain !== 'pending' &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(subdomain);
  const domainStage = domainStageFor(domains, subdomain);
  const exactRepository = repoSha === expectedSha;
  const abuse = Boolean(runtime.abuse);
  const runtimeError = Boolean(runtime.errorMessage);
  const blocked = abuse || runtimeError;
  const pausedStartedAt = exactRepository && stage === 'PAUSED'
    ? pausedSince || now
    : 0;
  const pausedForMs = pausedStartedAt ? Math.max(0, now - pausedStartedAt) : 0;

  let disposition = 'wait';
  let reason = 'runtime_not_ready';

  // 即使残留字段仍为 RUNNING，平台拦截和错误状态也必须优先失败。
  if (abuse || (exactRepository && (runtimeError || stage.endsWith('_ERROR')))) {
    disposition = 'terminal';
    reason = abuse ? 'platform_abuse' : runtimeError ? 'platform_error' : 'runtime_error';
  } else if (exactRepository && subdomain !== 'pending' && !subdomainValid) {
    disposition = 'terminal';
    reason = 'invalid_subdomain';
  } else if (exactRepository && pausedForMs >= pausedGraceMs) {
    disposition = 'terminal';
    reason = 'paused_timeout';
  } else if (
    exactRepository &&
    runtimeSha === expectedSha &&
    stage === 'RUNNING' &&
    domainStage === 'READY' &&
    subdomainValid
  ) {
    disposition = 'ready';
    reason = 'ready';
  }

  return {
    disposition,
    reason,
    repoSha,
    runtimeSha,
    stage,
    domainStage,
    subdomain,
    subdomainValid,
    blocked,
    pausedSince: pausedStartedAt,
    pausedForMs,
  };
}

function cli() {
  const [, , inputPath, expectedSha, pausedSinceValue = '0', stateOutputPath] = process.argv;
  if (!inputPath || !expectedSha) {
    throw new Error(
      'Usage: hf-space-runtime-state.mjs INFO_JSON EXPECTED_SHA [PAUSED_SINCE_EPOCH_MS] [STATE_OUTPUT_JSON]',
    );
  }
  const pausedSince = Number.parseInt(pausedSinceValue, 10);
  const info = JSON.parse(readFileSync(inputPath, 'utf8'));
  const result = evaluateSpaceRuntime(info, expectedSha, pausedSince);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!stateOutputPath) {
    process.stdout.write(serialized);
    return;
  }
  writeFileSync(stateOutputPath, serialized, { mode: 0o600 });
  process.stdout.write(`${[
    result.disposition,
    result.reason,
    result.repoSha,
    result.runtimeSha,
    result.stage,
    result.domainStage,
    result.subdomain,
    result.pausedSince,
    result.pausedForMs,
  ].join('\t')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli();
}

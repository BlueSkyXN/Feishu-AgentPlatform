import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';

import type { HostConfig, ModelProviderPolicy } from './types.js';

export function loadHostConfig(projectRoot = process.cwd()): HostConfig {
  const resolvedProjectRoot = resolve(projectRoot);
  const isHuggingFaceSpace = Boolean(
    process.env.SPACE_ID?.trim() || process.env.HF_SPACE_ID?.trim(),
  );
  const dataRoot = resolve(
    process.env.DATA_ROOT?.trim() ||
      (isHuggingFaceSpace
        ? '/data/feishu-agent-platform'
        : join(resolvedProjectRoot, 'data')),
  );
  const shardCount = envInteger('APP_SHARD_COUNT', 1, 1, 1024);
  const shardIndex = envInteger('APP_SHARD_INDEX', 0, 0, shardCount - 1);
  const modelProviderPolicy = envEnum<ModelProviderPolicy>(
    'MODEL_PROVIDER_POLICY',
    ['host-broker-only'],
    'host-broker-only',
  );

  const publicHost = process.env.PUBLIC_HTTP_HOST?.trim() || '0.0.0.0';
  const publicPort = envInteger(
    'PUBLIC_HTTP_PORT',
    Number(process.env.PORT?.trim()) || 7860,
    1,
    65_535,
  );
  const internalHost = process.env.INTERNAL_HTTP_HOST?.trim() || '127.0.0.1';
  if (!isLoopbackHost(internalHost)) {
    throw new Error('INTERNAL_HTTP_HOST must be a loopback host.');
  }
  const brokerHost = process.env.MODEL_BROKER_HOST?.trim() || '127.0.0.1';
  if (!isLoopbackHost(brokerHost)) {
    throw new Error('MODEL_BROKER_HOST must be a loopback host.');
  }

  const ttlMs = envInteger('APP_LEASE_TTL_MS', 45_000, 10_000, 600_000);
  const heartbeatMs = envInteger(
    'APP_LEASE_HEARTBEAT_MS',
    15_000,
    1_000,
    ttlMs - 1,
  );
  const adminToken = process.env.ADMIN_TOKEN?.trim() || undefined;
  const publicEnabled = envBoolean('PUBLIC_HTTP_ENABLED', true);
  const internalEnabled = envBoolean('INTERNAL_HTTP_ENABLED', true);
  const internalPort = envInteger('INTERNAL_HTTP_PORT', 8788, 1, 65_535);
  const brokerPort = envInteger('MODEL_BROKER_PORT', 8790, 1, 65_535);
  const enabledPorts = [
    ...(publicEnabled ? [{ name: 'PUBLIC_HTTP_PORT', value: publicPort }] : []),
    ...(internalEnabled ? [{ name: 'INTERNAL_HTTP_PORT', value: internalPort }] : []),
    { name: 'MODEL_BROKER_PORT', value: brokerPort },
  ];
  for (let left = 0; left < enabledPorts.length; left += 1) {
    for (let right = left + 1; right < enabledPorts.length; right += 1) {
      if (enabledPorts[left]?.value === enabledPorts[right]?.value) {
        throw new Error(
          `${enabledPorts[left]?.name} and ${enabledPorts[right]?.name} must be different.`,
        );
      }
    }
  }

  const allowNonCloudflareUpstream = envBoolean(
    'MODEL_BROKER_ALLOW_NON_CLOUDFLARE_UPSTREAM',
    false,
  );
  const upstreamBaseUrl = modelBrokerUpstreamBaseUrl(allowNonCloudflareUpstream);
  const upstreamApiKey = process.env.CLOUDFLARE_API_KEY?.trim() || undefined;
  const modelBrokerEnabled = envBoolean(
    'MODEL_BROKER_ENABLED',
    Boolean(upstreamBaseUrl && upstreamApiKey),
  );
  if (modelBrokerEnabled && !upstreamBaseUrl) {
    throw new Error(
      'MODEL_BROKER_ENABLED=true requires MODEL_BROKER_UPSTREAM_BASE_URL or CLOUDFLARE_ACCOUNT_ID plus CLOUDFLARE_GATEWAY_ID.',
    );
  }
  if (modelBrokerEnabled && !upstreamApiKey) {
    throw new Error('MODEL_BROKER_ENABLED=true requires CLOUDFLARE_API_KEY.');
  }

  return {
    projectRoot: resolvedProjectRoot,
    configRoot: process.env.PLATFORM_CONFIG_ROOT?.trim() || './config',
    dataRoot,
    databasePath: resolve(
      process.env.PLATFORM_DATABASE_PATH?.trim() || join(dataRoot, 'platform.db'),
    ),
    ...(process.env.PLATFORM_MASTER_KEY?.trim()
      ? { platformMasterKey: process.env.PLATFORM_MASTER_KEY.trim() }
      : {}),
    instanceId:
      process.env.INSTANCE_ID?.trim() ||
      `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    shard: { index: shardIndex, count: shardCount },
    lease: {
      ttlMs,
      heartbeatMs,
    },
    publicHttp: {
      enabled: publicEnabled,
      host: publicHost,
      port: publicPort,
      bodyLimitBytes: envInteger(
        'PUBLIC_HTTP_BODY_LIMIT_BYTES',
        1_048_576,
        1_024,
        20 * 1024 * 1024,
      ),
    },
    internalHttp: {
      enabled: internalEnabled,
      host: internalHost,
      port: internalPort,
      ...(adminToken ? { adminToken } : {}),
      bodyLimitBytes: envInteger(
        'INTERNAL_HTTP_BODY_LIMIT_BYTES',
        262_144,
        1_024,
        4 * 1024 * 1024,
      ),
    },
    adminTrustedProxyAddresses: envIpList('ADMIN_TRUSTED_PROXY_ADDRESSES'),
    adminOpenIds: envList('ADMIN_OPEN_IDS'),
    approvalTtlMs: envInteger(
      'TOOL_APPROVAL_TTL_MS',
      5 * 60_000,
      30_000,
      60 * 60_000,
    ),
    modelBroker: {
      enabled: modelBrokerEnabled,
      host: brokerHost,
      port: brokerPort,
      publicBaseUrl: `http://${normalizeLoopbackForUrl(brokerHost)}:${brokerPort}/v1`,
      ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
      ...(upstreamApiKey ? { upstreamApiKey } : {}),
      requestTimeoutMs: envInteger(
        'MODEL_BROKER_REQUEST_TIMEOUT_MS',
        300_000,
        1_000,
        3_600_000,
      ),
      maxBodyBytes: envInteger(
        'MODEL_BROKER_MAX_BODY_BYTES',
        20 * 1024 * 1024,
        1_024,
        100 * 1024 * 1024,
      ),
      capabilityTtlMs: envInteger(
        'MODEL_CAPABILITY_TTL_MS',
        15 * 60_000,
        30_000,
        24 * 60 * 60_000,
      ),
      capabilityMaxLifetimeMs: envInteger(
        'MODEL_CAPABILITY_MAX_LIFETIME_MS',
        6 * 60 * 60_000,
        60_000,
        7 * 24 * 60 * 60_000,
      ),
      allowNonCloudflareUpstream,
    },
    modelProviderPolicy,
    maxConcurrentTurnsGlobal: envInteger(
      'MAX_CONCURRENT_TURNS_GLOBAL',
      16,
      1,
      1_000,
    ),
    maxResidentPiWorkers: envInteger(
      'MAX_RESIDENT_PI_WORKERS',
      24,
      1,
      1_000,
    ),
    maxConcurrentWorkerStarts: envInteger(
      'MAX_CONCURRENT_WORKER_STARTS',
      4,
      1,
      100,
    ),
    maintenanceIntervalMs: envInteger(
      'MAINTENANCE_INTERVAL_MS',
      30_000,
      1_000,
      3_600_000,
    ),
    isHuggingFaceSpace,
  };
}

function modelBrokerUpstreamBaseUrl(
  allowNonCloudflareUpstream: boolean,
): string | undefined {
  const explicit = process.env.MODEL_BROKER_UPSTREAM_BASE_URL?.trim();
  if (explicit) {
    const normalized = normalizeAbsoluteHttpsUrl(
      explicit,
      'MODEL_BROKER_UPSTREAM_BASE_URL',
    );
    const hostname = new URL(normalized).hostname.toLowerCase();
    if (!allowNonCloudflareUpstream && hostname !== 'gateway.ai.cloudflare.com') {
      throw new Error(
        'MODEL_BROKER_UPSTREAM_BASE_URL must use gateway.ai.cloudflare.com unless development override is enabled.',
      );
    }
    return normalized;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const gateway = process.env.CLOUDFLARE_GATEWAY_ID?.trim();
  if (!account && !gateway) return undefined;
  if (!account || !gateway) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID must be configured together.',
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(account) || !/^[A-Za-z0-9_-]+$/.test(gateway)) {
    throw new Error('Cloudflare account and gateway identifiers contain invalid characters.');
  }
  return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`;
}

function envList(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} contains duplicate values.`);
  }
  return values;
}

function envIpList(name: string): string[] {
  const values = envList(name).map(normalizeIpAddress);
  if (values.some((value) => !isIP(value))) {
    throw new Error(`${name} must contain only IPv4 or IPv6 addresses.`);
  }
  return [...new Set(values)];
}

function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') && isIP(value.slice('::ffff:'.length)) === 4
    ? value.slice('::ffff:'.length)
    : value;
}

function normalizeAbsoluteHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be an absolute URL.`, { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment.`);
  }
  return url.toString().replace(/\/$/, '');
}

function envBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean; received "${value}".`);
}

function envInteger(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}

function normalizeLoopbackForUrl(host: string): string {
  return host === '::1' ? '[::1]' : host;
}

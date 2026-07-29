import assert from 'node:assert/strict';
import test from 'node:test';

import { loadHostConfig } from '../src/config/load-host.js';

const RELEVANT_ENV = [
  'SPACE_ID', 'HF_SPACE_ID', 'DATA_ROOT', 'PLATFORM_CONFIG_ROOT', 'PI_AGENT_DIR',
  'INSTANCE_ID', 'APP_SHARD_COUNT', 'APP_SHARD_INDEX', 'MODEL_PROVIDER_POLICY',
  'PORT', 'PUBLIC_HTTP_ENABLED', 'PUBLIC_HTTP_HOST', 'PUBLIC_HTTP_PORT',
  'INTERNAL_HTTP_ENABLED', 'INTERNAL_HTTP_HOST', 'INTERNAL_HTTP_PORT', 'ADMIN_TOKEN',
  'ADMIN_TRUSTED_PROXY_ADDRESSES',
  'APP_LEASE_TTL_MS', 'APP_LEASE_HEARTBEAT_MS',
  'MODEL_BROKER_ENABLED', 'MODEL_BROKER_HOST', 'MODEL_BROKER_PORT',
  'MODEL_BROKER_UPSTREAM_BASE_URL', 'CLOUDFLARE_API_KEY',
  'MODEL_BROKER_ALLOW_NON_CLOUDFLARE_UPSTREAM',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID',
] as const;

async function withEnvironment(
  values: Partial<Record<(typeof RELEVANT_ENV)[number], string | undefined>>,
  run: () => void | Promise<void>,
): Promise<void> {
  const snapshot = new Map<string, string | undefined>();
  for (const name of RELEVANT_ENV) {
    snapshot.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const name of RELEVANT_ENV) {
      const value = snapshot.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('HF defaults keep public and internal planes separate and derive Cloudflare upstream', async () => {
  await withEnvironment(
    {
      SPACE_ID: 'owner/space',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_GATEWAY_ID: 'gateway',
      CLOUDFLARE_API_KEY: 'secret',
    },
    () => {
      const config = loadHostConfig('/tmp/platform');
      assert.equal(config.dataRoot, '/data/feishu-agent-platform');
      assert.equal(config.configRoot, './config');
      assert.equal(config.publicHttp.port, 7860);
      assert.equal(config.internalHttp.host, '127.0.0.1');
      assert.equal(config.modelProviderPolicy, 'host-broker-only');
      assert.equal(config.modelBroker.enabled, true);
      assert.equal(config.modelBroker.port, 8790);
      assert.equal(
        config.modelBroker.upstreamBaseUrl,
        'https://gateway.ai.cloudflare.com/v1/account/gateway',
      );
    },
  );
});

test('model broker and internal control listeners must remain loopback-only', async () => {
  await withEnvironment({ INTERNAL_HTTP_HOST: '0.0.0.0' }, () => {
    assert.throws(() => loadHostConfig('/tmp/platform'), /loopback/);
  });
  await withEnvironment({ MODEL_BROKER_HOST: '0.0.0.0' }, () => {
    assert.throws(() => loadHostConfig('/tmp/platform'), /loopback/);
  });
});

test('enabled listeners cannot share a port', async () => {
  await withEnvironment({ PUBLIC_HTTP_PORT: '8790' }, () => {
    assert.throws(() => loadHostConfig('/tmp/platform'), /must be different/);
  });
});

test('enabled broker requires HTTPS upstream and Cloudflare credential', async () => {
  await withEnvironment(
    { MODEL_BROKER_ENABLED: 'true', MODEL_BROKER_UPSTREAM_BASE_URL: 'http://proxy' },
    () => assert.throws(() => loadHostConfig('/tmp/platform'), /HTTPS/),
  );
  await withEnvironment(
    {
      MODEL_BROKER_ENABLED: 'true',
      MODEL_BROKER_UPSTREAM_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
    },
    () => assert.throws(() => loadHostConfig('/tmp/platform'), /CLOUDFLARE_API_KEY/),
  );
  await withEnvironment(
    {
      MODEL_BROKER_ENABLED: 'true',
      MODEL_BROKER_UPSTREAM_BASE_URL: 'https://proxy.example',
      CLOUDFLARE_API_KEY: 'secret',
    },
    () => assert.throws(() => loadHostConfig('/tmp/platform'), /gateway\.ai\.cloudflare\.com/),
  );
});

test('direct model-provider policy is not accepted', async () => {
  await withEnvironment({ MODEL_PROVIDER_POLICY: 'any' }, () => {
    assert.throws(() => loadHostConfig('/tmp/platform'), /host-broker-only/);
  });
});

test('trusted Admin proxies must be configured as exact IP addresses', async () => {
  await withEnvironment(
    { ADMIN_TRUSTED_PROXY_ADDRESSES: '127.0.0.1,::ffff:192.0.2.10' },
    () => {
      assert.deepEqual(
        loadHostConfig('/tmp/platform').adminTrustedProxyAddresses,
        ['127.0.0.1', '192.0.2.10'],
      );
    },
  );
  await withEnvironment(
    { ADMIN_TRUSTED_PROXY_ADDRESSES: 'proxy.internal' },
    () => assert.throws(() => loadHostConfig('/tmp/platform'), /IPv4 or IPv6/),
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { LoadedBindingConfig } from '../src/config/types.js';
import {
  assertModelProviderPolicy,
  buildAgentWorkerEnvironment,
  exposedWorkerEnvironmentNames,
} from '../src/pi/model-env.js';

function config(provider = 'host-broker'): LoadedBindingConfig {
  return { id: 'office', agent: { provider } } as LoadedBindingConfig;
}

test('Pi worker environment receives no Host, Feishu, provider, OAuth, or Cloudflare secrets', () => {
  const snapshot = { ...process.env };
  try {
    process.env.CLOUDFLARE_API_KEY = 'gateway-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.FEISHU_APP_SECRET = 'feishu-secret';
    process.env.ADMIN_TOKEN = 'admin-secret';
    process.env.OPENAI_API_KEY = 'provider-secret';
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'oauth-secret';
    const env = buildAgentWorkerEnvironment(config(), '/isolated/home', '/isolated/tmp');
    for (const name of [
      'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'FEISHU_APP_SECRET',
      'ADMIN_TOKEN', 'OPENAI_API_KEY', 'OAUTH_TOKEN_ENCRYPTION_KEY',
    ]) assert.equal(env[name], undefined, `${name} leaked into worker`);
    assert.equal(env.HOME, '/isolated/home');
    assert.equal(env.PI_OFFLINE, '1');
    assert.equal(env.PI_TELEMETRY, '0');
  } finally {
    process.env = snapshot;
  }
});

test('host-broker-only policy rejects direct providers', () => {
  assert.throws(
    () => assertModelProviderPolicy(config('openai'), 'host-broker-only'),
    /host-broker/,
  );
  assert.doesNotThrow(() => assertModelProviderPolicy(config(), 'host-broker-only'));
});

test('published worker environment list contains no credential-like names', () => {
  const names = exposedWorkerEnvironmentNames(config());
  assert.equal(
    names.some((name) => /KEY|TOKEN|SECRET|PASSWORD|CLOUDFLARE|FEISHU|LARK|ADMIN|OAUTH/i.test(name)),
    false,
  );
});

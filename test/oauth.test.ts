import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { LoadedBindingConfig } from '../src/config/types.js';
import {
  FeishuOAuthService,
  OAuthStateStore,
  OAuthTokenStore,
  peekOAuthStateAppKey,
  type OAuthTokenRecord,
} from '../src/feishu/oauth.js';

test('OAuth state is signed, one-time and preserves a relative return path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-oauth-state-'));
  const store = new OAuthStateStore(root, '0123456789abcdef0123456789abcdef', 600);
  try {
    const state = await store.issue('bot', 'ou_user', '/admin?tab=oauth');
    const payload = await store.consume(state);
    assert.equal(payload.appKey, 'bot');
    assert.equal(payload.userId, 'ou_user');
    assert.equal(payload.returnTo, '/admin?tab=oauth');
    await assert.rejects(() => store.consume(state), /already used|unknown/);
    await assert.rejects(() => store.consume(`${state.slice(0, -1)}x`), /signature/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test('OAuth state can be consumed by exactly one concurrent callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-oauth-race-'));
  const store = new OAuthStateStore(root, '0123456789abcdef0123456789abcdef', 600);
  try {
    const state = await store.issue('bot', 'ou_user');
    const results = await Promise.allSettled([
      store.consume(state),
      store.consume(state),
      store.consume(state),
      store.consume(state),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OAuth state rejects cross-site and protocol-relative return paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-oauth-return-'));
  const store = new OAuthStateStore(root, '0123456789abcdef0123456789abcdef', 600);
  try {
    await assert.rejects(
      () => store.issue('bot', 'ou_user', 'https://evil.example/steal'),
      /same-site absolute path/,
    );
    await assert.rejects(
      () => store.issue('bot', 'ou_user', '//evil.example/steal'),
      /same-site absolute path/,
    );
    await assert.rejects(
      () => store.issue('bot', 'ou_user', '/admin\\redirect'),
      /same-site absolute path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OAuth token records are encrypted at rest and can be removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pi-oauth-token-'));
  const config = {
    id: 'bot',
    appKey: 'bot',
    oauth: { tokenRoot: root },
  } as LoadedBindingConfig;
  const store = new OAuthTokenStore(config, '0123456789abcdef0123456789abcdef');
  const record: OAuthTokenRecord = {
    version: 1,
    appKey: 'bot',
    userId: 'ou_user',
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
    scope: ['docx:document:readonly'],
    updatedAt: Date.now(),
  };
  try {
    await store.save(record);
    assert.deepEqual(await store.load('ou_user'), record);
    const files = await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'bot')));
    const ciphertext = await readFile(join(root, 'bot', files[0] as string), 'utf8');
    assert.doesNotMatch(ciphertext, /access-secret|refresh-secret/);
    await store.remove('ou_user');
    assert.equal(await store.load('ou_user'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('administrator SSO derives open_id only from the verified OAuth token response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-admin-sso-'));
  const originalFetch = globalThis.fetch;
  let tokenRequest: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    tokenRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      code: 0,
      access_token: 'admin-access-token',
      refresh_token: 'admin-refresh-token',
      expires_in: 3600,
      refresh_expires_in: 7200,
      open_id: 'ou_admin',
      scope: 'contact:user.base:readonly',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = {
    appKey: 'primary',
    appId: 'cli_test',
    appSecret: 'secret',
    feishu: { domain: 'feishu' },
    oauthPublicBaseUrl: 'https://platform.example',
    oauthEncryptionKey: '0123456789abcdef0123456789abcdef',
    oauth: {
      enabled: true,
      redirectPath: '/public/oauth/primary/callback',
      scopes: ['contact:user.base:readonly'],
      tokenRoot: join(root, 'tokens'),
      stateRoot: join(root, 'states'),
      stateTtlSeconds: 600,
    },
  } as LoadedBindingConfig;
  try {
    const service = new FeishuOAuthService(config);
    assert.equal(service.redirectUri, 'https://platform.example/public/oauth/primary/callback');
    assert.equal(
      service.adminRedirectUri,
      'https://platform.example/api/admin/v1/auth/sso/callback',
    );
    const userAuthorization = new URL(
      await service.createAuthorizationUrl('ou_user'),
    );
    assert.equal(
      userAuthorization.searchParams.get('redirect_uri'),
      'https://platform.example/public/oauth/primary/callback',
    );
    const authorization = new URL(await service.createAdminAuthorizationUrl('/admin'));
    const state = authorization.searchParams.get('state');
    assert.ok(state);
    assert.equal(peekOAuthStateAppKey(state), 'primary');
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://platform.example/api/admin/v1/auth/sso/callback',
    );
    const identity = await service.handleAdminCallback('verified-code', state);
    assert.deepEqual(identity, { openId: 'ou_admin', returnTo: '/admin' });
    assert.equal(
      tokenRequest?.redirect_uri,
      'https://platform.example/api/admin/v1/auth/sso/callback',
    );
    assert.equal((await service.tokens.status('ou_admin')).connected, true);

    const userFlowState = new URL(
      await service.createAdminAuthorizationUrl('/admin'),
    ).searchParams.get('state');
    assert.ok(userFlowState);
    await assert.rejects(
      () => service.handleCallback('verified-code', userFlowState),
      /Admin SSO state/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

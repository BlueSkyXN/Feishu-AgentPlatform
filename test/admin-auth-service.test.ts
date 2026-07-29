import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdminAuthError,
  AdminAuthService,
  StaticFeishuAdminAllowlist,
} from '../src/admin/index.js';

const ADMIN_TOKEN = 'admin-token-at-least-sixteen-characters';

test('bootstrap login issues hardened cookie sessions with rotating CSRF and TTL', () => {
  let now = Date.parse('2026-07-29T00:00:00Z');
  const service = new AdminAuthService({
    bootstrapToken: ADMIN_TOKEN,
    sessionTtlSeconds: 60,
    now: () => now,
  });
  const login = service.loginWithBootstrapToken(ADMIN_TOKEN, '127.0.0.1');
  assert.match(login.setCookie, /^fap_admin_session=/);
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=60']) {
    assert.match(login.setCookie, new RegExp(attribute));
  }
  const cookie = login.setCookie.split(';', 1)[0] ?? '';
  assert.ok(cookie);
  assert.equal(service.authenticate(cookie).actor.id, 'admin-token');
  assert.throws(
    () => service.authorizeRequest({ cookieHeader: cookie, method: 'POST' }),
    (error: unknown) => error instanceof AdminAuthError && error.code === 'csrf_rejected',
  );
  assert.equal(
    service.authorizeRequest({
      cookieHeader: cookie,
      method: 'POST',
      csrfToken: login.csrfToken,
    }).actor.id,
    'admin-token',
  );

  const rotated = service.issueCsrfToken(cookie);
  assert.equal(rotated.csrfToken, login.csrfToken);
  assert.equal(
    service.authorizeRequest({
      cookieHeader: cookie,
      method: 'DELETE',
      csrfToken: rotated.csrfToken,
    }).actor.id,
    'admin-token',
  );

  now += 60_001;
  assert.throws(
    () => service.authenticate(cookie),
    (error: unknown) =>
      error instanceof AdminAuthError && error.code === 'session_expired',
  );
});

test('failed bootstrap login is rate limited without blocking another client', () => {
  const service = new AdminAuthService({
    bootstrapToken: ADMIN_TOKEN,
    maxLoginAttempts: 2,
    rateLimitWindowSeconds: 60,
  });
  for (let index = 0; index < 2; index += 1) {
    assert.throws(
      () => service.loginWithBootstrapToken('wrong-token-value', 'client-a'),
      (error: unknown) => error instanceof AdminAuthError && error.status === 401,
    );
  }
  assert.throws(
    () => service.loginWithBootstrapToken(ADMIN_TOKEN, 'client-a'),
    (error: unknown) =>
      error instanceof AdminAuthError &&
      error.status === 429 &&
      error.retryAfterSeconds !== undefined,
  );
  assert.equal(
    service.loginWithBootstrapToken(ADMIN_TOKEN, 'client-b').session.actor.id,
    'admin-token',
  );
});

test('Feishu SSO session creation consumes a verified identity through an exact allowlist', () => {
  const service = new AdminAuthService({});
  const allowlist = new StaticFeishuAdminAllowlist({
    openIds: ['ou_admin'],
    tenantKeys: ['tenant-a'],
  });
  const result = service.createFeishuSsoSession(
    { openId: 'ou_admin', tenantKey: 'tenant-a', displayName: '管理员 A' },
    allowlist,
  );
  assert.equal(result.session.actor.type, 'feishu-sso');
  assert.equal(result.session.actor.id, 'feishu:tenant-a:ou_admin');
  assert.throws(
    () => service.createFeishuSsoSession(
      { openId: 'ou_admin', tenantKey: 'tenant-b' },
      allowlist,
    ),
    (error: unknown) => error instanceof AdminAuthError && error.code === 'sso_not_allowed',
  );
});

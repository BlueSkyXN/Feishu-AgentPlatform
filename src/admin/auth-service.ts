import { createHash, randomBytes } from 'node:crypto';

import { secureEqual } from '../core/crypto-store.js';

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_RATE_WINDOW_SECONDS = 5 * 60;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;

export type AdminActor =
  | { type: 'bootstrap-token'; id: 'admin-token'; displayName: string }
  | {
      type: 'feishu-sso';
      id: string;
      openId: string;
      tenantKey?: string;
      displayName?: string;
    };

export interface AdminSession {
  actor: AdminActor;
  createdAt: string;
  expiresAt: string;
}

export interface AdminLoginResult {
  session: AdminSession;
  csrfToken: string;
  setCookie: string;
}

export interface FeishuAdminIdentity {
  openId: string;
  tenantKey?: string;
  displayName?: string;
}

/** The existing OAuth/SSO integration verifies identity, then calls this policy. */
export interface FeishuAdminSsoAllowlist {
  allows(identity: FeishuAdminIdentity): boolean;
}

export interface AdminAuthAuditEvent {
  action: 'login.succeeded' | 'login.failed' | 'logout' | 'sso.succeeded' | 'sso.denied';
  actor?: string;
  clientKey?: string;
}

export interface AdminAuthOptions {
  bootstrapToken?: string;
  sessionTtlSeconds?: number;
  rateLimitWindowSeconds?: number;
  maxLoginAttempts?: number;
  cookieName?: string;
  now?: () => number;
  audit?: (event: AdminAuthAuditEvent) => void;
}

interface StoredSession {
  actor: AdminActor;
  createdAtMs: number;
  expiresAtMs: number;
}

interface FailedLoginBucket {
  failures: number;
  resetAtMs: number;
}

export class AdminAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export class StaticFeishuAdminAllowlist implements FeishuAdminSsoAllowlist {
  private readonly openIds: Set<string>;
  private readonly tenantKeys: Set<string>;

  constructor(input: { openIds: string[]; tenantKeys?: string[] }) {
    this.openIds = new Set(input.openIds.map(requiredIdentity));
    this.tenantKeys = new Set((input.tenantKeys ?? []).map(requiredIdentity));
  }

  allows(identity: FeishuAdminIdentity): boolean {
    if (!this.openIds.has(identity.openId)) return false;
    return this.tenantKeys.size === 0 || Boolean(identity.tenantKey && this.tenantKeys.has(identity.tenantKey));
  }
}

export class AdminAuthService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failedLogins = new Map<string, FailedLoginBucket>();
  private readonly bootstrapToken: string | undefined;
  private readonly sessionTtlMs: number;
  private readonly rateWindowMs: number;
  private readonly maxLoginAttempts: number;
  private readonly cookieName: string;
  private readonly now: () => number;
  private readonly audit: ((event: AdminAuthAuditEvent) => void) | undefined;

  constructor(options: AdminAuthOptions) {
    this.bootstrapToken = options.bootstrapToken?.trim() || undefined;
    if (this.bootstrapToken && this.bootstrapToken.length < 16) {
      throw new Error('ADMIN_TOKEN must contain at least 16 characters.');
    }
    this.sessionTtlMs = boundedSeconds(
      options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      60,
      7 * 24 * 60 * 60,
      'sessionTtlSeconds',
    ) * 1_000;
    this.rateWindowMs = boundedSeconds(
      options.rateLimitWindowSeconds ?? DEFAULT_RATE_WINDOW_SECONDS,
      1,
      24 * 60 * 60,
      'rateLimitWindowSeconds',
    ) * 1_000;
    this.maxLoginAttempts = boundedInteger(
      options.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS,
      1,
      100,
      'maxLoginAttempts',
    );
    this.cookieName = cookieName(options.cookieName ?? 'fap_admin_session');
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
  }

  static fromEnvironment(options: Omit<AdminAuthOptions, 'bootstrapToken'> = {}): AdminAuthService {
    const bootstrapToken = process.env.ADMIN_TOKEN;
    return new AdminAuthService({
      ...options,
      ...(bootstrapToken ? { bootstrapToken } : {}),
    });
  }

  loginWithBootstrapToken(token: string, clientKey: string): AdminLoginResult {
    const client = normalizeClientKey(clientKey);
    this.assertRateLimit(client);
    if (!this.bootstrapToken) {
      throw new AdminAuthError(503, 'bootstrap_disabled', 'ADMIN_TOKEN 引导登录未启用。');
    }
    if (!secureEqual(token, this.bootstrapToken)) {
      this.recordFailedLogin(client);
      this.audit?.({ action: 'login.failed', clientKey: client });
      throw new AdminAuthError(401, 'invalid_credentials', '管理员凭据无效。');
    }
    this.failedLogins.delete(client);
    const result = this.createSession({
      type: 'bootstrap-token',
      id: 'admin-token',
      displayName: '平台管理员',
    });
    this.audit?.({ action: 'login.succeeded', actor: result.session.actor.id, clientKey: client });
    return result;
  }

  createFeishuSsoSession(
    identityInput: FeishuAdminIdentity,
    allowlist: FeishuAdminSsoAllowlist,
  ): AdminLoginResult {
    const identity: FeishuAdminIdentity = {
      openId: requiredIdentity(identityInput.openId),
      ...(identityInput.tenantKey ? { tenantKey: requiredIdentity(identityInput.tenantKey) } : {}),
      ...(identityInput.displayName?.trim()
        ? { displayName: identityInput.displayName.trim().slice(0, 128) }
        : {}),
    };
    if (!allowlist.allows(identity)) {
      this.audit?.({ action: 'sso.denied', actor: identity.openId });
      throw new AdminAuthError(403, 'sso_not_allowed', '该飞书用户不在平台管理员 allowlist 中。');
    }
    const actor: AdminActor = {
      type: 'feishu-sso',
      id: `feishu:${identity.tenantKey ?? 'unknown'}:${identity.openId}`,
      openId: identity.openId,
      ...(identity.tenantKey ? { tenantKey: identity.tenantKey } : {}),
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    };
    const result = this.createSession(actor);
    this.audit?.({ action: 'sso.succeeded', actor: actor.id });
    return result;
  }

  authenticate(cookieHeader: string | undefined): AdminSession {
    this.purgeExpired();
    const token = parseCookies(cookieHeader)[this.cookieName];
    if (!token) throw new AdminAuthError(401, 'authentication_required', '请先登录管理台。');
    const stored = this.sessions.get(hash(token));
    if (!stored || stored.expiresAtMs <= this.now()) {
      if (stored) this.sessions.delete(hash(token));
      throw new AdminAuthError(401, 'session_expired', '管理员会话不存在或已过期。');
    }
    return publicSession(stored);
  }

  issueCsrfToken(cookieHeader: string | undefined): {
    session: AdminSession;
    csrfToken: string;
  } {
    this.purgeExpired();
    const token = parseCookies(cookieHeader)[this.cookieName];
    if (!token) throw new AdminAuthError(401, 'authentication_required', '请先登录管理台。');
    const stored = this.sessions.get(hash(token));
    if (!stored || stored.expiresAtMs <= this.now()) {
      if (stored) this.sessions.delete(hash(token));
      throw new AdminAuthError(401, 'session_expired', '管理员会话不存在或已过期。');
    }
    const csrfToken = csrfTokenForSession(token);
    return { session: publicSession(stored), csrfToken };
  }

  authorizeRequest(input: {
    cookieHeader?: string;
    method: string;
    csrfToken?: string;
  }): AdminSession {
    const token = parseCookies(input.cookieHeader)[this.cookieName];
    if (!token) throw new AdminAuthError(401, 'authentication_required', '请先登录管理台。');
    const stored = this.sessions.get(hash(token));
    if (!stored || stored.expiresAtMs <= this.now()) {
      if (stored) this.sessions.delete(hash(token));
      throw new AdminAuthError(401, 'session_expired', '管理员会话不存在或已过期。');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(input.method.toUpperCase())) {
      if (!input.csrfToken || !secureEqual(input.csrfToken, csrfTokenForSession(token))) {
        throw new AdminAuthError(403, 'csrf_rejected', 'CSRF Token 缺失或无效。');
      }
    }
    return publicSession(stored);
  }

  logout(cookieHeader: string | undefined, csrfToken: string | undefined): string {
    const token = parseCookies(cookieHeader)[this.cookieName];
    if (!token) throw new AdminAuthError(401, 'authentication_required', '请先登录管理台。');
    const key = hash(token);
    const stored = this.sessions.get(key);
    if (!stored || stored.expiresAtMs <= this.now()) {
      this.sessions.delete(key);
      throw new AdminAuthError(401, 'session_expired', '管理员会话不存在或已过期。');
    }
    if (!csrfToken || !secureEqual(csrfToken, csrfTokenForSession(token))) {
      throw new AdminAuthError(403, 'csrf_rejected', 'CSRF Token 缺失或无效。');
    }
    this.sessions.delete(key);
    this.audit?.({ action: 'logout', actor: stored.actor.id });
    return clearCookie(this.cookieName);
  }

  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    for (const [key, bucket] of this.failedLogins) {
      if (bucket.resetAtMs <= now) this.failedLogins.delete(key);
    }
    return removed;
  }

  private createSession(actor: AdminActor): AdminLoginResult {
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = csrfTokenForSession(sessionToken);
    const now = this.now();
    const stored: StoredSession = {
      actor,
      createdAtMs: now,
      expiresAtMs: now + this.sessionTtlMs,
    };
    this.sessions.set(hash(sessionToken), stored);
    return {
      session: publicSession(stored),
      csrfToken,
      setCookie: sessionCookie(this.cookieName, sessionToken, Math.floor(this.sessionTtlMs / 1_000)),
    };
  }

  private assertRateLimit(clientKey: string): void {
    const bucket = this.failedLogins.get(clientKey);
    const now = this.now();
    if (!bucket || bucket.resetAtMs <= now) {
      if (bucket) this.failedLogins.delete(clientKey);
      return;
    }
    if (bucket.failures >= this.maxLoginAttempts) {
      throw new AdminAuthError(
        429,
        'login_rate_limited',
        '管理员登录失败次数过多，请稍后重试。',
        Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1_000)),
      );
    }
  }

  private recordFailedLogin(clientKey: string): void {
    const now = this.now();
    const current = this.failedLogins.get(clientKey);
    const bucket = !current || current.resetAtMs <= now
      ? { failures: 0, resetAtMs: now + this.rateWindowMs }
      : current;
    bucket.failures += 1;
    this.failedLogins.set(clientKey, bucket);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function publicSession(stored: StoredSession): AdminSession {
  return {
    actor: structuredClone(stored.actor),
    createdAt: new Date(stored.createdAtMs).toISOString(),
    expiresAt: new Date(stored.expiresAtMs).toISOString(),
  };
}

function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function csrfTokenForSession(sessionToken: string): string {
  return createHash('sha256')
    .update('feishu-agent-platform-admin-csrf\u0000', 'utf8')
    .update(sessionToken, 'utf8')
    .digest('base64url');
}

function requiredIdentity(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new Error('Feishu SSO identity is invalid.');
  }
  return normalized;
}

function normalizeClientKey(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return normalized || 'unknown';
}

function cookieName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error('Admin cookie name is invalid.');
  return value;
}

function boundedSeconds(value: number, minimum: number, maximum: number, label: string): number {
  return boundedInteger(value, minimum, maximum, label);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

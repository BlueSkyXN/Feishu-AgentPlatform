import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FeishuDomain, LoadedBindingConfig } from '../config/types.js';
import {
  readJsonFile,
  writeJsonFileAtomic,
} from '../core/atomic-file.js';
import {
  decryptJson,
  encryptJson,
  secureEqual,
  type EncryptedEnvelope,
} from '../core/crypto-store.js';

interface OAuthStatePayload {
  version: 1;
  appKey: string;
  userId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  returnTo?: string;
}

interface OAuthTokenResponse {
  code?: number;
  message?: string;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  token_type?: string;
  scope?: string;
  open_id?: string;
  union_id?: string;
}

const ADMIN_SSO_STATE_USER = '__feishu_agent_platform_admin_sso__';

export interface OAuthTokenRecord {
  version: 1;
  appKey: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  tokenType: string;
  scope: string[];
  updatedAt: number;
}

export interface OAuthStatus {
  connected: boolean;
  userId: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes: string[];
}

export class OAuthStateStore {
  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  async issue(
    appKey: string,
    userId: string,
    returnTo?: string,
  ): Promise<string> {
    const normalizedReturnTo = normalizeReturnTo(returnTo);
    const now = Date.now();
    const payload: OAuthStatePayload = {
      version: 1,
      appKey,
      userId,
      nonce: randomBytes(24).toString('base64url'),
      issuedAt: now,
      expiresAt: now + this.ttlSeconds * 1_000,
      ...(normalizedReturnTo ? { returnTo: normalizedReturnTo } : {}),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const signature = this.sign(encoded);
    await writeJsonFileAtomic(this.statePath(payload.nonce), payload);
    return `${encoded}.${signature}`;
  }

  async consume(state: string): Promise<OAuthStatePayload> {
    const [encoded, signature, extra] = state.split('.');
    if (!encoded || !signature || extra) throw new Error('Invalid OAuth state.');
    const expected = this.sign(encoded);
    if (!secureEqual(signature, expected)) {
      throw new Error('Invalid OAuth state signature.');
    }

    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as OAuthStatePayload;
    } catch (error) {
      throw new Error('Invalid OAuth state payload.', { cause: error });
    }
    if (
      payload.version !== 1 ||
      !payload.appKey ||
      !payload.userId ||
      !payload.nonce ||
      !Number.isFinite(payload.expiresAt)
    ) {
      throw new Error('Invalid OAuth state payload.');
    }
    if (payload.expiresAt < Date.now()) {
      await rm(this.statePath(payload.nonce), { force: true });
      throw new Error('OAuth state expired.');
    }

    const source = this.statePath(payload.nonce);
    const claimed = join(
      this.root,
      `.${safeKey(payload.nonce)}.consuming-${randomBytes(8).toString('hex')}.json`,
    );
    try {
      await rename(source, claimed);
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error('OAuth state was already used or is unknown.');
      }
      throw error;
    }

    try {
      const persisted = await readJsonFile<OAuthStatePayload>(claimed);
      if (
        !persisted ||
        persisted.nonce !== payload.nonce ||
        persisted.appKey !== payload.appKey ||
        persisted.userId !== payload.userId ||
        persisted.expiresAt !== payload.expiresAt
      ) {
        throw new Error('Persisted OAuth state does not match its signed payload.');
      }
      return payload;
    } finally {
      await rm(claimed, { force: true });
    }
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.root, { withFileTypes: true });
    let removed = 0;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.json')) return;
        const path = join(this.root, entry.name);
        const value = await readJsonFile<OAuthStatePayload>(path).catch(
          () => undefined,
        );
        if (!value || value.expiresAt < now) {
          await rm(path, { force: true });
          removed += 1;
        }
      }),
    );
    return removed;
  }

  private statePath(nonce: string): string {
    return join(this.root, `${safeKey(nonce)}.json`);
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret)
      .update(encoded)
      .digest('base64url');
  }
}

export class OAuthTokenStore {
  private readonly refreshes = new Map<string, Promise<OAuthTokenRecord>>();

  constructor(
    private readonly config: LoadedBindingConfig,
    private readonly secret: string,
  ) {}

  async save(record: OAuthTokenRecord): Promise<void> {
    await writeJsonFileAtomic(
      this.tokenPath(record.userId),
      encryptJson(record, this.secret),
    );
  }

  async load(userId: string): Promise<OAuthTokenRecord | undefined> {
    const envelope = await readJsonFile<EncryptedEnvelope>(this.tokenPath(userId));
    if (!envelope) return undefined;
    const record = decryptJson<OAuthTokenRecord>(envelope, this.secret);
    if (
      record.version !== 1 ||
      record.appKey !== this.config.appKey ||
      record.userId !== userId
    ) {
      throw new Error('OAuth token record does not match the requested app/user.');
    }
    return record;
  }

  async remove(userId: string): Promise<void> {
    await rm(this.tokenPath(userId), { force: true });
  }

  async status(userId: string): Promise<OAuthStatus> {
    const record = await this.load(userId);
    return record
      ? {
          connected: true,
          userId,
          accessTokenExpiresAt: record.accessTokenExpiresAt,
          ...(record.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt }
            : {}),
          scopes: record.scope,
        }
      : { connected: false, userId, scopes: [] };
  }

  async validAccessToken(userId: string): Promise<string> {
    const record = await this.load(userId);
    if (!record) {
      throw new OAuthRequiredError(this.config.appKey, userId);
    }
    if (record.accessTokenExpiresAt > Date.now() + 60_000) {
      return record.accessToken;
    }

    const key = `${this.config.appKey}:${userId}`;
    const existing = this.refreshes.get(key);
    if (existing) return (await existing).accessToken;
    const refresh = this.refresh(record).finally(() => {
      this.refreshes.delete(key);
    });
    this.refreshes.set(key, refresh);
    return (await refresh).accessToken;
  }

  private async refresh(record: OAuthTokenRecord): Promise<OAuthTokenRecord> {
    if (
      record.refreshTokenExpiresAt !== undefined &&
      record.refreshTokenExpiresAt <= Date.now() + 60_000
    ) {
      throw new OAuthRequiredError(this.config.appKey, record.userId);
    }
    const response = await requestToken(this.config.feishu.domain, {
      grant_type: 'refresh_token',
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      refresh_token: record.refreshToken,
    });
    const updated = tokenRecordFromResponse(
      this.config.appKey,
      record.userId,
      response,
      record.refreshToken,
      record.refreshTokenExpiresAt,
    );
    await this.save(updated);
    return updated;
  }

  private tokenPath(userId: string): string {
    return join(
      this.config.oauth.tokenRoot,
      this.config.appKey,
      `${safeKey(userId)}.json.enc`,
    );
  }
}

export class FeishuOAuthService {
  readonly states: OAuthStateStore;
  readonly tokens: OAuthTokenStore;

  constructor(private readonly config: LoadedBindingConfig) {
    if (
      !config.oauth.enabled ||
      !config.oauthPublicBaseUrl ||
      !config.oauthEncryptionKey
    ) {
      throw new Error(`OAuth is not configured for app ${config.appKey}.`);
    }
    this.states = new OAuthStateStore(
      join(config.oauth.stateRoot, config.appKey),
      config.oauthEncryptionKey,
      config.oauth.stateTtlSeconds,
    );
    this.tokens = new OAuthTokenStore(config, config.oauthEncryptionKey);
  }

  get redirectUri(): string {
    return `${this.config.oauthPublicBaseUrl}${this.config.oauth.redirectPath}`;
  }

  get adminRedirectUri(): string {
    return `${this.config.oauthPublicBaseUrl}/api/admin/v1/auth/sso/callback`;
  }

  async createAuthorizationUrl(
    userId: string,
    returnTo?: string,
  ): Promise<string> {
    return await this.createAuthorizationUrlFor(userId, this.redirectUri, returnTo);
  }

  async createAdminAuthorizationUrl(returnTo = '/admin'): Promise<string> {
    return await this.createAuthorizationUrlFor(
      ADMIN_SSO_STATE_USER,
      this.adminRedirectUri,
      returnTo,
    );
  }

  private async createAuthorizationUrlFor(
    userId: string,
    redirectUri: string,
    returnTo?: string,
  ): Promise<string> {
    const state = await this.states.issue(this.config.appKey, userId, returnTo);
    const endpoint = oauthEndpoints(this.config.feishu.domain).authorize;
    const url = new URL(endpoint);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (this.config.oauth.scopes.length > 0) {
      url.searchParams.set('scope', this.config.oauth.scopes.join(' '));
    }
    return url.toString();
  }

  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ userId: string; returnTo?: string }> {
    const payload = await this.states.consume(state);
    if (payload.appKey !== this.config.appKey) {
      throw new Error('OAuth state belongs to another app.');
    }
    if (payload.userId === ADMIN_SSO_STATE_USER) {
      throw new Error('Admin SSO state cannot be consumed by the user OAuth callback.');
    }
    const response = await requestToken(this.config.feishu.domain, {
      grant_type: 'authorization_code',
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      code,
      redirect_uri: this.redirectUri,
    });
    if (response.open_id && response.open_id !== payload.userId) {
      throw new Error(
        'The Feishu account completing OAuth does not match the user who initiated it.',
      );
    }
    await this.tokens.save(
      tokenRecordFromResponse(this.config.appKey, payload.userId, response),
    );
    return {
      userId: payload.userId,
      ...(payload.returnTo ? { returnTo: payload.returnTo } : {}),
    };
  }

  async handleAdminCallback(
    code: string,
    state: string,
  ): Promise<{ openId: string; returnTo?: string }> {
    const payload = await this.states.consume(state);
    if (
      payload.appKey !== this.config.appKey ||
      payload.userId !== ADMIN_SSO_STATE_USER
    ) {
      throw new Error('OAuth state does not belong to the administrator SSO flow.');
    }
    const response = await requestToken(this.config.feishu.domain, {
      grant_type: 'authorization_code',
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      code,
      redirect_uri: this.adminRedirectUri,
    });
    if (!response.open_id) throw new Error('Feishu administrator SSO response has no open_id.');
    await this.tokens.save(
      tokenRecordFromResponse(this.config.appKey, response.open_id, response),
    );
    return {
      openId: response.open_id,
      ...(payload.returnTo ? { returnTo: payload.returnTo } : {}),
    };
  }
}

export class OAuthRequiredError extends Error {
  constructor(
    readonly appKey: string,
    readonly userId: string,
  ) {
    super(`Feishu user OAuth is required for app ${appKey} and user ${userId}.`);
    this.name = 'OAuthRequiredError';
  }
}

function oauthEndpoints(domain: FeishuDomain): {
  authorize: string;
  token: string;
} {
  return domain === 'lark'
    ? {
        authorize: 'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
        token: 'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
      }
    : {
        authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
        token: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      };
}

async function requestToken(
  domain: FeishuDomain,
  body: Record<string, string>,
): Promise<OAuthTokenResponse> {
  const response = await fetch(oauthEndpoints(domain).token, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: OAuthTokenResponse;
  try {
    payload = JSON.parse(text) as OAuthTokenResponse;
  } catch (error) {
    throw new Error(`Feishu OAuth returned non-JSON HTTP ${response.status}.`, {
      cause: error,
    });
  }
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(
      `Feishu OAuth token request failed: HTTP ${response.status}, code ${payload.code ?? 'unknown'}, ${payload.message ?? 'unknown error'}.`,
    );
  }
  return payload;
}

function tokenRecordFromResponse(
  appKey: string,
  userId: string,
  response: OAuthTokenResponse,
  fallbackRefreshToken?: string,
  fallbackRefreshExpiresAt?: number,
): OAuthTokenRecord {
  if (!response.access_token || !response.expires_in) {
    throw new Error('Feishu OAuth response does not contain an access token.');
  }
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error('Feishu OAuth response does not contain a refresh token.');
  }
  const now = Date.now();
  return {
    version: 1,
    appKey,
    userId,
    accessToken: response.access_token,
    refreshToken,
    accessTokenExpiresAt: now + Math.max(0, response.expires_in - 30) * 1_000,
    ...(response.refresh_expires_in
      ? {
          refreshTokenExpiresAt:
            now + Math.max(0, response.refresh_expires_in - 30) * 1_000,
        }
      : fallbackRefreshExpiresAt
        ? { refreshTokenExpiresAt: fallbackRefreshExpiresAt }
        : {}),
    tokenType: response.token_type ?? 'Bearer',
    scope: response.scope ? response.scope.split(/\s+/).filter(Boolean) : [],
    updatedAt: now,
  };
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Untrusted routing hint only. The owning OAuth service still verifies the signature and state file. */
export function peekOAuthStateAppKey(state: string): string | undefined {
  const encoded = state.split('.')[0];
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const appKey = (value as Record<string, unknown>).appKey;
    return typeof appKey === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(appKey)
      ? appKey
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeReturnTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new Error('OAuth returnTo must be a same-site absolute path.');
  }
  return trimmed;
}


function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

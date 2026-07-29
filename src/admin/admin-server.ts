import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { URL } from 'node:url';

import {
  AdminAuthError,
  AdminAuthService,
  type FeishuAdminSsoAllowlist,
} from './auth-service.js';
import { peekOAuthStateAppKey } from '../feishu/oauth.js';
import {
  AdminBackendError,
  type AdminBackend,
  type AdminRequestContext,
} from './contracts.js';

const STATIC_ASSETS = new Map([
  ['/admin', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/admin/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/admin/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/admin/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

export interface AdminServerOptions {
  host: string;
  port: number;
  bodyLimitBytes: number;
  staticRoot?: string;
  auth: AdminAuthService;
  trustedProxyAddresses?: string[];
  ssoAllowlist?: FeishuAdminSsoAllowlist;
  backend: AdminBackend;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

export class AdminServer {
  private server: Server | undefined;
  private readonly staticRoot: string;

  constructor(private readonly options: AdminServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error('Admin port must be an integer between 0 and 65535.');
    }
    if (!Number.isInteger(options.bodyLimitBytes) || options.bodyLimitBytes < 1) {
      throw new Error('Admin bodyLimitBytes must be a positive integer.');
    }
    this.staticRoot = resolve(options.staticRoot ?? resolve(process.cwd(), 'web'));
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).then((handled) => {
        if (!handled && !response.writableEnded) sendJson(response, 404, { error: 'not_found' });
      });
    });
    this.server = server;
    await listen(server, this.options.host, this.options.port);
    this.options.logger?.info('Admin server listening', this.address());
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await close(server);
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      return { host: this.options.host, port: this.options.port };
    }
    return { host: address.address, port: address.port };
  }

  /** Handles only `/admin` and `/api/admin/v1` so the public ingress can mount it. */
  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', 'http://admin.local').pathname;
    if (
      pathname !== '/admin' &&
      !pathname.startsWith('/admin/') &&
      !pathname.startsWith('/api/admin/v1/')
    ) {
      return false;
    }
    try {
      await this.route(request, response);
    } catch (error) {
      this.handleError(response, error);
    }
    return true;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    const url = new URL(request.url ?? '/', 'http://admin.local');
    const method = request.method ?? 'GET';

    if (method === 'GET' && STATIC_ASSETS.has(url.pathname)) {
      await this.serveStatic(url.pathname, response);
      return;
    }
    if (!url.pathname.startsWith('/api/admin/v1/')) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/v1/auth/login') {
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const token = requiredString(body.token, 'token');
      const result = this.options.auth.loginWithBootstrapToken(
        token,
        administratorClientKey(request, this.options.trustedProxyAddresses ?? []),
      );
      response.setHeader('set-cookie', result.setCookie);
      sendJson(response, 200, {
        session: result.session,
        csrfToken: result.csrfToken,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/v1/auth/sso/start') {
      if (!this.options.ssoAllowlist || !this.options.backend.startAdminSso) {
        throw new AdminBackendError(503, 'sso_disabled', '飞书管理员 SSO 未启用。');
      }
      const appKey = url.searchParams.get('appKey')?.trim();
      if (!appKey) throw new AdminHttpInputError(400, 'appKey query 参数必填。');
      const authorizationUrl = await this.options.backend.startAdminSso({
        appKey,
        returnTo: '/admin',
      });
      response.statusCode = 302;
      response.setHeader('location', authorizationUrl);
      response.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/v1/auth/sso/callback') {
      if (
        !this.options.ssoAllowlist ||
        !this.options.backend.completeAdminSso
      ) {
        throw new AdminBackendError(503, 'sso_disabled', '飞书管理员 SSO 未启用。');
      }
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const appKey = peekOAuthStateAppKey(state);
      if (!code || !state || !appKey) {
        throw new AdminHttpInputError(400, '飞书 SSO callback 参数无效。');
      }
      const identity = await this.options.backend.completeAdminSso({ appKey, code, state });
      const result = this.options.auth.createFeishuSsoSession(identity, this.options.ssoAllowlist);
      response.setHeader('set-cookie', result.setCookie);
      response.statusCode = 303;
      response.setHeader('location', identity.returnTo ?? '/admin');
      response.end();
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/v1/auth/logout') {
      const clearCookie = this.options.auth.logout(
        request.headers.cookie,
        firstHeader(request.headers['x-csrf-token']),
      );
      response.setHeader('set-cookie', clearCookie);
      sendJson(response, 200, { loggedOut: true });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/v1/auth/session') {
      sendJson(response, 200, this.options.auth.issueCsrfToken(request.headers.cookie));
      return;
    }

    const csrfToken = firstHeader(request.headers['x-csrf-token']);
    const session = this.options.auth.authorizeRequest({
      ...(request.headers.cookie ? { cookieHeader: request.headers.cookie } : {}),
      method,
      ...(csrfToken ? { csrfToken } : {}),
    });
    const context: AdminRequestContext = { session, actor: session.actor.id };
    if (method === 'GET' && url.pathname === '/api/admin/v1/overview') {
      sendJson(response, 200, await this.options.backend.getOverview(context));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/apps') {
      sendJson(response, 200, { items: await this.options.backend.listApps(context) });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/agents') {
      sendJson(response, 200, { items: await this.options.backend.listAgents(context) });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/bindings') {
      sendJson(response, 200, { items: await this.options.backend.listBindings(context) });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/config') {
      sendJson(response, 200, await this.options.backend.getConfigState(context));
      return;
    }
    const draftCollection = /^\/api\/admin\/v1\/draft\/(apps|agents|bindings)$/u.exec(
      url.pathname,
    );
    if (method === 'GET' && draftCollection) {
      const kind = draftCollection[1] as 'apps' | 'agents' | 'bindings';
      const state = await this.options.backend.getConfigState(context);
      const source = state.draft?.document ?? state.active?.document ?? {};
      const items = Array.isArray(source[kind]) ? source[kind] : [];
      sendJson(response, 200, { items, draftRevisionId: state.draft?.id ?? null });
      return;
    }
    if (method === 'POST' && draftCollection) {
      if (!this.options.backend.mutateDraftEntity) {
        throw new AdminBackendError(501, 'not_implemented', 'Draft 实体编辑尚未接入。');
      }
      const kind = draftCollection[1] as 'apps' | 'agents' | 'bindings';
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const id = requiredString(body.id, 'id');
      const entity = objectBody(body.entity);
      const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
      const revision = await this.options.backend.mutateDraftEntity({
        kind,
        action: 'create',
        id,
        entity,
        ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
      }, context);
      sendJson(response, 201, revision);
      return;
    }
    const draftEntity = /^\/api\/admin\/v1\/draft\/(apps|agents|bindings)\/([^/]+)(?:\/(copy|disable))?$/u.exec(
      url.pathname,
    );
    if (draftEntity) {
      if (!this.options.backend.mutateDraftEntity) {
        throw new AdminBackendError(501, 'not_implemented', 'Draft 实体编辑尚未接入。');
      }
      const kind = draftEntity[1] as 'apps' | 'agents' | 'bindings';
      const id = decodePathSegment(draftEntity[2] ?? '');
      const operation = draftEntity[3];
      if (method === 'PUT' && !operation) {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const entity = objectBody(body.entity);
        const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
        sendJson(response, 200, await this.options.backend.mutateDraftEntity({
          kind,
          action: 'update',
          id,
          entity,
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
        }, context));
        return;
      }
      if (method === 'POST' && operation === 'copy') {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const newId = requiredString(body.newId, 'newId');
        const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
        sendJson(response, 201, await this.options.backend.mutateDraftEntity({
          kind,
          action: 'copy',
          id,
          newId,
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
        }, context));
        return;
      }
      if (method === 'POST' && operation === 'disable') {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
        sendJson(response, 200, await this.options.backend.mutateDraftEntity({
          kind,
          action: 'disable',
          id,
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
        }, context));
        return;
      }
      if (method === 'DELETE' && !operation) {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const confirmation = requiredString(body.confirmation, 'confirmation');
        const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
        sendJson(response, 200, await this.options.backend.mutateDraftEntity({
          kind,
          action: 'delete',
          id,
          confirmation,
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
        }, context));
        return;
      }
    }
    if (
      method === 'PUT' &&
      ['/api/admin/v1/config/draft', '/api/admin/v1/draft'].includes(url.pathname)
    ) {
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const document = objectBody(body.document);
      const note = optionalString(body.note, 'note');
      const expected = optionalNullableInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
      const revision = await this.options.backend.saveDraft(
        {
          document,
          ...(note ? { note } : {}),
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
        },
        context,
      );
      sendJson(response, 201, revision);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/admin/v1/draft/validate') {
      if (!this.options.backend.validateDraft) {
        throw new AdminBackendError(501, 'not_implemented', 'Draft 校验尚未接入。');
      }
      sendJson(response, 200, await this.options.backend.validateDraft(context));
      return;
    }
    if (
      method === 'POST' &&
      ['/api/admin/v1/config/publish', '/api/admin/v1/draft/publish'].includes(url.pathname)
    ) {
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const expected = optionalInteger(body.expectedDraftRevisionId, 'expectedDraftRevisionId');
      const note = optionalString(body.note, 'note');
      const revision = await this.options.backend.publishDraft(
        {
          ...(expected === undefined ? {} : { expectedDraftRevisionId: expected }),
          ...(note ? { note } : {}),
        },
        context,
      );
      sendJson(response, 200, revision);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/admin/v1/config/rollback') {
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const revisionId = requiredInteger(body.revisionId, 'revisionId');
      const note = optionalString(body.note, 'note');
      const revision = await this.options.backend.rollbackRevision(
        { revisionId, ...(note ? { note } : {}) },
        context,
      );
      sendJson(response, 200, revision);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/revisions') {
      const limit = queryInteger(url, 'limit', 100, 1, 500);
      sendJson(response, 200, { items: await this.options.backend.listRevisions({ limit }, context) });
      return;
    }
    const revisionMatch = /^\/api\/admin\/v1\/revisions\/(\d+)$/u.exec(url.pathname);
    if (method === 'GET' && revisionMatch) {
      const revisionId = Number(revisionMatch[1]);
      const revision = await this.options.backend.getRevision(revisionId, context);
      if (!revision) throw new AdminBackendError(404, 'revision_not_found', 'Revision 不存在。');
      sendJson(response, 200, revision);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/credentials') {
      sendJson(response, 200, { items: await this.options.backend.listCredentials(context) });
      return;
    }
    const appCredentialMatch = /^\/api\/admin\/v1\/apps\/([^/]+)\/credentials$/u.exec(
      url.pathname,
    );
    if (appCredentialMatch) {
      const appKey = decodePathSegment(appCredentialMatch[1] ?? '');
      const app = (await this.options.backend.listApps(context)).find((item) => item.id === appKey);
      if (!app) throw new AdminBackendError(404, 'app_not_found', 'Feishu App 不存在。');
      if (method === 'GET') {
        sendJson(response, 200, { items: app.credentials });
        return;
      }
      if (method === 'PUT') {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const name = requiredString(body.name, 'name');
        if (!app.credentials.some((credential) => credential.name === name)) {
          throw new AdminBackendError(400, 'credential_not_owned', '凭据不属于该 App。');
        }
        const kind = requiredString(body.kind, 'kind');
        const value = requiredString(body.value, 'value', false);
        sendJson(
          response,
          200,
          await this.options.backend.setCredential({ name, kind, value }, context),
        );
        return;
      }
    }
    const credentialMatch = /^\/api\/admin\/v1\/credentials\/([A-Za-z0-9][A-Za-z0-9._:%-]{0,255})$/u.exec(
      url.pathname,
    );
    if (credentialMatch) {
      const name = decodePathSegment(credentialMatch[1] ?? '');
      if (method === 'PUT') {
        const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
        const kind = requiredString(body.kind, 'kind');
        const value = requiredString(body.value, 'value', false);
        const status = await this.options.backend.setCredential({ name, kind, value }, context);
        sendJson(response, 200, status);
        return;
      }
      if (method === 'DELETE') {
        const deleted = await this.options.backend.deleteCredential(name, context);
        sendJson(response, 200, { name, configured: false, deleted });
        return;
      }
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/audit') {
      const limit = queryInteger(url, 'limit', 100, 1, 500);
      const beforeId = optionalQueryInteger(url, 'beforeId', 1, Number.MAX_SAFE_INTEGER);
      const items = await this.options.backend.listAudit(
        { limit, ...(beforeId === undefined ? {} : { beforeId }) },
        context,
      );
      sendJson(response, 200, { items });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/sessions') {
      if (!this.options.backend.listSessions) {
        throw new AdminBackendError(501, 'not_implemented', '会话索引尚未接入。');
      }
      const appKey = url.searchParams.get('appKey') ?? undefined;
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const bindingId = url.searchParams.get('bindingId') ?? undefined;
      const limit = queryInteger(url, 'limit', 100, 1, 1_000);
      const items = await this.options.backend.listSessions(
        {
          ...(appKey ? { appKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(bindingId ? { bindingId } : {}),
          limit,
        },
        context,
      );
      sendJson(response, 200, { items });
      return;
    }
    const sessionOperation = /^\/api\/admin\/v1\/sessions\/([^/]+)\/(abort|reset)$/u.exec(
      url.pathname,
    );
    if (method === 'POST' && sessionOperation) {
      if (!this.options.backend.operateSession) {
        throw new AdminBackendError(501, 'not_implemented', '会话操作尚未接入。');
      }
      const storageId = decodePathSegment(sessionOperation[1] ?? '');
      const action = sessionOperation[2] as 'abort' | 'reset';
      sendJson(
        response,
        200,
        await this.options.backend.operateSession({ storageId, action }, context),
      );
      return;
    }
    const sessionDelete = /^\/api\/admin\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (method === 'DELETE' && sessionDelete) {
      if (!this.options.backend.operateSession) {
        throw new AdminBackendError(501, 'not_implemented', '会话操作尚未接入。');
      }
      const storageId = decodePathSegment(sessionDelete[1] ?? '');
      const body = objectBody(await readJsonBody(request, this.options.bodyLimitBytes));
      const confirmation = requiredString(body.confirmation, 'confirmation');
      sendJson(
        response,
        200,
        await this.options.backend.operateSession(
          { storageId, action: 'delete', confirmation },
          context,
        ),
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/approvals') {
      if (!this.options.backend.listApprovals) {
        throw new AdminBackendError(501, 'not_implemented', '审批查询尚未接入。');
      }
      const state = url.searchParams.get('state') ?? undefined;
      const limit = queryInteger(url, 'limit', 100, 1, 500);
      const items = await this.options.backend.listApprovals(
        { ...(state ? { state } : {}), limit },
        context,
      );
      sendJson(response, 200, { items });
      return;
    }
    const approvalOperation = /^\/api\/admin\/v1\/approvals\/([^/]+)\/(approve|deny)$/u.exec(
      url.pathname,
    );
    if (method === 'POST' && approvalOperation) {
      if (!this.options.backend.resolveApproval) {
        throw new AdminBackendError(501, 'not_implemented', '管理台审批操作尚未接入。');
      }
      const id = decodePathSegment(approvalOperation[1] ?? '');
      const decision = approvalOperation[2] as 'approve' | 'deny';
      sendJson(
        response,
        200,
        await this.options.backend.resolveApproval({ id, decision }, context),
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/v1/diagnostics/lark-cli') {
      if (!this.options.backend.listLarkCliDiagnostics) {
        throw new AdminBackendError(501, 'not_implemented', 'lark-cli 诊断尚未接入。');
      }
      sendJson(response, 200, {
        items: await this.options.backend.listLarkCliDiagnostics(context),
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const asset = STATIC_ASSETS.get(pathname);
    if (!asset) throw new AdminBackendError(404, 'not_found', '静态资源不存在。');
    const content = await readFile(resolve(this.staticRoot, asset.file));
    response.statusCode = 200;
    response.setHeader('content-type', asset.contentType);
    response.setHeader('content-length', content.byteLength);
    response.end(content);
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof AdminAuthError) {
      if (error.retryAfterSeconds !== undefined) {
        response.setHeader('retry-after', String(error.retryAfterSeconds));
      }
      sendJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof AdminBackendError || error instanceof AdminHttpInputError) {
      sendJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    this.options.logger?.error('Admin request failed', {
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    sendJson(response, 500, { error: 'internal_error', message: '管理请求处理失败。' });
  }
}

function administratorClientKey(
  request: IncomingMessage,
  trustedProxyAddresses: readonly string[],
): string {
  const peer = normalizeIpAddress(request.socket.remoteAddress ?? '');
  const trusted = new Set(trustedProxyAddresses.map(normalizeIpAddress));
  if (peer && trusted.has(peer)) {
    const forwarded = firstHeader(request.headers['x-forwarded-for'])
      ?.split(',', 1)[0]
      ?.trim();
    const client = normalizeIpAddress(forwarded ?? '');
    if (isIP(client)) return client;
  }
  return isIP(peer) ? peer : 'unknown';
}

function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') && isIP(value.slice('::ffff:'.length)) === 4
    ? value.slice('::ffff:'.length)
    : value;
}

class AdminHttpInputError extends Error {
  readonly code = 'invalid_request';

  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AdminHttpInputError';
  }
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new AdminHttpInputError(413, `请求体超过 ${limit} bytes。`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminHttpInputError(400, '请求体必须是有效 JSON。');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminHttpInputError(400, '请求体字段必须是 JSON object。');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, trim = true): string {
  if (typeof value !== 'string') throw new AdminHttpInputError(400, `${name} 必须是字符串。`);
  const normalized = trim ? value.trim() : value;
  if (!normalized) throw new AdminHttpInputError(400, `${name} 不得为空。`);
  if (normalized.length > 100_000) throw new AdminHttpInputError(400, `${name} 过长。`);
  return normalized;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = requiredString(value, name);
  if (normalized.length > 1_000) throw new AdminHttpInputError(400, `${name} 过长。`);
  return normalized;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AdminHttpInputError(400, `${name} 必须是正整数。`);
  }
  return Number(value);
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredInteger(value, name);
}

function optionalNullableInteger(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredInteger(value, name);
}

function queryInteger(url: URL, name: string, fallback: number, min: number, max: number): number {
  return optionalQueryInteger(url, name, min, max) ?? fallback;
}

function optionalQueryInteger(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AdminHttpInputError(400, `${name} query 参数无效。`);
  }
  return value;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminHttpInputError(400, 'URL path 编码无效。');
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const content = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', content.byteLength);
  response.end(content);
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

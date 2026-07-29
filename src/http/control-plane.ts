import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import type { HttpListenerConfig } from '../config/types.js';
import { secureEqual } from '../core/crypto-store.js';
import { Logger, errorFields } from '../core/logger.js';
import type { MetricsRegistry } from '../core/metrics.js';
import type {
  FeishuAppRuntime,
  FeishuAppRuntimeSnapshot,
  HttpIngressKind,
} from '../feishu/app-runtime.js';
import type { ModelApi } from '../config/types.js';

export interface AppAssignmentSnapshot {
  id: string;
  state: 'pending' | 'running' | 'standby' | 'failed';
  reason?: string;
  changedAt?: number;
}

export interface HostSnapshot {
  version: string;
  instanceId: string;
  startedAt: number;
  ready: boolean;
  setupRequired: boolean;
  activeRevisionId?: number;
  configuredApps: number;
  configuredAgents: number;
  configuredBindings: number;
  assignedApps: number;
  activeApps: number;
  skippedByShard: number;
  waitingForLease: number;
  failedApps: number;
  shard: { index: number; count: number };
  globalConcurrency: { capacity: number; inUse: number; waiting: number };
  runtimeCapacity: {
    residentWorkers: number;
    residentWorkerLimit: number;
    pendingResidentWorkers: number;
    workerStartsInUse: number;
    workerStartLimit: number;
    workerStartsWaiting: number;
  };
  modelBroker: {
    enabled: boolean;
    started: boolean;
    activeCapabilities: number;
    upstreamConfigured: boolean;
  };
  assignments: AppAssignmentSnapshot[];
  apps: FeishuAppRuntimeSnapshot[];
  agents: Array<{
    id: string;
    provider: string;
    model: string;
    modelApi: ModelApi;
    runtimeIsolation: 'process' | 'in-process';
    workspaceMode: 'none' | 'read-only' | 'read-write';
    feishuTools: string[];
    workspaceTools: string[];
  }>;
  bindings: Array<{
    id: string;
    app: string;
    agent: string;
    route: unknown;
    conversationScope: 'chat' | 'thread';
  }>;
}

export interface ControlPlaneBackend {
  snapshot(): HostSnapshot;
  getApp(id: string): FeishuAppRuntime | undefined;
  listApps(): FeishuAppRuntime[];
}

export interface PublicAdminRouter {
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export class PublicIngressServer {
  private server: Server | undefined;
  private adminRouter: PublicAdminRouter | undefined;

  constructor(
    private readonly config: HttpListenerConfig,
    private readonly backend: ControlPlaneBackend,
    private readonly logger: Logger,
  ) {}

  mountAdmin(router: PublicAdminRouter): void {
    if (this.server) throw new Error('Admin router must be mounted before public HTTP starts.');
    this.adminRouter = router;
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.server) return;
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.logger.error('Public HTTP request failed', errorFields(error));
        if (!response.headersSent) sendHttpError(response, error);
        else response.end();
      });
    });
    this.server = server;
    await listen(server, this.config.host, this.config.port);
    this.logger.info('Public HTTP ingress listening', {
      host: this.config.host,
      port: this.config.port,
    });
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
      return { host: this.config.host, port: this.config.port };
    }
    return { host: address.address, port: address.port };
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.adminRouter && await this.adminRouter.handleRequest(request, response)) return;
    applyPublicHeaders(response);
    const url = requestUrl(request);
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && url.pathname === '/readyz') {
      const snapshot = this.backend.snapshot();
      sendJson(response, snapshot.ready ? 200 : 503, {
        status: snapshot.setupRequired
          ? 'setup_required'
          : snapshot.ready
            ? 'ready'
            : 'not_ready',
        activeApps: snapshot.activeApps,
        failedApps: snapshot.failedApps,
      });
      return;
    }

    const oauthApp = this.backend
      .listApps()
      .find((app) => app.oauthRedirectPath === url.pathname);
    if (method === 'GET' && oauthApp) {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (!code || !state) {
        sendHtml(response, 400, oauthPage('授权失败', '缺少 code 或 state。'));
        return;
      }
      try {
        const result = await oauthApp.handleOAuthCallback(code, state);
        sendHtml(
          response,
          200,
          oauthPage(
            '授权完成',
            `已连接飞书用户 ${escapeHtml(result.userId)}。可以关闭此页面。`,
          ),
        );
      } catch (error) {
        this.logger.warn('OAuth callback rejected', {
          appKey: oauthApp.id,
          ...errorFields(error),
        });
        sendHtml(response, 400, oauthPage('授权失败', '授权链接无效、已使用或已过期。'));
      }
      return;
    }

    if (method === 'POST') {
      const route = findFeishuRoute(this.backend.listApps(), url.pathname);
      if (route) {
        const body = await readJsonBody(request, this.config.bodyLimitBytes);
        const result = await route.app.invokeHttp(route.kind, request.headers, body);
        sendJson(response, 200, result ?? {});
        return;
      }
    }

    sendJson(response, 404, { error: 'not_found' });
  }
}

export class InternalControlServer {
  private server: Server | undefined;

  constructor(
    private readonly config: HttpListenerConfig & { adminToken?: string },
    private readonly backend: ControlPlaneBackend,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled || this.server) return;
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.logger.error('Internal HTTP request failed', errorFields(error));
        if (!response.headersSent) sendHttpError(response, error);
        else response.end();
      });
    });
    this.server = server;
    await listen(server, this.config.host, this.config.port);
    this.logger.info('Internal control API listening', {
      host: this.config.host,
      port: this.config.port,
      authentication: this.config.adminToken ? 'bearer' : 'loopback-only',
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await close(server);
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    applyInternalHeaders(response);
    if (!this.authorized(request.headers)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = requestUrl(request);
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && url.pathname === '/readyz') {
      const snapshot = this.backend.snapshot();
      sendJson(response, snapshot.ready ? 200 : 503, snapshot);
      return;
    }
    if (method === 'GET' && url.pathname === '/metrics') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(this.metrics.renderPrometheus());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/status') {
      sendJson(response, 200, this.backend.snapshot());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/apps') {
      sendJson(response, 200, this.backend.listApps().map((app) => app.snapshot()));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/agents') {
      sendJson(response, 200, this.backend.snapshot().agents);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/bindings') {
      sendJson(response, 200, this.backend.snapshot().bindings);
      return;
    }

    const sessionMatch = /^\/api\/v1\/apps\/([^/]+)\/sessions$/.exec(url.pathname);
    if (method === 'GET' && sessionMatch) {
      const app = this.backend.getApp(decodeURIComponent(sessionMatch[1] ?? ''));
      if (!app) {
        sendJson(response, 404, { error: 'app_not_found' });
        return;
      }
      sendJson(response, 200, await app.listSessions());
      return;
    }

    const operationMatch = /^\/api\/v1\/apps\/([^/]+)\/conversations\/(abort|reset)$/.exec(
      url.pathname,
    );
    if (method === 'POST' && operationMatch) {
      const app = this.backend.getApp(decodeURIComponent(operationMatch[1] ?? ''));
      if (!app) {
        sendJson(response, 404, { error: 'app_not_found' });
        return;
      }
      const body = await readJsonBody(request, this.config.bodyLimitBytes);
      const conversationKey = requiredBodyString(body, 'conversationKey');
      if (operationMatch[2] === 'abort') {
        sendJson(response, 200, {
          aborted: await app.abortConversation(conversationKey),
        });
      } else {
        await app.resetConversation(conversationKey);
        sendJson(response, 200, { reset: true });
      }
      return;
    }

    const policyMatch = /^\/api\/v1\/apps\/([^/]+)\/policy$/.exec(url.pathname);
    if (method === 'POST' && policyMatch) {
      const app = this.backend.getApp(decodeURIComponent(policyMatch[1] ?? ''));
      if (!app) {
        sendJson(response, 404, { error: 'app_not_found' });
        return;
      }
      const body = await readJsonBody(request, this.config.bodyLimitBytes);
      app.updatePolicy(parsePolicy(body));
      sendJson(response, 200, { updated: true, note: 'runtime-only' });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  }

  private authorized(headers: IncomingHttpHeaders): boolean {
    if (!this.config.adminToken) return true;
    const authorization = headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    return secureEqual(token, this.config.adminToken);
  }
}

function findFeishuRoute(
  apps: FeishuAppRuntime[],
  path: string,
): { app: FeishuAppRuntime; kind: HttpIngressKind } | undefined {
  for (const app of apps) {
    if (app.eventsHttpPath === path) return { app, kind: 'events' };
    if (app.callbacksHttpPath === path) return { app, kind: 'callbacks' };
  }
  return undefined;
}

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      throw new HttpInputError(413, `Request body exceeds ${limit} bytes.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HttpInputError(400, 'Request body must be valid JSON.', error);
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost');
}


function sendHttpError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpInputError) {
    sendJson(response, error.status, { error: 'invalid_request' });
    return;
  }
  sendJson(response, 500, { error: 'internal_error' });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(body);
}

function applyPublicHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  response.setHeader('cache-control', 'no-store');
}

function applyInternalHeaders(response: ServerResponse): void {
  applyPublicHeaders(response);
  response.setHeader('x-frame-options', 'DENY');
}

function oauthPage(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 24px;line-height:1.7}main{border:1px solid #ddd;border-radius:12px;padding:24px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requiredBodyString(body: unknown, key: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpInputError(400, 'Request body must be an object.');
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpInputError(400, `${key} must be a non-empty string.`);
  }
  return value;
}

function parsePolicy(body: unknown): {
  groupAllowlist?: string[];
  dmAllowlist?: string[];
  requireMention?: boolean;
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
  respondToMentionAll?: boolean;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpInputError(400, 'Policy body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const result: ReturnType<typeof parsePolicy> = {};
  if (record.groupAllowlist !== undefined) {
    result.groupAllowlist = stringArray(record.groupAllowlist, 'groupAllowlist');
  }
  if (record.dmAllowlist !== undefined) {
    result.dmAllowlist = stringArray(record.dmAllowlist, 'dmAllowlist');
  }
  if (record.requireMention !== undefined) {
    result.requireMention = boolean(record.requireMention, 'requireMention');
  }
  if (record.respondToMentionAll !== undefined) {
    result.respondToMentionAll = boolean(
      record.respondToMentionAll,
      'respondToMentionAll',
    );
  }
  if (record.dmMode !== undefined) {
    if (!['open', 'allowlist', 'pair', 'disabled'].includes(String(record.dmMode))) {
      throw new HttpInputError(400, 'dmMode is invalid.');
    }
    result.dmMode = record.dmMode as 'open' | 'allowlist' | 'pair' | 'disabled';
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new HttpInputError(400, `${label} must be a string array.`);
  }
  return value as string[];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpInputError(400, `${label} must be a boolean.`);
  }
  return value;
}

class HttpInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpInputError';
  }
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

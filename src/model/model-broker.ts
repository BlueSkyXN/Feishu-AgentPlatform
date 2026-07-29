import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ModelApi, ModelBrokerConfig } from '../config/types.js';
import { Logger, errorFields } from '../core/logger.js';

export interface ModelBrokerCapability {
  token: string;
  baseUrl: string;
}

export interface ModelBrokerCapabilityScope {
  appKey: string;
  agentId: string;
  bindingId: string;
  storageId: string;
  model: string;
  modelApi: ModelApi;
  upstreamPath: string;
}

interface CapabilityRecord {
  appKey: string;
  agentId: string;
  bindingId: string;
  storageId: string;
  model: string;
  modelApi: ModelApi;
  upstreamPath: string;
  issuedAt: number;
  lastUsedAt: number;
  expiresAt: number;
  maxExpiresAt: number;
}

export interface HostModelBrokerOptions {
  capabilityTtlMs?: number;
  capabilityMaxLifetimeMs?: number;
  now?: () => number;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface ModelBrokerSnapshot {
  enabled: boolean;
  started: boolean;
  activeCapabilities: number;
  upstreamConfigured: boolean;
}

/**
 * Loopback model proxy. Pi workers only receive a revocable capability; the
 * Cloudflare AI Gateway credential stays in this Host process.
 */
export class HostModelBroker {
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly capabilityTtlMs: number;
  private readonly capabilityMaxLifetimeMs: number;
  private readonly now: () => number;
  private readonly fetchRequest: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  private server: Server | undefined;
  private started = false;

  constructor(
    private readonly config: ModelBrokerConfig,
    private readonly logger: Logger,
    options: HostModelBrokerOptions = {},
  ) {
    this.capabilityTtlMs = positiveDuration(
      options.capabilityTtlMs ?? config.capabilityTtlMs ?? 15 * 60_000,
      'Model capability TTL',
    );
    this.capabilityMaxLifetimeMs = positiveDuration(
      options.capabilityMaxLifetimeMs ??
        config.capabilityMaxLifetimeMs ??
        6 * 60 * 60_000,
      'Model capability maximum lifetime',
    );
    this.now = options.now ?? Date.now;
    this.fetchRequest = options.fetch ?? fetch;
  }

  async start(required: boolean): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) {
      if (required) throw new Error('Host model broker is required but disabled.');
      return;
    }
    if (!this.config.upstreamBaseUrl || !this.config.upstreamApiKey) {
      throw new Error('Host model broker upstream is incomplete.');
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        this.logger.error('Model broker request failed', errorFields(error));
        if (!response.headersSent) {
          writeJson(response, 502, { error: { message: 'Model broker upstream failed.' } });
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server as Server;
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
      server.listen(this.config.port, this.config.host);
    });
    this.started = true;
    this.logger.info('Host model broker listening', {
      host: this.config.host,
      port: this.config.port,
    });
  }

  async stop(): Promise<void> {
    this.capabilities.clear();
    const server = this.server;
    this.server = undefined;
    this.started = false;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  issue(input: ModelBrokerCapabilityScope): ModelBrokerCapability {
    if (!this.started) throw new Error('Host model broker is not started.');
    const token = randomBytes(32).toString('base64url');
    const upstreamPath = normalizeUpstreamPath(input.upstreamPath);
    const now = this.now();
    const maxExpiresAt = now + this.capabilityMaxLifetimeMs;
    this.capabilities.set(token, {
      appKey: requiredScopeValue(input.appKey, 'appKey'),
      agentId: requiredScopeValue(input.agentId, 'agentId'),
      bindingId: requiredScopeValue(input.bindingId, 'bindingId'),
      storageId: requiredScopeValue(input.storageId, 'storageId'),
      model: requiredScopeValue(input.model, 'model'),
      modelApi: input.modelApi,
      upstreamPath,
      issuedAt: now,
      lastUsedAt: now,
      expiresAt: Math.min(now + this.capabilityTtlMs, maxExpiresAt),
      maxExpiresAt,
    });
    return {
      token,
      baseUrl: providerBaseUrl(this.config.publicBaseUrl, input.modelApi),
    };
  }

  revoke(token: string): void {
    this.capabilities.delete(token);
  }

  snapshot(): ModelBrokerSnapshot {
    this.pruneExpiredCapabilities(this.now());
    return {
      enabled: this.config.enabled,
      started: this.started,
      activeCapabilities: this.capabilities.size,
      upstreamConfigured: Boolean(
        this.config.upstreamBaseUrl && this.config.upstreamApiKey,
      ),
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: { message: 'Method not allowed.' } });
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const capability = token
      ? this.activeCapability(token, this.now())
      : undefined;
    if (!capability) {
      writeJson(response, 401, { error: { message: 'Invalid model capability.' } });
      return;
    }
    const inboundUrl = new URL(request.url ?? '/', 'http://model-broker.local');
    if (!inboundUrl.pathname.startsWith('/v1/')) {
      writeJson(response, 404, { error: { message: 'Unsupported model path.' } });
      return;
    }
    const controller = new AbortController();
    let clientDisconnected = false;
    const abortForClientDisconnect = (): void => {
      if (response.writableEnded) return;
      clientDisconnected = true;
      if (token) this.capabilities.delete(token);
      controller.abort(new Error('Model broker client disconnected.'));
    };
    request.once('aborted', abortForClientDisconnect);
    response.once('close', abortForClientDisconnect);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const body = await readBody(request, this.config.maxBodyBytes);
      if (clientDisconnected) return;
      const validation = validateRequestedModel(capability, inboundUrl, body);
      if (!validation.ok) {
        writeJson(response, validation.status, {
          error: { message: validation.message },
        });
        return;
      }
      if (!token || !this.renewCapability(token, capability, this.now())) {
        writeJson(response, 401, {
          error: { message: 'Invalid model capability.' },
        });
        return;
      }

      const upstreamUrl = buildUpstreamUrl(
        this.config.upstreamBaseUrl as string,
        capability,
        inboundUrl,
      );
      const headers = forwardHeaders(request);
      headers.set(
        'cf-aig-authorization',
        `Bearer ${this.config.upstreamApiKey as string}`,
      );
      timeout = setTimeout(
        () => controller.abort(new Error('Model broker upstream timeout.')),
        this.config.requestTimeoutMs,
      );
      timeout.unref();
      const upstream = await this.fetchRequest(upstreamUrl, {
        method: 'POST',
        headers,
        body: body.toString('utf8'),
        signal: controller.signal,
      });
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream.headers, response);
      if (!upstream.body) {
        response.end();
        return;
      }
      for await (const chunk of upstream.body) {
        if (!response.write(Buffer.from(chunk))) {
          await waitForDrain(response, controller.signal);
        }
      }
      response.end();
    } catch (error) {
      if (clientDisconnected) return;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      request.off('aborted', abortForClientDisconnect);
      response.off('close', abortForClientDisconnect);
    }
  }

  private activeCapability(
    token: string,
    now: number,
  ): CapabilityRecord | undefined {
    const capability = this.capabilities.get(token);
    if (!capability) return undefined;
    if (isCapabilityExpired(capability, now)) {
      this.capabilities.delete(token);
      return undefined;
    }
    return capability;
  }

  private renewCapability(
    token: string,
    expected: CapabilityRecord,
    now: number,
  ): boolean {
    const capability = this.activeCapability(token, now);
    if (capability !== expected) return false;
    capability.lastUsedAt = now;
    capability.expiresAt = Math.min(
      now + this.capabilityTtlMs,
      capability.maxExpiresAt,
    );
    return capability.expiresAt > now;
  }

  private pruneExpiredCapabilities(now: number): void {
    for (const [token, capability] of this.capabilities) {
      if (isCapabilityExpired(capability, now)) this.capabilities.delete(token);
    }
  }
}

function buildUpstreamUrl(
  baseUrl: string,
  capability: CapabilityRecord,
  inbound: URL,
): URL {
  const base = `${baseUrl.replace(/\/$/, '')}${capability.upstreamPath}`;
  const suffix = capability.modelApi.startsWith('openai-')
    ? inbound.pathname.slice('/v1'.length)
    : inbound.pathname;
  const target = new URL(`${base}${suffix}`);
  target.search = inbound.search;
  return target;
}

function providerBaseUrl(baseUrl: string, modelApi: ModelApi): string {
  const normalized = baseUrl.replace(/\/$/u, '');
  if (modelApi !== 'anthropic-messages') return normalized;
  return normalized.replace(/\/v1$/u, '');
}

function normalizeUpstreamPath(value: string): string {
  const path = value.trim();
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes('..') || path.includes('//')) {
    throw new Error('Agent upstreamPath must be a normalized relative URL path.');
  }
  return path === '/' ? '' : path.replace(/\/$/, '');
}

type ModelValidationResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; message: string };

function validateRequestedModel(
  capability: CapabilityRecord,
  inboundUrl: URL,
  body: Buffer,
): ModelValidationResult {
  for (const name of inboundUrl.searchParams.keys()) {
    if (/^(?:key|api[-_]?key|access[-_]?token|auth(?:orization)?)$/iu.test(name)) {
      return {
        ok: false,
        status: 400,
        message: 'Model request query contains a credential parameter.',
      };
    }
  }
  const pathValidation = validateModelApiPath(capability.modelApi, inboundUrl.pathname);
  if (!pathValidation.ok) return pathValidation;
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return {
      ok: false,
      status: 400,
      message: 'Model request body must be valid JSON.',
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      status: 400,
      message: 'Model request body must be a JSON object.',
    };
  }

  const bodyModel = (value as Record<string, unknown>).model;
  const requestedModels: string[] = [];
  if (bodyModel !== undefined) {
    if (typeof bodyModel !== 'string' || !bodyModel.trim()) {
      return {
        ok: false,
        status: 400,
        message: 'Model request body requires a string model.',
      };
    }
    requestedModels.push(bodyModel.trim());
  }
  if (capability.modelApi === 'google-generative-ai') {
    const pathModel = googleModelFromPath(inboundUrl.pathname);
    if (pathModel) requestedModels.push(pathModel);
  }
  if (requestedModels.length === 0) {
    return {
      ok: false,
      status: 400,
      message: 'Model request does not identify a model.',
    };
  }
  if (
    requestedModels.some(
      (requested) =>
        normalizeModelIdentifier(requested) !==
        normalizeModelIdentifier(capability.model),
    )
  ) {
    return {
      ok: false,
      status: 403,
      message: 'Requested model is outside the capability scope.',
    };
  }
  return { ok: true };
}

function validateModelApiPath(
  modelApi: ModelApi,
  pathname: string,
): ModelValidationResult {
  const accepted = modelApi === 'openai-completions'
    ? pathname === '/v1/chat/completions'
    : modelApi === 'openai-responses'
      ? pathname === '/v1/responses'
      : modelApi === 'anthropic-messages'
        ? pathname === '/v1/messages'
        : /^\/v1\/models\/[^/:]+:(?:generateContent|streamGenerateContent)$/u.test(pathname);
  return accepted
    ? { ok: true }
    : {
        ok: false,
        status: 404,
        message: `Unsupported path for model API ${modelApi}.`,
      };
}

function googleModelFromPath(pathname: string): string | undefined {
  const match = /(?:^|\/)models\/([^/:]+)(?::[^/]*)?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function normalizeModelIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function isCapabilityExpired(capability: CapabilityRecord, now: number): boolean {
  return now >= capability.expiresAt || now >= capability.maxExpiresAt;
}

function requiredScopeValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Model capability ${name} must not be empty.`);
  return normalized;
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value);
  return match?.[1];
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('Model request body exceeds the Host limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function forwardHeaders(request: IncomingMessage): Headers {
  const result = new Headers();
  const allowed = new Set([
    'accept',
    'content-type',
    'anthropic-version',
    'anthropic-beta',
    'openai-beta',
    'x-goog-api-client',
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function copyResponseHeaders(headers: Headers, response: ServerResponse): void {
  const blocked = new Set([
    'connection',
    'content-length',
    'content-encoding',
    'transfer-encoding',
  ]);
  headers.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase())) response.setHeader(name, value);
  });
}

async function waitForDrain(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Model broker client disconnected.'));
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Model broker operation aborted.');
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

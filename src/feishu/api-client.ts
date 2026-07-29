import { withUserAccessToken } from '@larksuiteoapi/node-sdk';

import type {
  HttpMethod,
  LoadedBindingConfig,
  ToolIdentity,
} from '../config/types.js';
import type { OAuthTokenStore } from './oauth.js';
import { assertReadOnlyAllowed, normalizeOpenApiPath } from './openapi-policy.js';

interface RawClientLike {
  request(
    request: {
      method: HttpMethod;
      url: string;
      data?: unknown;
      params?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    options?: unknown,
  ): Promise<unknown>;
}

export interface FeishuApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  identity?: ToolIdentity;
  userId?: string;
  enforceGenericAllowlist?: boolean;
  signal?: AbortSignal;
}

export class FeishuOpenApiClient {
  constructor(
    private readonly config: LoadedBindingConfig,
    private readonly client: RawClientLike,
    private readonly oauthTokens?: OAuthTokenStore,
  ) {}

  async request(request: FeishuApiRequest): Promise<unknown> {
    const { signal } = request;
    throwIfAborted(signal);
    const path = normalizeOpenApiPath(request.path);
    if (request.enforceGenericAllowlist) {
      assertReadOnlyAllowed(
        request.method,
        path,
        this.config.agent.openApiReadAllowlist,
      );
    }

    const identity = request.identity ?? this.config.agent.defaultToolIdentity;
    let options: unknown;
    if (identity === 'user') {
      if (!request.userId) {
        throw new Error('A Feishu user identity request requires userId.');
      }
      if (!this.oauthTokens) {
        throw new Error(`User OAuth is disabled for app ${this.config.appKey}.`);
      }
      options = withUserAccessToken(
        await abortable(
          this.oauthTokens.validAccessToken(request.userId),
          signal,
        ),
      );
    }

    throwIfAborted(signal);
    const response = await abortable(
      this.client.request(
        {
          method: request.method,
          url: `${apiBase(this.config.feishu.domain)}${path}`,
          ...(request.body !== undefined ? { data: request.body } : {}),
          ...(request.query ? { params: request.query } : {}),
          ...(signal ? { signal } : {}),
        },
        options,
      ),
      signal,
    );
    assertFeishuSuccess(response, request.method, path);
    return response;
  }
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly method: HttpMethod,
    readonly path: string,
    readonly code?: number,
    readonly response?: unknown,
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}


function assertFeishuSuccess(
  response: unknown,
  method: HttpMethod,
  path: string,
): void {
  if (!response || typeof response !== 'object') return;
  const record = response as Record<string, unknown>;
  const code = typeof record.code === 'number' ? record.code : undefined;
  if (code !== undefined && code !== 0) {
    const message =
      typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : 'unknown Feishu API error';
    throw new FeishuApiError(
      `${method} ${path} failed with Feishu code ${code}: ${message}`,
      method,
      path,
      code,
      response,
    );
  }
}

function apiBase(domain: LoadedBindingConfig['feishu']['domain']): string {
  return domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation;
  throwIfAborted(signal);
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(abortReason(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Feishu API request was aborted.');
  error.name = 'AbortError';
  return error;
}

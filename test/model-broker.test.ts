import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import test from 'node:test';

import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';

import type { ModelBrokerConfig } from '../src/config/types.js';
import { Logger } from '../src/core/logger.js';
import {
  HostModelBroker,
  type ModelBrokerCapability,
  type ModelBrokerCapabilityScope,
} from '../src/model/model-broker.js';

test('Host model broker exchanges a short-lived capability for the Cloudflare header', async () => {
  let receivedPath = '';
  let receivedAuthorization: string | undefined;
  let receivedCloudflare: string | undefined;
  let receivedAnthropicVersion: string | undefined;
  let receivedWorkerApiKey: string | undefined;
  let receivedGoogleApiKey: string | undefined;
  let receivedCustomSecret: string | undefined;
  const upstream = createServer((request, response) => {
    receivedPath = request.url ?? '';
    receivedAuthorization = request.headers.authorization;
    receivedCloudflare = request.headers['cf-aig-authorization'] as string | undefined;
    receivedAnthropicVersion = request.headers['anthropic-version'] as string | undefined;
    receivedWorkerApiKey = request.headers['x-api-key'] as string | undefined;
    receivedGoogleApiKey = request.headers['x-goog-api-key'] as string | undefined;
    receivedCustomSecret = request.headers['x-custom-secret'] as string | undefined;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-test' }),
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());
    const response = await fetch(`${capability.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability.token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': capability.token,
        'x-goog-api-key': capability.token,
        'x-custom-secret': 'must-not-cross-the-broker',
      },
      body: JSON.stringify({ model: 'test' }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedPath, '/openai/chat/completions');
    assert.equal(receivedAuthorization, undefined);
    assert.equal(receivedCloudflare, 'Bearer cloudflare-secret');
    assert.equal(receivedAnthropicVersion, '2023-06-01');
    assert.equal(receivedWorkerApiKey, undefined);
    assert.equal(receivedGoogleApiKey, undefined);
    assert.equal(receivedCustomSecret, undefined);
    broker.revoke(capability.token);
    const rejected = await fetch(`${capability.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${capability.token}` },
      body: '{}',
    });
    assert.equal(rejected.status, 401);
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('capability TTL slides on valid requests but never exceeds maximum lifetime', async () => {
  let now = 1_000;
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('{}');
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-ttl-test' }),
    {
      capabilityTtlMs: 100,
      capabilityMaxLifetimeMs: 250,
      now: () => now,
    },
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());

    now = 1_099;
    assert.equal((await modelRequest(capability, 'test')).status, 200);
    now = 1_150;
    assert.equal((await modelRequest(capability, 'test')).status, 200);
    now = 1_249;
    assert.equal((await modelRequest(capability, 'test')).status, 200);
    now = 1_250;
    assert.equal((await modelRequest(capability, 'test')).status, 401);
    assert.equal(upstreamRequests, 3);
    assert.equal(broker.snapshot().activeCapabilities, 0);

    now = 2_000;
    const idle = broker.issue(capabilityScope({ storageId: 'idle-session' }));
    now = 2_100;
    assert.equal((await modelRequest(idle, 'test')).status, 401);
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('capability rejects a missing or mismatched body model without reaching upstream', async () => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('{}');
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-model-scope-test' }),
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());
    assert.equal((await modelRequest(capability, 'other-model')).status, 403);
    assert.equal((await modelRequest(capability, undefined)).status, 400);
    assert.equal(upstreamRequests, 0);
    assert.equal((await modelRequest(capability, 'test')).status, 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('Google model scope is enforced from the request path when the body omits model', async () => {
  let receivedPath = '';
  const upstream = createServer((request, response) => {
    receivedPath = request.url ?? '';
    response.end('{}');
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-google-scope-test' }),
  );
  try {
    await broker.start(true);
    const capability = broker.issue(
      capabilityScope({
        model: 'gemini-2.5-pro',
        modelApi: 'google-generative-ai',
        upstreamPath: '/google',
      }),
    );
    const accepted = await fetch(
      `${capability.baseUrl}/models/gemini-2.5-pro:streamGenerateContent`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ contents: [] }),
      },
    );
    assert.equal(accepted.status, 200);
    assert.equal(
      receivedPath,
      '/google/v1/models/gemini-2.5-pro:streamGenerateContent',
    );
    const rejected = await fetch(
      `${capability.baseUrl}/models/gemini-2.5-flash:streamGenerateContent`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${capability.token}` },
        body: JSON.stringify({ contents: [] }),
      },
    );
    assert.equal(rejected.status, 403);
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('broker composes and streams the exact endpoint for every supported model API', async () => {
  const requests: Array<{ path: string; body: string }> = [];
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push({ path: request.url ?? '', body });
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: first\n\n');
    response.end('data: second\n\n');
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-path-test' }),
  );
  try {
    await broker.start(true);
    const cases = [
      {
        scope: capabilityScope({
          storageId: 'responses',
          modelApi: 'openai-responses',
          upstreamPath: '/openai',
        }),
        inboundPath: '/responses',
        expectedPath: '/openai/responses',
        body: { model: 'test', input: 'hello', stream: true },
      },
      {
        scope: capabilityScope({
          storageId: 'anthropic',
          modelApi: 'anthropic-messages',
          upstreamPath: '/anthropic',
        }),
        inboundPath: '/v1/messages',
        expectedPath: '/anthropic/v1/messages',
        body: { model: 'test', messages: [], stream: true },
      },
      {
        scope: capabilityScope({
          storageId: 'google',
          model: 'gemini-2.5-pro',
          modelApi: 'google-generative-ai',
          upstreamPath: '/google',
        }),
        inboundPath: '/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
        expectedPath: '/google/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
        body: { contents: [] },
      },
    ] as const;
    for (const entry of cases) {
      const capability = broker.issue(entry.scope);
      const response = await fetch(`${capability.baseUrl}${entry.inboundPath}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(entry.body),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
    }
    assert.deepEqual(
      requests.map((entry) => entry.path),
      cases.map((entry) => entry.expectedPath),
    );
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('Anthropic capability base omits v1 because the pinned SDK appends it', async () => {
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort),
    new Logger({ service: 'model-broker-anthropic-base-test' }),
    { fetch: async () => new Response('{}') },
  );
  try {
    await broker.start(true);
    const anthropic = broker.issue(capabilityScope({
      modelApi: 'anthropic-messages',
      upstreamPath: '/anthropic',
    }));
    const openai = broker.issue(capabilityScope());
    assert.equal(anthropic.baseUrl, `http://127.0.0.1:${brokerPort}`);
    assert.equal(openai.baseUrl, `http://127.0.0.1:${brokerPort}/v1`);
  } finally {
    await broker.stop();
  }
});

test('pinned Pi Anthropic provider reaches the broker and upstream at one v1 path', async () => {
  let receivedPath = '';
  let receivedWorkerApiKey: string | undefined;
  const upstream = createServer(async (request, response) => {
    receivedPath = request.url ?? '';
    receivedWorkerApiKey = request.headers['x-api-key'] as string | undefined;
    for await (const _chunk of request) {
      // Drain the request before returning the intentional provider error.
    }
    response.statusCode = 400;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'test stop' },
    }));
  });
  const upstreamPort = await listenRandom(upstream);
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    new Logger({ service: 'model-broker-pi-anthropic-test' }),
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope({
      modelApi: 'anthropic-messages',
      upstreamPath: '/anthropic',
    }));
    const stream = streamAnthropic(
      {
        id: 'test',
        name: 'test',
        provider: 'host-broker',
        api: 'anthropic-messages',
        baseUrl: capability.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 1_000,
      },
      {
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
        tools: [],
      },
      {
        apiKey: capability.token,
        headers: { authorization: `Bearer ${capability.token}` },
        maxTokens: 16,
        maxRetries: 0,
      },
    );
    for await (const _event of stream) {
      // The upstream intentionally returns an error after the request is observed.
    }
    assert.equal(receivedPath, '/anthropic/v1/messages');
    assert.equal(receivedWorkerApiKey, undefined);
  } finally {
    await broker.stop();
    await close(upstream);
  }
});

test('broker rejects credential-bearing model query parameters', async () => {
  let upstreamRequests = 0;
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort),
    new Logger({ service: 'model-broker-query-credential-test' }),
    {
      fetch: async () => {
        upstreamRequests += 1;
        return new Response('{}');
      },
    },
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());
    const response = await fetch(
      `${capability.baseUrl}/chat/completions?api_key=${encodeURIComponent(capability.token)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'test' }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(upstreamRequests, 0);
  } finally {
    await broker.stop();
  }
});

test('capability cannot be reused for another endpoint on the same upstream provider', async () => {
  let upstreamRequests = 0;
  const brokerPort = await reservePort();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort),
    new Logger({ service: 'model-broker-endpoint-scope-test' }),
    {
      fetch: async () => {
        upstreamRequests += 1;
        return new Response('{}');
      },
    },
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());
    const response = await fetch(`${capability.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'test' }),
    });
    assert.equal(response.status, 404);
    assert.equal(upstreamRequests, 0);
  } finally {
    await broker.stop();
  }
});

test('closing the broker client aborts the in-flight upstream fetch', async () => {
  const brokerPort = await reservePort();
  const fetchStarted = deferred<void>();
  const upstreamAborted = deferred<void>();
  const broker = new HostModelBroker(
    brokerConfig(brokerPort),
    new Logger({ service: 'model-broker-disconnect-test' }),
    {
      fetch: async (_input, init) => {
        fetchStarted.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('Expected an upstream abort signal.'));
            return;
          }
          const abort = (): void => {
            upstreamAborted.resolve();
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Upstream aborted.'),
            );
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
    },
  );
  try {
    await broker.start(true);
    const capability = broker.issue(capabilityScope());
    const client = httpRequest(`${capability.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability.token}`,
        'content-type': 'application/json',
      },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ model: 'test' }));
    await fetchStarted.promise;
    client.destroy();
    await Promise.race([
      upstreamAborted.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('Upstream fetch was not aborted.')),
          1_000,
        ),
      ),
    ]);
    assert.equal((await modelRequest(capability, 'test')).status, 401);
  } finally {
    await broker.stop();
  }
});

function brokerConfig(
  brokerPort: number,
  overrides: Partial<ModelBrokerConfig> = {},
): ModelBrokerConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: brokerPort,
    publicBaseUrl: `http://127.0.0.1:${brokerPort}/v1`,
    upstreamBaseUrl: 'https://gateway.ai.cloudflare.com/test',
    upstreamApiKey: 'cloudflare-secret',
    requestTimeoutMs: 5_000,
    maxBodyBytes: 1024 * 1024,
    capabilityTtlMs: 15 * 60_000,
    capabilityMaxLifetimeMs: 6 * 60 * 60_000,
    allowNonCloudflareUpstream: true,
    ...overrides,
  };
}

function capabilityScope(
  overrides: Partial<ModelBrokerCapabilityScope> = {},
): ModelBrokerCapabilityScope {
  return {
    appKey: 'primary',
    agentId: 'general',
    bindingId: 'primary-general',
    storageId: 'session-1',
    model: 'test',
    modelApi: 'openai-completions',
    upstreamPath: '/openai',
    ...overrides,
  };
}

async function modelRequest(
  capability: ModelBrokerCapability,
  model: string | undefined,
): Promise<Response> {
  return await fetch(`${capability.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${capability.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(model === undefined ? {} : { model }),
  });
}

async function listenRandom(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port.');
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listenRandom(server);
  await close(server);
  return port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}

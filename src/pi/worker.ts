import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import type { BrokerToolName } from '../tools/catalog.js';
import { createPiSessionCore } from './session-core.js';
import {
  deserializeError,
  serializeError,
  type HostToWorkerMessage,
  type WorkerInit,
  type WorkerStatus,
  type WorkerToHostMessage,
} from './worker-protocol.js';
import type { BridgeEvent } from './text-delta-bridge.js';

let session: AgentSession | undefined;
let init: WorkerInit | undefined;
let activePromptId: string | undefined;
let unsubscribe: (() => void) | undefined;
const pendingTools = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

process.on('message', (message: HostToWorkerMessage) => {
  void handle(message).catch((error: unknown) => {
    if ('requestId' in message) {
      send({ type: 'error', requestId: message.requestId, error: serializeError(error) });
    } else {
      send({ type: 'fatal', error: serializeError(error) });
    }
  });
});

process.on('disconnect', () => {
  void cleanup().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  send({ type: 'fatal', error: serializeError(error) });
  void cleanup().finally(() => process.exit(1));
});

process.on('unhandledRejection', (error) => {
  send({ type: 'fatal', error: serializeError(error) });
  void cleanup().finally(() => process.exit(1));
});

async function handle(message: HostToWorkerMessage): Promise<void> {
  switch (message.type) {
    case 'init':
      await initialize(message.init);
      return;
    case 'prompt':
      await runPrompt(message.requestId, message.prompt, message.images);
      return;
    case 'abort':
      if (session?.isStreaming) await session.abort();
      send({ type: 'result', requestId: message.requestId, status: status() });
      return;
    case 'status':
      send({ type: 'result', requestId: message.requestId, status: status() });
      return;
    case 'dispose':
      if (session?.isStreaming) await session.abort();
      await cleanup();
      send({ type: 'result', requestId: message.requestId });
      setImmediate(() => process.exit(0));
      return;
    case 'tool_result': {
      const pending = pendingTools.get(message.requestId);
      if (!pending) return;
      pendingTools.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(deserializeError(message.error));
      return;
    }
    default:
      return assertNever(message);
  }
}

async function initialize(value: WorkerInit): Promise<void> {
  if (session || init) throw new Error('Worker is already initialized.');
  init = value;
  await Promise.all([
    mkdir(value.workspace, { recursive: true, mode: 0o700 }),
    mkdir(value.sessionDir, { recursive: true, mode: 0o700 }),
    mkdir(value.agentDir, { recursive: true, mode: 0o700 }),
  ]);
  process.chdir(value.workspace);
  const core = await createPiSessionCore(value, requestTool);
  session = core.session;
  unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const mapped = mapPiEvent(event);
    if (mapped && activePromptId) {
      send({ type: 'event', requestId: activePromptId, event: mapped });
    }
  });
  send({ type: 'ready', status: status() });
}

async function runPrompt(
  requestId: string,
  prompt: string,
  images: Array<{ type: 'image'; data: string; mimeType: string }>,
): Promise<void> {
  const current = requireSession();
  if (activePromptId) throw new Error('Worker already has an active prompt.');
  activePromptId = requestId;
  try {
    if (images.length > 0) await current.prompt(prompt, { images });
    else await current.prompt(prompt);
    send({ type: 'result', requestId, status: status() });
  } catch (error) {
    send({ type: 'error', requestId, error: serializeError(error) });
  } finally {
    activePromptId = undefined;
  }
}

async function requestTool(
  name: BrokerToolName,
  argumentsValue: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const requestId = randomUUID();
  return await new Promise<unknown>((resolve, reject) => {
    const abort = (): void => {
      pendingTools.delete(requestId);
      send({ type: 'tool_cancel', requestId });
      reject(abortError());
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (signal) signal.addEventListener('abort', abort, { once: true });
    pendingTools.set(requestId, {
      resolve: (value) => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      },
    });
    send({ type: 'tool_request', requestId, name, arguments: argumentsValue });
  });
}

function status(): WorkerStatus {
  const current = requireSession();
  const model = current.model;
  return {
    sessionId: current.sessionId,
    model: model ? `${model.provider}/${model.id}` : '(no model)',
    messageCount: current.messages.length,
    streaming: current.isStreaming,
    supportsImages: Boolean(model?.input?.includes('image')),
  };
}

function mapPiEvent(event: AgentSessionEvent): BridgeEvent | undefined {
  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent.type === 'text_delta'
  ) {
    return { type: 'text_delta', delta: event.assistantMessageEvent.delta };
  }
  if (event.type === 'tool_execution_start') {
    return { type: 'tool_start', toolName: event.toolName };
  }
  if (event.type === 'tool_execution_end') {
    return {
      type: 'tool_end',
      toolName: event.toolName,
      isError: event.isError,
    };
  }
  return undefined;
}

async function cleanup(): Promise<void> {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const [requestId, pending] of pendingTools.entries()) {
    send({ type: 'tool_cancel', requestId });
    pending.reject(new Error('Agent worker is shutting down.'));
  }
  pendingTools.clear();
  const current = session;
  session = undefined;
  try {
    await current?.dispose();
  } catch {
    // Best effort during process shutdown.
  }
}

function requireSession(): AgentSession {
  if (!session) throw new Error('Worker is not initialized.');
  return session;
}

function send(message: WorkerToHostMessage): void {
  if (process.connected && process.send) process.send(message);
}

function abortError(): Error {
  const error = new Error('Tool call aborted.');
  error.name = 'AbortError';
  return error;
}

function assertNever(value: never): never {
  throw new Error(`Unknown worker message: ${JSON.stringify(value)}`);
}

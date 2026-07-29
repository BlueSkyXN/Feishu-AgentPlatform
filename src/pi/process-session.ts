import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LoadedBindingConfig } from '../config/types.js';
import { Logger, errorFields } from '../core/logger.js';
import type { ToolBroker } from '../tools/tool-broker.js';
import type { BridgeEvent } from './text-delta-bridge.js';
import type {
  AgentPromptInput,
  AgentSessionHandle,
  AgentSessionSnapshot,
} from './agent-session.js';
import { buildAgentWorkerEnvironment } from './model-env.js';
import {
  deserializeError,
  serializeError,
  type HostToWorkerMessage,
  type WorkerInit,
  type WorkerStatus,
  type WorkerToHostMessage,
} from './worker-protocol.js';

interface PendingRequest {
  resolve: (status?: WorkerStatus) => void;
  reject: (error: Error) => void;
}

export interface ProcessAgentSessionOptions {
  config: LoadedBindingConfig;
  workspace: string;
  sessionDir: string;
  storageId: string;
  agentDir: string;
  broker: ToolBroker;
  modelAccess: {
    baseUrl: string;
    capability: string;
    revoke(): void;
  };
  logger: Logger;
}

export class ProcessAgentSession implements AgentSessionHandle {
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly toolControllers = new Map<string, AbortController>();
  private child: ChildProcess | undefined;
  private currentStatus: AgentSessionSnapshot;
  private disposed = false;

  private constructor(
    private readonly options: ProcessAgentSessionOptions,
    child: ChildProcess,
  ) {
    this.child = child;
    this.currentStatus = {
      sessionId: '(starting)',
      model: `${options.config.agent.provider}/${options.config.agent.model}`,
      messageCount: 0,
      streaming: false,
      supportsImages: false,
      available: true,
      isolation: 'process',
      ...(child.pid ? { workerPid: child.pid } : {}),
    };
  }

  static async create(
    options: ProcessAgentSessionOptions,
  ): Promise<ProcessAgentSession> {
    const home = join(options.sessionDir, '.worker-home');
    const temp = join(options.workspace, '.tmp');
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temp, { recursive: true, mode: 0o700 }),
    ]);

    const target = workerTarget();
    const child = fork(target.path, [], {
      cwd: options.workspace,
      env: buildAgentWorkerEnvironment(options.config, home, temp),
      execArgv: target.typescript ? ['--import', 'tsx'] : [],
      // Worker output may contain provider or prompt material. IPC is the only
      // supported worker-to-host channel, so stdout/stderr are discarded.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    const instance = new ProcessAgentSession(options, child);
    instance.attachChild(child);
    try {
      await instance.initialize();
      return instance;
    } catch (error) {
      await instance.dispose().catch(() => undefined);
      throw error;
    }
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: AgentPromptInput): Promise<void> {
    this.assertAlive();
    this.currentStatus = { ...this.currentStatus, streaming: true };
    const requestId = randomUUID();
    try {
      await this.request({
        type: 'prompt',
        requestId,
        prompt: input.prompt,
        images: input.images,
      });
    } finally {
      this.currentStatus = { ...this.currentStatus, streaming: false };
    }
  }

  async abort(): Promise<void> {
    if (!this.child || this.disposed) return;
    await this.request({ type: 'abort', requestId: randomUUID() });
  }

  snapshot(): AgentSessionSnapshot {
    return { ...this.currentStatus };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.currentStatus = { ...this.currentStatus, available: false, streaming: false };
    const child = this.child;
    this.child = undefined;
    if (!child) {
      this.options.modelAccess.revoke();
      return;
    }

    const graceMs = this.options.config.runtime.workerShutdownGraceSeconds * 1_000;
    const requestId = randomUUID();
    const graceful = this.requestWithChild(
      child,
      { type: 'dispose', requestId },
    ).catch(() => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    timer.unref();
    await graceful;
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    this.rejectAll(new Error('Agent session was disposed.'));
    this.options.modelAccess.revoke();
  }

  private async initialize(): Promise<void> {
    const init: WorkerInit = {
      workspace: this.options.workspace,
      sessionDir: this.options.sessionDir,
      agentDir: this.options.agentDir,
      provider: this.options.config.agent.provider,
      model: this.options.config.agent.model,
      modelApi: this.options.config.agent.modelApi,
      modelOptions: this.options.config.agent.modelOptions,
      modelBroker: {
        baseUrl: this.options.modelAccess.baseUrl,
        capability: this.options.modelAccess.capability,
      },
      thinkingLevel: this.options.config.agent.thinkingLevel,
      systemPrompt: this.options.config.systemPrompt,
      skillPaths: this.options.config.agent.skillPaths,
      tools: [
        ...this.options.config.agent.feishuTools,
        ...this.options.config.agent.workspaceTools,
      ],
    };
    const child = this.requireChild();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Pi agent worker initialization timed out.'));
      }, 60_000);
      timer.unref();
      const onReady = (message: WorkerToHostMessage): void => {
        if (message.type === 'ready') {
          this.updateStatus(message.status);
          cleanup();
          resolve();
        } else if (message.type === 'fatal') {
          cleanup();
          reject(deserializeError(message.error));
        }
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error('Pi agent worker exited during initialization.'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('message', onReady);
        child.off('exit', onExit);
      };
      child.on('message', onReady);
      child.once('exit', onExit);
      child.send({ type: 'init', init } satisfies HostToWorkerMessage);
    });
  }

  private attachChild(child: ChildProcess): void {
    child.on('message', (message: WorkerToHostMessage) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.options.logger.error('Pi worker message handling failed', errorFields(error));
      });
    });
    child.once('exit', (code, signal) => {
      const wasDisposed = this.disposed;
      this.child = undefined;
      this.currentStatus = {
        ...this.currentStatus,
        available: false,
        streaming: false,
      };
      this.options.modelAccess.revoke();
      this.rejectAll(
        new Error(
          `Pi agent worker exited (code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
      if (!wasDisposed) {
        this.options.logger.error('Pi agent worker exited unexpectedly', {
          code,
          signal,
          storageId: this.options.storageId,
        });
      }
    });
    child.once('error', (error) => {
      this.currentStatus = {
        ...this.currentStatus,
        available: false,
        streaming: false,
      };
      this.options.modelAccess.revoke();
      this.rejectAll(error);
    });
  }

  private async handleMessage(message: WorkerToHostMessage): Promise<void> {
    switch (message.type) {
      case 'event':
        for (const listener of this.listeners) listener(message.event);
        return;
      case 'result': {
        if (message.status) this.updateStatus(message.status);
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        pending.resolve(message.status);
        return;
      }
      case 'error': {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        pending.reject(deserializeError(message.error));
        return;
      }
      case 'tool_request': {
        const controller = new AbortController();
        this.toolControllers.set(message.requestId, controller);
        try {
          const result = await this.options.broker.execute(
            message.name,
            message.arguments,
            controller.signal,
          );
          this.send({
            type: 'tool_result',
            requestId: message.requestId,
            ok: true,
            result,
          });
        } catch (error) {
          this.send({
            type: 'tool_result',
            requestId: message.requestId,
            ok: false,
            error: serializeError(error),
          });
        } finally {
          this.toolControllers.delete(message.requestId);
        }
        return;
      }
      case 'tool_cancel':
        this.toolControllers.get(message.requestId)?.abort();
        return;
      case 'fatal':
        this.rejectAll(deserializeError(message.error));
        this.child?.kill('SIGTERM');
        return;
      case 'ready':
        this.updateStatus(message.status);
        return;
      default:
        return assertNever(message);
    }
  }

  private async request(message: HostToWorkerMessage): Promise<void> {
    const child = this.requireChild();
    await this.requestWithChild(child, message);
  }

  private async requestWithChild(
    child: ChildProcess,
    message: HostToWorkerMessage,
  ): Promise<void> {
    if (!('requestId' in message)) {
      child.send(message);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.pending.set(message.requestId, {
        resolve: (status) => {
          if (status) this.updateStatus(status);
          resolve();
        },
        reject,
      });
      child.send(message, (error) => {
        if (!error) return;
        this.pending.delete(message.requestId);
        reject(error);
      });
    });
  }

  private send(message: HostToWorkerMessage): void {
    const child = this.child;
    if (child?.connected) child.send(message);
  }

  private updateStatus(status: WorkerStatus): void {
    this.currentStatus = {
      sessionId: status.sessionId,
      model: status.model,
      messageCount: status.messageCount,
      streaming: status.streaming,
      supportsImages: status.supportsImages,
      available: !this.disposed && Boolean(this.child?.connected),
      isolation: 'process',
      ...(this.child?.pid ? { workerPid: this.child.pid } : {}),
    };
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.toolControllers.values()) controller.abort(error);
    this.toolControllers.clear();
  }

  private requireChild(): ChildProcess {
    this.assertAlive();
    return this.child as ChildProcess;
  }

  private assertAlive(): void {
    if (this.disposed || !this.child?.connected) {
      throw new Error('Pi agent worker is not available.');
    }
  }
}

function workerTarget(): { path: string; typescript: boolean } {
  const javascript = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (existsSync(javascript)) return { path: javascript, typescript: false };
  const typescript = fileURLToPath(new URL('./worker.ts', import.meta.url));
  if (existsSync(typescript)) return { path: typescript, typescript: true };
  throw new Error(`Pi worker entrypoint not found beside ${dirname(javascript)}.`);
}

function assertNever(value: never): never {
  throw new Error(`Unknown worker response: ${JSON.stringify(value)}`);
}

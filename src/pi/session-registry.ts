import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ApprovalCoordinator } from '../approvals/coordinator.js';
import type { LoadedBindingConfig } from '../config/types.js';
import { conversationStorageId } from '../core/conversation.js';
import { Logger, errorFields } from '../core/logger.js';
import { FeishuOpenApiClient } from '../feishu/api-client.js';
import type { FeishuIdentityContextService } from '../feishu/identity-context.js';
import type { FeishuOAuthService } from '../feishu/oauth.js';
import type { HostModelBroker } from '../model/model-broker.js';
import { createWorkspaceGuard } from '../sandbox/factory.js';
import type { WorkspaceGuard } from '../sandbox/types.js';
import type { PersistentSessionIndex } from '../storage/session-index.js';
import { ToolBroker } from '../tools/tool-broker.js';
import { TurnContextRef, type TurnContext } from '../tools/turn-context.js';
import type { AgentSessionHandle } from './agent-session.js';
import { InProcessAgentSession } from './in-process-session.js';
import { ProcessAgentSession } from './process-session.js';
import {
  UNBOUNDED_RESIDENT_RUNTIME_COORDINATOR,
  UNBOUNDED_WORKER_START_LIMITER,
  type ResidentRuntimeCoordinator,
  type ResidentRuntimeLease,
  type WorkerStartLimiter,
} from './runtime-capacity.js';

interface SessionChannel {
  rawClient: {
    request(
      request: {
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        data?: unknown;
        params?: Record<string, unknown>;
      },
      options?: unknown,
    ): Promise<unknown>;
  };
  getChatInfo(chatId: string): Promise<unknown>;
}

export interface ManagedSession {
  appKey: string;
  agentId: string;
  bindingId: string;
  handle: AgentSessionHandle;
  storageId: string;
  workspace: string;
  sessionDir: string;
  conversationKey: string;
  chatId: string;
  turn: TurnContextRef;
  workspaceGuard: WorkspaceGuard;
  createdAt: number;
  lastUsedAt: number;
}

interface SessionEntry {
  promise: Promise<ManagedSession>;
  reservations: number;
  startupController: AbortController;
  start(): void;
  managed?: ManagedSession;
  residentLease?: ResidentRuntimeLease;
  disposal?: Promise<void>;
}

export interface ManagedSessionFactoryInput {
  conversationKey: string;
  chatId: string;
  storageId: string;
}

export interface PiSessionRegistryOptions {
  workerStartLimiter?: WorkerStartLimiter;
  residentCoordinator?: ResidentRuntimeCoordinator;
  sessionFactory?: (
    input: ManagedSessionFactoryInput,
  ) => Promise<ManagedSession>;
  sessionIndex?: PersistentSessionIndex;
}

export interface SessionStatus {
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  sessionId: string;
  model: string;
  messageCount: number;
  streaming: boolean;
  supportsImages: boolean;
  available: boolean;
  isolation: 'process' | 'in-process';
  workerPid?: number;
  storageId: string;
  workspace: string;
  createdAt: number;
  lastUsedAt: number;
}

export class PiSessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly workerStartLimiter: WorkerStartLimiter;
  private readonly residentCoordinator: ResidentRuntimeCoordinator;
  private readonly sessionFactory:
    | ((input: ManagedSessionFactoryInput) => Promise<ManagedSession>)
    | undefined;
  private readonly approvals: ApprovalCoordinator | undefined;
  private readonly sessionIndex: PersistentSessionIndex | undefined;

  constructor(
    private readonly config: LoadedBindingConfig,
    private readonly channel: SessionChannel,
    private readonly oauth: FeishuOAuthService | undefined,
    private readonly identityContext: FeishuIdentityContextService,
    private readonly logger: Logger,
    private readonly modelBroker: HostModelBroker,
    approvals?: ApprovalCoordinator,
    options: PiSessionRegistryOptions = {},
  ) {
    this.approvals = approvals;
    this.workerStartLimiter =
      options.workerStartLimiter ?? UNBOUNDED_WORKER_START_LIMITER;
    this.residentCoordinator =
      options.residentCoordinator ?? UNBOUNDED_RESIDENT_RUNTIME_COORDINATOR;
    this.sessionFactory = options.sessionFactory;
    this.sessionIndex = options.sessionIndex;
  }

  get residentCount(): number {
    return this.sessions.size;
  }

  async acquireForTurn(
    conversationKey: string,
    chatId: string,
  ): Promise<ManagedSession> {
    while (true) {
      const selection = await this.withMutation(() => {
        const existing = this.sessions.get(conversationKey);
        if (existing) {
          existing.reservations += 1;
          return { entry: existing, created: false };
        }

        const evicted = this.takeIdleEntryForCapacity();
        const entry = this.prepareEntry(conversationKey, chatId, evicted);
        this.sessions.set(conversationKey, entry);
        return { entry, created: true };
      });
      if (selection.created) selection.entry.start();

      let managed: ManagedSession;
      try {
        managed = await selection.entry.promise;
        managed.lastUsedAt = Date.now();
      } catch (error) {
        selection.entry.reservations = Math.max(
          0,
          selection.entry.reservations - 1,
        );
        throw error;
      }
      if (managed.handle.snapshot().available) return managed;

      selection.entry.reservations = Math.max(
        0,
        selection.entry.reservations - 1,
      );
      const removed = await this.withMutation(() => {
        if (this.sessions.get(conversationKey) !== selection.entry) return false;
        this.sessions.delete(conversationKey);
        return true;
      });
      if (removed) await this.disposeEntry(selection.entry);
    }
  }

  beginTurn(managed: ManagedSession, context: TurnContext): void {
    managed.lastUsedAt = Date.now();
    managed.turn.set(context);
  }

  endTurn(managed: ManagedSession): void {
    managed.turn.clear();
    managed.lastUsedAt = Date.now();
    this.touchSessionIndex(managed);
    this.releaseManagedReservation(managed);
  }

  async reset(conversationKey: string): Promise<void> {
    const existing = await this.withMutation(() => {
      const entry = this.sessions.get(conversationKey);
      this.sessions.delete(conversationKey);
      return entry;
    });
    if (existing) await this.disposeEntry(existing);

    const storageId = conversationStorageId(conversationKey);
    const sessionDir = join(
      this.config.agent.sessionRoot,
      this.config.appKey,
      this.config.agentId,
      storageId,
    );
    await rm(sessionDir, { recursive: true, force: true });
    this.sessionIndex?.remove(storageId);
    this.logger.info('Conversation session reset', { conversationKey, storageId });
  }

  async evictRuntime(
    conversationKey: string,
    expected?: ManagedSession,
  ): Promise<boolean> {
    const entry = await this.withMutation(() => {
      const current = this.sessions.get(conversationKey);
      if (!current) return undefined;
      if (expected && current.managed !== expected) return undefined;
      this.sessions.delete(conversationKey);
      return current;
    });
    if (!entry) return false;
    await this.disposeEntry(entry);
    return true;
  }

  async abort(conversationKey: string): Promise<boolean> {
    const entry = this.sessions.get(conversationKey);
    if (!entry) return false;
    entry.reservations += 1;
    try {
      const managed = await entry.promise;
      if (!managed.turn.snapshot() || !managed.handle.snapshot().streaming) return false;
      await managed.handle.abort();
      await this.evictRuntime(conversationKey, managed);
      return true;
    } finally {
      this.releaseEntryReservation(conversationKey, entry);
    }
  }

  async status(conversationKey: string, chatId: string): Promise<SessionStatus> {
    const managed = await this.acquireForTurn(conversationKey, chatId);
    try {
      return snapshot(managed);
    } finally {
      this.releaseManagedReservation(managed);
    }
  }

  async list(): Promise<SessionStatus[]> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((entry) => entry.promise),
    );
    return results
      .filter(
        (result): result is PromiseFulfilledResult<ManagedSession> =>
          result.status === 'fulfilled',
      )
      .map((result) => snapshot(result.value))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async pruneIdle(now = Date.now()): Promise<number> {
    const { entries, ttlMs } = await this.withMutation(() => {
      const ttlMs = this.config.conversation.idleTtlSeconds * 1_000;
      const entries: SessionEntry[] = [];
      for (const [key, entry] of [...this.sessions.entries()]) {
        const managed = entry.managed;
        if (!managed) continue;
        const status = managed.handle.snapshot();
        if (
          entry.reservations === 0 &&
          !status.streaming &&
          !managed.turn.snapshot() &&
          (!status.available || now - managed.lastUsedAt >= ttlMs)
        ) {
          if (this.sessions.get(key) === entry) {
            this.sessions.delete(key);
            entries.push(entry);
          }
        }
      }
      return { entries, ttlMs };
    });
    await Promise.allSettled(entries.map((entry) => this.disposeEntry(entry)));
    if (entries.length > 0) {
      this.logger.info('Reclaimed idle Pi runtimes', {
        pruned: entries.length,
        ttlMs,
      });
    }
    return entries.length;
  }

  async abortAll(): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const entry of this.sessions.values()) {
      const managed = entry.managed;
      if (managed?.handle.snapshot().streaming) {
        aborts.push(managed.handle.abort());
      }
    }
    await Promise.allSettled(aborts);
  }

  async disposeAll(): Promise<void> {
    const pending = await this.withMutation(() => {
      const entries = [...this.sessions.values()];
      this.sessions.clear();
      return entries;
    });
    await Promise.allSettled(pending.map((entry) => this.disposeEntry(entry)));
  }

  private prepareEntry(
    conversationKey: string,
    chatId: string,
    evicted: SessionEntry | undefined,
  ): SessionEntry {
    const startupController = new AbortController();
    let releaseStart!: () => void;
    let started = false;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let entry!: SessionEntry;
    const promise = startGate
      .then(async () => {
        if (evicted) await this.disposeEntry(evicted);
        return await this.startManagedSession(
          entry,
          conversationKey,
          chatId,
          startupController.signal,
        );
      })
      .then((managed) => {
        entry.managed = managed;
        return managed;
      })
      .catch(async (error: unknown) => {
        await this.withMutation(() => {
          if (this.sessions.get(conversationKey) === entry) {
            this.sessions.delete(conversationKey);
          }
        });
        throw error;
      });
    entry = {
      promise,
      reservations: 1,
      startupController,
      start: (): void => {
        if (started) return;
        started = true;
        releaseStart();
      },
    };
    return entry;
  }

  private async startManagedSession(
    entry: SessionEntry,
    conversationKey: string,
    chatId: string,
    signal: AbortSignal,
  ): Promise<ManagedSession> {
    const storageId = conversationStorageId(conversationKey);
    try {
      const lease = await this.residentCoordinator.acquire(
        {
          appKey: this.config.appKey,
          agentId: this.config.agentId,
          bindingId: this.config.id,
          conversationKey,
          storageId,
        },
        signal,
      );
      entry.residentLease = lease;
      throwIfStartupAborted(signal);
      const managed = await this.workerStartLimiter.run(
        async () =>
          this.sessionFactory
            ? await this.sessionFactory({ conversationKey, chatId, storageId })
            : await this.create(conversationKey, chatId),
        signal,
      );
      if (signal.aborted) {
        await disposeManaged(managed, this.logger);
        throwIfStartupAborted(signal);
      }
      this.activateResidentLease(entry, managed);
      this.touchSessionIndex(managed);
      return managed;
    } catch (error) {
      this.releaseResidentLease(entry);
      throw error;
    }
  }

  private releaseManagedReservation(managed: ManagedSession): void {
    const entry = this.sessions.get(managed.conversationKey);
    if (!entry || entry.managed !== managed) return;
    entry.reservations = Math.max(0, entry.reservations - 1);
    entry.residentLease?.touch();
  }

  private activateResidentLease(entry: SessionEntry, managed: ManagedSession): void {
    entry.residentLease?.activate({
      isIdle: () =>
        this.sessions.get(managed.conversationKey) === entry &&
        entry.reservations === 0 &&
        !managed.handle.snapshot().streaming &&
        !managed.turn.snapshot(),
      lastUsedAt: () => managed.lastUsedAt,
      evict: async () => {
        const removed = await this.withMutation(() => {
          if (
            this.sessions.get(managed.conversationKey) !== entry ||
            entry.reservations !== 0 ||
            managed.handle.snapshot().streaming ||
            managed.turn.snapshot()
          ) {
            return false;
          }
          this.sessions.delete(managed.conversationKey);
          return true;
        });
        if (!removed) return false;
        await this.disposeEntry(entry);
        return true;
      },
    });
  }

  private touchSessionIndex(managed: ManagedSession): void {
    if (!this.sessionIndex) return;
    try {
      this.sessionIndex.touch({
        storageId: managed.storageId,
        conversationKey: managed.conversationKey,
        appKey: managed.appKey,
        agentId: managed.agentId,
        bindingId: managed.bindingId,
        chatId: managed.chatId,
        workspacePath: managed.workspace,
        sessionPath: managed.sessionDir,
        createdAt: managed.createdAt,
        lastUsedAt: managed.lastUsedAt,
      });
    } catch (error) {
      this.logger.warn('Failed to update persistent session index', {
        storageId: managed.storageId,
        ...errorFields(error),
      });
    }
  }

  private releaseEntryReservation(
    conversationKey: string,
    expected: SessionEntry,
  ): void {
    const entry = this.sessions.get(conversationKey);
    if (entry !== expected) return;
    entry.reservations = Math.max(0, entry.reservations - 1);
    entry.residentLease?.touch();
  }

  private takeIdleEntryForCapacity(): SessionEntry | undefined {
    if (this.sessions.size < this.config.conversation.maxResidentSessions) {
      return undefined;
    }

    let candidate:
      | { key: string; entry: SessionEntry; managed: ManagedSession }
      | undefined;
    for (const [key, entry] of this.sessions) {
      const managed = entry.managed;
      if (
        !managed ||
        entry.reservations !== 0 ||
        managed.handle.snapshot().streaming ||
        managed.turn.snapshot()
      ) {
        continue;
      }
      if (!candidate || managed.lastUsedAt < candidate.managed.lastUsedAt) {
        candidate = { key, entry, managed };
      }
    }
    if (!candidate) {
      throw new Error(
        `Binding ${this.config.id} reached maxResidentSessions and no idle runtime can be evicted.`,
      );
    }
    if (this.sessions.get(candidate.key) === candidate.entry) {
      this.sessions.delete(candidate.key);
      return candidate.entry;
    }
    return undefined;
  }

  private releaseResidentLease(entry: SessionEntry): void {
    const lease = entry.residentLease;
    delete entry.residentLease;
    lease?.release();
  }

  private async withMutation<T>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async create(
    conversationKey: string,
    chatId: string,
  ): Promise<ManagedSession> {
    const storageId = conversationStorageId(conversationKey);
    const workspace = join(
      this.config.agent.workspaceRoot,
      this.config.appKey,
      this.config.agentId,
      storageId,
    );
    const sessionDir = join(
      this.config.agent.sessionRoot,
      this.config.appKey,
      this.config.agentId,
      storageId,
    );
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    ]);

    const turn = new TurnContextRef();
    const workspaceGuard = await createWorkspaceGuard(this.config, workspace);
    const api = new FeishuOpenApiClient(
      this.config,
      this.channel.rawClient,
      this.oauth?.tokens,
    );
    const broker = new ToolBroker({
      config: this.config,
      channel: this.channel,
      api,
      identityContext: this.identityContext,
      ...(this.config.sandbox.mode === 'none' ? {} : { workspace: workspaceGuard }),
      ...(this.approvals ? { approvals: this.approvals } : {}),
      turn,
    });

    const capability = this.modelBroker.issue({
      appKey: this.config.appKey,
      agentId: this.config.agentId,
      bindingId: this.config.id,
      storageId,
      model: this.config.agent.model,
      modelApi: this.config.agent.modelApi,
      upstreamPath: this.config.agent.upstreamPath,
    });
    const modelAccess = {
      baseUrl: capability.baseUrl,
      capability: capability.token,
      revoke: () => this.modelBroker.revoke(capability.token),
    };
    const workerAgentDir = join(sessionDir, 'agent-runtime');
    let handle: AgentSessionHandle;
    try {
      handle =
        this.config.runtime.isolation === 'process'
          ? await ProcessAgentSession.create({
              config: this.config,
              workspace,
              sessionDir,
              storageId,
              agentDir: workerAgentDir,
              broker,
              modelAccess,
              logger: this.logger,
            })
          : await InProcessAgentSession.create({
              config: this.config,
              workspace,
              sessionDir,
              agentDir: workerAgentDir,
              broker,
              modelAccess,
            });
    } catch (error) {
      modelAccess.revoke();
      await workspaceGuard.dispose().catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    const managed: ManagedSession = {
      appKey: this.config.appKey,
      agentId: this.config.agentId,
      bindingId: this.config.id,
      handle,
      storageId,
      workspace,
      sessionDir,
      conversationKey,
      chatId,
      turn,
      workspaceGuard,
      createdAt: now,
      lastUsedAt: now,
    };
    this.logger.info('Pi conversation runtime ready', {
      storageId,
      ...handle.snapshot(),
      feishuTools: this.config.agent.feishuTools,
      workspaceTools: this.config.agent.workspaceTools,
      skillPaths: this.config.agent.skillPaths,
    });
    return managed;
  }

  private async disposeEntry(entry: SessionEntry): Promise<void> {
    if (entry.disposal) return await entry.disposal;
    entry.startupController.abort(
      new Error('Pi session startup was cancelled during disposal.'),
    );
    entry.start();
    entry.disposal = (async () => {
      try {
        const managed = await entry.promise;
        await disposeManaged(managed, this.logger);
      } catch (error) {
        if (!isAbortError(error)) {
          this.logger.warn(
            'Session creation failed during disposal',
            errorFields(error),
          );
        }
      } finally {
        this.releaseResidentLease(entry);
      }
    })();
    return await entry.disposal;
  }
}

async function disposeManaged(
  managed: ManagedSession,
  logger: Logger,
): Promise<void> {
  managed.turn.clear();
  const results = await Promise.allSettled([
    managed.handle.dispose(),
    managed.workspaceGuard.dispose(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Runtime resource disposal failed', errorFields(result.reason));
    }
  }
}

function snapshot(managed: ManagedSession): SessionStatus {
  const status = managed.handle.snapshot();
  return {
    appKey: managed.appKey,
    agentId: managed.agentId,
    bindingId: managed.bindingId,
    conversationKey: managed.conversationKey,
    sessionId: status.sessionId,
    model: status.model,
    messageCount: status.messageCount,
    streaming: status.streaming,
    supportsImages: status.supportsImages,
    available: status.available,
    isolation: status.isolation,
    ...(status.workerPid ? { workerPid: status.workerPid } : {}),
    storageId: managed.storageId,
    workspace: managed.workspace,
    createdAt: managed.createdAt,
    lastUsedAt: managed.lastUsedAt,
  };
}

function throwIfStartupAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === 'Error') reason.name = 'AbortError';
    throw reason;
  }
  const error = new Error('Pi session startup was aborted.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

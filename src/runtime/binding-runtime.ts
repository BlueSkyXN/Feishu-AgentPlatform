import {
  LarkChannelError,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';

import type { ApprovalCoordinator } from '../approvals/coordinator.js';
import type { LoadedBindingConfig } from '../config/types.js';
import {
  buildConversationKey,
  conversationBelongsTo,
  shouldReplyInThread,
} from '../core/conversation.js';
import { KeyedQueue, QueueFullError } from '../core/keyed-queue.js';
import { Logger, errorFields } from '../core/logger.js';
import type { MetricsRegistry } from '../core/metrics.js';
import { Semaphore } from '../core/semaphore.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import {
  buildTrustedTurnPrompt,
  extractTenantKey,
  FeishuIdentityContextService,
} from '../feishu/identity-context.js';
import { prepareTurnInput } from '../feishu/attachments.js';
import { FeishuOpenApiClient } from '../feishu/api-client.js';
import { OAuthRequiredError, type FeishuOAuthService } from '../feishu/oauth.js';
import type { HostModelBroker } from '../model/model-broker.js';
import {
  PiSessionRegistry,
  type PiSessionRegistryOptions,
  type SessionStatus,
} from '../pi/session-registry.js';
import { streamSessionReply } from '../pi/stream-session.js';
import {
  ensureLarkCliProfile,
  type LarkCliProfileStatus,
} from '../tools/lark-cli.js';

export interface BindingRuntimeSnapshot {
  id: string;
  appKey: string;
  agentId: string;
  defaultRoute: boolean;
  priority: number;
  acceptingMessages: boolean;
  ready: boolean;
  residentSessions: number;
  activeConversationQueues: number;
  activeTurns: number;
  waitingTurns: number;
  runtimeIsolation: LoadedBindingConfig['runtime']['isolation'];
  lastMessageAt?: number;
  lastError?: string;
  larkCli?: {
    enabled: boolean;
    expectedVersion: string;
    actualVersion?: string;
    initialized: boolean;
  };
}

export class AppAgentBindingRuntime {
  private readonly queue: KeyedQueue;
  private readonly sessions: PiSessionRegistry;
  private readonly identityContext: FeishuIdentityContextService;
  private readonly semaphore: Semaphore;
  private readonly logger: Logger;
  private readonly activeTurnControllers = new Set<AbortController>();
  private acceptingMessages = false;
  private lastMessageAt?: number;
  private lastError?: string;
  private dependencyReady = false;
  private larkCliStatus: LarkCliProfileStatus | undefined;

  constructor(
    readonly config: LoadedBindingConfig,
    private readonly channel: LarkChannel,
    private readonly oauth: FeishuOAuthService | undefined,
    rootLogger: Logger,
    private readonly metrics: MetricsRegistry,
    private readonly globalSemaphore: Semaphore,
    modelBroker: HostModelBroker,
    approvals?: ApprovalCoordinator,
    sessionOptions: PiSessionRegistryOptions = {},
  ) {
    this.logger = rootLogger.child({
      appKey: config.appKey,
      agentId: config.agentId,
      bindingId: config.id,
    });
    this.queue = new KeyedQueue(config.conversation.maxPendingTurns);
    this.semaphore = new Semaphore(config.conversation.maxConcurrentTurns);
    const api = new FeishuOpenApiClient(config, channel.rawClient, oauth?.tokens);
    this.identityContext = new FeishuIdentityContextService(
      config,
      api,
      this.logger,
    );
    this.sessions = new PiSessionRegistry(
      config,
      channel,
      oauth,
      this.identityContext,
      this.logger,
      modelBroker,
      approvals,
      sessionOptions,
    );
  }

  start(): void {
    this.acceptingMessages = this.dependencyReady;
  }

  async prepare(): Promise<void> {
    delete this.lastError;
    this.larkCliStatus = undefined;
    if (!this.config.agent.larkCli.enabled) {
      this.dependencyReady = true;
      return;
    }
    try {
      this.larkCliStatus = await ensureLarkCliProfile(this.config);
      this.dependencyReady = true;
    } catch (error) {
      this.dependencyReady = false;
      this.lastError = errorText(error);
      this.logger.error('lark-cli dependency is not ready', errorFields(error));
    }
  }

  get ready(): boolean {
    return this.dependencyReady;
  }

  async stop(): Promise<void> {
    this.acceptingMessages = false;
    const drainMs = this.config.conversation.turnTimeoutSeconds * 1_000;
    const drained = await this.waitForStopPhase(
      this.queue.onIdle(),
      drainMs,
      'graceful queue drain',
    );
    if (!drained) {
      this.abortActiveTurns(
        new Error(`Binding ${this.config.id} is stopping after drain timeout.`),
      );
      await this.waitForStopPhase(
        this.sessions.abortAll(),
        drainMs,
        'session abort',
      );
      await this.waitForStopPhase(
        this.queue.onIdle(),
        drainMs,
        'forced queue drain',
      );
    }
    await this.waitForStopPhase(
      this.sessions.disposeAll(),
      drainMs,
      'session disposal',
    );
  }

  enqueue(message: NormalizedMessage, ingress: 'websocket' | 'http'): void {
    if (!this.acceptingMessages) return;
    this.lastMessageAt = Date.now();
    const tenantKey = extractTenantKey(message) ?? 'unknown';
    const conversationKey = buildConversationKey(
      this.config.appKey,
      this.config.agentId,
      tenantKey,
      message,
      this.config.conversation.scope,
    );
    if (normalizeCommand(message.content) === '/abort') {
      void this.abortFast(conversationKey, message);
      return;
    }

    const enqueuedAt = Date.now();
    try {
      void this.queue
        .enqueue(conversationKey, async () => {
          const remaining =
            this.config.conversation.queuedTurnTtlSeconds * 1_000 -
            (Date.now() - enqueuedAt);
          if (remaining <= 0) {
            throw new TimeoutError(0, 'Queued turn expired before execution.');
          }
          const release = await this.acquireTurnSlots(remaining);
          const turnController = new AbortController();
          this.activeTurnControllers.add(turnController);
          try {
            await withTimeout(
              (signal) => this.handleMessage(
                conversationKey,
                message,
                tenantKey,
                signal,
              ),
              this.config.conversation.turnTimeoutSeconds * 1_000,
              `Binding ${this.config.id} turn timed out.`,
              turnController.signal,
              () => this.sessions.abort(conversationKey).then(() => undefined),
            );
          } finally {
            this.activeTurnControllers.delete(turnController);
            release();
          }
        })
        .catch((error: unknown) =>
          this.reportTurnFailure(message, conversationKey, error),
        );
      this.logger.info('Feishu message queued', {
        conversationKey,
        messageId: message.messageId,
        ingress,
        pendingTurns: this.queue.pending(conversationKey),
      });
    } catch (error) {
      void this.reportTurnFailure(message, conversationKey, error);
    }
  }

  snapshot(): BindingRuntimeSnapshot {
    return {
      id: this.config.id,
      appKey: this.config.appKey,
      agentId: this.config.agentId,
      defaultRoute: this.config.route.default,
      priority: this.config.route.priority,
      acceptingMessages: this.acceptingMessages,
      ready: this.dependencyReady,
      residentSessions: this.sessions.residentCount,
      activeConversationQueues: this.queue.activeKeys(),
      activeTurns: this.semaphore.inUse,
      waitingTurns: this.semaphore.waiting,
      runtimeIsolation: this.config.runtime.isolation,
      ...(this.lastMessageAt ? { lastMessageAt: this.lastMessageAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      larkCli: {
        enabled: this.config.agent.larkCli.enabled,
        expectedVersion: this.config.agent.larkCli.expectedVersion,
        ...(this.larkCliStatus
          ? { actualVersion: this.larkCliStatus.actualVersion }
          : {}),
        initialized: Boolean(this.larkCliStatus),
      },
    };
  }

  listSessions(): Promise<SessionStatus[]> {
    return this.sessions.list();
  }

  ownsConversation(conversationKey: string, chatId?: string): boolean {
    return conversationBelongsTo(
      conversationKey,
      this.config.appKey,
      this.config.agentId,
      chatId,
    );
  }

  async resetConversation(conversationKey: string): Promise<void> {
    this.assertConversationBelongs(conversationKey);
    await this.queue.enqueue(conversationKey, () => this.sessions.reset(conversationKey));
  }

  abortConversation(conversationKey: string): Promise<boolean> {
    this.assertConversationBelongs(conversationKey);
    return this.sessions.abort(conversationKey);
  }

  async maintenance(): Promise<void> {
    await this.sessions.pruneIdle();
    this.metrics.setGauge(
      'feishu_agent_resident_sessions',
      'Resident Pi sessions held in memory.',
      labels(this.config),
      this.sessions.residentCount,
    );
    this.metrics.setGauge(
      'feishu_agent_active_queues',
      'Conversation queues currently holding work.',
      labels(this.config),
      this.queue.activeKeys(),
    );
    this.metrics.setGauge(
      'feishu_agent_active_turns',
      'Agent turns currently using a binding concurrency slot.',
      labels(this.config),
      this.semaphore.inUse,
    );
  }

  async handleCardAction(
    action: string,
    conversationKey: string,
    chatId?: string,
  ): Promise<unknown> {
    this.assertConversationBelongs(conversationKey, chatId);
    if (action === 'abort') {
      void this.sessions.abort(conversationKey).catch((error: unknown) => {
        this.logger.warn('Card abort action failed after acknowledgement', {
          conversationKey,
          ...errorFields(error),
        });
      });
      return { toast: { type: 'success', content: '已提交终止请求' } };
    }
    if (action === 'reset') {
      try {
        void this.queue
          .enqueue(conversationKey, () => this.sessions.reset(conversationKey))
          .catch((error: unknown) => {
            this.logger.warn('Card reset action failed after acknowledgement', {
              conversationKey,
              ...errorFields(error),
            });
          });
        return { toast: { type: 'success', content: '已提交会话重置' } };
      } catch (error) {
        this.logger.warn('Card reset action could not be queued', {
          conversationKey,
          ...errorFields(error),
        });
        return { toast: { type: 'error', content: '当前会话队列已满' } };
      }
    }
    return { toast: { type: 'info', content: '未识别的操作' } };
  }

  private async acquireTurnSlots(timeoutMs: number): Promise<() => void> {
    return await withTimeout(
      async (signal) => {
        const releaseGlobal = await this.globalSemaphore.acquire(signal);
        try {
          const releaseBinding = await this.semaphore.acquire(signal);
          return () => {
            releaseBinding();
            releaseGlobal();
          };
        } catch (error) {
          releaseGlobal();
          throw error;
        }
      },
      timeoutMs,
      'Queued turn expired while waiting for a concurrency slot.',
    );
  }

  private async handleMessage(
    conversationKey: string,
    message: NormalizedMessage,
    expectedTenantKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.acceptingMessages) return;
    throwIfAborted(signal);
    this.metrics.increment(
      'feishu_agent_messages_received_total',
      'Feishu messages accepted for processing.',
      { ...labels(this.config), type: message.rawContentType },
    );
    const command = normalizeCommand(message.content);
    if (command) {
      await this.handleCommand(command, conversationKey, message);
      return;
    }

    const enriched = await this.identityContext.enrich(message, signal);
    throwIfAborted(signal);
    if (
      enriched.tenantKey !== 'unknown' &&
      expectedTenantKey !== 'unknown' &&
      enriched.tenantKey !== expectedTenantKey
    ) {
      throw new Error('Feishu tenant identity changed during turn processing.');
    }
    const managed = await this.sessions.acquireForTurn(conversationKey, message.chatId);
    const started = Date.now();
    try {
      throwIfAborted(signal);
      this.sessions.beginTurn(managed, {
        appKey: this.config.appKey,
        agentId: this.config.agentId,
        bindingId: this.config.id,
        conversationKey,
        tenantKey: enriched.tenantKey,
        message,
        identity: enriched.identity,
        recentHistory: enriched.recentHistory,
        workspace: managed.workspace,
        receivedAt: Date.now(),
      });
      const prepared = await prepareTurnInput(
        this.channel,
        this.config,
        message,
        managed.workspaceGuard,
        managed.handle.snapshot().supportsImages,
        signal,
      );
      throwIfAborted(signal);
      const input = {
        ...prepared,
        prompt: buildTrustedTurnPrompt(
          message,
          enriched.identity,
          enriched.recentHistory,
          {
            attachmentPaths: prepared.attachmentPaths,
            imagesPassedToModel: prepared.images.length,
            skippedAttachments: prepared.skipped,
            totalBytes: prepared.totalBytes,
          },
          {
            appKey: this.config.appKey,
            agentId: this.config.agentId,
            bindingId: this.config.id,
          },
        ),
      };
      try {
        await streamSessionReply(
          this.channel,
          managed.handle,
          this.config,
          message,
          input,
          this.logger,
        );
      } catch (error) {
        if (error instanceof TimeoutError || !managed.handle.snapshot().available) {
          await this.sessions.evictRuntime(conversationKey, managed);
        }
        throw error;
      }
      this.metrics.increment(
        'feishu_agent_turns_completed_total',
        'Successfully completed Agent turns.',
        labels(this.config),
      );
    } finally {
      this.sessions.endTurn(managed);
      this.metrics.setGauge(
        'feishu_agent_last_turn_duration_ms',
        'Duration of the latest Agent turn in milliseconds.',
        labels(this.config),
        Date.now() - started,
      );
    }
  }

  private async handleCommand(
    command: Command,
    conversationKey: string,
    message: NormalizedMessage,
  ): Promise<void> {
    if (command === '/help') {
      await this.reply(
        message,
        [
          `**Agent：${this.config.agentId}**`,
          '- `/new` 或 `/reset`：清空当前会话历史',
          '- `/abort`：终止当前正在生成的回答',
          '- `/status`：显示当前 Pi Runtime 状态',
          ...(this.oauth
            ? [
                '- `/oauth`：连接当前飞书用户身份',
                '- `/oauth-status`：查看用户授权状态',
                '- `/oauth-logout`：删除本地用户授权',
              ]
            : []),
          '- `/help`：显示此说明',
        ].join('\n'),
      );
      return;
    }
    if (command === '/new' || command === '/reset') {
      await this.sessions.reset(conversationKey);
      await this.reply(message, '当前 Agent 会话历史已清空。');
      return;
    }
    if (command === '/status') {
      const status = await this.sessions.status(conversationKey, message.chatId);
      await this.reply(
        message,
        [
          '**Pi Runtime 状态**',
          `- App：\`${status.appKey}\``,
          `- Agent：\`${status.agentId}\``,
          `- Binding：\`${status.bindingId}\``,
          `- 模型：\`${status.model}\``,
          `- 隔离：\`${status.isolation}\``,
          `- 可用：${status.available ? '是' : '否'}`,
          `- 消息数：${status.messageCount}`,
          `- 正在生成：${status.streaming ? '是' : '否'}`,
          `- 会话 ID：\`${status.sessionId}\``,
          `- 存储 ID：\`${status.storageId}\``,
          ...(status.workerPid ? [`- Worker PID：\`${status.workerPid}\``] : []),
        ].join('\n'),
      );
      return;
    }
    if (command === '/oauth') {
      if (!this.oauth) {
        await this.reply(message, '当前飞书 App 未启用用户 OAuth。');
        return;
      }
      if (!isDirectChat(message.chatType)) {
        await this.reply(message, '请与机器人单聊后发送 `/oauth`。');
        return;
      }
      const url = await this.oauth.createAuthorizationUrl(message.senderId);
      await this.reply(message, `请在十分钟内完成授权：[连接飞书用户身份](${url})`);
      return;
    }
    if (command === '/oauth-status') {
      if (!this.oauth || !isDirectChat(message.chatType)) {
        await this.reply(message, '请在已启用 OAuth 的机器人单聊中查询。');
        return;
      }
      const status = await this.oauth.tokens.status(message.senderId);
      await this.reply(
        message,
        status.connected
          ? [
              '**飞书用户授权**',
              '- 状态：已连接',
              `- Access Token 到期：${formatTime(status.accessTokenExpiresAt)}`,
              `- Refresh Token 到期：${formatTime(status.refreshTokenExpiresAt)}`,
              `- Scopes：${status.scopes.join(', ') || '(平台未返回)'}`,
            ].join('\n')
          : '当前用户尚未授权。发送 `/oauth` 开始连接。',
      );
      return;
    }
    if (command === '/oauth-logout') {
      if (!this.oauth || !isDirectChat(message.chatType)) {
        await this.reply(message, '请在已启用 OAuth 的机器人单聊中操作。');
        return;
      }
      await this.oauth.tokens.remove(message.senderId);
      await this.reply(message, '当前用户的本地 OAuth 凭据已删除。');
      return;
    }
    await this.abortFast(conversationKey, message);
  }

  private async abortFast(
    conversationKey: string,
    message: NormalizedMessage,
  ): Promise<void> {
    try {
      const aborted = await this.sessions.abort(conversationKey);
      await this.reply(
        message,
        aborted ? '已请求终止当前生成。' : '当前会话没有正在生成的回答。',
      );
    } catch (error) {
      await this.reportTurnFailure(message, conversationKey, error);
    }
  }

  private async reportTurnFailure(
    message: NormalizedMessage,
    conversationKey: string,
    error: unknown,
  ): Promise<void> {
    this.lastError = errorText(error);
    this.metrics.increment(
      'feishu_agent_turns_failed_total',
      'Agent turns that failed.',
      { ...labels(this.config), reason: errorReason(error) },
    );
    this.logger.error('Feishu Agent turn failed', {
      conversationKey,
      messageId: message.messageId,
      ...errorFields(error),
    });
    if (!this.acceptingMessages) return;
    const text =
      error instanceof QueueFullError
        ? '当前会话排队消息过多，请稍后再发。'
        : error instanceof TimeoutError
          ? '该消息等待或执行时间超过配置上限，已终止。'
          : publicErrorText(error, Boolean(this.oauth));
    try {
      await this.reply(message, text);
    } catch (replyError) {
      this.logger.error('Failed to send error reply', errorFields(replyError));
    }
  }

  private async reply(message: NormalizedMessage, markdown: string): Promise<void> {
    await this.channel.send(
      message.chatId,
      { markdown },
      {
        replyTo: message.messageId,
        replyInThread: shouldReplyInThread(message),
      },
    );
  }

  private abortActiveTurns(reason: Error): void {
    for (const controller of this.activeTurnControllers) {
      controller.abort(reason);
    }
  }

  private async waitForStopPhase(
    operation: Promise<unknown>,
    timeoutMs: number,
    phase: string,
  ): Promise<boolean> {
    try {
      await withTimeout(
        operation,
        timeoutMs,
        `Binding ${this.config.id} ${phase} timed out.`,
      );
      return true;
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      this.logger.warn('Binding stop phase timed out', {
        phase,
        timeoutMs,
      });
      return false;
    }
  }

  private assertConversationBelongs(
    conversationKey: string,
    chatId?: string,
  ): void {
    if (!this.ownsConversation(conversationKey, chatId)) {
      throw new Error('Conversation key does not belong to this App/Agent/chat.');
    }
  }
}

type Command =
  | '/help'
  | '/new'
  | '/reset'
  | '/status'
  | '/abort'
  | '/oauth'
  | '/oauth-status'
  | '/oauth-logout';

function normalizeCommand(content: string): Command | undefined {
  const trimmed = content.trim().toLowerCase();
  return /^\/(help|new|reset|status|abort|oauth|oauth-status|oauth-logout)$/.test(
    trimmed,
  )
    ? (trimmed as Command)
    : undefined;
}

function labels(config: LoadedBindingConfig): Record<string, string> {
  return {
    app: config.appKey,
    agent: config.agentId,
    binding: config.id,
  };
}

function publicErrorText(error: unknown, oauthEnabled: boolean): string {
  if (error instanceof OAuthRequiredError) {
    return oauthEnabled
      ? '该操作需要当前用户授权。发送 `/oauth` 完成连接后重试。'
      : '该操作需要用户身份，但飞书 App 未启用 OAuth。';
  }
  const larkCode = larkChannelErrorCode(error);
  if (larkCode === 'rate_limited') return '飞书接口触发限流，请稍后重试。';
  if (larkCode === 'permission_denied') return '飞书应用权限不足，请检查读取权限。';
  return '处理失败。请检查模型路由、飞书读取权限和服务日志。';
}

function errorReason(error: unknown): string {
  if (error instanceof QueueFullError) return 'queue_full';
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof OAuthRequiredError) return 'oauth_required';
  return larkChannelErrorCode(error) ??
    (error instanceof Error ? error.name : 'unknown');
}

function larkChannelErrorCode(error: unknown): string | undefined {
  if (!(error instanceof LarkChannelError)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : 'lark_channel_error';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Binding turn was aborted.');
  error.name = 'AbortError';
  throw error;
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toISOString() : '(未知)';
}

function isDirectChat(chatType: string | undefined): boolean {
  return Boolean(
    chatType && ['p2p', 'private', 'direct'].includes(chatType.toLowerCase()),
  );
}

import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';

import { ApprovalCoordinator } from '../approvals/coordinator.js';
import {
  resolveBindingConfig,
  type LoadedAppAgentBinding,
  type LoadedFeishuApp,
} from '../config/types.js';
import { parseConversationKey, shouldReplyInThread } from '../core/conversation.js';
import { secureEqual } from '../core/crypto-store.js';
import { DedupeWindow } from '../core/dedupe-window.js';
import { Logger, errorFields } from '../core/logger.js';
import type { MetricsRegistry } from '../core/metrics.js';
import type { Semaphore } from '../core/semaphore.js';
import type { HostModelBroker } from '../model/model-broker.js';
import type {
  ResidentRuntimeCoordinator,
  WorkerStartLimiter,
} from '../pi/runtime-capacity.js';
import type { SessionStatus } from '../pi/session-registry.js';
import type { PersistentSessionIndex } from '../storage/session-index.js';
import type { ToolApprovalStore } from '../storage/approval-store.js';
import { BindingRouter, AmbiguousBindingRouteError } from '../runtime/binding-router.js';
import {
  AppAgentBindingRuntime,
  type BindingRuntimeSnapshot,
} from '../runtime/binding-runtime.js';
import { FeishuOAuthService } from './oauth.js';

export type HttpIngressKind = 'events' | 'callbacks';

export interface FeishuAppRuntimeSnapshot {
  id: string;
  appIdSuffix: string;
  eventsTransport: LoadedFeishuApp['events']['transport'];
  callbacksTransport: LoadedFeishuApp['callbacks']['transport'];
  eventsPath?: string;
  callbacksPath?: string;
  domain: LoadedFeishuApp['domain'];
  started: boolean;
  ready: boolean;
  acceptingMessages: boolean;
  botName?: string;
  botOpenId?: string;
  oauthEnabled: boolean;
  bindingCount: number;
  residentSessions: number;
  pendingApprovals: number;
  startedAt?: number;
  lastMessageAt?: number;
  lastError?: string;
  bindings: BindingRuntimeSnapshot[];
}

export type FeishuChannelFactory = (
  transport: 'websocket' | 'http',
  app: LoadedFeishuApp,
  bindings: LoadedAppAgentBinding[],
) => LarkChannel;

interface EventDispatcherLike {
  invoke(data: unknown): Promise<unknown>;
}

export class FeishuAppRuntime {
  private readonly wsChannel: LarkChannel | undefined;
  private readonly eventsHttpChannel: LarkChannel | undefined;
  private readonly callbacksHttpChannel: LarkChannel | undefined;
  private readonly outboundChannel: LarkChannel;
  private readonly channels: LarkChannel[];
  private readonly oauth: FeishuOAuthService | undefined;
  readonly approvals: ApprovalCoordinator;
  private readonly router: BindingRouter;
  private readonly bindings = new Map<string, AppAgentBindingRuntime>();
  private readonly bindingByAgent = new Map<string, AppAgentBindingRuntime>();
  private readonly logger: Logger;
  private readonly dedupe = new DedupeWindow(15 * 60_000, 50_000);
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;
  private acceptingMessages = false;
  private startedAt?: number;
  private lastMessageAt?: number;
  private lastError?: string;

  constructor(
    readonly config: LoadedFeishuApp,
    bindingDefinitions: LoadedAppAgentBinding[],
    rootLogger: Logger,
    private readonly metrics: MetricsRegistry,
    globalSemaphore: Semaphore,
    modelBroker: HostModelBroker,
    runtimeOptions: {
      adminOpenIds?: string[];
      approvalTtlMs?: number;
      workerStartLimiter?: WorkerStartLimiter;
      residentCoordinator?: ResidentRuntimeCoordinator;
      sessionIndex?: PersistentSessionIndex;
      approvalStore?: ToolApprovalStore;
      channelFactory?: FeishuChannelFactory;
    } = {},
  ) {
    if (bindingDefinitions.some((binding) => binding.app !== config.id)) {
      throw new Error(`AppRuntime ${config.id} received a foreign binding.`);
    }
    this.logger = rootLogger.child({ appKey: config.id });
    this.router = new BindingRouter(bindingDefinitions);
    const channelFactory = runtimeOptions.channelFactory ??
      ((transport: 'websocket' | 'http') => this.createChannel(transport, bindingDefinitions));
    this.wsChannel =
      config.events.transport === 'websocket'
        ? channelFactory('websocket', config, bindingDefinitions)
        : undefined;
    this.eventsHttpChannel =
      config.events.transport === 'http'
        ? channelFactory('http', config, bindingDefinitions)
        : undefined;
    this.callbacksHttpChannel =
      config.callbacks.transport === 'http'
        ? channelFactory('http', config, bindingDefinitions)
        : undefined;
    this.channels = uniqueChannels([
      this.wsChannel,
      this.eventsHttpChannel,
      this.callbacksHttpChannel,
    ]);
    const outbound =
      this.wsChannel ?? this.eventsHttpChannel ?? this.callbacksHttpChannel;
    if (!outbound) throw new Error(`App ${config.id} has no enabled transport.`);
    this.outboundChannel = outbound;
    this.approvals = new ApprovalCoordinator(
      this.outboundChannel,
      new Set(runtimeOptions.adminOpenIds ?? []),
      runtimeOptions.approvalTtlMs ?? 5 * 60_000,
      runtimeOptions.approvalStore,
    );

    const defaultBinding = bindingDefinitions.find((binding) => binding.route.default);
    if (!defaultBinding) throw new Error(`App ${config.id} has no default binding.`);
    const oauthConfig = resolveBindingConfig(defaultBinding);
    this.oauth = config.oauth.enabled ? new FeishuOAuthService(oauthConfig) : undefined;
    for (const binding of bindingDefinitions) {
      const resolved = resolveBindingConfig(binding);
      const runtime = new AppAgentBindingRuntime(
        resolved,
        this.outboundChannel,
        this.oauth,
        this.logger,
        metrics,
        globalSemaphore,
        modelBroker,
        this.approvals,
        {
          ...(runtimeOptions.workerStartLimiter
            ? { workerStartLimiter: runtimeOptions.workerStartLimiter }
            : {}),
          ...(runtimeOptions.residentCoordinator
            ? { residentCoordinator: runtimeOptions.residentCoordinator }
            : {}),
          ...(runtimeOptions.sessionIndex
            ? { sessionIndex: runtimeOptions.sessionIndex }
            : {}),
        },
      );
      this.bindings.set(binding.id, runtime);
      this.bindingByAgent.set(binding.agent, runtime);
    }
    this.attachHandlers();
  }

  get id(): string {
    return this.config.id;
  }

  get eventsHttpPath(): string | undefined {
    return this.config.events.transport === 'http' ? this.config.events.path : undefined;
  }

  get callbacksHttpPath(): string | undefined {
    return this.config.callbacks.transport === 'http'
      ? this.config.callbacks.path
      : undefined;
  }

  get oauthRedirectPath(): string | undefined {
    return this.oauth ? this.config.oauth.redirectPath : undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await Promise.all([...this.bindings.values()].map((binding) => binding.prepare()));
    this.acceptingMessages = true;
    for (const binding of this.bindings.values()) binding.start();
    try {
      for (const channel of this.channels) await channel.connect();
      this.started = true;
      this.startedAt = Date.now();
    } catch (error) {
      this.acceptingMessages = false;
      this.lastError = errorText(error);
      await Promise.allSettled(
        [...this.bindings.values()].map((binding) => binding.stop()),
      );
      await Promise.allSettled(this.channels.map((channel) => channel.disconnect()));
      throw error;
    }
    this.metrics.setGauge(
      'feishu_app_up',
      'Whether a configured Feishu AppRuntime is active.',
      { app: this.config.id },
      1,
    );
    this.logger.info('Feishu AppRuntime connected', {
      botName: this.outboundChannel.botIdentity?.name,
      botOpenId: this.outboundChannel.botIdentity?.openId,
      eventsTransport: this.config.events.transport,
      callbacksTransport: this.config.callbacks.transport,
      bindingCount: this.bindings.size,
    });
  }

  async stop(): Promise<void> {
    this.acceptingMessages = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.allSettled(
      [...this.bindings.values()].map((binding) => binding.stop()),
    );
    await Promise.allSettled(this.channels.map((channel) => channel.disconnect()));
    this.approvals.stop();
    this.started = false;
    this.metrics.setGauge(
      'feishu_app_up',
      'Whether a configured Feishu AppRuntime is active.',
      { app: this.config.id },
      0,
    );
    this.logger.info('Feishu AppRuntime stopped');
  }

  snapshot(): FeishuAppRuntimeSnapshot {
    const bindings = [...this.bindings.values()]
      .map((binding) => binding.snapshot())
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      id: this.config.id,
      appIdSuffix: this.config.appId.slice(-6),
      eventsTransport: this.config.events.transport,
      callbacksTransport: this.config.callbacks.transport,
      ...(this.eventsHttpPath ? { eventsPath: this.eventsHttpPath } : {}),
      ...(this.callbacksHttpPath ? { callbacksPath: this.callbacksHttpPath } : {}),
      domain: this.config.domain,
      started: this.started,
      ready: this.started && bindings.every((binding) => binding.ready),
      acceptingMessages: this.acceptingMessages,
      ...(this.outboundChannel.botIdentity?.name
        ? { botName: this.outboundChannel.botIdentity.name }
        : {}),
      ...(this.outboundChannel.botIdentity?.openId
        ? { botOpenId: this.outboundChannel.botIdentity.openId }
        : {}),
      oauthEnabled: Boolean(this.oauth),
      bindingCount: bindings.length,
      residentSessions: bindings.reduce(
        (total, binding) => total + binding.residentSessions,
        0,
      ),
      pendingApprovals: this.approvals.list().length,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.lastMessageAt ? { lastMessageAt: this.lastMessageAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      bindings,
    };
  }

  listBindings(): AppAgentBindingRuntime[] {
    return [...this.bindings.values()];
  }

  async listSessions(): Promise<SessionStatus[]> {
    const results = await Promise.all(
      [...this.bindings.values()].map((binding) => binding.listSessions()),
    );
    return results.flat().sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  resetConversation(conversationKey: string): Promise<void> {
    return this.bindingForConversation(conversationKey).resetConversation(conversationKey);
  }

  abortConversation(conversationKey: string): Promise<boolean> {
    return this.bindingForConversation(conversationKey).abortConversation(conversationKey);
  }

  resolveAdminApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    operator: string,
  ): Promise<boolean> {
    return this.approvals.resolveFromTrustedAdmin(approvalId, decision, operator);
  }

  async maintenance(): Promise<void> {
    await Promise.all([
      ...[...this.bindings.values()].map((binding) => binding.maintenance()),
      this.oauth?.states.purgeExpired() ?? Promise.resolve(0),
    ]);
    this.dedupe.prune();
  }

  updatePolicy(policy: {
    groupAllowlist?: string[];
    dmAllowlist?: string[];
    requireMention?: boolean;
    dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
    respondToMentionAll?: boolean;
  }): void {
    for (const channel of this.channels) channel.updatePolicy(policy);
  }

  async invokeHttp(
    kind: HttpIngressKind,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<unknown> {
    const channel =
      kind === 'events' ? this.eventsHttpChannel : this.callbacksHttpChannel;
    if (!channel) throw new Error(`App ${this.config.id} has no HTTP ${kind} ingress.`);
    if (!this.started) throw new Error(`App ${this.config.id} is not started.`);
    if (isPlainChallenge(body)) {
      const token = typeof body.token === 'string' ? body.token : '';
      if (
        this.config.verificationToken &&
        !secureEqual(token, this.config.verificationToken)
      ) {
        throw new Error('Feishu HTTP challenge token mismatch.');
      }
      return { challenge: body.challenge };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Feishu HTTP body must be a JSON object.');
    }
    const payload = body as Record<string, unknown>;
    for (const reserved of ['headers', '__proto__', 'constructor', 'prototype']) {
      if (Object.hasOwn(payload, reserved)) {
        throw new Error(`Feishu HTTP body contains reserved property "${reserved}".`);
      }
    }
    const assigned = Object.assign(Object.create(null) as Record<string, unknown>, payload);
    Object.defineProperty(assigned, 'headers', {
      value: Object.freeze(normalizeHeaders(headers)),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return await channelDispatcher(channel).invoke(assigned);
  }

  async createOAuthAuthorizationUrl(
    userId: string,
    returnTo?: string,
  ): Promise<string> {
    if (!this.oauth) throw new Error(`OAuth is disabled for app ${this.config.id}.`);
    return await this.oauth.createAuthorizationUrl(userId, returnTo);
  }

  async handleOAuthCallback(
    code: string,
    state: string,
  ): Promise<{ userId: string; returnTo?: string }> {
    if (!this.oauth) throw new Error(`OAuth is disabled for app ${this.config.id}.`);
    return await this.oauth.handleCallback(code, state);
  }

  async createAdminSsoAuthorizationUrl(returnTo = '/admin'): Promise<string> {
    if (!this.oauth) throw new Error(`OAuth is disabled for app ${this.config.id}.`);
    return await this.oauth.createAdminAuthorizationUrl(returnTo);
  }

  async handleAdminSsoCallback(
    code: string,
    state: string,
  ): Promise<{ openId: string; returnTo?: string }> {
    if (!this.oauth) throw new Error(`OAuth is disabled for app ${this.config.id}.`);
    return await this.oauth.handleAdminCallback(code, state);
  }

  private createChannel(
    transport: 'websocket' | 'http',
    bindings: LoadedAppAgentBinding[],
  ): LarkChannel {
    const workspaceRoots = [
      ...new Set(bindings.map((binding) => binding.agentDefinition.workspace.root)),
    ];
    return createLarkChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      transport: transport === 'http' ? 'webhook' : 'websocket',
      ...(transport === 'http'
        ? {
            webhook: {
              ...(this.config.verificationToken
                ? { verificationToken: this.config.verificationToken }
                : {}),
              ...(this.config.encryptKey ? { encryptKey: this.config.encryptKey } : {}),
            },
          }
        : {}),
      loggerLevel: LoggerLevel.info,
      source: 'feishu-agent-platform/0.1.0',
      includeRawInMessage: true,
      policy: { ...this.config.policy },
      safety: { chatQueue: { enabled: false } },
      outbound: {
        streamInitialText: '思考中…',
        streamMaxElementChars: 30_000,
        allowedFileDirs: workspaceRoots,
        retry: { maxAttempts: 3, baseDelayMs: 500 },
      },
    });
  }

  private attachHandlers(): void {
    if (this.wsChannel) this.attachEventHandlers(this.wsChannel, 'websocket');
    if (this.eventsHttpChannel) this.attachEventHandlers(this.eventsHttpChannel, 'http');
    if (this.callbacksHttpChannel) {
      this.unsubscribers.push(
        this.callbacksHttpChannel.on('cardAction', (async (event: CardActionEvent) => {
          const dedupeId = cardActionDedupeId(event);
          const dedupeKey = `card:${dedupeId}`;
          if (!this.dedupe.accept(dedupeKey)) {
            return { toast: { type: 'info', content: '该操作已处理' } };
          }
          try {
            return await this.handleCardAction(event);
          } catch (error) {
            this.dedupe.forget(dedupeKey);
            throw error;
          }
        }) as never),
      );
    }
    for (const channel of this.channels) {
      this.unsubscribers.push(
        channel.on('error', (error: unknown) => {
          this.lastError = errorText(error);
          this.metrics.increment(
            'feishu_app_channel_errors_total',
            'Inbound Feishu Channel errors.',
            { app: this.config.id },
          );
          this.logger.error('Feishu channel inbound error', errorFields(error));
        }),
        channel.on('reconnecting', () => this.logger.warn('Feishu WebSocket reconnecting')),
        channel.on('reconnected', () => this.logger.info('Feishu WebSocket reconnected')),
      );
    }
  }

  private attachEventHandlers(
    channel: LarkChannel,
    ingress: 'websocket' | 'http',
  ): void {
    this.unsubscribers.push(
      channel.on('message', (message: NormalizedMessage) => {
        if (!this.acceptingMessages) return;
        if (!this.dedupe.accept(`message:${message.messageId}`)) return;
        this.lastMessageAt = Date.now();
        try {
          const matched = this.router.resolve(message);
          const binding = this.bindings.get(matched.binding.id);
          if (!binding?.ready) {
            throw new Error(`Agent binding ${matched.binding.id} is not ready.`);
          }
          binding.enqueue(matched.message, ingress);
        } catch (error) {
          this.lastError = errorText(error);
          this.logger.error('Feishu binding route failed', {
            messageId: message.messageId,
            ...errorFields(error),
          });
          void this.replyRouteFailure(message, error);
        }
      }),
      channel.on(
        'reject',
        (event: { reason: string; chatId?: string; senderId?: string }) => {
          this.metrics.increment(
            'feishu_app_messages_rejected_total',
            'Feishu messages rejected by App policy.',
            { app: this.config.id, reason: event.reason },
          );
        },
      ),
    );
  }

  private async handleCardAction(event: CardActionEvent): Promise<unknown> {
    const approvalResult = await this.approvals.handleCardAction(event);
    if (approvalResult !== undefined) return approvalResult;
    const value =
      event.action.value && typeof event.action.value === 'object'
        ? (event.action.value as Record<string, unknown>)
        : {};
    const action = typeof value.action === 'string' ? value.action : '';
    const conversationKey =
      typeof value.conversationKey === 'string' ? value.conversationKey : '';
    if (!conversationKey) return { toast: { type: 'info', content: '未识别的操作' } };
    return await this.bindingForConversation(conversationKey, event.chatId).handleCardAction(
      action,
      conversationKey,
      event.chatId,
    );
  }

  private bindingForConversation(
    conversationKey: string,
    chatId?: string,
  ): AppAgentBindingRuntime {
    const address = parseConversationKey(conversationKey);
    if (address.appKey !== this.config.id || (chatId && address.chatId !== chatId)) {
      throw new Error('Conversation key does not belong to this App/chat.');
    }
    const binding = this.bindingByAgent.get(address.agentId);
    if (!binding || !binding.ownsConversation(conversationKey, chatId)) {
      throw new Error('Conversation key refers to an unavailable Agent binding.');
    }
    return binding;
  }

  private async replyRouteFailure(
    message: NormalizedMessage,
    error: unknown,
  ): Promise<void> {
    const markdown =
      error instanceof AmbiguousBindingRouteError
        ? '当前消息同时匹配多个 Agent，请使用更明确的命令前缀。'
        : '无法为当前消息选择 Agent，请检查 Binding 配置。';
    await this.outboundChannel
      .send(
        message.chatId,
        { markdown },
        {
          replyTo: message.messageId,
          replyInThread: shouldReplyInThread(message),
        },
      )
      .catch((replyError: unknown) => {
        this.logger.error('Failed to send route error reply', errorFields(replyError));
      });
  }
}

function channelDispatcher(channel: LarkChannel): EventDispatcherLike {
  const candidate = channel as unknown as {
    dispatcher?: EventDispatcherLike;
    eventDispatcher?: EventDispatcherLike;
  };
  const dispatcher = candidate.dispatcher ?? candidate.eventDispatcher;
  if (!dispatcher?.invoke) {
    throw new Error('The pinned Lark Channel HTTP dispatcher is unavailable.');
  }
  return dispatcher;
}

function isPlainChallenge(
  body: unknown,
): body is { challenge: string; token?: string } {
  return (
    Boolean(body) &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>).challenge === 'string' &&
    !('encrypt' in (body as Record<string, unknown>))
  );
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(
        (entry): entry is [string, string | string[]] => entry[1] !== undefined,
      )
      .map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(',') : value,
      ]),
  );
}

function uniqueChannels(values: Array<LarkChannel | undefined>): LarkChannel[] {
  return [...new Set(values.filter((value): value is LarkChannel => Boolean(value)))];
}

export function cardActionDedupeId(event: CardActionEvent): string {
  const value = event as unknown as Record<string, unknown>;
  const eventId = [value.eventId, value.token, value.openMessageId]
    .find((item) => typeof item === 'string' && item);
  return [
    typeof eventId === 'string' ? eventId : '',
    event.messageId,
    event.chatId,
    event.operator.openId,
    event.action.tag,
    event.action.name ?? '',
    event.action.option ?? '',
    JSON.stringify(event.action.value ?? {}),
  ].join(':');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

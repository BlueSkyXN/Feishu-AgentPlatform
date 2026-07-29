import { createHash, randomBytes } from 'node:crypto';

import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';

import type { ToolApproval, ToolEffect } from '../config/types.js';
import type { ToolApprovalStore } from '../storage/approval-store.js';

export interface ApprovalRequest {
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  chatId: string;
  messageId: string;
  replyInThread: boolean;
  requesterOpenId: string;
  operation: string;
  effect: ToolEffect;
  approval: ToolApproval;
  arguments: unknown;
}

interface PendingApproval extends ApprovalRequest {
  id: string;
  argumentsHash: string;
  expiresAt: number;
  cardMessageId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalSnapshot {
  id: string;
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  chatId: string;
  messageId: string;
  requesterOpenId: string;
  operation: string;
  effect: ToolEffect;
  approval: ToolApproval;
  argumentsHash: string;
  expiresAt: number;
}

/** One-time in-flight approval coordinator. Durable audit is supplied by the platform store. */
export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly channel: Pick<LarkChannel, 'send' | 'updateCard'>,
    private readonly adminOpenIds: ReadonlySet<string>,
    private readonly ttlMs = 5 * 60_000,
    private readonly store?: ToolApprovalStore,
  ) {}

  async request(input: ApprovalRequest, signal?: AbortSignal): Promise<void> {
    if (input.approval === 'never' || input.effect === 'read') return;
    if (input.approval === 'admin' && this.adminOpenIds.size === 0) {
      throw new Error('High-risk operation requires at least one configured administrator.');
    }
    if (signal?.aborted) throw abortError('Tool approval was aborted.');

    const id = randomBytes(24).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlMs;
    const argumentsHash = hashArguments(input.arguments);
    this.store?.create({
      id,
      appKey: input.appKey,
      agentId: input.agentId,
      bindingId: input.bindingId,
      conversationKey: input.conversationKey,
      chatId: input.chatId,
      messageId: input.messageId,
      requesterOpenId: input.requesterOpenId,
      operation: input.operation,
      effect: input.effect,
      approval: input.approval,
      argumentsHash,
      createdAt,
      expiresAt,
    });
    let cleanupAbort: (() => void) | undefined;
    const approved = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (current) {
          this.pending.delete(id);
          try {
            this.store?.resolve(id, 'expired', undefined, Date.now());
          } catch {
            // The in-memory tool call must still finish when durable audit storage is unavailable.
          } finally {
            current.reject(new Error('Tool approval expired.'));
          }
        }
      }, this.ttlMs);
      this.pending.set(id, {
        ...input,
        id,
        argumentsHash,
        expiresAt,
        resolve,
        reject,
        timer,
      });
      const abort = (): void => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        clearTimeout(current.timer);
        try {
          this.store?.resolve(id, 'aborted', undefined, Date.now());
        } catch {
          // Abort remains authoritative even if its audit update cannot be persisted.
        } finally {
          current.reject(abortError('Tool approval was aborted.'));
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      cleanupAbort = () => signal?.removeEventListener('abort', abort);
    });

    try {
      const result = await this.channel.send(input.chatId, {
        card: approvalCard(id, input, expiresAt),
      }, {
        replyTo: input.messageId,
        replyInThread: input.replyInThread,
      });
      const current = this.pending.get(id);
      if (current) current.cardMessageId = result.messageId;
      await approved;
    } catch (error) {
      const current = this.pending.get(id);
      if (current) {
        this.pending.delete(id);
        clearTimeout(current.timer);
        try {
          this.store?.resolve(id, 'aborted', undefined, Date.now());
        } catch {
          // Preserve the original send/handler failure while completing local cleanup.
        } finally {
          current.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      await approved.catch(() => undefined);
      throw error;
    } finally {
      cleanupAbort?.();
    }
  }

  async handleCardAction(event: CardActionEvent): Promise<unknown | undefined> {
    const value = objectValue(event.action.value);
    if (value?.action !== 'tool_approval') return undefined;
    const approvalId = typeof value.approvalId === 'string' ? value.approvalId : '';
    const decision = value.decision === 'approve' || value.decision === 'deny'
      ? value.decision
      : undefined;
    if (!approvalId || !decision) {
      return { toast: { type: 'error', content: '审批参数无效' } };
    }
    const pending = this.pending.get(approvalId);
    if (!pending) return { toast: { type: 'info', content: '审批已处理或已过期' } };
    if (pending.chatId !== event.chatId) {
      return { toast: { type: 'error', content: '审批不属于当前会话' } };
    }
    const operator = event.operator.openId;
    const allowed = pending.approval === 'admin'
      ? this.adminOpenIds.has(operator)
      : operator === pending.requesterOpenId;
    if (!allowed) return { toast: { type: 'error', content: '你没有审批该操作的权限' } };
    if (!await this.resolvePending(pending, decision, operator)) {
      return { toast: { type: 'info', content: '审批已处理或已过期' } };
    }
    return {
      toast: {
        type: decision === 'approve' ? 'success' : 'info',
        content: decision === 'approve' ? '已批准操作' : '已拒绝操作',
      },
    };
  }

  async resolveFromTrustedAdmin(
    approvalId: string,
    decision: 'approve' | 'deny',
    operator: string,
  ): Promise<boolean> {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.approval !== 'admin') return false;
    return await this.resolvePending(pending, decision, operator);
  }

  list(): ApprovalSnapshot[] {
    return [...this.pending.values()]
      .map(({ resolve: _resolve, reject: _reject, timer: _timer, cardMessageId: _card, arguments: _arguments, ...value }) => value)
      .sort((left, right) => left.expiresAt - right.expiresAt);
  }

  stop(): void {
    const pendingApprovals = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingApprovals) {
      clearTimeout(pending.timer);
      try {
        this.store?.resolve(pending.id, 'aborted', undefined, Date.now());
      } catch {
        // Shutdown cannot leave an in-memory approval promise unresolved.
      } finally {
        pending.reject(new Error('Approval coordinator stopped.'));
      }
    }
  }

  private async resolvePending(
    pending: PendingApproval,
    decision: 'approve' | 'deny',
    operator: string,
  ): Promise<boolean> {
    const resolved = this.store?.resolve(
        pending.id,
        decision === 'approve' ? 'approved' : 'denied',
        operator,
        Date.now(),
      ) ?? true;
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    if (!resolved) {
      pending.reject(new Error('Tool approval expired or was already consumed.'));
      return false;
    }
    if (decision === 'approve') pending.resolve();
    else pending.reject(new Error('Tool operation was denied by the approver.'));
    if (pending.cardMessageId) {
      await this.channel.updateCard(
        pending.cardMessageId,
        resolvedCard(pending.operation, decision, operator),
      ).catch(() => undefined);
    }
    return true;
  }
}

function approvalCard(
  id: string,
  input: ApprovalRequest,
  expiresAt: number,
): object {
  const approver = input.approval === 'admin' ? '平台管理员' : '本次请求发送者';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Agent 工具操作审批' },
      template: input.effect === 'high-risk-write' ? 'red' : 'orange',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**操作：** \`${escapeMarkdown(input.operation)}\``,
            `**级别：** \`${input.effect}\``,
            `**审批人：** ${approver}`,
            `**参数摘要：** \`${escapeMarkdown(argumentSummary(input.arguments))}\``,
            `**到期：** ${new Date(expiresAt).toISOString()}`,
          ].join('\n'),
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '批准' },
              type: 'primary',
              value: { action: 'tool_approval', approvalId: id, decision: 'approve' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '拒绝' },
              type: 'default',
              value: { action: 'tool_approval', approvalId: id, decision: 'deny' },
            },
          ],
        },
      ],
    },
  };
}

function resolvedCard(operation: string, decision: 'approve' | 'deny', operator: string): object {
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: decision === 'approve' ? '操作已批准' : '操作已拒绝' },
      template: decision === 'approve' ? 'green' : 'grey',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `\`${escapeMarkdown(operation)}\` 已由 \`${escapeMarkdown(operator)}\` ${decision === 'approve' ? '批准' : '拒绝'}。`,
      }],
    },
  };
}

function argumentSummary(value: unknown): string {
  const text = JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'string' && nested.length > 160) return `${nested.slice(0, 160)}…`;
    return nested;
  }) ?? 'null';
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

function hashArguments(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[`\\]/gu, '\\$&');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

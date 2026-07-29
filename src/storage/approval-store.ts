import type { ToolApproval, ToolEffect } from '../config/types.js';
import {
  PlatformDatabase,
  nullableStringColumn,
  numberColumn,
  stringColumn,
} from './database.js';

export type StoredApprovalState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'aborted';

export interface StoredToolApproval {
  id: string;
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  chatId: string;
  messageId: string;
  requesterOpenId: string;
  operation: string;
  effect: Exclude<ToolEffect, 'read'>;
  approval: Exclude<ToolApproval, 'never'>;
  argumentsHash: string;
  state: StoredApprovalState;
  approverOpenId?: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
}

export class ToolApprovalStore {
  constructor(private readonly database: PlatformDatabase) {
    this.expirePending();
  }

  create(input: Omit<StoredToolApproval, 'state'>): StoredToolApproval {
    const record: StoredToolApproval = { ...input, state: 'pending' };
    validate(record);
    this.database.run(
      `INSERT INTO tool_approvals
        (id, app_key, agent_id, binding_id, conversation_key, chat_id, message_id,
         requester_open_id, operation, effect, approval, arguments_hash, state,
         approver_open_id, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      record.id,
      record.appKey,
      record.agentId,
      record.bindingId,
      record.conversationKey,
      record.chatId,
      record.messageId,
      record.requesterOpenId,
      record.operation,
      record.effect,
      record.approval,
      record.argumentsHash,
      record.createdAt,
      record.expiresAt,
    );
    return structuredClone(record);
  }

  resolve(
    id: string,
    state: Exclude<StoredApprovalState, 'pending'>,
    approverOpenId?: string,
    now = Date.now(),
  ): boolean {
    if (state === 'expired') {
      return this.database.run(
        `UPDATE tool_approvals
         SET state = 'expired', approver_open_id = NULL, resolved_at = ?
         WHERE id = ? AND state = 'pending' AND expires_at <= ?`,
        now,
        id,
        now,
      ).changes === 1;
    }

    this.expirePending(now);
    const result = this.database.run(
      `UPDATE tool_approvals
       SET state = ?, approver_open_id = ?, resolved_at = ?
       WHERE id = ? AND state = 'pending' AND expires_at > ?`,
      state,
      approverOpenId ?? null,
      now,
      id,
      now,
    );
    return result.changes === 1;
  }

  expirePending(now = Date.now()): number {
    return this.database.run(
      `UPDATE tool_approvals
       SET state = 'expired', resolved_at = ?
       WHERE state = 'pending' AND expires_at <= ?`,
      now,
      now,
    ).changes;
  }

  get(id: string): StoredToolApproval | undefined {
    this.expirePending();
    const row = this.database.get(
      'SELECT * FROM tool_approvals WHERE id = ?',
      id,
    );
    return row ? recordFromRow(row) : undefined;
  }

  list(input: { state?: StoredApprovalState; limit?: number } = {}): StoredToolApproval[] {
    this.expirePending();
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('approval limit must be an integer between 1 and 500.');
    }
    const rows = input.state
      ? this.database.all(
          'SELECT * FROM tool_approvals WHERE state = ? ORDER BY created_at DESC LIMIT ?',
          input.state,
          limit,
        )
      : this.database.all(
          'SELECT * FROM tool_approvals ORDER BY created_at DESC LIMIT ?',
          limit,
        );
    return rows.map(recordFromRow);
  }
}

function recordFromRow(
  row: Record<string, import('node:sqlite').SQLOutputValue>,
): StoredToolApproval {
  const approverOpenId = nullableStringColumn(row, 'approver_open_id');
  const resolvedAt = row.resolved_at === null ? undefined : numberColumn(row, 'resolved_at');
  return {
    id: stringColumn(row, 'id'),
    appKey: stringColumn(row, 'app_key'),
    agentId: stringColumn(row, 'agent_id'),
    bindingId: stringColumn(row, 'binding_id'),
    conversationKey: stringColumn(row, 'conversation_key'),
    chatId: stringColumn(row, 'chat_id'),
    messageId: stringColumn(row, 'message_id'),
    requesterOpenId: stringColumn(row, 'requester_open_id'),
    operation: stringColumn(row, 'operation'),
    effect: stringColumn(row, 'effect') as StoredToolApproval['effect'],
    approval: stringColumn(row, 'approval') as StoredToolApproval['approval'],
    argumentsHash: stringColumn(row, 'arguments_hash'),
    state: stringColumn(row, 'state') as StoredApprovalState,
    ...(approverOpenId ? { approverOpenId } : {}),
    createdAt: numberColumn(row, 'created_at'),
    expiresAt: numberColumn(row, 'expires_at'),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  };
}

function validate(record: StoredToolApproval): void {
  for (const value of [
    record.id,
    record.appKey,
    record.agentId,
    record.bindingId,
    record.conversationKey,
    record.chatId,
    record.messageId,
    record.requesterOpenId,
    record.operation,
    record.argumentsHash,
  ]) {
    if (!value.trim() || value.length > 4_096 || value.includes('\u0000')) {
      throw new Error('Approval field is invalid.');
    }
  }
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)) {
    throw new Error('Approval timestamps are invalid.');
  }
  if (record.expiresAt <= record.createdAt) throw new Error('Approval expiry must follow creation.');
}

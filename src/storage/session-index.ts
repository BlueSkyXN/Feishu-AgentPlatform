import type { SQLInputValue } from 'node:sqlite';
import { isAbsolute, resolve } from 'node:path';

import {
  conversationStorageId,
  parseConversationKey,
} from '../core/conversation.js';

import {
  PlatformDatabase,
  numberColumn,
  stringColumn,
} from './database.js';

export interface PersistentSessionRecord {
  storageId: string;
  conversationKey: string;
  appKey: string;
  agentId: string;
  bindingId: string;
  chatId: string;
  workspacePath: string;
  sessionPath: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface SessionIndexQuery {
  appKey?: string;
  agentId?: string;
  bindingId?: string;
  beforeLastUsedAt?: number;
  limit?: number;
}

export class PersistentSessionIndex {
  constructor(private readonly database: PlatformDatabase) {}

  touch(record: PersistentSessionRecord): void {
    validateRecord(record);
    this.database.run(
      `INSERT INTO conversation_sessions
        (storage_id, conversation_key, app_key, agent_id, binding_id, chat_id,
         workspace_path, session_path, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(storage_id) DO UPDATE SET
         conversation_key = excluded.conversation_key,
         app_key = excluded.app_key,
         agent_id = excluded.agent_id,
         binding_id = excluded.binding_id,
         chat_id = excluded.chat_id,
         workspace_path = excluded.workspace_path,
         session_path = excluded.session_path,
         last_used_at = excluded.last_used_at`,
      record.storageId,
      record.conversationKey,
      record.appKey,
      record.agentId,
      record.bindingId,
      record.chatId,
      record.workspacePath,
      record.sessionPath,
      record.createdAt,
      record.lastUsedAt,
    );
  }

  remove(storageId: string): boolean {
    return this.database.run(
      'DELETE FROM conversation_sessions WHERE storage_id = ?',
      requiredText(storageId, 'storageId'),
    ).changes > 0;
  }

  get(storageId: string): PersistentSessionRecord | undefined {
    const row = this.database.get(
      'SELECT * FROM conversation_sessions WHERE storage_id = ?',
      requiredText(storageId, 'storageId'),
    );
    return row ? recordFromRow(row) : undefined;
  }

  list(query: SessionIndexQuery = {}): PersistentSessionRecord[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [column, value] of [
      ['app_key', query.appKey],
      ['agent_id', query.agentId],
      ['binding_id', query.bindingId],
    ] as const) {
      if (!value) continue;
      conditions.push(`${column} = ?`);
      values.push(requiredText(value, column));
    }
    if (query.beforeLastUsedAt !== undefined) {
      conditions.push('last_used_at < ?');
      values.push(boundedTimestamp(query.beforeLastUsedAt, 'beforeLastUsedAt'));
    }
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('session index limit must be an integer between 1 and 1000.');
    }
    values.push(limit);
    return this.database.all(
      `SELECT * FROM conversation_sessions
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY last_used_at DESC, storage_id
       LIMIT ?`,
      ...values,
    ).map(recordFromRow);
  }

  count(): number {
    return numberColumn(
      this.database.get('SELECT COUNT(*) AS count FROM conversation_sessions'),
      'count',
    );
  }
}

function recordFromRow(
  row: Record<string, import('node:sqlite').SQLOutputValue>,
): PersistentSessionRecord {
  const record = {
    storageId: stringColumn(row, 'storage_id'),
    conversationKey: stringColumn(row, 'conversation_key'),
    appKey: stringColumn(row, 'app_key'),
    agentId: stringColumn(row, 'agent_id'),
    bindingId: stringColumn(row, 'binding_id'),
    chatId: stringColumn(row, 'chat_id'),
    workspacePath: stringColumn(row, 'workspace_path'),
    sessionPath: stringColumn(row, 'session_path'),
    createdAt: numberColumn(row, 'created_at'),
    lastUsedAt: numberColumn(row, 'last_used_at'),
  };
  validateRecord(record);
  return record;
}

function validateRecord(record: PersistentSessionRecord): void {
  for (const [label, value] of Object.entries({
    storageId: record.storageId,
    conversationKey: record.conversationKey,
    appKey: record.appKey,
    agentId: record.agentId,
    bindingId: record.bindingId,
    chatId: record.chatId,
    workspacePath: record.workspacePath,
    sessionPath: record.sessionPath,
  })) requiredText(value, label);
  const address = parseConversationKey(record.conversationKey);
  if (
    conversationStorageId(record.conversationKey) !== record.storageId ||
    address.appKey !== record.appKey ||
    address.agentId !== record.agentId ||
    address.chatId !== record.chatId
  ) {
    throw new Error('Session index identity does not match its conversation key.');
  }
  for (const [label, path] of [
    ['workspacePath', record.workspacePath],
    ['sessionPath', record.sessionPath],
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
    const normalized = resolve(path);
    const expected = resolve(
      normalized,
      '..',
      '..',
      '..',
      record.appKey,
      record.agentId,
      record.storageId,
    );
    if (expected !== normalized) {
      throw new Error(`${label} does not match the Session namespace.`);
    }
  }
  boundedTimestamp(record.createdAt, 'createdAt');
  boundedTimestamp(record.lastUsedAt, 'lastUsedAt');
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096 || normalized.includes('\u0000')) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function boundedTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a timestamp.`);
  return value;
}

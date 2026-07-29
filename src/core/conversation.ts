import { createHash } from 'node:crypto';

export interface ConversationMessage {
  chatId: string;
  threadId?: string;
  rootId?: string;
}

export type ConversationScope = 'chat' | 'thread';

export interface ConversationAddress {
  appKey: string;
  agentId: string;
  tenantKey: string;
  chatId: string;
  topicKey: string;
}

const PREFIX = 'v2';

export function buildConversationKey(
  appKey: string,
  agentId: string,
  tenantKey: string | undefined,
  message: ConversationMessage,
  scope: ConversationScope,
): string {
  const topicKey =
    scope === 'thread' ? (message.threadId ?? message.rootId ?? 'main') : 'main';
  return [
    PREFIX,
    appKey,
    agentId,
    tenantKey?.trim() || 'unknown',
    message.chatId,
    topicKey,
  ]
    .map(encodeSegment)
    .join(':');
}

export function parseConversationKey(value: string): ConversationAddress {
  const parts = value.split(':').map(decodeSegment);
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    throw new Error('Invalid conversation key.');
  }
  const [, appKey, agentId, tenantKey, chatId, topicKey] = parts;
  if (!appKey || !agentId || !tenantKey || !chatId || !topicKey) {
    throw new Error('Invalid conversation key.');
  }
  return { appKey, agentId, tenantKey, chatId, topicKey };
}

export function conversationBelongsTo(
  conversationKey: string,
  appKey: string,
  agentId: string,
  chatId?: string,
): boolean {
  try {
    const address = parseConversationKey(conversationKey);
    return (
      address.appKey === appKey &&
      address.agentId === agentId &&
      (!chatId || address.chatId === chatId)
    );
  } catch {
    return false;
  }
}

export function shouldReplyInThread(message: ConversationMessage): boolean {
  return Boolean(message.threadId ?? message.rootId);
}

export function conversationStorageId(conversationKey: string): string {
  return createHash('sha256').update(conversationKey).digest('hex').slice(0, 32);
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid conversation key encoding.');
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!decoded || encodeSegment(decoded) !== value) {
      throw new Error('Invalid conversation key encoding.');
    }
    return decoded;
  } catch {
    throw new Error('Invalid conversation key encoding.');
  }
}

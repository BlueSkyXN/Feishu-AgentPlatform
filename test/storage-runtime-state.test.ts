import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConversationKey,
  conversationStorageId,
} from '../src/core/conversation.js';
import { ToolApprovalStore } from '../src/storage/approval-store.js';
import { PlatformDatabase } from '../src/storage/database.js';
import { PersistentSessionIndex } from '../src/storage/session-index.js';

test('persistent session index holds 10,000 metadata-only sessions with scoped pagination', () => {
  const database = new PlatformDatabase(':memory:');
  const index = new PersistentSessionIndex(database);
  try {
    database.transaction(() => {
      for (let value = 0; value < 10_000; value += 1) {
        const appKey = `app-${value % 20}`;
        const agentId = `agent-${value % 50}`;
        const chatId = `chat-${value}`;
        const conversationKey = buildConversationKey(
          appKey,
          agentId,
          'tenant',
          { chatId },
          'thread',
        );
        const storageId = conversationStorageId(conversationKey);
        index.touch({
          storageId,
          conversationKey,
          appKey,
          agentId,
          bindingId: `binding-${value % 100}`,
          chatId,
          workspacePath: `/data/workspaces/${appKey}/${agentId}/${storageId}`,
          sessionPath: `/data/sessions/${appKey}/${agentId}/${storageId}`,
          createdAt: value,
          lastUsedAt: value,
        });
      }
    });
    assert.equal(index.count(), 10_000);
    const page = index.list({ appKey: 'app-3', limit: 25 });
    assert.equal(page.length, 25);
    assert.ok(page.every((item) => item.appKey === 'app-3'));
    assert.ok(page.every((item) => !('messages' in item)));
    assert.ok((page[0]?.lastUsedAt ?? -Infinity) > (page.at(-1)?.lastUsedAt ?? 0));
    const cursorItem = page.at(-1);
    assert.ok(cursorItem);
    const next = index.list({
      appKey: 'app-3',
      beforeLastUsedAt: cursorItem.lastUsedAt,
      limit: 25,
    });
    assert.equal(next.length, 25);
    assert.ok((next[0]?.lastUsedAt ?? Infinity) < (page.at(-1)?.lastUsedAt ?? 0));
  } finally {
    database.close();
  }
});

test('tool approvals are scoped, expire, and can be consumed only once', () => {
  const database = new PlatformDatabase(':memory:');
  const approvals = new ToolApprovalStore(database);
  try {
    approvals.create({
      id: 'approval-1',
      appKey: 'app',
      agentId: 'agent',
      bindingId: 'binding',
      conversationKey: 'conversation',
      chatId: 'chat',
      messageId: 'message',
      requesterOpenId: 'requester',
      operation: 'doc.create',
      effect: 'write',
      approval: 'requester',
      argumentsHash: 'a'.repeat(64),
      createdAt: 100,
      expiresAt: 200,
    });
    assert.equal(approvals.resolve('approval-1', 'approved', 'requester', 150), true);
    assert.equal(approvals.resolve('approval-1', 'denied', 'requester', 151), false);
    assert.equal(approvals.list({ limit: 10 })[0]?.state, 'approved');

    approvals.create({
      id: 'approval-2',
      appKey: 'app',
      agentId: 'agent',
      bindingId: 'binding',
      conversationKey: 'conversation',
      chatId: 'chat',
      messageId: 'message-2',
      requesterOpenId: 'requester',
      operation: 'base.records.delete',
      effect: 'high-risk-write',
      approval: 'admin',
      argumentsHash: 'b'.repeat(64),
      createdAt: 200,
      expiresAt: 300,
    });
    assert.equal(approvals.expirePending(301), 1);
    assert.equal(approvals.list({ state: 'expired', limit: 10 })[0]?.id, 'approval-2');
  } finally {
    database.close();
  }
});

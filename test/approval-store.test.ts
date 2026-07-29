import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolApprovalStore } from '../src/storage/approval-store.js';
import { PlatformDatabase } from '../src/storage/database.js';

test('get lazily persists expired pending approvals', () => {
  const database = new PlatformDatabase(':memory:');
  const store = new ToolApprovalStore(database);
  try {
    createApproval(store, 'expired-on-read', 1, 2);

    const approval = store.get('expired-on-read');
    assert.equal(approval?.state, 'expired');
    assert.equal(approval?.approverOpenId, undefined);
    assert.ok(approval?.resolvedAt !== undefined && approval.resolvedAt >= 2);
  } finally {
    database.close();
  }
});

test('late approval is rejected and persisted as expired', () => {
  const database = new PlatformDatabase(':memory:');
  const store = new ToolApprovalStore(database);
  try {
    createApproval(store, 'late-approval', 1, 2);

    assert.equal(store.resolve('late-approval', 'approved', 'ou_approver', 3), false);
    assert.deepEqual(store.get('late-approval'), {
      ...approvalFields('late-approval', 1, 2),
      state: 'expired',
      resolvedAt: 3,
    });
  } finally {
    database.close();
  }
});

test('expiry resolves at the deadline while an unexpired approval still succeeds', () => {
  const database = new PlatformDatabase(':memory:');
  const store = new ToolApprovalStore(database);
  try {
    createApproval(store, 'deadline-expiry', 10, 20);
    assert.equal(store.resolve('deadline-expiry', 'expired', undefined, 20), true);
    assert.equal(store.get('deadline-expiry')?.state, 'expired');
    assert.equal(store.get('deadline-expiry')?.resolvedAt, 20);

    createApproval(store, 'approved-before-expiry', 100, 200);
    assert.equal(
      store.resolve('approved-before-expiry', 'approved', 'ou_approver', 150),
      true,
    );
    assert.equal(store.get('approved-before-expiry')?.state, 'approved');
    assert.equal(store.get('approved-before-expiry')?.approverOpenId, 'ou_approver');
    assert.equal(store.get('approved-before-expiry')?.resolvedAt, 150);
  } finally {
    database.close();
  }
});

function createApproval(
  store: ToolApprovalStore,
  id: string,
  createdAt: number,
  expiresAt: number,
): void {
  store.create({
    ...approvalFields(id, createdAt, expiresAt),
  });
}

function approvalFields(id: string, createdAt: number, expiresAt: number) {
  return {
    id,
    appKey: 'app',
    agentId: 'agent',
    bindingId: 'binding',
    conversationKey: 'conversation',
    chatId: 'chat',
    messageId: 'message',
    requesterOpenId: 'ou_requester',
    operation: 'doc.create',
    effect: 'write' as const,
    approval: 'requester' as const,
    argumentsHash: 'arguments-hash',
    createdAt,
    expiresAt,
  };
}

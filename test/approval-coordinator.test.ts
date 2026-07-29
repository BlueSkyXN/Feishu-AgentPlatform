import assert from 'node:assert/strict';
import test from 'node:test';

import type { CardActionEvent } from '@larksuiteoapi/node-sdk';

import { ApprovalCoordinator } from '../src/approvals/coordinator.js';
import { ToolApprovalStore } from '../src/storage/approval-store.js';
import { PlatformDatabase } from '../src/storage/database.js';

test('requester approval is operator-scoped, persisted, and consumed once', async () => {
  const database = new PlatformDatabase(':memory:');
  const store = new ToolApprovalStore(database);
  let card: unknown;
  const updates: unknown[] = [];
  const coordinator = new ApprovalCoordinator(
    {
      send: async (_chatId, content) => {
        card = content;
        return { messageId: 'approval-card-message' } as never;
      },
      updateCard: async (_messageId, content) => {
        updates.push(content);
        return {} as never;
      },
    },
    new Set(['ou_admin']),
    10_000,
    store,
  );
  try {
    const pending = coordinator.request({
      appKey: 'app',
      agentId: 'agent',
      bindingId: 'binding',
      conversationKey: 'conversation',
      chatId: 'chat',
      messageId: 'message',
      replyInThread: false,
      requesterOpenId: 'ou_requester',
      operation: 'doc.create',
      effect: 'write',
      approval: 'requester',
      arguments: { title: 'test' },
    });
    await waitFor(() => card !== undefined);
    const id = coordinator.list()[0]?.id;
    assert.ok(id);

    const deniedOperator = await coordinator.handleCardAction(event(
      id,
      'approve',
      'ou_other',
    ));
    assert.deepEqual(deniedOperator, {
      toast: { type: 'error', content: '你没有审批该操作的权限' },
    });
    assert.equal(coordinator.list().length, 1);

    const approved = await coordinator.handleCardAction(event(
      id,
      'approve',
      'ou_requester',
    ));
    assert.deepEqual(approved, {
      toast: { type: 'success', content: '已批准操作' },
    });
    await pending;
    assert.equal(coordinator.list().length, 0);
    assert.equal(store.list({ limit: 10 })[0]?.state, 'approved');
    assert.equal(store.list({ limit: 10 })[0]?.approverOpenId, 'ou_requester');
    assert.equal(updates.length, 1);

    const repeated = await coordinator.handleCardAction(event(
      id,
      'deny',
      'ou_requester',
    ));
    assert.deepEqual(repeated, {
      toast: { type: 'info', content: '审批已处理或已过期' },
    });
  } finally {
    coordinator.stop();
    database.close();
  }
});

test('trusted Admin resolution only consumes pending admin approvals', async () => {
  const database = new PlatformDatabase(':memory:');
  const store = new ToolApprovalStore(database);
  const coordinator = new ApprovalCoordinator(
    {
      send: async () => ({ messageId: 'admin-approval-card' }) as never,
      updateCard: async () => ({}) as never,
    },
    new Set(['ou_admin']),
    10_000,
    store,
  );
  try {
    const pending = coordinator.request({
      appKey: 'app',
      agentId: 'agent',
      bindingId: 'binding',
      conversationKey: 'conversation',
      chatId: 'chat',
      messageId: 'message',
      replyInThread: false,
      requesterOpenId: 'ou_requester',
      operation: 'base.records.delete',
      effect: 'high-risk-write',
      approval: 'admin',
      arguments: { record_id: 'rec-1' },
    });
    await waitFor(() => coordinator.list().length === 1);
    const id = coordinator.list()[0]?.id;
    assert.ok(id);
    assert.equal(await coordinator.resolveFromTrustedAdmin(id, 'approve', 'admin-token'), true);
    await pending;
    assert.equal(store.get(id)?.state, 'approved');
    assert.equal(store.get(id)?.approverOpenId, 'admin-token');
    assert.equal(await coordinator.resolveFromTrustedAdmin(id, 'deny', 'admin-token'), false);
  } finally {
    coordinator.stop();
    database.close();
  }
});

test('durable resolution failure keeps an approval retryable', async () => {
  let failResolve = true;
  const coordinator = new ApprovalCoordinator(
    {
      send: async () => ({ messageId: 'retryable-card' }) as never,
      updateCard: async () => ({}) as never,
    },
    new Set(['ou_admin']),
    10_000,
    {
      create: () => undefined,
      resolve: () => {
        if (failResolve) throw new Error('simulated audit outage');
        return true;
      },
    } as unknown as ToolApprovalStore,
  );
  const pending = coordinator.request({
    appKey: 'app',
    agentId: 'agent',
    bindingId: 'binding',
    conversationKey: 'conversation',
    chatId: 'chat',
    messageId: 'message',
    replyInThread: false,
    requesterOpenId: 'ou_requester',
    operation: 'doc.create',
    effect: 'write',
    approval: 'requester',
    arguments: { title: 'retry' },
  });
  await waitFor(() => coordinator.list().length === 1);
  const id = coordinator.list()[0]?.id;
  assert.ok(id);
  await assert.rejects(
    () => coordinator.handleCardAction(event(id, 'approve', 'ou_requester')),
    /simulated audit outage/,
  );
  assert.equal(coordinator.list().length, 1);
  failResolve = false;
  assert.deepEqual(
    await coordinator.handleCardAction(event(id, 'approve', 'ou_requester')),
    { toast: { type: 'success', content: '已批准操作' } },
  );
  await pending;
  coordinator.stop();
});

test('expiry settles the tool call even when durable audit storage fails', async () => {
  const coordinator = new ApprovalCoordinator(
    {
      send: async () => ({ messageId: 'expiring-card' }) as never,
      updateCard: async () => ({}) as never,
    },
    new Set(['ou_admin']),
    5,
    {
      create: () => undefined,
      resolve: () => {
        throw new Error('simulated audit outage');
      },
    } as unknown as ToolApprovalStore,
  );
  try {
    await assert.rejects(
      () => coordinator.request({
        appKey: 'app',
        agentId: 'agent',
        bindingId: 'binding',
        conversationKey: 'conversation',
        chatId: 'chat',
        messageId: 'message',
        replyInThread: false,
        requesterOpenId: 'ou_requester',
        operation: 'doc.create',
        effect: 'write',
        approval: 'requester',
        arguments: {},
      }),
      /Tool approval expired/,
    );
    assert.equal(coordinator.list().length, 0);
  } finally {
    coordinator.stop();
  }
});

function event(
  approvalId: string,
  decision: 'approve' | 'deny',
  operator: string,
): CardActionEvent {
  return {
    messageId: 'approval-card-message',
    chatId: 'chat',
    operator: { openId: operator },
    action: {
      tag: 'button',
      value: { action: 'tool_approval', approvalId, decision },
    },
  } as CardActionEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for approval card.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

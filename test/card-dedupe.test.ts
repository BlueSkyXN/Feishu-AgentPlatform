import assert from 'node:assert/strict';
import test from 'node:test';

import type { CardActionEvent } from '@larksuiteoapi/node-sdk';

import { cardActionDedupeId } from '../src/feishu/app-runtime.js';

test('Card dedupe distinguishes event, operator, button action, and approval ID', () => {
  const original = cardEvent('ou_a', 'approve', 'approval-a');
  assert.equal(cardActionDedupeId(original), cardActionDedupeId(original));
  assert.notEqual(
    cardActionDedupeId(original),
    cardActionDedupeId(cardEvent('ou_b', 'approve', 'approval-a')),
  );
  assert.notEqual(
    cardActionDedupeId(original),
    cardActionDedupeId(cardEvent('ou_a', 'deny', 'approval-a')),
  );
  assert.notEqual(
    cardActionDedupeId(original),
    cardActionDedupeId(cardEvent('ou_a', 'approve', 'approval-b')),
  );
});

function cardEvent(
  operator: string,
  decision: 'approve' | 'deny',
  approvalId: string,
): CardActionEvent {
  return {
    eventId: 'same-delivery-envelope',
    messageId: 'message',
    chatId: 'chat',
    operator: { openId: operator },
    action: {
      tag: 'button',
      name: 'approval',
      value: { action: 'tool_approval', decision, approvalId },
    },
  } as CardActionEvent;
}

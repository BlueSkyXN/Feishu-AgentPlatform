import assert from 'node:assert/strict';
import test from 'node:test';

import { belongsToShard, shardFor } from '../src/core/sharding.js';

test('shardFor is deterministic and bounded', () => {
  const first = shardFor('weekly-report', 8);
  assert.equal(shardFor('weekly-report', 8), first);
  assert.ok(first >= 0 && first < 8);
});

test('every key belongs to exactly one shard', () => {
  for (const key of ['a', 'b', 'code-reviewer', '机器人']) {
    const owners = Array.from({ length: 7 }, (_, index) =>
      belongsToShard(key, index, 7),
    ).filter(Boolean);
    assert.equal(owners.length, 1);
  }
});

test('invalid shard arguments are rejected', () => {
  assert.throws(() => shardFor('x', 0));
  assert.throws(() => belongsToShard('x', 2, 2));
});

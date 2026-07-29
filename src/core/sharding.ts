import { createHash } from 'node:crypto';

export function shardFor(key: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer.');
  }
  const digest = createHash('sha256').update(key).digest();
  const value = digest.readUInt32BE(0);
  return value % shardCount;
}

export function belongsToShard(
  key: string,
  shardIndex: number,
  shardCount: number,
): boolean {
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error('shardIndex must be within shardCount.');
  }
  return shardFor(key, shardCount) === shardIndex;
}

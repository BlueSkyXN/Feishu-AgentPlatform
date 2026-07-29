import assert from 'node:assert/strict';
import test from 'node:test';

import { MetricsRegistry } from '../src/core/metrics.js';

test('metrics render deterministic Prometheus output with escaped labels', () => {
  const metrics = new MetricsRegistry();
  metrics.increment('turns_total', 'Completed turns', { bot: 'a"b' });
  metrics.increment('turns_total', 'Completed turns', { bot: 'a"b' }, 2);
  metrics.setGauge('active_bots', 'Active bots', { instance: 'local' }, 3);
  const text = metrics.renderPrometheus();
  assert.match(text, /# TYPE active_bots gauge/);
  assert.match(text, /active_bots\{instance="local"\} 3/);
  assert.match(text, /turns_total\{bot="a\\"b"\} 3/);
});

test('metrics reject invalid names, labels and values', () => {
  const metrics = new MetricsRegistry();
  assert.throws(() => metrics.increment('bad-name', 'x'));
  assert.throws(() => metrics.increment('ok_name', 'x', { 'bad-name': 'x' }));
  assert.throws(() => metrics.increment('counter', 'x', {}, -1));
  assert.throws(() => metrics.setGauge('gauge', 'x', {}, Number.NaN));
});

test('a metric cannot change type or help text', () => {
  const metrics = new MetricsRegistry();
  metrics.increment('requests_total', 'Requests');
  assert.throws(() => metrics.setGauge('requests_total', 'Requests', {}, 1));
  assert.throws(() => metrics.increment('requests_total', 'Different help'));
});

// Unit tests for OutreachRateLimiter (ticket d86d0c24 review fix #1) — the
// per-channel proactive hourly request cap backing OutreachChannel.rate_limit_per_hour.
// Pure in-memory class, no fake-fetch/DB needed here; RedditConnector's own
// wiring into this class is covered separately in outreach-reddit-connector.test.mjs
// and the end-to-end publish path in outreach-publish-behavior.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutreachRateLimiter, OutreachChannelRateLimitedError } from '../dist/modules/outreach/outreach-rate-limiter.js';

const HOUR = 60 * 60 * 1000;

test('rate_limit_per_hour <= 0 (including omitted/default 0) is unlimited — never throws', () => {
  const rl = new OutreachRateLimiter();
  for (let i = 0; i < 50; i++) rl.checkAndRecord('ch-1', 0);
  for (let i = 0; i < 50; i++) rl.checkAndRecord('ch-1', -5);
});

test('the (N+1)th call within the window throws OutreachChannelRateLimitedError; the Nth does not', () => {
  const rl = new OutreachRateLimiter();
  const now = 1_000_000;
  rl.checkAndRecord('ch-1', 3, now);
  rl.checkAndRecord('ch-1', 3, now + 1);
  rl.checkAndRecord('ch-1', 3, now + 2);
  assert.throws(() => rl.checkAndRecord('ch-1', 3, now + 3), OutreachChannelRateLimitedError);
});

test('different channel_ids have independent counters', () => {
  const rl = new OutreachRateLimiter();
  const now = 2_000_000;
  rl.checkAndRecord('ch-a', 1, now);
  rl.checkAndRecord('ch-b', 1, now); // ch-b's own budget, unaffected by ch-a
  assert.throws(() => rl.checkAndRecord('ch-a', 1, now + 1), OutreachChannelRateLimitedError);
  assert.throws(() => rl.checkAndRecord('ch-b', 1, now + 1), OutreachChannelRateLimitedError);
});

test('a call that ages out of the rolling 1h window frees up budget again', () => {
  const rl = new OutreachRateLimiter();
  const now = 3_000_000;
  rl.checkAndRecord('ch-1', 1, now);
  assert.throws(() => rl.checkAndRecord('ch-1', 1, now + 1000), OutreachChannelRateLimitedError);
  // Exactly at the window boundary the old call has aged out (window is a
  // strict `t > windowStart` filter).
  rl.checkAndRecord('ch-1', 1, now + HOUR + 1);
});

test('a blocked call does NOT get recorded — it never consumes a future slot', () => {
  const rl = new OutreachRateLimiter();
  const now = 4_000_000;
  rl.checkAndRecord('ch-1', 1, now);
  assert.throws(() => rl.checkAndRecord('ch-1', 1, now + 10));
  assert.throws(() => rl.checkAndRecord('ch-1', 1, now + 20), 'still blocked — the two prior attempts did not consume extra slots');
});

test('OutreachChannelRateLimitedError carries a positive retryAfterMs pointing at when the oldest call ages out', () => {
  const rl = new OutreachRateLimiter();
  const now = 5_000_000;
  rl.checkAndRecord('ch-1', 1, now);
  try {
    rl.checkAndRecord('ch-1', 1, now + 100);
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof OutreachChannelRateLimitedError);
    assert.equal(e.code, 'channel_rate_limited');
    assert.equal(e.retryAfterMs, HOUR - 100, 'retryAfterMs = time until the oldest call ages out of the window');
  }
});

// Unit test — `hasAuditTrailSince` (ticket 2fd06686).
//
// This is the grace re-verification the silent-exit exit handlers call
// before trusting a local "no comment seen" verdict: it re-fetches the
// ticket's ACTUAL comments and checks whether any of them were created at/
// after the session's start time (minus a small clock-skew buffer),
// excluding the manager's own prior silent-exit fallback rows. Tested here
// in isolation from both TicketSessionManager and SubagentManager, which
// each have their own integration-level coverage
// (silent-exit-fallback.test.mjs, oneshot-circuit-breaker.test.mjs).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { hasAuditTrailSince } from '../dist/lib/rest.js';

function makeConfig(overrides = {}) {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0, // skip the real 2s grace delay in tests
    ...overrides,
  };
}

let originalFetch;
let requests;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockTicketResponse(payload, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET' });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('empty ticketId → false, no fetch performed', async () => {
  globalThis.fetch = async () => {
    throw new Error('must not be called');
  };
  const result = await hasAuditTrailSince(makeConfig(), undefined, Date.now());
  assert.equal(result, false);
});

test('a comment created after sinceMs → true', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c1', created_at: new Date(sinceMs + 3_000).toISOString(), metadata: {} },
    ],
  });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', sinceMs);
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/tickets\/ticket-1$/);
});

test('only a comment created before sinceMs (minus buffer) → false', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c-old', created_at: new Date(sinceMs - 60_000).toISOString(), metadata: {} },
    ],
  });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', sinceMs);
  assert.equal(result, false);
});

test('a comment just inside the clock-skew buffer (created slightly before sinceMs) → true', async () => {
  // The buffer exists so a manager clock a few seconds ahead of the server's
  // doesn't cause a genuine comment right at session start to be missed.
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c-skew', created_at: new Date(sinceMs - 2_000).toISOString(), metadata: {} },
    ],
  });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', sinceMs);
  assert.equal(result, true, 'a few seconds of clock skew must not cause a false negative');
});

test('a comment tagged reason=silent_exit is excluded even if freshly created', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      {
        id: 'c-fallback',
        created_at: new Date(sinceMs + 1_000).toISOString(),
        metadata: { reason: 'silent_exit' },
      },
    ],
  });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', sinceMs);
  assert.equal(result, false, 'the manager\'s own prior fallback row is not evidence of subagent work');
});

test('a real comment alongside an excluded silent_exit row still counts', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      {
        id: 'c-fallback',
        created_at: new Date(sinceMs + 1_000).toISOString(),
        metadata: { reason: 'silent_exit' },
      },
      {
        id: 'c-real',
        created_at: new Date(sinceMs + 2_000).toISOString(),
        metadata: {},
      },
    ],
  });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', sinceMs);
  assert.equal(result, true);
});

test('HTTP error response → false (fails closed, preserves pre-fix behavior)', async () => {
  mockTicketResponse({ error: 'not found' }, { status: 404 });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', Date.now());
  assert.equal(result, false);
});

test('network failure → false (fails closed)', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', Date.now());
  assert.equal(result, false);
});

test('ticket with no comments field at all → false, no throw', async () => {
  mockTicketResponse({ id: 'ticket-1' });
  const result = await hasAuditTrailSince(makeConfig(), 'ticket-1', Date.now());
  assert.equal(result, false);
});

test('graceDelayMs is honored from config (production default is NOT zero)', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({ comments: [{ id: 'c1', created_at: new Date(sinceMs + 1_000).toISOString(), metadata: {} }] });
  const start = Date.now();
  // Deliberately omit the override — this is the ONE test in the suite that
  // exercises the real production delay, so keep it short but non-zero.
  await hasAuditTrailSince(makeConfig({ silentExitVerifyDelayMs: 50 }), 'ticket-1', sinceMs);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 45, `expected the configured grace delay to elapse (got ${elapsed}ms)`);
});

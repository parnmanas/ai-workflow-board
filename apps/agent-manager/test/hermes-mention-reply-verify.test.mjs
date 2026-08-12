// Unit test — `hasAgentCommentSince` (ticket e8105c84, review round 1).
//
// This is the post-dispatch re-verification handleCommentMention's Hermes
// branch calls before trusting stopReason='end_turn' as proof that a mention
// was actually answered: it re-fetches the ticket's ACTUAL comments and
// checks whether the SAME agent posted one at/after the dispatch's start
// time (minus a small clock-skew buffer). Modeled on
// silent-exit-audit-trail-verify.test.mjs's coverage of the sibling
// `hasAuditTrailSince` helper, with the author-scoping this helper adds
// front and center (that's the whole reason it isn't just a call to
// `hasAuditTrailSince`).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { hasAgentCommentSince } from '../dist/lib/rest.js';

const AGENT = 'agent-hermes-mention-reply';
const OTHER_AGENT = 'agent-someone-else';

function makeConfig(overrides = {}) {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
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
  const result = await hasAgentCommentSince(makeConfig(), undefined, AGENT, Date.now());
  assert.equal(result, false);
});

test('empty agentId → false, no fetch performed', async () => {
  globalThis.fetch = async () => {
    throw new Error('must not be called');
  };
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', undefined, Date.now());
  assert.equal(result, false);
});

test('a comment from the SAME agent created after sinceMs → true', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c1', author_id: AGENT, created_at: new Date(sinceMs + 3_000).toISOString() },
    ],
  });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, sinceMs);
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/tickets\/ticket-1$/);
});

test('a fresh comment from a DIFFERENT agent → false (author-scoped, unlike hasAuditTrailSince)', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c-other', author_id: OTHER_AGENT, created_at: new Date(sinceMs + 3_000).toISOString() },
    ],
  });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, sinceMs);
  assert.equal(result, false, 'a reply from someone else is not evidence THIS agent answered the mention');
});

test('only a comment created before sinceMs (minus buffer) → false', async () => {
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c-old', author_id: AGENT, created_at: new Date(sinceMs - 60_000).toISOString() },
    ],
  });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, sinceMs);
  assert.equal(result, false);
});

test('a same-agent comment just inside the clock-skew buffer (created slightly before sinceMs) → true', async () => {
  // The buffer exists so a manager clock a few seconds ahead of the server's
  // doesn't cause a genuine reply right at dispatch start to be missed.
  const sinceMs = Date.now();
  mockTicketResponse({
    comments: [
      { id: 'c-skew', author_id: AGENT, created_at: new Date(sinceMs - 2_000).toISOString() },
    ],
  });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, sinceMs);
  assert.equal(result, true, 'a few seconds of clock skew must not cause a false negative');
});

test('HTTP error response → false (fails closed)', async () => {
  mockTicketResponse({ error: 'not found' }, { status: 404 });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, Date.now());
  assert.equal(result, false);
});

test('network failure → false (fails closed)', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, Date.now());
  assert.equal(result, false);
});

test('ticket with no comments field at all → false, no throw', async () => {
  mockTicketResponse({ id: 'ticket-1' });
  const result = await hasAgentCommentSince(makeConfig(), 'ticket-1', AGENT, Date.now());
  assert.equal(result, false);
});

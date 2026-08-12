// Unit test — `hasNewAgentComment` (ticket e8105c84, review round 2).
//
// This is the post-dispatch re-verification handleCommentMention's Hermes
// branch calls before trusting stopReason='end_turn' as proof that a mention
// was actually answered: it re-fetches the ticket's ACTUAL comments and
// checks whether the SAME agent's comment id set gained a member that wasn't
// in the pre-dispatch snapshot. Modeled on
// silent-exit-audit-trail-verify.test.mjs's coverage of the sibling
// `hasAuditTrailSince` helper, but id-set membership instead of a timestamp
// window — round 1 added author-scoping on top of a `sinceMs` cutoff, and
// round 2 found that ANY timestamp buffer wide enough to absorb clock skew
// is also wide enough to mistake the same agent's genuinely OLDER comment
// (posted just before dispatch) for this dispatch's reply. Exact id
// membership has neither failure mode, so that's what these tests pin down.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { hasNewAgentComment } from '../dist/lib/rest.js';

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
  const result = await hasNewAgentComment(makeConfig(), undefined, AGENT, new Set());
  assert.equal(result, false);
});

test('empty agentId → false, no fetch performed', async () => {
  globalThis.fetch = async () => {
    throw new Error('must not be called');
  };
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', undefined, new Set());
  assert.equal(result, false);
});

test('a comment from the SAME agent whose id is NOT in the known set → true', async () => {
  mockTicketResponse({
    comments: [{ id: 'c-new', author_id: AGENT, created_at: new Date().toISOString() }],
  });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set(['c-old']));
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/tickets\/ticket-1$/);
});

test('a same-agent comment whose id IS in the known set → false, even though it is "fresh" (the exact false-positive round 2 caught)', async () => {
  // This is the review-round-2 scenario verbatim: the same agent has an
  // OLDER comment that happens to be recent (e.g. posted seconds before this
  // dispatch started) and no genuinely new reply landed. A timestamp cutoff
  // with any clock-skew buffer would count this as evidence of a reply; id
  // membership correctly does not, regardless of created_at.
  const preExistingId = 'c-pre-existing';
  mockTicketResponse({
    comments: [{ id: preExistingId, author_id: AGENT, created_at: new Date().toISOString() }],
  });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set([preExistingId]));
  assert.equal(result, false, 'a comment already present before dispatch is not evidence of a new reply');
});

test('a fresh-id comment from a DIFFERENT agent → false (author-scoped, unlike hasAuditTrailSince)', async () => {
  mockTicketResponse({
    comments: [{ id: 'c-other', author_id: OTHER_AGENT, created_at: new Date().toISOString() }],
  });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set());
  assert.equal(result, false, 'a reply from someone else is not evidence THIS agent answered the mention');
});

test('a mix of known, foreign, and one genuinely new same-agent comment → true', async () => {
  mockTicketResponse({
    comments: [
      { id: 'c-known', author_id: AGENT, created_at: new Date().toISOString() },
      { id: 'c-foreign-new', author_id: OTHER_AGENT, created_at: new Date().toISOString() },
      { id: 'c-genuinely-new', author_id: AGENT, created_at: new Date().toISOString() },
    ],
  });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set(['c-known']));
  assert.equal(result, true);
});

test('HTTP error response → false (fails closed)', async () => {
  mockTicketResponse({ error: 'not found' }, { status: 404 });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set());
  assert.equal(result, false);
});

test('network failure → false (fails closed)', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set());
  assert.equal(result, false);
});

test('ticket with no comments field at all → false, no throw', async () => {
  mockTicketResponse({ id: 'ticket-1' });
  const result = await hasNewAgentComment(makeConfig(), 'ticket-1', AGENT, new Set());
  assert.equal(result, false);
});

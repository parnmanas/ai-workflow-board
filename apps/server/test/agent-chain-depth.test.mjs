// Unit coverage for the shared agent-chain-depth counting rule (ticket
// 07402c57) — the algorithm room-messaging.service.ts's chat-room chain and
// the ticket-comment mention chain both delegate to.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeChainDepth,
  computeTicketCommentChainDepth,
  TICKET_COMMENT_CHAIN_LOOKBACK,
} from '../dist/common/agent-chain-depth.js';

const agent = (id) => ({ isAgent: true, authorKey: id });
const user = () => ({ isAgent: false, authorKey: 'user' });

test('computeChainDepth mirrors the documented room-messaging examples', () => {
  // user only → chain broken immediately
  assert.equal(computeChainDepth([user()]), 0);
  // single agent turn
  assert.equal(computeChainDepth([agent('A')]), 1);
  // same agent retrying — not a loop, consolidates to one step
  assert.equal(computeChainDepth([agent('A'), agent('A'), agent('A')]), 1);
  // one round-trip between two different agents
  assert.equal(computeChainDepth([agent('B'), agent('A')]), 2);
  // B replied to A, then A replied again
  assert.equal(computeChainDepth([agent('A'), agent('B'), agent('A')]), 3);
  // initial duplicates collapse before the alternation
  assert.equal(computeChainDepth([agent('A'), agent('A'), agent('B'), agent('A')]), 3);
});

test('computeChainDepth breaks on the first non-agent entry walking backwards from latest', () => {
  // Latest is a user comment — depth is 0 regardless of what preceded it.
  assert.equal(computeChainDepth([user(), agent('B'), agent('A')]), 0);
  // A user comment two agents deep in history caps how far back we can count.
  assert.equal(computeChainDepth([agent('A'), agent('B'), user(), agent('A'), agent('B')]), 2);
});

test('computeChainDepth on an empty history is 0', () => {
  assert.equal(computeChainDepth([]), 0);
});

function fakeCommentRepo(rows) {
  return {
    async find(opts) {
      assert.equal(opts.where.ticket_id, 't1');
      assert.deepEqual(opts.order, { created_at: 'DESC', id: 'DESC' });
      assert.equal(opts.take, TICKET_COMMENT_CHAIN_LOOKBACK);
      return rows.slice(0, opts.take);
    },
  };
}

test('computeTicketCommentChainDepth queries latest-first and delegates to computeChainDepth', async () => {
  // Row order simulates a DESC-by-created_at query result: index 0 is the
  // just-saved comment that triggered the mention dispatch.
  const rows = [
    { author_type: 'agent', author_id: 'agentA' },
    { author_type: 'agent', author_id: 'agentB' },
    { author_type: 'agent', author_id: 'agentA' },
    { author_type: 'user', author_id: 'human1' },
  ];
  const depth = await computeTicketCommentChainDepth(fakeCommentRepo(rows), 't1');
  assert.equal(depth, 3);
});

test('computeTicketCommentChainDepth is 0 when the latest comment is user-authored', async () => {
  const rows = [
    { author_type: 'user', author_id: 'human1' },
    { author_type: 'agent', author_id: 'agentA' },
    { author_type: 'agent', author_id: 'agentB' },
  ];
  const depth = await computeTicketCommentChainDepth(fakeCommentRepo(rows), 't1');
  assert.equal(depth, 0);
});

test('computeTicketCommentChainDepth respects the lookback window', async () => {
  // 8 alternating agent turns then a user comment sits just past the window —
  // the query already truncates to TICKET_COMMENT_CHAIN_LOOKBACK, so the user
  // row is never seen and the full window counts as agent turns.
  const rows = [];
  for (let i = 0; i < TICKET_COMMENT_CHAIN_LOOKBACK; i++) {
    rows.push({ author_type: 'agent', author_id: i % 2 === 0 ? 'agentA' : 'agentB' });
  }
  rows.push({ author_type: 'user', author_id: 'human1' });
  const depth = await computeTicketCommentChainDepth(fakeCommentRepo(rows), 't1');
  assert.equal(depth, TICKET_COMMENT_CHAIN_LOOKBACK);
});

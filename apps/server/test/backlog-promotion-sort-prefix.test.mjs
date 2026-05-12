// Regression-grep — ticket 8b3fa67e (BacklogPromotion chain prefix).
//
// We need the candidate sort in `BacklogPromotionService.tryPromote` to
// always carry the chain_target prefix; a future refactor that reduces
// the sort back to just (priority_index, created_at) re-opens the
// "critical outsider starves chain target" bug fixed in v0.42.
//
// The behavioural test (test/qa-flows/backlog-promotion-chain.test.mjs)
// covers the runtime contract. This file is the cheap static check:
// it greps the source of backlog-promotion.service.ts and fails if the
// candidate-sort block is missing the chain prefix. Catches accidental
// reverts in PR-review-without-flow-tests scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = path.resolve(
  __dirname,
  '..',
  'src',
  'modules',
  'agents',
  'backlog-promotion.service.ts',
);

function read() {
  return fs.readFileSync(SOURCE, 'utf8');
}

// Extract the candidate sort block — text between `candidates.sort((a, b) =>`
// and the matching closing `});`. We don't try to be a full TS parser;
// the file has exactly one such block and the regex is anchored on
// `candidates.sort((a, b) =>` which is the only place the candidate
// array is sorted.
function extractCandidateSort(src) {
  const start = src.indexOf('candidates.sort((a, b) =>');
  assert.notEqual(start, -1, 'expected `candidates.sort((a, b) =>` block in backlog-promotion.service.ts');
  // Find the matching `});` after start — naive but sufficient: there
  // are no nested arrow functions inside the sort body.
  const end = src.indexOf('});', start);
  assert.notEqual(end, -1, 'expected matching `});` after candidates.sort');
  return src.slice(start, end + 3);
}

test('BacklogPromotion candidate sort carries the chain_target prefix', () => {
  const src = read();
  const block = extractCandidateSort(src);

  // Must reference the chain-target set from the IN-list query.
  assert.match(
    block,
    /isChainTarget\.has\(\s*a\.id\s*\)/,
    'candidate sort must check isChainTarget.has(a.id) as a sort-key prefix',
  );
  assert.match(
    block,
    /isChainTarget\.has\(\s*b\.id\s*\)/,
    'candidate sort must check isChainTarget.has(b.id) as a sort-key prefix',
  );

  // Must still preserve the priority + created_at fallthrough — the
  // prefix is additive, not a replacement.
  assert.match(
    block,
    /priorityIndex\(\s*a\.priority\s*\)/,
    'candidate sort must keep priorityIndex(a.priority) (chain prefix is additive)',
  );
  assert.match(
    block,
    /created_at/,
    'candidate sort must keep the created_at fallthrough',
  );
});

test('BacklogPromotion materializes the chain-parents IN-list before sort', () => {
  const src = read();
  // We need a single query that finds every ticket whose next_ticket_id
  // points at any candidate.id, so the sort prefix is O(1) lookup per
  // pair rather than N round-trips.
  assert.match(
    src,
    /next_ticket_id\s+IN\s+\(:\.\.\.ids\)/,
    'tryPromote must batch-lookup chain parents via `next_ticket_id IN (:...ids)`',
  );
});

test('backlog_promoted audit row records the chain_target=true|false token', () => {
  const src = read();
  // The audit row is the only place we surface chain_target to ops
  // dashboards. Make sure the token wasn't dropped during a refactor.
  assert.match(
    src,
    /chain_target=\$\{isChainTarget\.has\(ticket\.id\)\}/,
    'backlog_promoted activity new_value must include `chain_target=${isChainTarget.has(ticket.id)}`',
  );
});

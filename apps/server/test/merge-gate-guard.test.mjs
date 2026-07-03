// Regression-grep — merge/integration gate (ticket c806bad3).
//
// Merge quality was entirely prompt-driven + agent self-report; this gate moves
// the checks the merging prompt only *asks* for into server code that *blocks*:
//   - Review→Merging  : reject when the feature branch is BEHIND base (stale).
//   - Merging→Done    : reject when it still carries commits NOT in base (partial).
// Availability-first: OFF unless a board opts in via merge_gate_config, and any
// unresolvable repo/branch/git condition degrades to a PASS — so a board that
// never enabled it is byte-for-byte unchanged (DoD "게이트 미설정 보드 무회귀").
//
// Same shape as review-approval-guard.test.mjs / terminal-reopen-guard.test.mjs:
// strip comments first so doc-prose that names a helper can't false-positive on
// a file that no longer actually calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function code(relPath) {
  const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
  return stripComments(fs.readFileSync(SOURCE, 'utf8'));
}

test('merge-gate module exports the classifier, pure decider, orchestrator + error', () => {
  const src = code('modules/mcp/shared/merge-gate.ts');
  assert.match(src, /export function classifyMergeTransition\b/, 'classifyMergeTransition must exist');
  assert.match(src, /export function decideMergeGate\b/, 'decideMergeGate (pure) must exist');
  assert.match(src, /export async function evaluateMergeGate\b/, 'evaluateMergeGate orchestrator must exist');
  assert.match(src, /export class MergeGateBlockedError\b/, 'MergeGateBlockedError must exist');
  assert.match(src, /export function resolveFeatureBranch\b/, 'resolveFeatureBranch must exist');

  // The transition classifier must be data-driven on ColumnKind (review→merging,
  // merging→terminal) — NOT a column-name compare, forbidden in apps/server/src.
  assert.match(src, /\(source as any\)\?\.kind/, 'classifier must read source ColumnKind');
  assert.match(src, /\(dest as any\)\?\.kind/, 'classifier must read dest ColumnKind');
  assert.match(src, /s === 'review' && d === 'merging'/, 'review→merging must key on ColumnKind');
  assert.match(src, /s === 'merging' && d === 'terminal'/, 'merging→Done must key on ColumnKind (Done = terminal)');
});

test('decideMergeGate gates behind-count for stale-base and ahead-count for partial-merge', () => {
  const src = code('modules/mcp/shared/merge-gate.ts');
  // stale-base = require_fresh_base AND behind > 0
  assert.match(src, /require_fresh_base\s*&&\s*ba\.behind\s*>\s*0/, 'stale-base must gate behind>0 under require_fresh_base');
  assert.match(src, /merge_gate_stale_base/, 'stale-base code must exist');
  // partial-merge = require_full_merge AND ahead > 0
  assert.match(src, /require_full_merge\s*&&\s*ba\.ahead\s*>\s*0/, 'partial-merge must gate ahead>0 under require_full_merge');
  assert.match(src, /merge_gate_partial_merge/, 'partial-merge code must exist');
});

test('evaluateMergeGate is availability-first — unresolvable / disabled degrade to a PASS', () => {
  const src = code('modules/mcp/shared/merge-gate.ts');
  // A disabled board and every unresolvable step must return a non-blocking pass,
  // never a block. The presence of these outcomes proves the degrade paths exist.
  assert.match(src, /PASS\(\s*'disabled'\s*\)/, 'disabled board must degrade to pass');
  assert.match(src, /PASS\(\s*'unresolvable'\s*\)/, 'unresolvable repo/branch must degrade to pass');
  // The gate only arms when the board opted in (resolveMergeGate.enabled).
  assert.match(src, /resolveMergeGate\(/, 'must resolve the per-board merge_gate_config');
  assert.match(src, /if\s*\(\s*!gate\.enabled\s*\)/, 'must return early when the gate is not enabled');
});

// Every move surface that can perform a gated transition must call the gate
// behind a force override. Mirrors the review-approval guard coverage exactly:
// MCP move_ticket, REST human drag, agent-api single + batch.
const GUARDED_MOVE_SOURCES = [
  ['modules/mcp/tools/ticket-workflow-tools.ts', /!\s*force/, 'MCP move_ticket — the tool agents call'],
  ['modules/tickets/tickets.controller.ts', /!\s*force/, 'human REST drag path'],
  ['modules/agent-api/agent-api.controller.ts', /!\s*(op\.)?force/, 'legacy agent-api move-ticket (single + batch)'],
];

for (const [relPath, forceToken, why] of GUARDED_MOVE_SOURCES) {
  test(`${path.basename(relPath)} calls evaluateMergeGate behind a force override`, () => {
    const src = code(relPath);
    assert.match(src, /evaluateMergeGate\(/, `${relPath} must invoke the merge gate. ${why}`);
    // The call must be reachable only when force is falsy, so a refactor can't
    // make it unconditional (blocking deliberate overrides).
    assert.match(
      src,
      new RegExp(`${forceToken.source}[\\s\\S]{0,140}?evaluateMergeGate\\(`),
      `${relPath} must gate evaluateMergeGate behind a force override`,
    );
  });
}

// The agent-api batch surface loops move-ticket ops in ONE transaction — a known
// backdoor risk. Its move branch must carry the gate too. Unlike the review-
// approval guard (a cheap DB read that can run inside the txn), the merge gate's
// prober does a git fetch, so holding the DB transaction during it would stall
// sql.js's single connection. The batch therefore PRE-evaluates the gate BEFORE
// entering the transaction — on the dataSource scope, gated on op.force — and
// caches the block for the loop to consume. This test pins that shape so a
// refactor can neither drop the batch gate (BLOCKER that shipped once) nor move
// the git I/O back inside the transaction.
test('agent-api batch move-ticket is guarded by a PRE-transaction merge-gate pass', () => {
  const src = code('modules/agent-api/agent-api.controller.ts');
  // A pre-computed block map, built outside the txn and consumed by the loop.
  assert.match(src, /const mergeGateBlocks = new Map/, 'batch must build a pre-computed merge-gate block map');
  // The pre-pass skips non-move and force ops, then evaluates on the dataSource
  // scope (NOT the txn manager) — proving the git fetch is outside the DB txn.
  assert.match(src, /op\.action !== 'move-ticket' \|\| op\.force\) continue;/, 'batch pre-pass must skip non-move and forced ops');
  assert.match(src, /evaluateMergeGate\(this\.dataSource,/, 'batch merge-gate must pre-evaluate outside the txn on the dataSource scope');
  // The move-ticket branch inside the loop consumes the cached block by op index.
  assert.match(src, /mergeGateBlocks\.get\(opIndex\)/, 'batch move loop must consume the pre-computed merge-gate block');
  // The evaluate must NOT sit on the txn manager scope (would re-introduce the
  // git-fetch-inside-transaction problem the pre-pass exists to avoid).
  assert.doesNotMatch(src, /evaluateMergeGate\(manager,/, 'batch merge-gate must not run inside the transaction (manager scope)');
});

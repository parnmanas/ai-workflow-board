// Regression-grep — ticket a3d25202 (Review→Merging approval guard, proposal 2
// of 86bfb8af).
//
// A ticket must not cross the review gate (a `review` column → a `merging`
// column) unless a reviewer-authored comment exists on it
// (metadata.author_role === 'reviewer'); an assignee self-LGTM does not count.
// 86bfb8af's proposal 1 killed the trigger-race that let an assignee strand
// self-LGTM→self-merge; this guard is the defense-in-depth that closes the
// remaining manual / abnormal paths (a human drag, a batch caller, or a future
// routing edit that re-adds assignee to the Review routing). Bypassable only via
// an explicit force flag — a deliberate human override, never the default.
//
// Same shape as terminal-reopen-guard.test.mjs: strip comments first so the
// doc-prose that legitimately names the helper doesn't false-positive on a file
// that no longer actually calls it.

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

test('review-approval-guard exports isReviewToMerging + hasReviewerApproval + ReviewApprovalRequiredError', () => {
  const src = code('modules/mcp/shared/review-approval-guard.ts');
  assert.match(src, /export function isReviewToMerging\b/, 'isReviewToMerging helper must exist');
  assert.match(src, /export async function hasReviewerApproval\b/, 'hasReviewerApproval helper must exist');
  assert.match(src, /export class ReviewApprovalRequiredError\b/, 'ReviewApprovalRequiredError must exist');
  // The predicate must gate on review-source AND merging-dest specifically, data
  // -driven on ColumnKind — not a column-name compare (forbidden in src).
  assert.match(
    src,
    /kind\s*===\s*'review'\s*&&[\s\S]*kind\s*===\s*'merging'/,
    'isReviewToMerging must be review-source AND merging-dest, keyed on ColumnKind',
  );
  // The approval check must look for a reviewer-authored comment and exclude
  // system rows — an assignee self-LGTM (author_role 'assignee') must not pass.
  assert.match(src, /author_role\s*===\s*'reviewer'/, 'hasReviewerApproval must require author_role === reviewer');
  assert.match(src, /type\s*===\s*'system'/, 'hasReviewerApproval must skip system comments');
});

// Every move surface that can perform a Review→Merging transition must call the
// guard behind a force override. Unlike the terminal-reopen guard, the human
// REST drag path (tickets.controller PATCH /tickets/:id/move) IS included here —
// proposal 2 explicitly targets the manual "person drags the card" path.
const GUARDED_MOVE_SOURCES = [
  [
    'modules/mcp/tools/ticket-workflow-tools.ts',
    'force',
    'MCP move_ticket — the tool agents call',
  ],
  [
    'modules/agent-api/agent-api.controller.ts',
    'force',
    'legacy agent-api move-ticket (single) — automated caller',
  ],
  [
    'modules/tickets/tickets.controller.ts',
    'force',
    'human REST drag path — proposal 2 targets the manual move explicitly',
  ],
];

for (const [relPath, forceToken, why] of GUARDED_MOVE_SOURCES) {
  test(`${path.basename(relPath)} calls isReviewToMerging before moving`, () => {
    const src = code(relPath);
    assert.match(
      src,
      /isReviewToMerging\(/,
      `${relPath} must invoke the review-approval guard. ${why}`,
    );
    // Must be gated behind a force override AND a hasReviewerApproval check, so a
    // refactor can neither make it unconditional (blocking forced overrides) nor
    // drop the approval probe (turning the guard into a no-op).
    assert.match(
      src,
      new RegExp(`!\\s*${forceToken}\\s*&&\\s*isReviewToMerging\\(`),
      `${relPath} must gate isReviewToMerging behind a force override`,
    );
    assert.match(
      src,
      /hasReviewerApproval\(/,
      `${relPath} must probe hasReviewerApproval so the gate actually requires a reviewer comment`,
    );
  });
}

// The batch surface is a known backdoor risk — it loops move-ticket ops in one
// transaction. Its move-ticket branch must carry the guard too, gated on
// op.force (not the single-shot `force`).
test('agent-api batch move-ticket guards op.force for review-approval', () => {
  const src = code('modules/agent-api/agent-api.controller.ts');
  assert.match(src, /!op\.force\s*&&\s*isReviewToMerging\(/, 'batch move-ticket must honor op.force review-approval guard');
  assert.match(src, /hasReviewerApproval\(manager,/, 'batch path must run the approval probe on the transaction manager scope');
});

// Regression-grep — ticket e79eef92 (workflow-state cap building block).
//
// `BacklogPromotionService.tryPromote` and `TriggerLoopService._emitTrigger`
// used to gate on `AgentStatusService.getActiveTicketIds()`, which only
// counts subagent processes that are currently alive (plugin signal). That
// re-opened the per-agent cap whenever an agent finished a WAIT-only turn,
// leading to N tickets piling up on non-terminal columns even though the
// board's `max_concurrent_tickets_per_agent` was 1.
//
// Both dispatch paths now read workflow state via
// `AgentWorkloadService` — specifically `getAgentFocusTicketIds()` (the
// top-N focus WINDOW that generalized the top-1 selector in ticket
// 701e5e36) which internally calls `getWorkflowLoadTicketIds()` for its
// candidate set. Admission is by rank position within that window, NOT by
// counting live subagent processes — which is exactly why the anti-
// process-state invariant below matters MORE with N>1: a cap enforced by
// `getActiveTicketIds` would re-open every time a WAIT-only turn shrank
// active_tasks, letting the window over-admit and re-spawning the storm.
// This static check guards against a future refactor reverting to the
// process-state helper: it greps the two source files (after stripping
// comments so doc-prose that still names the old helper doesn't
// false-positive) and fails if `getActiveTicketIds` is called from
// either dispatch path.
//
// EventsController is still allowed to read it for the live "subagent
// alive?" status badge — that's status reporting, not cap enforcement.
//
// The queue-specific assertions that used to live here (gate label on
// `trigger_enqueued`, `item.gate` in the queue, depth-cap appendage)
// were retired alongside the dispatch queue itself — ticket 4a6cdfd7
// replaced the cap model with a focus selector that never enqueues.
// See `workflow-focus-selector-guard.test.mjs` for the new structural
// invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISPATCH_SOURCES = [
  path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'backlog-promotion.service.ts'),
  path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts'),
];

// Strip block + line comments so doc-prose that legitimately references
// `AgentStatusService.getActiveTicketIds` (e.g. in the "why this exists"
// header) doesn't trip the call-site grep. The remaining code text is
// what runtime dispatch actually executes.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

for (const SOURCE of DISPATCH_SOURCES) {
  test(`${path.basename(SOURCE)} does not call getActiveTicketIds (workflow-state is the gate)`, () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.doesNotMatch(
      code,
      /getActiveTicketIds/,
      `${path.basename(SOURCE)} must not call AgentStatusService.getActiveTicketIds — use AgentWorkloadService.getFocusTicket / getWorkflowLoadTicketIds instead. active_tasks is plugin-signal driven and re-opens the cap on WAIT-only turns.`,
    );
  });
}

test('AgentWorkloadService exists and exposes getWorkflowLoadTicketIds', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'agent-workload.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(
    src,
    /class\s+AgentWorkloadService/,
    'agent-workload.service.ts must export class AgentWorkloadService',
  );
  assert.match(
    src,
    /getWorkflowLoadTicketIds\s*\(/,
    'AgentWorkloadService must expose getWorkflowLoadTicketIds (candidate-set building block — kept for tests and audit even after the focus selector replaced the cap loop)',
  );
  // The SQL must filter on non-terminal AND non-intake columns. Without
  // either filter the set counts wrong things (Backlog ⇒ over-promote;
  // Done ⇒ never-promote-after-completion). The focus selector inherits
  // this filter through its `candidateIds` call.
  assert.match(
    src,
    /is_terminal/,
    'getWorkflowLoadTicketIds query must filter on c.is_terminal',
  );
  assert.match(
    src,
    /kind\s*!=\s*'intake'/,
    "getWorkflowLoadTicketIds query must exclude c.kind = 'intake'",
  );
});

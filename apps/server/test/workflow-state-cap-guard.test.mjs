// Regression-grep — ticket e79eef92 (workflow-state cap).
//
// `BacklogPromotionService.tryPromote` and `TriggerLoopService._emitTrigger`
// used to gate on `AgentStatusService.getActiveTicketIds()`, which only
// counts subagent processes that are currently alive (plugin signal). That
// re-opened the per-agent cap whenever an agent finished a WAIT-only turn,
// leading to N tickets piling up on non-terminal columns even though the
// board's `max_concurrent_tickets_per_agent` was 1.
//
// Both dispatch paths now read workflow state via
// `AgentWorkloadService.getWorkflowLoadTicketIds()`. This static check
// guards against a future refactor reverting to the process-state helper:
// it greps the two source files (after stripping comments so doc-prose
// that still names the old helper doesn't false-positive) and fails if
// `getActiveTicketIds` is called from either dispatch path.
//
// EventsController is still allowed to read it for the live "subagent
// alive?" status badge — that's status reporting, not cap enforcement.

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
  test(`${path.basename(SOURCE)} does not call getActiveTicketIds (workflow-state cap is the gate)`, () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.doesNotMatch(
      code,
      /getActiveTicketIds/,
      `${path.basename(SOURCE)} must not call AgentStatusService.getActiveTicketIds — use AgentWorkloadService.getWorkflowLoadTicketIds instead. Active_tasks is plugin-signal driven and re-opens the cap on WAIT-only turns.`,
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
    'AgentWorkloadService must expose getWorkflowLoadTicketIds',
  );
  // The SQL must filter on non-terminal AND non-intake columns. Without
  // either filter the cap counts wrong things (Backlog ⇒ over-promote;
  // Done ⇒ never-promote-after-completion).
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

test('backlog-promotion writes a backlog_promotion_skipped_workflow_load audit row on cap-skip', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'backlog-promotion.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(
    src,
    /backlog_promotion_skipped_workflow_load/,
    'BacklogPromotionService must emit a backlog_promotion_skipped_workflow_load activity row when the workflow-state cap closes (audit trail for "why did this backlog stop draining?")',
  );
});

test('trigger-loop tags trigger_enqueued audit row with gate=workflow-state on workflow-load cap-skip', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  // The QueueItem carries a `gate` field; AgentDispatchQueueService
  // appends it to the trigger_enqueued audit summary.
  assert.match(
    src,
    /gate:\s*['"]workflow-state['"]/,
    'TriggerLoopService must label the QueueItem gate as "workflow-state" so the trigger_enqueued audit row records the rationale',
  );
});

test('agent-dispatch-queue appends gate=... to the trigger_enqueued summary', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'agent-dispatch-queue.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(
    src,
    /item\.gate/,
    'AgentDispatchQueueService must read item.gate and include it in the trigger_enqueued summary',
  );
  // The summary is composed via a template token built from item.gate
  // (` gate=${item.gate}` joined into the trigger_enqueued message).
  // Match either the direct substitution or the helper-token name —
  // future refactors that rename `gateToken` are fine as long as
  // `item.gate` still flows into the trigger_enqueued summary.
  assert.match(
    src,
    /(gate=\$\{item\.gate\}|gateToken)/,
    'AgentDispatchQueueService trigger_enqueued summary must surface item.gate (directly or via a helper token)',
  );
});

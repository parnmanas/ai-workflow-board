// Regression-grep — ticket 4a6cdfd7 (WorkflowFocusSelector).
//
// The cap layers stacked across `TriggerLoopService` and
// `BacklogPromotionService` (an in-memory pendingDispatches race
// guard, an `alreadyOnTarget` bypass, an explicit per-candidate
// workflow-load loop, and a separate dispatch queue) interacted to
// emit a trigger every supervisor tick for every parked ticket on a
// non-terminal column. The new model picks ONE focus ticket per
// (agent, board, role) via `AgentWorkloadService.getFocusTicket` and
// gates both promotion and trigger emission on that single id.
//
// This static check enforces the structural invariants that make the
// new model work:
//
//   1. The dispatch path no longer references the removed cap layers.
//   2. Both dispatch services call `agentWorkload.getFocusTicket(`.
//   3. The new audit row name `backlog_promotion_skipped_focus_held`
//      is present in `backlog-promotion.service.ts`.
//   4. The `agent-dispatch-queue.service.ts` source file is gone.
//   5. `AgentWorkloadService` exposes both helpers — `getFocusTicket`
//      (the selector) and `getWorkflowLoadTicketIds` (the candidate-
//      set building block retained for tests + observability).
//
// Comments are stripped before grepping so the prose in the file
// headers — which legitimately names the obsolete `pendingDispatches`
// / `alreadyOnTarget` / dispatch-queue concepts to explain WHY they're
// gone — doesn't false-positive the call-site grep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.resolve(__dirname, '..', 'src', 'modules', 'agents');
const TRIGGER_LOOP   = path.join(SRC_DIR, 'trigger-loop.service.ts');
const BACKLOG_PROMOTE = path.join(SRC_DIR, 'backlog-promotion.service.ts');
const AGENT_WORKLOAD  = path.join(SRC_DIR, 'agent-workload.service.ts');
const DISPATCH_QUEUE  = path.join(SRC_DIR, 'agent-dispatch-queue.service.ts');

// Same comment-stripper used by workflow-state-cap-guard.test.mjs:
// remove /* … */ block comments and // line comments so doc-prose
// references don't trip the call-site grep. The remaining code text
// is what the dispatch path actually executes at runtime.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// Cap-layer tokens that must NOT appear in the runtime code of the
// two dispatch-path services. Doc-prose can still mention them (the
// guard strips comments first), so future readers can see the
// historical rationale in the file headers without tripping CI.
const FORBIDDEN_TOKENS_DISPATCH = [
  'alreadyOnTarget',
  'inflightSet',
  'pendingDispatches',
  'PENDING_DISPATCH_TTL_MS',
  '_tryDispatchFromQueue',
  '_addPendingDispatch',
  '_getPendingTicketIds',
  'AgentDispatchQueueService',
  'agent-dispatch-queue.service',
  'dispatchQueue',
];

for (const SOURCE of [TRIGGER_LOOP, BACKLOG_PROMOTE]) {
  test(`${path.basename(SOURCE)} has no cap-layer tokens in runtime code`, () => {
    const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
    for (const token of FORBIDDEN_TOKENS_DISPATCH) {
      assert.doesNotMatch(
        code,
        new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${path.basename(SOURCE)} must not reference \`${token}\` — the cap-layer model was replaced by the focus selector (ticket 4a6cdfd7).`,
      );
    }
  });
}

for (const SOURCE of [TRIGGER_LOOP, BACKLOG_PROMOTE]) {
  test(`${path.basename(SOURCE)} calls agentWorkload.getFocusTicket()`, () => {
    const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
    assert.match(
      code,
      /agentWorkload\.getFocusTicket\s*\(/,
      `${path.basename(SOURCE)} must gate emission/promotion on AgentWorkloadService.getFocusTicket — the single source of truth for "which ticket should this agent be working on right now".`,
    );
  });
}

test('AgentWorkloadService exposes both getFocusTicket and getWorkflowLoadTicketIds', () => {
  const src = fs.readFileSync(AGENT_WORKLOAD, 'utf8');
  assert.match(
    src,
    /class\s+AgentWorkloadService/,
    'agent-workload.service.ts must export class AgentWorkloadService',
  );
  assert.match(
    src,
    /getFocusTicket\s*\(/,
    'AgentWorkloadService must expose getFocusTicket — the new focus-selector entry point.',
  );
  assert.match(
    src,
    /getWorkflowLoadTicketIds\s*\(/,
    'AgentWorkloadService must still expose getWorkflowLoadTicketIds — preserved as the candidate-set building block + for tests.',
  );
  // The selector is sorted in JS, so the priorityIndex helper must be
  // imported (no raw priority-string compares anywhere in the dispatch
  // path — that ban is enforced elsewhere too, this is belt-and-braces).
  assert.match(
    src,
    /priorityIndex/,
    'getFocusTicket must use the priorityIndex helper — raw priority string compares are banned in the dispatch path.',
  );
  // Step 2 of the selector must be predecessor-aware — "is my parent in
  // the candidate set?" — not the older "is anything pointing at me?"
  // boolean. The boolean version can't distinguish two adjacent chain
  // members in the same candidate set, so a high-priority middle node
  // can starve its medium-priority predecessor forever (ticket ee0324ac).
  // The fix builds a child→parent map and asks O(1) "do I still have
  // an unresolved predecessor here?".
  const code = stripComments(fs.readFileSync(AGENT_WORKLOAD, 'utf8'));
  assert.match(
    code,
    /parentOfChild/,
    'getFocusTicket step 2 must materialise the chainParents query into a child→parent map (`parentOfChild`) so head-readiness is decidable per-candidate (ticket ee0324ac).',
  );
  assert.match(
    code,
    /hasUnresolvedPredecessor/,
    'getFocusTicket step 2 must rank candidates by `hasUnresolvedPredecessor` (head-ready first), not the old `is_chain_target` boolean — the boolean ties across adjacent chain members (ticket ee0324ac).',
  );
});

test('backlog-promotion writes the backlog_promotion_skipped_focus_held audit row on focus-held skip', () => {
  const src = fs.readFileSync(BACKLOG_PROMOTE, 'utf8');
  assert.match(
    src,
    /backlog_promotion_skipped_focus_held/,
    'BacklogPromotionService must emit a backlog_promotion_skipped_focus_held activity row when a destination-role holder already owns a focus ticket (audit trail for "why didn\'t this backlog promote?").',
  );
  // The new_value should record holder + focus_ticket_id so post-
  // mortems can identify the parked ticket.
  assert.match(
    src,
    /holder=\$\{[^}]*holderId\}/,
    'audit row new_value must include holder=${...} so post-mortems can identify the blocking agent',
  );
  assert.match(
    src,
    /focus_ticket_id=\$\{[^}]*focusTicketId\}/,
    'audit row new_value must include focus_ticket_id=${...} so post-mortems can identify the ticket occupying the slot',
  );
});

test('the dispatch-queue source file is removed (queue model retired)', () => {
  assert.ok(
    !fs.existsSync(DISPATCH_QUEUE),
    `${path.basename(DISPATCH_QUEUE)} must be removed — the per-agent dispatch queue was retired in favour of the focus selector (ticket 4a6cdfd7).`,
  );
});

test('agents.module.ts no longer registers AgentDispatchQueueService', () => {
  const MODULE = path.resolve(SRC_DIR, 'agents.module.ts');
  const src = fs.readFileSync(MODULE, 'utf8');
  const code = stripComments(src);
  assert.doesNotMatch(
    code,
    /AgentDispatchQueueService/,
    'agents.module.ts must not import / provide / export AgentDispatchQueueService (the service was deleted; module references would break Nest dependency resolution).',
  );
});

test('emitManualTrigger threads bypassFocus through to _emitTrigger', () => {
  const code = stripComments(fs.readFileSync(TRIGGER_LOOP, 'utf8'));
  // The manual-trigger code path is an explicit user override: clicking
  // "Trigger" on a non-focus ticket WAKES that ticket's agent. The
  // gate flag is the single mechanism by which the override is
  // delivered — without it the click would no-op silently.
  assert.match(
    code,
    /bypassFocus\s*:\s*true/,
    'emitManualTrigger must call _emitTrigger with { bypassFocus: true } — the manual button is a deliberate user override.',
  );
});

// QA flow: review-drift classification + episode state (ticket 59efbde9).
//
// ec498050's retrospective found the same NON-conflicting base-freshness
// reason bouncing a ticket Review→In Progress→Review 5 times in a row, purely
// because origin/main kept advancing under concurrent merges from other
// tickets — the old gate bounced on ANY advance, never checking whether it
// actually touched anything the ticket's own branch cared about.
//
// This spec drives the real `check_review_drift` MCP tool over a continuous
// main-advance fixture (the exact shape this ticket asks for):
//   R1  no drift                      -> classification=fresh,                 recommendation=proceed
//   R2  non-overlapping main advance  -> classification=non_overlapping_drift,  recommendation=proceed
//   R3  non-overlapping main advance  -> classification=non_overlapping_drift,  recommendation=proceed
//   R4  overlapping main advance      -> classification=overlapping_drift,      recommendation=rebase_required (bounce #1)
//   [Review -> In Progress -> Review, exactly the one bounce R4 recommended]
//   R5  overlapping main advance again -> classification=overlapping_drift_budget_exhausted, recommendation=proceed_no_action (NO bounce)
//
// Total Review round-trips across the whole episode: exactly 1 (R4's), never
// 2 — the regression this ticket exists to fix. The row is also checked to
// survive the R4 bounce (reverification_count persists) and to be deleted
// only once the episode actually ends (Review -> Merging).
//
// The behind/ahead git facts normally come from a per-Resource cache clone
// (real git). This test boots the app IN-PROCESS from the same compiled
// module, so it injects a deterministic probe via the module's test seam
// (same shape as merge-gate.test.mjs's `__setMergeGateProbeForTests`) and
// then drives the REAL MCP `check_review_drift` + `move_ticket` tools — the
// DB resolution, classification, counter persistence and episode-end delete
// all run through the production path; only the git numbers are stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createColumn,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PORT = process.env.QA_REVIEW_DRIFT_PORT || '7923';

const DIST_REVIEW_DRIFT = 'file://' + path.resolve(
  __dirname, '..', '..', 'dist', 'modules', 'mcp', 'shared', 'review-drift.js',
);

const BRANCH_PATHS = ['apps/server/src/modules/mcp/shared/review-drift.ts'];

// One canned probe result per `check_review_drift` call, in order — mirrors
// the R1..R5 fixture in the file banner. `baseShaAtEntry` (what the real
// prober would receive) is ignored: the stub is purely call-index-driven, the
// orchestrator's DB-persisted counter is what actually gates the outcome.
const ROUNDS = [
  { mainDriftPaths: [] }, // R1: fresh
  { mainDriftPaths: ['apps/client/src/unrelated-r2.ts'] }, // R2: non-overlapping
  { mainDriftPaths: ['apps/client/src/unrelated-r3.ts'] }, // R3: non-overlapping
  { mainDriftPaths: ['apps/server/src/modules/mcp/shared/review-drift.ts'] }, // R4: overlapping (exact match)
  { mainDriftPaths: ['apps/server/src/modules/mcp/shared/review-drift.ts'] }, // R5: overlapping again (budget exhausted)
];

async function installStubSequence() {
  const mod = await import(DIST_REVIEW_DRIFT);
  let callIndex = 0;
  mod.__setReviewDriftProbeForTests(async () => {
    const round = ROUNDS[Math.min(callIndex, ROUNDS.length - 1)];
    callIndex += 1;
    return {
      baseTipSha: `sha-base-${callIndex}`,
      featureBranch: 'ticket/59efbde9-review-drift-dedup',
      featureTipSha: `sha-feature-${callIndex}`,
      branchPaths: BRANCH_PATHS,
      mainDriftPaths: round.mainDriftPaths,
    };
  });
  return () => callIndex;
}
async function resetStub() {
  const mod = await import(DIST_REVIEW_DRIFT);
  mod.__setReviewDriftProbeForTests(null);
}

test('review-drift classifies a continuous main-advance fixture with at most one Review round-trip', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  t.after(() => resetStub());
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed a kanban scene + Merging column (kind=merging) + a repo Resource');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-drift',
  });
  const merging = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging', position: 5, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
  });
  const resource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: ws.id, name: 'repo', type: 'repository',
      url: 'https://example.com/review-drift.git', default_branch: 'main',
    }),
  );

  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id, label: 'worker',
  });

  step('Create ticket in Review (worker holds all roles), point it at the repo');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id,
    title: 'Review-drift ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  const ticketRepo = ds.getRepository('Ticket');
  await ticketRepo.update(ticket.id, {
    base_repo_resource_id: resource.id, base_branch: 'main',
  });

  const va = new VirtualAgent({ name: 'worker', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());

  const driftRepo = ds.getRepository('ReviewDriftState');
  const checkDrift = () => va.mcp.callTool('check_review_drift', { ticket_id: ticket.id });
  const moveTo = (name) => va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id, target_column_name: name, board_id: board.id,
  });

  await installStubSequence();

  step('R1: no drift -> fresh / proceed');
  const r1 = await checkDrift();
  assert.equal(r1.classification, 'fresh', `R1 must classify fresh: ${JSON.stringify(r1)}`);
  assert.equal(r1.recommendation, 'proceed', 'R1 must recommend proceed');
  assert.equal(r1.reverification_count, 0, 'R1 must not touch the reverification counter');

  step('R2: non-overlapping main advance -> non_overlapping_drift / proceed');
  const r2 = await checkDrift();
  assert.equal(r2.classification, 'non_overlapping_drift', `R2: ${JSON.stringify(r2)}`);
  assert.equal(r2.recommendation, 'proceed', 'R2 must recommend proceed (unrelated path)');
  assert.equal(r2.reverification_count, 0, 'R2 must not bump the counter');

  step('R3: another non-overlapping main advance -> non_overlapping_drift / proceed');
  const r3 = await checkDrift();
  assert.equal(r3.classification, 'non_overlapping_drift', `R3: ${JSON.stringify(r3)}`);
  assert.equal(r3.recommendation, 'proceed', 'R3 must recommend proceed');
  assert.equal(r3.reverification_count, 0, 'R3 must not bump the counter');

  step('R4: overlapping main advance -> overlapping_drift / rebase_required (the ONE bounce)');
  const r4 = await checkDrift();
  assert.equal(r4.classification, 'overlapping_drift', `R4: ${JSON.stringify(r4)}`);
  assert.equal(r4.recommendation, 'rebase_required', 'R4 must recommend a rebase bounce');
  assert.equal(r4.reverification_count, 1, 'R4 must bump the reverification counter to 1');
  assert.deepEqual(r4.overlapping_paths, BRANCH_PATHS, 'R4 must report the overlapping path');

  step('Bounce Review -> In Progress -> Review (exactly the one round-trip R4 recommended)');
  const bounced = await moveTo('In Progress');
  assert.ok(!bounced?.isError, `bounce to In Progress must succeed: ${JSON.stringify(bounced)}`);
  let row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.ok(row, 'ReviewDriftState row must survive the Review -> In Progress bounce');
  assert.equal(row.reverification_count, 1, 'reverification_count must be PRESERVED across the bounce (core invariant)');

  const backToReview = await moveTo('Review');
  assert.ok(!backToReview?.isError, `move back to Review must succeed: ${JSON.stringify(backToReview)}`);
  row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.ok(row, 'ReviewDriftState row must still exist after re-entering Review');
  assert.equal(row.reverification_count, 1, 'reverification_count must still be 1 after re-entering Review');

  step('R5: overlapping main advance AGAIN -> overlapping_drift_budget_exhausted / proceed_no_action (NO second bounce)');
  const r5 = await checkDrift();
  assert.equal(r5.classification, 'overlapping_drift_budget_exhausted', `R5: ${JSON.stringify(r5)}`);
  assert.equal(r5.recommendation, 'proceed_no_action', 'R5 must NOT recommend another bounce — budget already spent');
  assert.equal(r5.reverification_count, 1, 'R5 must not bump the counter past 1');

  row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.ok(row, 'ReviewDriftState row must still exist — episode has not ended yet');

  step('Episode end: Review -> Merging deletes the ReviewDriftState row');
  // review-approval-guard requires a reviewer-authored comment before this
  // transition is allowed — unrelated to review-drift, satisfy it like
  // merge-gate.test.mjs does so the move itself isn't blocked by a DIFFERENT
  // gate.
  const lgtm = await va.mcp.callTool('add_comment', {
    ticket_id: ticket.id, content: 'LGTM — reviewed.', author_role: 'reviewer',
  });
  assert.ok(!lgtm?.isError, `reviewer comment must post: ${JSON.stringify(lgtm)}`);
  const toMerging = await moveTo('Merging');
  assert.ok(!toMerging?.isError, `move to Merging must succeed: ${JSON.stringify(toMerging)}`);
  const ticketRow = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(ticketRow?.column_id, merging.id, 'ticket must land in Merging');
  row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.equal(row, null, 'ReviewDriftState row must be deleted once the episode ends (Review -> Merging)');
});

test('check_review_drift degrades to proceed_no_action when the git probe is unresolvable', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  t.after(() => resetStub());
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed a scene WITHOUT a base repo configured on the ticket');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-drift-unresolvable',
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker2' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id, label: 'worker2',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'No-repo ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });

  const va = new VirtualAgent({ name: 'worker2', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());

  step('check_review_drift with no base_repo_resource_id -> proceed_no_action, never an error');
  const result = await va.mcp.callTool('check_review_drift', { ticket_id: ticket.id });
  assert.ok(!result?.isError, `must not error: ${JSON.stringify(result)}`);
  assert.equal(result.recommendation, 'proceed_no_action', 'unresolvable repo must degrade to proceed_no_action');
  assert.equal(result.classification, null, 'unresolvable repo must report a null classification');

  const driftRepo = ds.getRepository('ReviewDriftState');
  const row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.equal(row, null, 'an unresolvable check must not create a ReviewDriftState row');
});

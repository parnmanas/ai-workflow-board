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
const DIST_MERGE_GATE = 'file://' + path.resolve(
  __dirname, '..', '..', 'dist', 'modules', 'mcp', 'shared', 'merge-gate.js',
);

const BRANCH_PATHS = ['apps/server/src/modules/mcp/shared/review-drift.ts'];

// The fork point this fixture's branch forked from. `base_sha_at_entry` is
// seeded from the merge-base (blocker 1 fix, review-drift.ts's
// `defaultReviewDriftProbe`) and never changes for the life of the episode,
// so a faithful stub must always see this same value once the entry call has
// happened — never the tip sha of a prior call.
const MERGE_BASE_SHA = 'sha-fork-point';

// Each entry is one main-side advance that lands BEFORE the correspondingly-
// numbered round's `check_review_drift` call — mirrors the R1..R5 fixture in
// the file banner (R1 sees zero advances landed, R2 sees the first, etc).
// The real prober's `mainDriftPaths` is CUMULATIVE from the effective entry
// point (the merge-base, since `base_sha_at_entry` is fixed) to the CURRENT
// base tip — never incremental since the last call (see review-drift.ts's
// `ReviewDriftProbeResult.mainDriftPaths` doc) — so the stub reproduces that
// by accumulating every landed advance's paths, not handing back one round's
// paths in isolation the way the old (call-index-only) stub did.
const ADVANCES = [
  ['apps/client/src/unrelated-r2.ts'], // lands before R2 (non-overlapping)
  ['apps/client/src/unrelated-r3.ts'], // lands before R3 (non-overlapping)
  ['apps/server/src/modules/mcp/shared/review-drift.ts'], // lands before R4 (overlap)
  ['apps/server/src/modules/mcp/shared/review-drift.ts'], // lands before R5 (overlap again)
];

async function installStubSequence() {
  const mod = await import(DIST_REVIEW_DRIFT);
  let callIndex = 0; // number of check_review_drift calls made so far
  mod.__setReviewDriftProbeForTests(async ({ baseShaAtEntry }) => {
    const landed = ADVANCES.slice(0, callIndex); // advances landed BEFORE this call
    callIndex += 1;
    const baseTipSha = landed.length ? `sha-base-after-advance-${landed.length}` : MERGE_BASE_SHA;
    // Mirror the real prober contract: the entry call receives
    // baseShaAtEntry=null and falls back to the merge-base; every later call
    // receives whatever base_sha_at_entry the orchestrator persisted, which
    // must stay MERGE_BASE_SHA for the whole episode (blocker 1 regression
    // guard — this would fail if the orchestrator ever again persisted the
    // entry-time base TIP instead of the merge-base).
    const driftFrom = baseShaAtEntry || MERGE_BASE_SHA;
    assert.equal(
      driftFrom, MERGE_BASE_SHA,
      'base_sha_at_entry must stay fixed at the fork point for the whole episode',
    );
    return {
      baseTipSha,
      mergeBaseSha: MERGE_BASE_SHA,
      featureBranch: 'ticket/59efbde9-review-drift-dedup',
      featureTipSha: `sha-feature-${callIndex}`,
      branchPaths: BRANCH_PATHS,
      mainDriftPaths: [...new Set(landed.flat())],
    };
  });
  return () => callIndex;
}
async function resetStub() {
  const mod = await import(DIST_REVIEW_DRIFT);
  mod.__setReviewDriftProbeForTests(null);
}

async function setMergeGateStub(behind, ahead, baseTipSha) {
  const mod = await import(DIST_MERGE_GATE);
  mod.__setMergeGateProbeForTests(async () => ({ behind, ahead, baseTipSha }));
}
async function resetMergeGateStub() {
  const mod = await import(DIST_MERGE_GATE);
  mod.__setMergeGateProbeForTests(null);
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
  // mainDriftPaths at R4 is the CUMULATIVE set since entry (unrelated-r2,
  // unrelated-r3, review-drift.ts) — overlapping_paths must report only the
  // subset that actually overlaps this branch, not the whole cumulative set.
  assert.deepEqual(r4.overlapping_paths, BRANCH_PATHS, 'R4 must report only the actually-overlapping path, not every path main touched');

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
  assert.deepEqual(r5.overlapping_paths, BRANCH_PATHS, 'R5 must still name the actually-overlapping path even though the budget is spent');

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
  // 고정 포트를 산술로 파생(PORT+n)하지 않고 OS 가 고른 빈 포트를 쓴다 (ticket 5db0964a).
  // 파생 포트는 소스 grep 에도 포트 목록에도 잡히지 않는 데다, bootApp 이 부팅마다
  // process.env.PORT 를 실제 바인딩 포트로 덮어쓰기 때문에 두 번째 파생부터는 의도한
  // 번호에서 밀리기까지 했다. 실제 포트는 bootApp 의 반환값을 그대로 쓴다.
  const { app, port, modules } = await bootApp({ port: 0 });
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

// ── blocker 1 regression guard ──────────────────────────────────────────────
// The original bug lived entirely inside `defaultReviewDriftProbe`: on the
// entry call `baseShaAtEntry` is null, and the buggy probe short-circuited to
// `mainDriftPaths: []` whenever that was the case — forcing EVERY episode's
// first `check_review_drift` call to classify `fresh` regardless of how far
// behind the branch actually was. The fixture above never exercises this
// axis (its entry call has zero pre-existing drift by design), so this test
// adds the one the original review flagged as missing: a branch whose fork
// point is ALREADY behind an overlapping main change before review even
// starts.
test('check_review_drift: branch already behind main at review entry -> overlapping_drift on the FIRST call', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  t.after(() => resetStub());
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed a kanban scene + repo Resource');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-drift-preexisting',
  });
  const resource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: ws.id, name: 'repo', type: 'repository',
      url: 'https://example.com/review-drift-preexisting.git', default_branch: 'main',
    }),
  );
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker3' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id, label: 'worker3',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'Pre-existing drift ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  const ticketRepo = ds.getRepository('Ticket');
  await ticketRepo.update(ticket.id, { base_repo_resource_id: resource.id, base_branch: 'main' });

  const va = new VirtualAgent({ name: 'worker3', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());

  step('Stub: main already advanced past the fork point (touching the branch\'s own file) BEFORE review started');
  const mod = await import(DIST_REVIEW_DRIFT);
  let probeCalled = false;
  mod.__setReviewDriftProbeForTests(async ({ baseShaAtEntry }) => {
    assert.equal(baseShaAtEntry, null, 'the FIRST call of a fresh episode must receive baseShaAtEntry=null');
    probeCalled = true;
    return {
      baseTipSha: 'sha-base-tip',
      mergeBaseSha: 'sha-fork-point', // != baseTipSha: main moved since the branch forked
      featureBranch: 'ticket/59efbde9-review-drift-dedup',
      featureTipSha: 'sha-feature-tip',
      branchPaths: BRANCH_PATHS,
      // What a faithful probe computes from the fork point (the effective
      // entry point, since baseShaAtEntry is null) to the current base tip:
      // main already touched the branch's own file before review started.
      mainDriftPaths: BRANCH_PATHS,
    };
  });

  step('Entry call must classify overlapping_drift / rebase_required, NOT fresh');
  const r1 = await va.mcp.callTool('check_review_drift', { ticket_id: ticket.id });
  assert.ok(probeCalled, 'the probe must actually run');
  assert.equal(
    r1.classification, 'overlapping_drift',
    `entry call with pre-existing overlapping drift must not default to fresh: ${JSON.stringify(r1)}`,
  );
  assert.equal(r1.recommendation, 'rebase_required', `must recommend a rebase, not proceed: ${JSON.stringify(r1)}`);
  assert.deepEqual(r1.overlapping_paths, BRANCH_PATHS);
  assert.equal(r1.reverification_count, 1, 'pre-existing overlapping drift spends the episode\'s bounce on the entry call itself');

  const driftRepo = ds.getRepository('ReviewDriftState');
  const row = await driftRepo.findOne({ where: { ticket_id: ticket.id } });
  assert.equal(
    row.base_sha_at_entry, 'sha-fork-point',
    'base_sha_at_entry must be seeded from the merge-base (fork point), not the base tip at entry time',
  );
});

// ── blocker 2 regression guard ──────────────────────────────────────────────
// Q3's merge-gate bypass (merge-gate.ts's decideMergeGate) only ever sees a
// classification the ORCHESTRATOR persisted — it never re-runs the drift
// probe itself. This drove the original deadlock: since blocker 1 forced
// every entry call to 'fresh', and 'fresh' never manufactures a bypass,
// require_fresh_base boards blocked Review->Merging right after the reviewer
// had just been told to proceed. With blocker 1 fixed, this covers the
// bypass path end to end over the real move_ticket surface, plus the
// staleness guard (issue 4): a classification computed against an OLDER base
// tip than the one evaluateMergeGate is deciding against must not bypass.
test('require_fresh_base gate: Q3 bypasses on a fresh classification, but not a stale one', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  t.after(() => resetStub());
  t.after(() => resetMergeGateStub());
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed a require_fresh_base-gated board + Merging column + repo Resource');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'review-drift-gate',
  });
  const merging = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging', position: 5, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
  });
  await ds.getRepository('Board').update(board.id, {
    merge_gate_config: JSON.stringify({ enabled: true, require_fresh_base: true }),
  });
  const resource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: ws.id, name: 'repo', type: 'repository',
      url: 'https://example.com/review-drift-gate.git', default_branch: 'main',
    }),
  );
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker4' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id, label: 'worker4',
  });
  const ticketRepo = ds.getRepository('Ticket');
  const va = new VirtualAgent({ name: 'worker4', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());
  const moveTo = (ticketId, name) => va.mcp.callTool('move_ticket', {
    ticket_id: ticketId, target_column_name: name, board_id: board.id,
  });

  step('Ticket A: non_overlapping_drift checked against sha-base-A, then Merging move sees the SAME tip -> bypass, no deadlock');
  const ticketA = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'Gate deadlock ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  await ticketRepo.update(ticketA.id, { base_repo_resource_id: resource.id, base_branch: 'main' });
  await va.mcp.callTool('add_comment', { ticket_id: ticketA.id, content: 'LGTM — reviewed.', author_role: 'reviewer' });

  const reviewDriftMod = await import(DIST_REVIEW_DRIFT);
  reviewDriftMod.__setReviewDriftProbeForTests(async () => ({
    baseTipSha: 'sha-base-A',
    mergeBaseSha: 'sha-fork-a',
    featureBranch: 'ticket/59efbde9-review-drift-dedup',
    featureTipSha: 'sha-feature-a',
    branchPaths: BRANCH_PATHS,
    mainDriftPaths: ['apps/client/src/unrelated.ts'],
  }));
  const driftA = await va.mcp.callTool('check_review_drift', { ticket_id: ticketA.id });
  assert.equal(driftA.classification, 'non_overlapping_drift', `ticket A drift check: ${JSON.stringify(driftA)}`);

  await setMergeGateStub(3, 0, 'sha-base-A'); // behind=3, but SAME tip the drift check just verified
  const bypassed = await moveTo(ticketA.id, 'Merging');
  assert.ok(!bypassed?.isError, `fresh non_overlapping_drift must bypass the stale-base block: ${JSON.stringify(bypassed)}`);
  const rowA = await ticketRepo.findOne({ where: { id: ticketA.id } });
  assert.equal(rowA?.column_id, merging.id, 'ticket A must land in Merging (Q3 bypass, no deadlock)');

  step('Ticket B: same non_overlapping_drift verdict, but main advances AGAIN before the Merging move -> classification is stale, must NOT bypass');
  const ticketB = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'Gate staleness ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  await ticketRepo.update(ticketB.id, { base_repo_resource_id: resource.id, base_branch: 'main' });
  await va.mcp.callTool('add_comment', { ticket_id: ticketB.id, content: 'LGTM — reviewed.', author_role: 'reviewer' });

  reviewDriftMod.__setReviewDriftProbeForTests(async () => ({
    baseTipSha: 'sha-base-B',
    mergeBaseSha: 'sha-fork-b',
    featureBranch: 'ticket/59efbde9-review-drift-dedup',
    featureTipSha: 'sha-feature-b',
    branchPaths: BRANCH_PATHS,
    mainDriftPaths: ['apps/client/src/unrelated.ts'],
  }));
  const driftB = await va.mcp.callTool('check_review_drift', { ticket_id: ticketB.id });
  assert.equal(driftB.classification, 'non_overlapping_drift', `ticket B drift check: ${JSON.stringify(driftB)}`);

  // Main moved AGAIN (sha-base-C) after that check ran — the stored
  // last_checked_base_sha (sha-base-B) no longer matches the tip
  // evaluateMergeGate resolves now, so the classification must be treated as
  // stale and the original stale-base block must fire.
  await setMergeGateStub(4, 0, 'sha-base-C');
  const stillBlocked = await moveTo(ticketB.id, 'Merging');
  assert.equal(stillBlocked?.isError, true, 'a stale non_overlapping_drift classification must NOT bypass the stale-base block');
  assert.match(
    JSON.stringify(stillBlocked?.error ?? stillBlocked),
    /merge_gate_stale_base|stale/i,
    'rejection names the stale-base reason',
  );
  const rowB = await ticketRepo.findOne({ where: { id: ticketB.id } });
  assert.equal(rowB?.column_id, columns.review.id, 'ticket B STAYS in Review — no bypass on a stale classification');
});

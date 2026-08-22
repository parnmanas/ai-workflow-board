// Durable CI-wait resume (ticket 778b6dc7) — against a REAL sql.js
// DataSource driven through the app's own buildDataSourceOptions() (so
// `synchronize` actually creates Ticket.pending_ci_wait / ci_wait_context —
// the dual-DB migration-free config-column convention). Mirrors
// hard-budget-guard.test.mjs's bootstrap shape.
//
// Central regressions this file exists to pin:
//
//   Review round 1 (P0) — a wait must resolve EXACTLY ONCE even when the
//   resolution path races itself, AND must NEVER be lost when a
//   crash/exception lands between "the run resolved" and "the
//   comment+dispatch side effects finished". Fixed by recording the outcome
//   (phase 1) WITHOUT clearing `pending_ci_wait`.
//
//   Review round 1 (P1) — run_id/head_sha must be validated against their
//   real external formats, both at the service layer and through the actual
//   registered MCP tool handler.
//
//   Review round 2 (P0 continued) — recording the outcome alone was not
//   enough: every sweep that saw `ctx.outcome` present went straight into
//   comment+dispatch with NO coordination between concurrent/retried
//   attempts, so (a) two sweeps racing AFTER the outcome was already
//   recorded could both deliver, and (b) `markDelivered`'s CAS on
//   `pending_ci_wait: true` alone let a stale in-flight delivery clear a
//   brand-new wait that raced in via cancel+re-register. Fixed by a
//   lease-based durable outbox (`lease_owner`/`lease_expires_at`/
//   `delivery_generation`, mirroring `DispatchIntentService.claimForDispatch`)
//   plus durable per-step flags (`comment_posted`/`dispatch_done`) plus
//   pinning `markDelivered`'s CAS to the exact finished context.
//
// GitHub reads are stubbed by monkey-patching the `.github` property after
// construction — CiWaitResumeService compiles `private readonly github` to a
// plain enumerable instance property (TS `private` is compile-time-only), so
// this is a supported, no-extra-seam substitution, not a hack around
// encapsulation.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses an isolated SQLJS_DB_PATH temp file so it never touches
// the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ci-wait-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'ci-wait-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { isValidGitHubRunId, isValidGitSha } = await import('file://' + path.join(DIST, 'services', 'github-connector.service.js'));
const { CiWaitService } = await import('file://' + path.join(DIST, 'modules', 'tickets', 'ci-wait.service.js'));
const { CiWaitResumeService, __test__ } = await import('file://' + path.join(DIST, 'modules', 'agents', 'ci-wait-resume.service.js'));
const { registerCiWaitTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'ci-wait-tools.js'));
const { DataSource } = await import('typeorm');

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const ciWaitService = new CiWaitService(ds, activityService);

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);

async function makeTicket(overrides = {}) {
  const board = await boardRepo.save(boardRepo.create({ name: 'B' }));
  const col = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Merging', position: 1 }));
  return ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col.id, workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}

function makeResumer(githubStub, dispatchCalls, dispatchImpl) {
  const fakeTriggerLoop = {
    async dispatchCurrentColumn(ticketId, source, by) {
      dispatchCalls.push({ ticketId, source, by });
      if (dispatchImpl) return dispatchImpl(ticketId, source, by);
      return { emitted: 1 };
    },
  };
  const resumer = new CiWaitResumeService(ds, logStub, ciWaitService, fakeTriggerLoop);
  resumer.github = githubStub;
  return resumer;
}

const SUCCESS_GITHUB_STUB = { async getWorkflowRun() { return { id: '999', status: 'completed', conclusion: 'success', html_url: 'https://x/999', created_at: '', updated_at: '', head_sha: '' }; } };
const THROWING_GITHUB_STUB = { async getWorkflowRun() { throw new Error('must not be called — outcome already recorded'); } };

/** Full outcome shape (post round-2 redesign) — pass overrides for the bits a test cares about. */
function makeOutcome(overrides = {}) {
  return {
    kind: 'resolved', message: 'x', resolved_at: new Date().toISOString(),
    delivery_generation: 0, lease_owner: '', lease_expires_at: '',
    comment_posted: false, dispatch_done: false,
    ...overrides,
  };
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Pure config parsing ──────────────────────────────────────────────────

test('readConfigFromEnv: overrides are honored', () => {
  const cfg = __test__.readConfigFromEnv({
    CI_WAIT_ENABLED: 'true',
    CI_WAIT_SWEEP_MS: '5000',
    CI_WAIT_MAX_AGE_MS: '3600000',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.sweepMs, 5000);
  assert.equal(cfg.maxAgeMs, 3_600_000);
});

test('readConfigFromEnv: CI_WAIT_ENABLED=false disables the service', () => {
  const cfg = __test__.readConfigFromEnv({ CI_WAIT_ENABLED: 'false' });
  assert.equal(cfg.enabled, false);
});

test('readConfigFromEnv: unset env falls back to DEFAULTS', () => {
  const cfg = __test__.readConfigFromEnv({});
  assert.equal(cfg.enabled, __test__.DEFAULTS.ENABLED);
  assert.equal(cfg.sweepMs, __test__.DEFAULTS.SWEEP_MS);
  assert.equal(cfg.maxAgeMs, __test__.DEFAULTS.MAX_AGE_MS);
});

// ── P1: external-identifier format validation (review round 1) ──────────

test('isValidGitHubRunId: accepts a realistic decimal run id, rejects garbage', () => {
  assert.equal(isValidGitHubRunId('123456789'), true);
  assert.equal(isValidGitHubRunId('1'), true);
  assert.equal(isValidGitHubRunId(''), false);
  assert.equal(isValidGitHubRunId('0'), false, 'leading/bare zero is never a real run id');
  assert.equal(isValidGitHubRunId('0123'), false, 'leading zero rejected');
  assert.equal(isValidGitHubRunId('12a34'), false, 'non-digit characters rejected');
  assert.equal(isValidGitHubRunId('123456789012345678901'), false, 'over 20 digits rejected');
  assert.equal(isValidGitHubRunId('-123'), false);
  assert.equal(isValidGitHubRunId('123; DROP TABLE tickets;'), false, 'injection-shaped input rejected outright, not truncated');
});

test('isValidGitSha: accepts a full 40-hex SHA-1, rejects anything else', () => {
  const validSha = 'a'.repeat(40);
  assert.equal(isValidGitSha(validSha), true);
  assert.equal(isValidGitSha(validSha.toUpperCase()), true, 'uppercase hex accepted (normalized by the caller)');
  assert.equal(isValidGitSha('a'.repeat(39)), false, 'too short (e.g. an abbreviated SHA) rejected');
  assert.equal(isValidGitSha('a'.repeat(41)), false, 'too long rejected');
  assert.equal(isValidGitSha('g'.repeat(40)), false, 'non-hex character rejected');
  assert.equal(isValidGitSha(''), false);
});

test('registerWait rejects a non-numeric / over-length run_id (service layer)', async () => {
  const ticket = await makeTicket();
  await assert.rejects(
    () => ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: 'not-a-number' }),
    /Invalid run_id/,
  );
  await assert.rejects(
    () => ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '1'.repeat(25) }),
    /Invalid run_id/,
  );
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false, 'a rejected registration must not leave a half-registered wait');
});

test('registerWait rejects a malformed head_sha but accepts a valid one, normalized to lowercase', async () => {
  const ticket = await makeTicket();
  await assert.rejects(
    () => ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111', head_sha: 'deadbeef' }),
    /Invalid head_sha/,
    'a short/abbreviated SHA must be rejected, not silently accepted',
  );
  const fresh1 = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh1.pending_ci_wait, false);

  const validSha = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'; // exactly 40 hex chars
  assert.equal(validSha.length, 40);
  await assert.rejects(
    () => ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111', head_sha: validSha + 'a' }),
    /Invalid head_sha/,
    '41 chars is over-length even though the extra char is hex',
  );

  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111', head_sha: validSha });
  const fresh2 = await ticketRepo.findOne({ where: { id: ticket.id } });
  const ctx = JSON.parse(fresh2.ci_wait_context);
  assert.equal(ctx.head_sha, validSha.toLowerCase(), 'head_sha must be normalized to lowercase for the later resolved-run comparison');
  await ciWaitService.cancelWait(ticket.id);
});

test('registerWait accepts omitted head_sha (still optional)', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true);
  await ciWaitService.cancelWait(ticket.id);
});

// ── MCP payload boundary — through the ACTUAL registered tool handler ───

function buildFakeMcpServer() {
  const tools = {};
  return {
    tools,
    tool(name, _description, _schema, handler) {
      tools[name] = handler;
    },
  };
}

test('await_ci_run MCP tool handler rejects a malformed run_id from a real caller payload', async () => {
  const ticket = await makeTicket();
  const fakeServer = buildFakeMcpServer();
  registerCiWaitTools(fakeServer, { dataSource: ds, activityService, ciWaitService });

  const result = await fakeServer.tools['await_ci_run']({
    ticket_id: ticket.id, owner: 'o', repo: 'r', run_id: '12a34',
  }, {});
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.match(body.error, /Invalid run_id/);

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false, 'the real tool handler must not leave a half-registered wait on rejected input');
});

test('await_ci_run MCP tool handler rejects a malformed head_sha from a real caller payload', async () => {
  const ticket = await makeTicket();
  const fakeServer = buildFakeMcpServer();
  registerCiWaitTools(fakeServer, { dataSource: ds, activityService, ciWaitService });

  const result = await fakeServer.tools['await_ci_run']({
    ticket_id: ticket.id, owner: 'o', repo: 'r', run_id: '123456', head_sha: 'zz-not-hex',
  }, {});
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.match(body.error, /Invalid head_sha/);
});

test('await_ci_run MCP tool handler accepts a valid payload and cancel_ci_wait clears it — full round trip through the real handlers', async () => {
  const ticket = await makeTicket();
  const fakeServer = buildFakeMcpServer();
  registerCiWaitTools(fakeServer, { dataSource: ds, activityService, ciWaitService });

  const registerResult = await fakeServer.tools['await_ci_run']({
    ticket_id: ticket.id, owner: 'o', repo: 'r', run_id: '123456', head_sha: 'a'.repeat(40),
  }, {});
  assert.notEqual(registerResult.isError, true);
  const registerBody = JSON.parse(registerResult.content[0].text);
  assert.equal(registerBody.registered, true);

  const cancelResult = await fakeServer.tools['cancel_ci_wait']({ ticket_id: ticket.id }, {});
  const cancelBody = JSON.parse(cancelResult.content[0].text);
  assert.equal(cancelBody.cancelled, true);
});

// ── tryUpdateContext / markDelivered — the lease-based CAS primitives ────

test('tryUpdateContext: two concurrent calls with the same expected prior context — exactly one wins, pending_ci_wait untouched', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome: makeOutcome() });

  const [a, b] = await Promise.all([
    ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx),
    ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx),
  ]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1, 'exactly one of the two concurrent CAS calls must win');

  const after1 = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after1.pending_ci_wait, true, 'recording the outcome must NOT clear pending_ci_wait — that is markDelivered\'s job, not this one\'s');
  await ciWaitService.cancelWait(ticket.id);
});

test('markDelivered: two concurrent calls with the same expected context — exactly one wins', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });

  const [a, b] = await Promise.all([
    ciWaitService.markDelivered(ticket.id, fresh.ci_wait_context),
    ciWaitService.markDelivered(ticket.id, fresh.ci_wait_context),
  ]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1);

  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

test('markDelivered: review round 2 — a stale in-flight delivery for an OLD wait cannot clear a brand-new wait registered via cancel+re-register in between', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const waitAState = await ticketRepo.findOne({ where: { id: ticket.id } });
  const staleFinishedContextA = JSON.stringify({
    ...JSON.parse(waitAState.ci_wait_context),
    outcome: makeOutcome({ comment_posted: true, dispatch_done: true }),
  });
  // waitAState.ci_wait_context (without the outcome) is what a stale
  // in-flight delivery for wait A would still be holding as its "expected"
  // parameter if it read the ticket BEFORE this test's simulated race —
  // but to make the race concrete, simulate the delivery having gotten all
  // the way to "ready to call markDelivered" for wait A's ORIGINAL context
  // (post-outcome, pre-clear), then have wait A get cancelled and a fresh
  // wait B registered before the stale caller's markDelivered finally runs.

  await ciWaitService.cancelWait(ticket.id);
  await ciWaitService.registerWait(ticket.id, { owner: 'o2', repo: 'r2', run_id: '222' });
  const waitBState = await ticketRepo.findOne({ where: { id: ticket.id } });

  const staleWon = await ciWaitService.markDelivered(ticket.id, staleFinishedContextA);
  assert.equal(staleWon, false, 'a stale delivery for wait A must NOT be able to clear wait B');

  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, true, 'wait B must still be active');
  assert.equal(after.ci_wait_context, waitBState.ci_wait_context, 'wait B\'s context must be completely untouched by the stale call');
  const ctxB = JSON.parse(after.ci_wait_context);
  assert.equal(ctxB.run_id, '222');

  await ciWaitService.cancelWait(ticket.id);
});

// ── Full sweep, via CiWaitResumeService ──────────────────────────────────

test('sweep(): a completed successful run resolves the wait exactly once — comment + dispatch fire once, not twice, under a concurrent double-sweep', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999', head_sha: 'a'.repeat(40) });

  const dispatchCalls = [];
  const resumer = makeResumer(SUCCESS_GITHUB_STUB, dispatchCalls);

  // Simulate two overlapping sweep ticks (e.g. a slow prior tick still
  // running when the interval fires again) racing to resolve the SAME wait
  // starting from "not yet resolved" (races on the phase-1 outcome CAS).
  await Promise.all([resumer.sweep(), resumer.sweep()]);

  const dispatchesForTicket = dispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(dispatchesForTicket.length, 1, 'dispatchCurrentColumn must fire exactly once for this ticket, not once per racing sweep');
  assert.equal(dispatchesForTicket[0].source, 'ci_wait_resolved');

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'exactly one resolution comment must be posted, not one per racing sweep');
  assert.match(comments[0].content, /CI 대기 완료/);
  assert.match(comments[0].content, /success/);

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
  assert.equal(fresh.ci_wait_context, '');
});

test('sweep(): review round 2 — concurrent double-sweep AFTER the outcome is already recorded still delivers exactly once (lease collision)', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  // Simulate "a prior sweep already recorded the outcome (phase 1 done) and
  // then crashed before ever entering _deliver" — every sweep from here on
  // reads ctx.outcome as already present and goes STRAIGHT into _deliver,
  // which is exactly the round-2 gap: without the lease, both racing sweeps
  // would see no comment posted yet and both post.
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const outcome = makeOutcome({ message: '✅ pre-recorded, racing delivery' });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  const won = await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);
  assert.equal(won, true);

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);

  await Promise.all([resumer.sweep(), resumer.sweep()]);

  const dispatchesForTicket = dispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(dispatchesForTicket.length, 1, 'the lease must let only ONE of the two racing sweeps actually dispatch');

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'the lease must let only ONE of the two racing sweeps actually post the comment');
  assert.match(comments[0].content, /pre-recorded, racing delivery/);

  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

test('sweep(): a fresh (unexpired) delivery lease held by another attempt is left alone — no duplicate comment/dispatch', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const outcome = makeOutcome({
    lease_owner: 'some-other-in-flight-attempt',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), // still fresh
  });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);
  await resumer.sweep();

  assert.equal(dispatchCalls.length, 0, 'must not dispatch while another attempt\'s lease is still fresh');
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 0, 'must not post while another attempt\'s lease is still fresh');
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, true, 'still pending — the lease-holder (or its expiry) owns resolution');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): an EXPIRED delivery lease (crashed attempt) is reclaimed and delivery completes', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const outcome = makeOutcome({
    message: '✅ recorded before the crash',
    lease_owner: 'a-crashed-attempt',
    lease_expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
  });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);
  await resumer.sweep();

  assert.equal(dispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1, 'an expired lease must be reclaimable');
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

test('sweep(): review round 2 — both durable flags already true (crash landed between dispatch success and markDelivered) — next sweep clears WITHOUT re-posting or re-dispatching', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  // Simulate: a prior attempt claimed the lease, posted the comment,
  // successfully called dispatchCurrentColumn, durably flipped BOTH flags —
  // then crashed in the sub-window before its own markDelivered call landed.
  const outcome = makeOutcome({
    lease_owner: 'crashed-right-before-markDelivered',
    lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    comment_posted: true,
    dispatch_done: true,
  });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);

  const dispatchCalls = [];
  // Both stubs throw if actually invoked — proves the recovery sweep does
  // NOT redo either side effect, exactly the scenario review round 2
  // explicitly asked for ("dispatch intent 기록/소비 뒤 clear 전 크래시 →
  // 다음 sweep에서도 재개 실행 1회" — here the count across the crash +
  // retry stays at the ZERO additional dispatches this recovery performs).
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls, () => { throw new Error('must not be called — dispatch_done was already true'); });

  await resumer.sweep();

  assert.equal(dispatchCalls.length, 0, 'dispatch_done=true must prevent any further dispatch attempt');
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 0, 'comment_posted=true must prevent any further comment attempt (none was ever actually saved in this simulation)');
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false, 'the defensive backstop must still clear the wait once both flags are true');
});

test('sweep(): a still-running run is left untouched (no comment, no dispatch, still pending)', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const dispatchCalls = [];
  const githubStub = { async getWorkflowRun() { return { id: '999', status: 'in_progress', conclusion: null, html_url: '', created_at: '', updated_at: '', head_sha: '' }; } };
  const resumer = makeResumer(githubStub, dispatchCalls);

  await resumer.sweep();
  assert.equal(dispatchCalls.length, 0);

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true, 'still-running run must leave the wait registered for the next sweep');
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.outcome, undefined, 'no outcome should be recorded while the run is still in flight');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): a failed run resolves the wait with a non-success message', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const githubStub = { async getWorkflowRun() { return { id: '999', status: 'completed', conclusion: 'failure', html_url: 'https://x/999', created_at: '', updated_at: '', head_sha: '' }; } };
  const dispatchCalls = [];
  const resumer = makeResumer(githubStub, dispatchCalls);

  await resumer.sweep();
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /결과: `failure`/);
  assert.equal(dispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1);

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
});

test('sweep(): a wait older than CI_WAIT_MAX_AGE_MS times out even though GitHub never resolves it', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  // Backdate registered_at past the (default) max age without going through
  // registerWait (which always stamps `new Date()`).
  const fresh1 = await ticketRepo.findOne({ where: { id: ticket.id } });
  const ctx = JSON.parse(fresh1.ci_wait_context);
  ctx.registered_at = new Date(Date.now() - 7 * 3_600_000).toISOString(); // 7h ago > 6h default
  await ticketRepo.update(ticket.id, { ci_wait_context: JSON.stringify(ctx) });

  let githubCalled = false;
  const githubStub = { async getWorkflowRun() { githubCalled = true; return { id: '999', status: 'in_progress', conclusion: null, html_url: '', created_at: '', updated_at: '', head_sha: '' }; } };
  const dispatchCalls = [];
  const resumer = makeResumer(githubStub, dispatchCalls);

  const stats = await resumer.sweep();
  assert.equal(stats.timed_out, 1);
  assert.equal(githubCalled, false, 'a timed-out wait must not even attempt a GitHub read');
  assert.equal(dispatchCalls.length, 1);

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.match(comments[0].content, /타임아웃/);

  const freshAfter = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(freshAfter.pending_ci_wait, false);
});

test('sweep(): a malformed ci_wait_context resolves as an error rather than hanging forever', async () => {
  const ticket = await makeTicket({ pending_ci_wait: true, ci_wait_context: 'not json' });

  const dispatchCalls = [];
  const resumer = makeResumer({ async getWorkflowRun() { throw new Error('must not be called'); } }, dispatchCalls);

  await resumer.sweep();
  assert.equal(dispatchCalls.length, 1);
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
});

test('sweep(): a GitHub read failure (rate limit / outage) leaves the wait registered for retry, not silently resolved', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const dispatchCalls = [];
  const resumer = makeResumer({ async getWorkflowRun() { throw new Error('rate limited'); } }, dispatchCalls);

  const stats = await resumer.sweep();
  assert.equal(stats.fetch_failures, 1);
  assert.equal(dispatchCalls.length, 0);
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true, 'a fetch failure must not clear the wait — retried next sweep');

  // Clean up — left pending by design above; clear it so it cannot leak into
  // a LATER test's sweep() scan.
  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): disabled (CI_WAIT_ENABLED=false) config short-circuits with skipped_disabled', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const resumer = makeResumer({ async getWorkflowRun() { throw new Error('must not be called'); } }, []);
  resumer.config.enabled = false;

  const stats = await resumer.sweep();
  assert.equal(stats.skipped_disabled, true);
  assert.equal(stats.scanned, 0);

  await ciWaitService.cancelWait(ticket.id);
});

// ── P0 crash/exception recovery (review round 1, adapted to the round-2 lease design) ─

test('crash recovery: outcome already recorded (phase 1 done, process died before delivery) — next sweep completes delivery without re-polling GitHub', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  // Simulate "a prior sweep tick recorded the outcome and then the process
  // died" by calling tryUpdateContext directly, bypassing _deliver entirely.
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const outcome = makeOutcome({ message: '✅ **CI 대기 완료** — pre-recorded outcome' });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  const won = await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);
  assert.equal(won, true);

  const midCrash = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(midCrash.pending_ci_wait, true, 'still a sweep candidate — this is the whole point of the design');
  const noComments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(noComments.length, 0, 'delivery never ran yet');

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);

  await resumer.sweep();

  assert.equal(dispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1);
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /pre-recorded outcome/);
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false, 'recovery sweep must complete delivery and finally clear the wait');
});

test('crash recovery: comment posted but dispatch threw (partial success) — retried next sweep WITHOUT duplicating the comment, then completes', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const dispatchCalls = [];
  const failingResumer = makeResumer(SUCCESS_GITHUB_STUB, dispatchCalls, () => { throw new Error('dispatch transiently failed'); });

  await failingResumer.sweep();

  // Comment landed, dispatch was attempted and failed — must NOT be marked delivered.
  const comments1 = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments1.length, 1, 'the comment side effect must have landed');
  assert.equal(dispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1);
  const midway = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(midway.pending_ci_wait, true, 'a dispatch failure must leave the wait retryable, not lost');
  const midwayCtx = JSON.parse(midway.ci_wait_context);
  assert.equal(midwayCtx.outcome.comment_posted, true);
  assert.equal(midwayCtx.outcome.dispatch_done, false);

  // Force the lease to look expired so the retry can reclaim it immediately
  // instead of waiting out the real lease TTL — same technique as the
  // dedicated lease-expiry test above, applied mid-scenario here.
  midwayCtx.outcome.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  await ticketRepo.update(ticket.id, { ci_wait_context: JSON.stringify(midwayCtx) });

  const retryDispatchCalls = [];
  const retryResumer = makeResumer(THROWING_GITHUB_STUB, retryDispatchCalls);
  await retryResumer.sweep();

  const comments2 = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments2.length, 1, 'retry must NOT duplicate the resolution comment');
  assert.equal(retryDispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1, 'retry must actually re-attempt dispatch');
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false, 'once dispatch succeeds on retry, the wait must finally clear');
});

test('crash recovery: comment write itself failed — retried next sweep, dispatch never attempted until the comment lands', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  // Force the comment save to fail by temporarily breaking the repository —
  // simplest reliable way: pass a ticket_id that violates the FK the moment
  // the comment tries to save is awkward with sql.js's loose typing, so
  // instead monkey-patch dataSource.getRepository for Comment to return a
  // repo whose .save() rejects, scoped to this resumer instance only.
  const dispatchCalls = [];
  const resumer = makeResumer(SUCCESS_GITHUB_STUB, dispatchCalls);
  // CiWaitResumeService only ever calls `.getRepository(...)` on
  // `this.dataSource` (never `.transaction()`/`.query()`/etc.), so a thin
  // wrapper implementing just that one method is a complete, safe stand-in —
  // no need to preserve the rest of the real DataSource's surface.
  const realGetRepository = ds.getRepository.bind(ds);
  let commentSaveAttempts = 0;
  resumer.dataSource = {
    getRepository(entity) {
      const repo = realGetRepository(entity);
      if (entity === Comment) {
        return new Proxy(repo, {
          get(target, prop, receiver) {
            if (prop === 'save' && commentSaveAttempts === 0) {
              return async () => { commentSaveAttempts++; throw new Error('transient comment write failure'); };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }
      return repo;
    },
  };

  await resumer.sweep();
  assert.equal(commentSaveAttempts, 1);
  assert.equal(dispatchCalls.length, 0, 'dispatch must not be attempted before the comment is durably posted');
  const midway = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(midway.pending_ci_wait, true);

  // Force the lease to look expired so the retry can reclaim immediately.
  const midwayCtx = JSON.parse(midway.ci_wait_context);
  midwayCtx.outcome.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  await ticketRepo.update(ticket.id, { ci_wait_context: JSON.stringify(midwayCtx) });

  // Retry — this time the SAME resumer's proxy no longer intercepts .save()
  // (commentSaveAttempts is already 1), so the comment goes through for real.
  await resumer.sweep();
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  assert.equal(dispatchCalls.length, 1);
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

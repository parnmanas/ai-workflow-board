// Durable CI-wait resume (ticket 778b6dc7) — against a REAL sql.js
// DataSource driven through the app's own buildDataSourceOptions() (so
// `synchronize` actually creates Ticket.pending_ci_wait / ci_wait_context —
// the dual-DB migration-free config-column convention). Mirrors
// hard-budget-guard.test.mjs's bootstrap shape.
//
// Central regression this file exists to pin: a wait must resolve EXACTLY
// ONCE even when the resolution path races itself — two overlapping sweep
// ticks, or a sweep racing an explicit cancel. That's the literal ask
// ("잘못된 wakeup 호출·clean exit·supervisor 재디스패치가 중복 실행을 만들지
// 않는 회귀 테스트") behind this ticket: the previous ad-hoc wait (sleep /
// ScheduleWakeup misuse) died mid-wait and needed a second session to
// rediscover state from scratch — a fix that ITSELF double-resolves under a
// race would just relocate the bug, not close it.
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
const { CiWaitService } = await import('file://' + path.join(DIST, 'modules', 'tickets', 'ci-wait.service.js'));
const { CiWaitResumeService, __test__ } = await import('file://' + path.join(DIST, 'modules', 'agents', 'ci-wait-resume.service.js'));
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

function makeResumer(githubStub, dispatchCalls) {
  const fakeTriggerLoop = {
    async dispatchCurrentColumn(ticketId, source, by) {
      dispatchCalls.push({ ticketId, source, by });
      return { emitted: 1 };
    },
  };
  const resumer = new CiWaitResumeService(ds, logStub, ciWaitService, fakeTriggerLoop);
  resumer.github = githubStub;
  return resumer;
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

// ── CiWaitService register/cancel ────────────────────────────────────────

test('registerWait sets pending_ci_wait + ci_wait_context; rejects a second registration without cancel', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111', head_sha: 'abc123' }, { actorName: 'A' });

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true);
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.owner, 'o');
  assert.equal(ctx.run_id, '111');

  await assert.rejects(
    () => ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '222' }),
    /already has an active CI wait/,
  );

  // Every test in this file shares one DataSource (no per-test DB reset) —
  // clean up so this ticket's still-pending wait cannot leak into a LATER
  // test's sweep() and pollute its aggregate stats.
  await ciWaitService.cancelWait(ticket.id);
});

test('cancelWait clears the flag and is idempotent', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });

  const first = await ciWaitService.cancelWait(ticket.id);
  assert.equal(first.cancelled, true);
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
  assert.equal(fresh.ci_wait_context, '');

  const second = await ciWaitService.cancelWait(ticket.id);
  assert.equal(second.cancelled, false, 'cancelling an already-clear wait is a no-op');
});

test('claimResolved: two concurrent claims on the same ticket — exactly one wins', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });

  const [a, b] = await Promise.all([
    ciWaitService.claimResolved(ticket.id),
    ciWaitService.claimResolved(ticket.id),
  ]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1, 'exactly one of the two concurrent claims must win the atomic CAS');

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
});

// ── Full sweep, via CiWaitResumeService ──────────────────────────────────

test('sweep(): a completed successful run resolves the wait exactly once — comment + dispatch fire once, not twice, under a concurrent double-sweep', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999', head_sha: 'deadbeef' });

  const dispatchCalls = [];
  const githubStub = {
    // Both racing sweeps may independently read the run before either wins
    // the claim (a harmless duplicate READ) — only the WRITE-side claim
    // needs to be exactly-once, which the assertions below verify.
    async getWorkflowRun() {
      return { id: '999', status: 'completed', conclusion: 'success', html_url: 'https://x/999', created_at: '', updated_at: '', head_sha: 'deadbeef' };
    },
  };
  const resumer = makeResumer(githubStub, dispatchCalls);

  // Simulate two overlapping sweep ticks (e.g. a slow prior tick still
  // running when the interval fires again) racing to resolve the SAME wait.
  // Assertions are scoped to THIS ticket's id throughout (not raw summed
  // stats) so the test stays correct regardless of whatever else the shared
  // DataSource happens to hold.
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

  // Clean up — this ticket is deliberately left pending above; clear it so
  // it cannot leak into a LATER test's sweep() and pollute its aggregate stats.
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
});

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
//   Review round 2 — recording the outcome alone was not enough: every
//   sweep that saw `ctx.outcome` present went straight into delivery with
//   no coordination between concurrent/retried attempts.
//
//   Review round 3 — round 2's fix (a lease + two separate durable flags
//   `comment_posted`/`dispatch_done`, each CASed AFTER its side effect)
//   still left a real window: two SEPARATE durable writes (do the side
//   effect; record that it happened) can never be made fully atomic no
//   matter how they are sequenced or leased — a crash exactly between them
//   reliably reproduces a duplicate on retry, and a slow side effect can
//   outlive the lease TTL and be reclaimed while still genuinely running.
//   Fixed by `CiWaitService.claimDelivery`: the `pending_ci_wait` CAS and
//   the resolution-comment insert now run in ONE DB transaction — the one
//   primitive in this codebase that is genuinely all-or-nothing. There is
//   no window left to crash in for that pair. The resume DISPATCH cannot
//   join that transaction (it crosses to agent-manager over SSE), so it is
//   ordered strictly AFTER the transaction commits and treated as
//   best-effort, backstopped by `DispatchReconcilerService`'s independent
//   idle-seed sweep (see ci-wait-resume.service.ts's class docstring).
//
// GitHub reads are stubbed by monkey-patching the `.github` property after
// construction — CiWaitResumeService compiles `private readonly github` to a
// plain enumerable instance property (TS `private` is compile-time-only), so
// this is a supported, no-extra-seam substitution, not a hack around
// encapsulation.
//
// A note on concurrency and dialect: the "concurrent" sweeps below race at
// the JS-Promise level, but this file runs on sql.js, whose single-WASM-
// connection backend serializes overlapping `dataSource.transaction()`
// calls through `serializeSqljsTransactions()` (db.ts) rather than truly
// interleaving them. The tests still prove the LOGICAL correctness of the
// conditional-UPDATE mutual exclusion (whichever transaction runs first
// wins; the other sees 0 affected rows and no-ops) — that SQL semantic is
// dialect-independent — but they do not exercise genuine concurrent-
// connection contention the way Postgres would. Per this project's own
// documented caveat (CLAUDE.md, "트랜잭션 직렬화 큐 — sql.js"), a green
// sql.js concurrency test must not be equated with proven Postgres behavior.
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

const { buildDataSourceOptions, serializeSqljsTransactions } = await import('file://' + path.join(DIST, 'db.js'));
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { Resource } = await import('file://' + path.join(DIST, 'entities', 'Resource.js'));
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
// CiWaitService.claimDelivery uses dataSource.transaction() (review round
// 3). A raw sql.js DataSource has no real connection pooling — two
// overlapping transaction() calls share the same underlying connection and
// throw "cannot start a transaction within a transaction" (ticket 02c85264,
// see db.ts's own docstring on this exact failure). AppDataSource /
// DatabaseModule apply this patch at construction; a bare `new DataSource()`
// in a test does not, so it must be applied explicitly here too (mirrors
// sqljs-transaction-serialize-queue.test.mjs's own setup).
serializeSqljsTransactions(ds);

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const ciWaitService = new CiWaitService(ds, activityService);

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const resourceRepo = ds.getRepository(Resource);

async function makeTicket(overrides = {}) {
  const board = await boardRepo.save(boardRepo.create({ name: 'B' }));
  const col = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Merging', position: 1 }));
  return ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col.id, workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}

/**
 * `dispatchCurrentColumn`'s stub enforces the SAME gate the real
 * trigger-loop.service.ts has: it refuses to emit while `pending_ci_wait`
 * is still true on the live ticket row. An earlier draft of `_deliver`
 * called dispatch BEFORE clearing the flag, so the real call was always a
 * silent no-op — a bug the round-2 tests never caught because their stub
 * didn't reproduce this gate. Baking the check into every test's stub
 * means any regression of the ordering fails loudly here instead of
 * silently under-reporting dispatch coverage.
 */
function makeResumer(githubStub, dispatchCalls, dispatchImpl, ciWaitServiceOverride = ciWaitService) {
  const fakeTriggerLoop = {
    async dispatchCurrentColumn(ticketId, source, by) {
      const live = await ticketRepo.findOne({ where: { id: ticketId } });
      const pendingStillTrue = !!live?.pending_ci_wait;
      dispatchCalls.push({ ticketId, source, by, pendingStillTrue });
      if (pendingStillTrue) {
        throw new Error(
          `dispatchCurrentColumn called for ${ticketId} while pending_ci_wait was still true — ` +
          'the real trigger-loop.service.ts gate would have silently no-op\'d this call',
        );
      }
      if (dispatchImpl) return dispatchImpl(ticketId, source, by);
      return { emitted: 1 };
    },
  };
  const resumer = new CiWaitResumeService(ds, logStub, ciWaitServiceOverride, fakeTriggerLoop);
  resumer.github = githubStub;
  return resumer;
}

function assertNoOrderingViolations(dispatchCalls) {
  const violations = dispatchCalls.filter((c) => c.pendingStillTrue);
  assert.equal(violations.length, 0, `dispatchCurrentColumn must never be called while pending_ci_wait is still true: ${JSON.stringify(violations)}`);
}

/**
 * Builds a CiWaitService whose `claimDelivery` transaction fails the FIRST
 * `failTimes` comment inserts it attempts (everything else — registerWait,
 * cancelWait, tryUpdateContext — passes straight through to the real
 * DataSource unaffected, since those never use `.transaction()`).
 */
function makeThrowOnceCiWaitService(failTimes = 1) {
  let remaining = failTimes;
  const fakeDs = {
    getRepository: ds.getRepository.bind(ds),
    transaction: (cb) => ds.transaction((manager) => {
      const wrappedManager = {
        getRepository(entity) {
          if (entity === Comment && remaining > 0) {
            return {
              createQueryBuilder() {
                remaining--;
                throw new Error('simulated comment-insert failure — mid-transaction');
              },
            };
          }
          return manager.getRepository(entity);
        },
      };
      return cb(wrappedManager);
    }),
  };
  return new CiWaitService(fakeDs, activityService);
}

const SUCCESS_GITHUB_STUB = { async getWorkflowRun() { return { id: '999', status: 'completed', conclusion: 'success', html_url: 'https://x/999', created_at: '', updated_at: '', head_sha: '' }; } };
const THROWING_GITHUB_STUB = { async getWorkflowRun() { throw new Error('must not be called — outcome already recorded'); } };

/** Outcome shape (post round-3 redesign) — pass overrides for the bits a test cares about. */
function makeOutcome(overrides = {}) {
  return {
    kind: 'resolved', message: 'x', resolved_at: new Date().toISOString(),
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

// ── tryUpdateContext / claimDelivery — the two atomic phase primitives ──

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
  assert.equal(after1.pending_ci_wait, true, 'recording the outcome must NOT clear pending_ci_wait — that is claimDelivery\'s job, not this one\'s');
  await ciWaitService.cancelWait(ticket.id);
});

test('claimDelivery: two concurrent calls with the same expected context — exactly one wins and runs withinTx exactly once', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });

  let calls = 0;
  const [a, b] = await Promise.all([
    ciWaitService.claimDelivery(ticket.id, fresh.ci_wait_context, async () => { calls++; }),
    ciWaitService.claimDelivery(ticket.id, fresh.ci_wait_context, async () => { calls++; }),
  ]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1);
  assert.equal(calls, 1, 'withinTx must run exactly once across both racing calls');

  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

test('claimDelivery: withinTx is NOT invoked when the claim is lost (already delivered)', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });

  let calls = 0;
  const won = await ciWaitService.claimDelivery(ticket.id, fresh.ci_wait_context, async () => { calls++; });
  assert.equal(won, true);
  assert.equal(calls, 1);

  let calls2 = 0;
  const wonAgain = await ciWaitService.claimDelivery(ticket.id, fresh.ci_wait_context, async () => { calls2++; });
  assert.equal(wonAgain, false, 'the exact same expectedContext must not win twice — pending_ci_wait is already false');
  assert.equal(calls2, 0, 'withinTx must not run when the claim is lost');
});

test('claimDelivery: review round 2 — a stale in-flight delivery for an OLD wait cannot clear a brand-new wait registered via cancel+re-register in between', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '111' });
  const waitAState = await ticketRepo.findOne({ where: { id: ticket.id } });
  const staleFinishedContextA = JSON.stringify({
    ...JSON.parse(waitAState.ci_wait_context),
    outcome: makeOutcome(),
  });

  await ciWaitService.cancelWait(ticket.id);
  await ciWaitService.registerWait(ticket.id, { owner: 'o2', repo: 'r2', run_id: '222' });
  const waitBState = await ticketRepo.findOne({ where: { id: ticket.id } });

  let calls = 0;
  const staleWon = await ciWaitService.claimDelivery(ticket.id, staleFinishedContextA, async () => { calls++; });
  assert.equal(staleWon, false, 'a stale delivery for wait A must NOT be able to clear wait B');
  assert.equal(calls, 0, 'withinTx must not run for a stale claim');

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

  assertNoOrderingViolations(dispatchCalls);
  const dispatchesForTicket = dispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(dispatchesForTicket.length, 1, 'dispatchCurrentColumn must fire exactly once for this ticket, not once per racing sweep');
  assert.equal(dispatchesForTicket[0].source, 'ci_wait_resolved');

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'exactly one resolution comment must be posted, not one per racing sweep');
  assert.match(comments[0].content, /CI 대기 완료/);
  assert.match(comments[0].content, /success/);
  assert.match(
    comments[0].operational_recurrence_key || '',
    new RegExp(`^ci-wait-resolved:${ticket.id}:`),
    'the resolution comment must carry a dedupe key namespaced by ci-wait-resolved + this ticket id',
  );

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false);
  assert.equal(fresh.ci_wait_context, '');
});

test('sweep(): review round 2/3 — concurrent double-sweep AFTER the outcome is already recorded still delivers exactly once (transactional mutual exclusion)', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });
  // Simulate "a prior sweep already recorded the outcome (phase 1 done) and
  // then crashed before ever entering _deliver" — every sweep from here on
  // reads ctx.outcome as already present and goes STRAIGHT into _deliver.
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const outcome = makeOutcome({ message: '✅ pre-recorded, racing delivery' });
  const nextCtx = JSON.stringify({ ...JSON.parse(fresh.ci_wait_context), outcome });
  const won = await ciWaitService.tryUpdateContext(ticket.id, fresh.ci_wait_context, nextCtx);
  assert.equal(won, true);

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);

  await Promise.all([resumer.sweep(), resumer.sweep()]);

  assertNoOrderingViolations(dispatchCalls);
  const dispatchesForTicket = dispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(dispatchesForTicket.length, 1, 'the transactional claim must let only ONE of the two racing sweeps actually dispatch');

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'the transactional claim must let only ONE of the two racing sweeps actually post the comment');
  assert.match(comments[0].content, /pre-recorded, racing delivery/);

  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
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
  assertNoOrderingViolations(dispatchCalls);
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
  assertNoOrderingViolations(dispatchCalls);
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
  assertNoOrderingViolations(dispatchCalls);
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

// ── Review round 3: proving the comment+flag pair is genuinely atomic ───

test('claimDelivery: a comment-insert failure mid-transaction rolls back the WHOLE transaction (pending_ci_wait untouched, no comment) — a fresh resumer then converges cleanly with no duplicate/loss', async () => {
  const ticket = await makeTicket();
  const failingCiWaitService = makeThrowOnceCiWaitService(1);
  await failingCiWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999', head_sha: 'a'.repeat(40) });

  const dispatchCalls = [];
  const failingResumer = makeResumer(SUCCESS_GITHUB_STUB, dispatchCalls, undefined, failingCiWaitService);

  await failingResumer.sweep();

  // Phase 1 (outcome recording) is a separate, already-committed CAS — it
  // is untouched by the phase-2 transaction's rollback.
  const midway = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(midway.pending_ci_wait, true, 'a mid-transaction failure must leave pending_ci_wait untouched — the CAS and the comment insert are ONE transaction');
  const midwayCtx = JSON.parse(midway.ci_wait_context);
  assert.ok(midwayCtx.outcome, 'phase 1 must still show the previously-recorded outcome');
  const commentsMidway = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(commentsMidway.length, 0, 'no comment must survive a rolled-back transaction');
  assert.equal(dispatchCalls.length, 0, 'dispatch must never be attempted when the claim/comment transaction rolled back');

  // "a fresh process/resumer resumes" — a brand-new CiWaitResumeService
  // instance, backed by the REAL (non-failing) ciWaitService this time,
  // sweeps the same ticket — simulating a fresh session picking up after a
  // crash, per the review round 3 requirement.
  const retryDispatchCalls = [];
  const retryResumer = makeResumer(THROWING_GITHUB_STUB, retryDispatchCalls);
  await retryResumer.sweep();

  assertNoOrderingViolations(retryDispatchCalls);
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'exactly one comment must exist after recovery — no duplicate, no loss');
  assert.equal(retryDispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1, 'exactly one dispatch must fire on recovery');
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false);
});

test('sweep(): dispatch throws AFTER the claim transaction already committed — comment still posted exactly once, wait still cleared, and a LATER sweep does not retry this ticket at all', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const dispatchCalls = [];
  const resumer = makeResumer(SUCCESS_GITHUB_STUB, dispatchCalls, () => { throw new Error('dispatch transiently failed after the claim already committed'); });

  await resumer.sweep();

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'the comment must be posted — it is inside the transaction, unaffected by a dispatch failure that happens strictly after commit');
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false, 'pending_ci_wait must already be cleared — committed before dispatch was even attempted');

  // A later sweep must find nothing to do for this ticket — it already left
  // the pending_ci_wait=true candidate set for good. From here on,
  // DispatchReconcilerService's idle-seed sweep is the sole backstop (see
  // ci-wait-resume.service.ts's class docstring) — this test only asserts
  // what CiWaitResumeService itself is responsible for: not retrying.
  const laterDispatchCalls = [];
  const laterResumer = makeResumer(THROWING_GITHUB_STUB, laterDispatchCalls);
  await laterResumer.sweep();
  const laterDispatchesForTicket = laterDispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(laterDispatchesForTicket.length, 0, 'a later sweep must not re-dispatch — the ticket is no longer a pending_ci_wait=true candidate');
  const commentsAfter = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(commentsAfter.length, 1, 'no duplicate comment from the later sweep');
});

// ── P0 crash/exception recovery (review round 1, still valid under round 3's design) ─

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
  assert.equal(midCrash.pending_ci_wait, true, 'still a sweep candidate — this is the whole point of the phase-1/phase-2 split');
  const noComments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(noComments.length, 0, 'delivery never ran yet');

  const dispatchCalls = [];
  const resumer = makeResumer(THROWING_GITHUB_STUB, dispatchCalls);

  await resumer.sweep();

  assertNoOrderingViolations(dispatchCalls);
  assert.equal(dispatchCalls.filter((c) => c.ticketId === ticket.id).length, 1);
  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /pre-recorded outcome/);
  const after = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(after.pending_ci_wait, false, 'recovery sweep must complete delivery and finally clear the wait');
});

// ── Credential resolution (ticket 9bbe9146) — the root cause: an unresolved
// credential made every GitHub read degrade to null and look EXACTLY like
// "still queued", forever ────────────────────────────────────────────────

test('sweep(): resolves credential_id from the ticket\'s bound Resource (same workspace) and passes it to getWorkflowRun', async () => {
  const resource = await resourceRepo.save(resourceRepo.create({
    workspace_id: 'w1', name: 'repo', type: 'repository', credential_id: 'cred-abc',
  }));
  const ticket = await makeTicket({ base_repo_resource_id: resource.id });
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  let seenCredentialId = 'unset';
  const githubStub = {
    async getWorkflowRun(_owner, _repo, _runId, credentialId) {
      seenCredentialId = credentialId;
      return { id: '999', status: 'completed', conclusion: 'success', html_url: '', created_at: '', updated_at: '', head_sha: '' };
    },
  };
  const resumer = makeResumer(githubStub, []);
  await resumer.sweep();

  assert.equal(seenCredentialId, 'cred-abc', 'the Resource\'s credential_id must reach getWorkflowRun\'s 4th argument');
});

test('sweep(): a bound Resource in a DIFFERENT workspace never leaks its credential_id to this ticket\'s poll', async () => {
  const resource = await resourceRepo.save(resourceRepo.create({
    workspace_id: 'other-workspace', name: 'repo', type: 'repository', credential_id: 'cred-should-not-leak',
  }));
  const ticket = await makeTicket({ workspace_id: 'w1', base_repo_resource_id: resource.id });
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  let seenCredentialId = 'unset';
  const githubStub = {
    async getWorkflowRun(_owner, _repo, _runId, credentialId) {
      seenCredentialId = credentialId;
      return { id: '999', status: 'in_progress', conclusion: null, html_url: '', created_at: '', updated_at: '', head_sha: '' };
    },
  };
  const resumer = makeResumer(githubStub, []);
  await resumer.sweep();

  assert.equal(seenCredentialId, null, 'a cross-workspace Resource must never leak its credential_id into this poll');
  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): no bound Resource degrades to a null credentialId — same env-token fallback as before this ticket', async () => {
  const ticket = await makeTicket(); // no base_repo_resource_id
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  let seenCredentialId = 'unset';
  const githubStub = {
    async getWorkflowRun(_owner, _repo, _runId, credentialId) {
      seenCredentialId = credentialId;
      return { id: '999', status: 'in_progress', conclusion: null, html_url: '', created_at: '', updated_at: '', head_sha: '' };
    },
  };
  const resumer = makeResumer(githubStub, []);
  await resumer.sweep();

  assert.equal(seenCredentialId, null);
  await ciWaitService.cancelWait(ticket.id);
});

// ── Poll-failure surfacing (ticket 9bbe9146) — the silent-degrade path that
// let six real Merging tickets sit parked for 1-2h before a human noticed;
// this is what turns that silence into an observable ticket comment ──────

test('sweep(): a run that degrades to null (no throw) is tracked as a poll failure, not silently ignored', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const githubStub = { async getWorkflowRun() { return null; } }; // degraded — no throw
  const resumer = makeResumer(githubStub, []);

  const stats = await resumer.sweep();
  assert.equal(stats.fetch_failures, 0, 'a null-degrade (not a throw) must not count toward fetch_failures — that stat is throw-only');

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true, 'a poll failure must not resolve the wait');
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.poll_issue.consecutive_failures, 1);
  assert.ok(ctx.poll_issue.first_failure_at);
  assert.equal(ctx.poll_issue.alerted, false);

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 0, 'must not alert before the configured threshold is reached');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): a thrown GitHub read error is tracked in the SAME poll-failure streak as a null-degrade', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const githubStub = { async getWorkflowRun() { throw new Error('rate limited'); } };
  const resumer = makeResumer(githubStub, []);
  await resumer.sweep();

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.poll_issue.consecutive_failures, 1, 'a thrown read error must feed the same poll-failure counter as a null-degrade');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): N consecutive poll failures post exactly ONE alert comment at the threshold, and later sweeps in the same streak do not re-alert', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  const githubStub = { async getWorkflowRun() { return null; } };
  const resumer = makeResumer(githubStub, []);
  const threshold = resumer.getConfig().alertAfterFailures;

  for (let i = 0; i < threshold; i++) await resumer.sweep();

  let comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, `exactly one alert comment must be posted once the ${threshold}th consecutive failure lands`);
  assert.match(comments[0].content, /폴링 반복 실패/);
  assert.match(comments[0].content, new RegExp(`${threshold}회 연속`));
  assert.match(comments[0].operational_recurrence_key || '', new RegExp(`^ci-wait-poll-alert:${ticket.id}:`));

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, true, 'an alert is a notification, not a resolution — the wait stays registered');
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.poll_issue.alerted, true);

  // Two more failing sweeps in the SAME streak must not post a second alert.
  await resumer.sweep();
  await resumer.sweep();
  comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1, 'once alerted, later sweeps in the same streak must not re-post');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): a poll that finally succeeds clears the failure streak entirely, and a LATER unrelated streak can alert again', async () => {
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  let fail = true;
  const githubStub = {
    async getWorkflowRun() {
      if (fail) return null;
      return { id: '999', status: 'in_progress', conclusion: null, html_url: '', created_at: '', updated_at: '', head_sha: '' };
    },
  };
  const resumer = makeResumer(githubStub, []);
  const threshold = resumer.getConfig().alertAfterFailures;

  for (let i = 0; i < threshold; i++) await resumer.sweep();
  let comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);

  fail = false;
  await resumer.sweep(); // now readable (still in_progress, but no longer a poll failure)
  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  const ctx = JSON.parse(fresh.ci_wait_context);
  assert.equal(ctx.poll_issue, undefined, 'a successful poll must clear the failure streak entirely, not just pause it');

  fail = true;
  for (let i = 0; i < threshold; i++) await resumer.sweep();
  comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 2, 'a fresh streak after a successful poll must be able to alert again — the OLD streak\'s alerted flag must not suppress it');

  await ciWaitService.cancelWait(ticket.id);
});

test('sweep(): review round 1 (reviewer) — N poll failures followed by a poll that is IMMEDIATELY completed resolves the wait in that SAME sweep() call, not a later one', async () => {
  // Regression for a real bug: clearing the poll_issue streak and recording
  // the resolved outcome were two SEPARATE tryUpdateContext CAS calls both
  // conditioned on the SAME stale `rawContext`. The first (clear) always won
  // and advanced ci_wait_context; the second (record outcome) then always
  // lost that CAS against its own now-stale `rawContext` and silently
  // deferred delivery to the NEXT sweep — breaking the "resumes within one
  // sweep" guarantee on exactly the recovery-after-failure path this ticket
  // exists to fix.
  const ticket = await makeTicket();
  await ciWaitService.registerWait(ticket.id, { owner: 'o', repo: 'r', run_id: '999' });

  let attempt = 0;
  const githubStub = {
    async getWorkflowRun() {
      attempt++;
      if (attempt <= 3) return null; // 3 consecutive poll failures (degraded)
      return { id: '999', status: 'completed', conclusion: 'success', html_url: 'https://x/999', created_at: '', updated_at: '', head_sha: '' };
    },
  };
  const dispatchCalls = [];
  const resumer = makeResumer(githubStub, dispatchCalls);

  for (let i = 0; i < 3; i++) await resumer.sweep(); // build up a poll_issue streak
  const midway = await ticketRepo.findOne({ where: { id: ticket.id } });
  const midwayCtx = JSON.parse(midway.ci_wait_context);
  assert.equal(midwayCtx.poll_issue.consecutive_failures, 3);

  // The 4th sweep: getWorkflowRun succeeds AND the run is already completed.
  await resumer.sweep();

  const dispatchesForTicket = dispatchCalls.filter((c) => c.ticketId === ticket.id);
  assert.equal(dispatchesForTicket.length, 1, 'the completed run must be delivered in the SAME sweep() call that first reads it successfully, not deferred to a later sweep');

  const comments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /CI 대기 완료/);

  const fresh = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(fresh.pending_ci_wait, false, 'the wait must be cleared in this same sweep, not deferred to a follow-up sweep');
  assert.equal(fresh.ci_wait_context, '', 'a fully delivered wait must not leave any context (stale poll_issue or otherwise) behind');
});

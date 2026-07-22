// QA flow: Agent token/cost usage observability (ticket 6dd3f968).
//
// What this proves (maps 1:1 to the ticket plan's step 3 / step 5 "Done when")
// ───────────────────────────────────────────────────────────────────────────
//   end() round-trip: a real HTTP `POST .../end` with a `usage` block persists
//     validated fields onto the Subagent row, drops malformed fields (negative /
//     over-ceiling counts) to null rather than clamping, truncates an oversized
//     model string, and stays idempotent on resend (first end() wins).
//   Legacy compat: an end() with NO `usage` key at all (pre-6dd3f968 manager)
//     leaves every usage column null — no crash, no default-to-zero.
//   Windowed aggregation: AgentUsageService.getTokenUsageStats() sums usage
//     columns only across in-window rows, reports instrumentation coverage,
//     computes avg cost over PRICED runs only (not all instrumented runs —
//     the exact skew the assignee flagged before starting), ranks top_tickets
//     by token volume, and derives estimated_saved_usd from a WINDOWED
//     suppression-event count (not RespawnStormDetectorService's lifetime
//     getSuppressionStats()).
//   Controller wiring: the combined workflow-health rollup embeds token_usage,
//     and the standalone /token-usage endpoint returns the same shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This flow drives the end()/register() REST endpoints with real `X-Agent-Key`
// auth (see authedPost below). MUST run before bootApp() reads the env (it
// only defaults AGENT_DEV_MODE when unset) — with the dev bypass left on,
// AgentAuthGuard never populates req.apiKey/currentAgentId and every
// authedPost call 401s at the controller's `_agentId(req)` check instead
// (same gotcha agent-api-workspace-scope.test.mjs documents).
process.env.AGENT_DEV_MODE = 'false';

import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createBoard,
  createColumn,
  createTicket,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_AGENT_USAGE_PORT || '7911';

const HOUR = 3_600_000;
let subCounter = 0;

/**
 * Insert a Subagent row directly with an already-ended lifecycle + usage
 * columns. started_at/ended_at are plain @Column Date fields (not
 * @CreateDateColumn), so a historical timestamp can be written on insert —
 * mirrors seedSubagent in respawn-storm-detector.test.mjs.
 */
async function seedSubagent(subRepo, {
  workspaceId, ticketId = null, ticketTitle = null, role = null,
  startedAt, endedAt = null, usage = {}, agentId = 'agent-usage-fixture',
}) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-usage-fixture-${subCounter}-${Math.floor(startedAt.getTime())}`,
    agent_id: agentId,
    workspace_id: workspaceId,
    kind: 'ticket',
    session_key: `${ticketId || 'chat'}:${role || '-'}`,
    pid: 20000 + subCounter,
    started_at: startedAt,
    ticket_id: ticketId,
    ticket_title: ticketTitle,
    role,
    ended_at: endedAt,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    total_cost_usd: usage.total_cost_usd ?? null,
    usage_model: usage.usage_model ?? null,
  }));
}

/** ActivityLog.created_at IS a @CreateDateColumn — insert then backdate via a
 *  separate UPDATE, same pattern as stuck-detector-hardening.test.mjs uses
 *  for Ticket.created_at. */
async function seedActivityLog(activityRepo, { action, createdAt, ticketId = 'fixture', workspaceId = '' }) {
  const row = await activityRepo.save(activityRepo.create({
    entity_type: 'ticket',
    entity_id: ticketId,
    action,
    ticket_id: ticketId,
    workspace_id: workspaceId,
  }));
  await activityRepo.update(row.id, { created_at: createdAt });
  return row;
}

function fakeRes() {
  let body;
  return {
    json(payload) { body = payload; return { statusCode: 200 }; },
    get body() { return body; },
  };
}

test('Agent usage stats — end() round-trip + windowed aggregation + controller wiring', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const usageModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-usage.service.js')
  );
  const usageSvc = app.get(usageModule.AgentUsageService);

  step('Seed workspace + agent + api key for real X-Agent-Key HTTP calls');
  const ws = await createWorkspace(app, getDataSourceToken, 'usage');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'usage-agent' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'usage' });

  const subRepo = ds.getRepository('Subagent');
  const activityRepo = ds.getRepository('ActivityLog');

  const authedPost = (urlPath, body) =>
    fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ── Group 1: end() usage round-trip over real HTTP ─────────────────────
  await t.test('end() persists validated usage, drops malformed fields to null, truncates an oversized model, stays idempotent on resend', async () => {
    const subagentId = `sub-e2e-${Date.now()}`;
    step('register a subagent over real HTTP');
    const reg = await authedPost('/api/agent-subagents', {
      subagent_id: subagentId, kind: 'oneshot', workspace_id: ws.id, pid: 4242,
    });
    assert.equal(reg.status, 201, 'register succeeds');

    step('end() with a mix of valid + malformed usage fields');
    const end1 = await authedPost(`/api/agent-subagents/${subagentId}/end`, {
      exit_code: 0,
      signal: null,
      usage: {
        input_tokens: 1500,
        output_tokens: 340,
        cache_read_input_tokens: -5, // negative → dropped to null, not clamped to 0
        cache_creation_input_tokens: 99_999_999_999, // past the sanity ceiling → dropped to null
        total_cost_usd: 0.0421,
        model: 'claude-opus-4-8-'.repeat(10), // > MAX_MODEL_LEN(100) → truncated, not dropped
      },
    });
    assert.equal(end1.status, 204, 'end succeeds');

    const row = await subRepo.findOne({ where: { subagent_id: subagentId } });
    assert.equal(row.input_tokens, 1500, 'valid count persisted verbatim');
    assert.equal(row.output_tokens, 340, 'valid count persisted verbatim');
    assert.equal(row.cache_read_input_tokens, null, 'negative count dropped to null, never clamped to 0');
    assert.equal(row.cache_creation_input_tokens, null, 'over-ceiling count dropped to null');
    assert.equal(row.total_cost_usd, 0.0421, 'valid cost persisted verbatim');
    assert.equal(row.usage_model.length, 100, 'oversized model string truncated to MAX_MODEL_LEN, not dropped');
    assert.equal(row.exit_code, 0, 'exit_code still recorded alongside usage');

    step('resend end() with different usage — idempotent (first end() wins, matches exit_code/signal behavior)');
    const end2 = await authedPost(`/api/agent-subagents/${subagentId}/end`, {
      exit_code: 0,
      usage: { input_tokens: 999_999, total_cost_usd: 5 },
    });
    assert.equal(end2.status, 204, 'resend still returns 204 (idempotent, not an error)');
    const rowAfterResend = await subRepo.findOne({ where: { subagent_id: subagentId } });
    assert.equal(rowAfterResend.input_tokens, 1500, 'a resend after ended_at is set does NOT overwrite usage');
    assert.equal(rowAfterResend.total_cost_usd, 0.0421, 'cost from the resend is discarded too');

    // getTokenUsageStats() is a global, unscoped rollup (no workspace/ticket
    // filter) — this row's started_at is real "now", so it would otherwise
    // land inside every window Group 2 queries below and skew its exact-count
    // assertions. Self-cleanup, same as Group 2's seeded rows are scoped to
    // their own test and never asserted on here.
    await subRepo.delete({ subagent_id: subagentId });
  });

  await t.test('end() with no usage key at all (pre-6dd3f968 manager compat) leaves every usage column null, not zero', async () => {
    const subagentId = `sub-legacy-${Date.now()}`;
    await authedPost('/api/agent-subagents', {
      subagent_id: subagentId, kind: 'oneshot', workspace_id: ws.id, pid: 4243,
    });
    const res = await authedPost(`/api/agent-subagents/${subagentId}/end`, { exit_code: 0, signal: null });
    assert.equal(res.status, 204, 'end succeeds with no usage body key at all');

    const row = await subRepo.findOne({ where: { subagent_id: subagentId } });
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cache_read_input_tokens, null);
    assert.equal(row.cache_creation_input_tokens, null);
    assert.equal(row.total_cost_usd, null);
    assert.equal(row.usage_model, null);

    // Same self-cleanup as the previous subtest — a null-usage row still
    // counts toward runs_total (a plain COUNT(*), not usage-filtered) in
    // Group 2's global rollup below.
    await subRepo.delete({ subagent_id: subagentId });
  });

  // ── Group 2: windowed aggregation ───────────────────────────────────────
  let now;
  await t.test('getTokenUsageStats sums in-window usage, excludes a stale row, reports coverage + priced-only avg cost', async () => {
    now = new Date();

    step('4 in-window subagent rows (2 Claude-shaped priced, 1 Codex-shaped unpriced, 1 fully uninstrumented) + 1 stale row outside the window');
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: 'ticket-A', ticketTitle: 'Storm victim A',
      startedAt: new Date(now.getTime() - 2 * HOUR), endedAt: new Date(now.getTime() - 2 * HOUR + 1000),
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, total_cost_usd: 0.02 },
    });
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: 'ticket-A', ticketTitle: 'Storm victim A',
      startedAt: new Date(now.getTime() - 1 * HOUR), endedAt: new Date(now.getTime() - 1 * HOUR + 1000),
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 300, total_cost_usd: 0.01 },
    });
    await seedSubagent(subRepo, {
      // Codex-shaped: real token counts, no cost concept at all.
      workspaceId: ws.id, ticketId: 'ticket-B', ticketTitle: 'Codex ticket',
      startedAt: new Date(now.getTime() - 30 * 60_000), endedAt: new Date(now.getTime() - 30 * 60_000 + 1000),
      usage: { input_tokens: 12437, output_tokens: 5, cache_read_input_tokens: 9984, cache_creation_input_tokens: null, total_cost_usd: null },
    });
    await seedSubagent(subRepo, {
      // Antigravity-shaped: never instrumented at all. Counts toward runs_total
      // but NOT runs_with_usage, and is excluded from top_tickets grouping.
      workspaceId: ws.id, ticketId: 'ticket-B', ticketTitle: 'Codex ticket',
      startedAt: new Date(now.getTime() - 10 * 60_000), endedAt: new Date(now.getTime() - 10 * 60_000 + 1000),
      usage: {},
    });
    await seedSubagent(subRepo, {
      // 30h ago — outside the 24h window entirely. Large numbers so any leak
      // into the aggregate is immediately obvious.
      workspaceId: ws.id, ticketId: 'ticket-A', ticketTitle: 'Storm victim A',
      startedAt: new Date(now.getTime() - 30 * HOUR), endedAt: new Date(now.getTime() - 30 * HOUR + 1000),
      usage: { input_tokens: 777_777, output_tokens: 777_777, total_cost_usd: 99 },
    });

    step('2 suppression events inside the window (different action types), 1 outside');
    await seedActivityLog(activityRepo, { action: 'respawn_storm_halted', createdAt: new Date(now.getTime() - 3 * HOUR), ticketId: 'ticket-A', workspaceId: ws.id });
    await seedActivityLog(activityRepo, { action: 'comment_pingpong_suppressed', createdAt: new Date(now.getTime() - 20 * 60_000), ticketId: 'ticket-B', workspaceId: ws.id });
    await seedActivityLog(activityRepo, { action: 'respawn_twin_detected', createdAt: new Date(now.getTime() - 30 * HOUR), ticketId: 'ticket-A', workspaceId: ws.id });

    step('getTokenUsageStats({ windowMs: 24h })');
    const stats = await usageSvc.getTokenUsageStats({ windowMs: 24 * HOUR, now });

    assert.equal(stats.window_minutes, 24 * 60);
    assert.equal(stats.coverage.runs_total, 4, 'the 30h-stale row is excluded from the window entirely');
    assert.equal(stats.coverage.runs_with_usage, 3, 'the fully-uninstrumented row is in runs_total but not runs_with_usage');

    assert.equal(stats.totals.input_tokens, 1000 + 500 + 12437);
    assert.equal(stats.totals.output_tokens, 200 + 100 + 5);
    assert.equal(stats.totals.cache_read_input_tokens, 500 + 0 + 9984);
    assert.equal(stats.totals.cache_creation_input_tokens, 0 + 300 + 0);
    assert.ok(Math.abs(stats.totals.total_cost_usd - 0.03) < 1e-9, `cost summed only across priced runs, got ${stats.totals.total_cost_usd}`);

    assert.equal(stats.priced_runs, 2, 'only the two Claude-shaped rows reported a cost — Codex and the uninstrumented row do not count');
    assert.ok(
      Math.abs(stats.avg_cost_per_run_usd_priced_only - 0.015) < 1e-9,
      'avg is 0.03/2 PRICED runs, not 0.03/3 instrumented runs — this is the exact skew the assignee flagged pre-implementation',
    );

    step('top_tickets ranked by token volume, uninstrumented row excluded from grouping');
    assert.equal(stats.top_tickets.length, 2, 'exactly ticket-A and ticket-B (the stale ticket-A row and the uninstrumented ticket-B row do not add a 3rd group)');
    const [first, second] = stats.top_tickets;
    assert.equal(first.ticket_id, 'ticket-B', 'ticket-B (12437+5=12442 tokens) outranks ticket-A (1500+300=1800) despite having only 1 run');
    assert.equal(first.runs, 1, 'the uninstrumented ticket-B row is excluded from this count');
    assert.equal(second.ticket_id, 'ticket-A');
    assert.equal(second.input_tokens, 1500);
    assert.equal(second.output_tokens, 300);
    assert.equal(second.runs, 2, 'the 30h-stale ticket-A row is NOT included — window-scoped, not all-time');

    step('estimated_saved_usd derives from a WINDOWED suppression count, not the lifetime getSuppressionStats()');
    assert.equal(stats.suppressed_attempts_in_window, 2, 'only the 2 in-window suppression events count; the 30h-old one is excluded');
    assert.ok(
      Math.abs(stats.estimated_saved_usd - (0.015 * 2)) < 1e-9,
      `estimated_saved_usd = avg_cost_per_run_usd_priced_only * suppressed_attempts_in_window, got ${stats.estimated_saved_usd}`,
    );
  });

  await t.test('getTokenUsageStats returns null derived fields (not 0) when a window has zero priced runs', async () => {
    const isolatedNow = new Date(now.getTime() - 100 * HOUR); // far from the Group-2 seeded data
    const stats = await usageSvc.getTokenUsageStats({ windowMs: HOUR, now: isolatedNow });
    assert.equal(stats.coverage.runs_total, 0);
    assert.equal(stats.priced_runs, 0);
    assert.equal(stats.avg_cost_per_run_usd_priced_only, null, 'null, not 0 — no priced runs to average');
    assert.equal(stats.estimated_saved_usd, null, 'null, not 0 — nothing to estimate from without a priced-run average');
    assert.deepEqual(stats.top_tickets, []);
  });

  // ── Group 2.5: boardId scoping ───────────────────────────────────────────
  // The ticket plan's stage-5 signature is `getTokenUsageStats({windowMs,
  // boardId?})` — Group 2 above never exercises `boardId` (its rows use bare
  // string ticket ids like 'ticket-A' with no real Ticket row behind them),
  // so this group proves the ticket→column→board resolution independently,
  // on a time window isolated from every other group's seeded data.
  await t.test('getTokenUsageStats boardId scoping — same-board tickets only, zero-ticket board short-circuits', async () => {
    const scopedNow = new Date(Date.now() - 300 * HOUR);

    const boardA = await createBoard(app, getDataSourceToken, ws.id, { name: 'usage-board-a' });
    const colA = await createColumn(app, getDataSourceToken, boardA.id, { name: 'active', position: 1, workspaceId: ws.id });
    const ticketA = await createTicket(app, getDataSourceToken, { columnId: colA.id, workspaceId: ws.id, title: 'Board A ticket' });

    const boardB = await createBoard(app, getDataSourceToken, ws.id, { name: 'usage-board-b' });
    const colB = await createColumn(app, getDataSourceToken, boardB.id, { name: 'active', position: 1, workspaceId: ws.id });
    const ticketB = await createTicket(app, getDataSourceToken, { columnId: colB.id, workspaceId: ws.id, title: 'Board B ticket' });

    const emptyBoard = await createBoard(app, getDataSourceToken, ws.id, { name: 'usage-board-empty' });

    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticketA.id, ticketTitle: ticketA.title,
      startedAt: new Date(scopedNow.getTime() - 1 * HOUR), endedAt: new Date(scopedNow.getTime() - 1 * HOUR + 1000),
      usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.05 },
    });
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticketB.id, ticketTitle: ticketB.title,
      startedAt: new Date(scopedNow.getTime() - 30 * 60_000), endedAt: new Date(scopedNow.getTime() - 30 * 60_000 + 1000),
      usage: { input_tokens: 3000, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.07 },
    });
    await seedActivityLog(activityRepo, { action: 'respawn_storm_halted', createdAt: new Date(scopedNow.getTime() - 20 * 60_000), ticketId: ticketA.id, workspaceId: ws.id });
    await seedActivityLog(activityRepo, { action: 'comment_pingpong_suppressed', createdAt: new Date(scopedNow.getTime() - 10 * 60_000), ticketId: ticketB.id, workspaceId: ws.id });

    step('boardId=A scopes totals/top_tickets/suppression count to ticketA only');
    const statsA = await usageSvc.getTokenUsageStats({ windowMs: 24 * HOUR, now: scopedNow, boardId: boardA.id });
    assert.equal(statsA.coverage.runs_total, 1, 'only the boardA-ticket row counts');
    assert.equal(statsA.totals.input_tokens, 2000);
    assert.equal(statsA.totals.output_tokens, 400);
    assert.equal(statsA.top_tickets.length, 1);
    assert.equal(statsA.top_tickets[0].ticket_id, ticketA.id);
    assert.equal(statsA.suppressed_attempts_in_window, 1, 'only the ticketA suppression event counts');

    step('boardId=B scopes to ticketB only');
    const statsB = await usageSvc.getTokenUsageStats({ windowMs: 24 * HOUR, now: scopedNow, boardId: boardB.id });
    assert.equal(statsB.coverage.runs_total, 1);
    assert.equal(statsB.totals.input_tokens, 3000);
    assert.equal(statsB.suppressed_attempts_in_window, 1);

    step('unscoped stats over the same isolated window sum both boards');
    const statsAll = await usageSvc.getTokenUsageStats({ windowMs: 24 * HOUR, now: scopedNow });
    assert.equal(statsAll.coverage.runs_total, 2);
    assert.equal(statsAll.totals.input_tokens, 2000 + 3000);
    assert.equal(statsAll.suppressed_attempts_in_window, 2);

    step('a board with zero tickets short-circuits to the null/zero shape');
    const statsEmpty = await usageSvc.getTokenUsageStats({ windowMs: 24 * HOUR, now: scopedNow, boardId: emptyBoard.id });
    assert.equal(statsEmpty.coverage.runs_total, 0);
    assert.equal(statsEmpty.priced_runs, 0);
    assert.equal(statsEmpty.avg_cost_per_run_usd_priced_only, null);
    assert.equal(statsEmpty.estimated_saved_usd, null);
    assert.deepEqual(statsEmpty.top_tickets, []);

    await subRepo.delete({ ticket_id: ticketA.id });
    await subRepo.delete({ ticket_id: ticketB.id });
  });

  // ── Group 3: controller wiring ──────────────────────────────────────────
  await t.test('WorkflowHealthController embeds token_usage in the combined rollup and exposes it standalone', async () => {
    const controllerModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'admin', 'workflow-health.controller.js')
    );
    const controller = app.get(controllerModule.WorkflowHealthController);

    step('GET / (combined rollup) — token_usage riding alongside the existing sub-rollups');
    const rollupRes = fakeRes();
    await controller.health(undefined, rollupRes);
    assert.ok(rollupRes.body.token_usage, 'combined rollup embeds a non-null token_usage');
    assert.equal(typeof rollupRes.body.token_usage.window_minutes, 'number');
    assert.ok('suppression_stats' in rollupRes.body, 'existing 3970db66 sub-rollups are untouched by this addition');

    step('GET /token-usage (standalone) — same shape as the embedded field');
    const standaloneRes = fakeRes();
    await controller.tokenUsage(undefined, standaloneRes);
    assert.equal(typeof standaloneRes.body.coverage.runs_total, 'number');
    assert.equal(typeof standaloneRes.body.avg_cost_per_run_usd_priced_only === 'number' || standaloneRes.body.avg_cost_per_run_usd_priced_only === null, true);

    step('GET /token-usage?board_id= (standalone) forwards board_id through to the service scoping');
    const scopedRes = fakeRes();
    await controller.tokenUsage('non-existent-board-id', scopedRes);
    assert.equal(scopedRes.body.coverage.runs_total, 0, 'a board_id matching no board resolves to zero tickets, same as AgentUsageService directly');
    assert.deepEqual(scopedRes.body.top_tickets, []);
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));

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
//     suppression-event count (historical activity rows — the respawn-storm
//     detector that wrote them, and its lifetime counter, are gone).
//   Controller wiring: the combined workflow-health rollup embeds token_usage,
//     and the standalone /token-usage endpoint returns the same shape.
//   일별 롤업(ticket 8d5c6f5d, 후속): SubagentMonitorService의 sweep이 곧
//     reap될 usage를 (workspace_id, usage_date, agent_id)로 묶어
//     AgentUsageDailyRollup에 접어 넣은 뒤, 원본 row와 log line을 지운다 —
//     이 전부가 하나의 트랜잭션. 아직 live인 row는 같은 sweep에서 손대지
//     않고 살아남고, 두 번째 sweep tick은 기존 롤업 row를 덮어쓰지 않고
//     증분하며, AgentUsageService.getLongTermUsageStats(롤업 SUM + live
//     SUM, day-aligned)는 sweep 경계 전후로 정확히 같은 합산 총합을
//     돌려준다 — 전체 설계가 기대는 disjoint 불변식.
//   재진입 가드(ticket 3c6422f1, 후속): 겹친 두 _sweepEnded() 호출 중
//     두 번째는 DB를 아예 건드리지 않고 skip되고(스캔 호출 횟수로 증명),
//     같은 배치가 롤업에 두 번 접히지 않으며, isSweeping 플래그는 항상
//     false로 복귀한다(영구 lockout 없음).

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
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_AGENT_USAGE_PORT || '0';

const HOUR = 3_600_000;
let subCounter = 0;

/**
 * Insert a Subagent row directly with an already-ended lifecycle + usage
 * columns. started_at/ended_at are plain @Column Date fields (not
 * @CreateDateColumn), so a historical timestamp can be written on insert.
 */
async function seedSubagent(subRepo, {
  workspaceId, ticketId = null, ticketTitle = null, role = null,
  startedAt, endedAt = null, usage = {}, agentId = 'agent-usage-fixture',
  // Group 1/2/2.5 호출부는 전부 null로 남긴다(sweep 대상 안 됨: NULL은
  // 두 dialect 모두에서 `expires_at < now`를 만족 못함). Group 4(ticket
  // 8d5c6f5d)는 row를 sweep 대상으로 만들려고 과거 Date를 넘기거나,
  // sweep을 거쳐도 살아있어야 하는 아직-만료 안 된 row를 흉내내려고
  // 미래 Date를 넘긴다.
  expiresAt = null,
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
    expires_at: expiresAt,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    total_cost_usd: usage.total_cost_usd ?? null,
    usage_model: usage.usage_model ?? null,
  }));
}

/** ActivityLog.created_at IS a @CreateDateColumn — insert then backdate via a
 *  separate UPDATE. */
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

    step('estimated_saved_usd derives from a WINDOWED suppression count, not a lifetime one');
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

  // ── Group 3: controller wiring ──────────────────────────────────────────
  await t.test('WorkflowHealthController embeds token_usage in the combined rollup and exposes it standalone', async () => {
    const controllerModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'admin', 'workflow-health.controller.js')
    );
    const controller = app.get(controllerModule.WorkflowHealthController);

    step('GET / (combined rollup) — token_usage embedded, window_minutes mirrored at the top level');
    const rollupRes = fakeRes();
    await controller.health(rollupRes);
    assert.ok(rollupRes.body.token_usage, 'combined rollup embeds a non-null token_usage');
    assert.equal(typeof rollupRes.body.token_usage.window_minutes, 'number');
    assert.equal(rollupRes.body.window_minutes, rollupRes.body.token_usage.window_minutes);
    assert.equal(typeof rollupRes.body.generated_at, 'string');
    // docs/tickets.md → Workflow health: storms / respawns / suppressions went
    // away with the respawn-storm detector — only the usage rollups remain.
    assert.ok(!('suppression_stats' in rollupRes.body), 'removed respawn-storm sub-rollups must not reappear');

    step('GET /token-usage (standalone) — same shape as the embedded field');
    const standaloneRes = fakeRes();
    await controller.tokenUsage(standaloneRes);
    assert.equal(typeof standaloneRes.body.coverage.runs_total, 'number');
    assert.equal(typeof standaloneRes.body.avg_cost_per_run_usd_priced_only === 'number' || standaloneRes.body.avg_cost_per_run_usd_priced_only === null, true);
    assert.deepEqual(Object.keys(standaloneRes.body).sort(), Object.keys(rollupRes.body.token_usage).sort(), 'standalone and embedded token_usage share one shape');
  });

  // ── Group 4: sweep 시 일별 롤업 접기(ticket 8d5c6f5d) ─────────────────────
  await t.test('_sweepEnded folds expired usage into AgentUsageDailyRollup, deletes originals + lines, and getLongTermUsageStats stays invariant across the sweep boundary', async () => {
    const monitorModule = await import(
      'file://' + path.join(DIST_ROOT, 'services', 'subagent-monitor.service.js')
    );
    const monitorSvc = app.get(monitorModule.SubagentMonitorService);
    const rollupRepo = ds.getRepository('AgentUsageDailyRollup');
    const linesRepo = ds.getRepository('SubagentLogLine');

    // "now"로부터 수년 떨어진 고정 달력 날짜 — 같은 workspace 안 다른
    // 그룹들의 now()-상대적 시드 row와 완전히 격리된다.
    const day = '2020-01-15';
    const dayStart = new Date(`${day}T10:00:00.000Z`);
    const past = new Date(Date.now() - 60_000); // 이미 retention을 넘김 → sweep 대상
    const future = new Date(Date.now() + 60 * 60_000); // 아직 안 만료 → sweep에서도 살아남아야 함

    step('seed 2 expired rows for agent A (same day), 1 expired uninstrumented row for agent B, 1 still-live row');
    const a1 = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-A',
      startedAt: dayStart, endedAt: dayStart, expiresAt: past,
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, total_cost_usd: 0.01 },
    });
    const a2 = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-A',
      startedAt: new Date(dayStart.getTime() + HOUR), endedAt: new Date(dayStart.getTime() + HOUR), expiresAt: past,
      usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 75, total_cost_usd: 0.02 },
    });
    const b1 = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-B',
      startedAt: dayStart, endedAt: dayStart, expiresAt: past,
      usage: {}, // 계측 안 됨 — runs_total엔 잡히지만 runs_with_usage/priced_runs엔 안 잡힘
    });
    const live1 = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-A',
      startedAt: dayStart, endedAt: dayStart, expiresAt: future,
      usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.005 },
    });
    await linesRepo.save(linesRepo.create({ subagent_id: a1.subagent_id, seq: 1, direction: 'out', line: 'hello', ts: dayStart }));

    step('getLongTermUsageStats BEFORE sweep — all 4 rows still live, nothing rolled up yet');
    const before = await usageSvc.getLongTermUsageStats({ workspaceId: ws.id, from: dayStart, to: dayStart });
    assert.equal(before.coverage.runs_total, 4);
    assert.equal(before.coverage.runs_with_usage, 3, 'b1 is uninstrumented');
    assert.equal(before.totals.input_tokens, 1000 + 2000 + 300);
    assert.equal(before.priced_runs, 3);

    step('run the sweep');
    await monitorSvc._sweepEnded();

    step('the 3 expired rows (a1, a2, b1) and a1’s log line are gone; the still-live row survives untouched');
    assert.equal(await subRepo.findOne({ where: { subagent_id: a1.subagent_id } }), null);
    assert.equal(await subRepo.findOne({ where: { subagent_id: a2.subagent_id } }), null);
    assert.equal(await subRepo.findOne({ where: { subagent_id: b1.subagent_id } }), null);
    assert.notEqual(await subRepo.findOne({ where: { subagent_id: live1.subagent_id } }), null, 'not-yet-expired row must survive the sweep');
    assert.deepEqual(await linesRepo.find({ where: { subagent_id: a1.subagent_id } }), [], 'log line deleted alongside its subagent row');

    step('AgentUsageDailyRollup has one row per (workspace, day, agent) — a1+a2 folded into agent A’s row, b1 into its own');
    const rollupA = await rollupRepo.findOne({ where: { workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-A' } });
    assert.ok(rollupA, 'agent A rollup row created');
    assert.equal(rollupA.runs_total, 2);
    assert.equal(rollupA.runs_with_usage, 2);
    assert.equal(rollupA.priced_runs, 2);
    assert.equal(rollupA.input_tokens, 1000 + 2000);
    assert.equal(rollupA.output_tokens, 100 + 200);
    assert.equal(rollupA.cache_read_input_tokens, 50 + 0);
    assert.equal(rollupA.cache_creation_input_tokens, 0 + 75);
    assert.ok(Math.abs(rollupA.total_cost_usd - 0.03) < 1e-9, `got ${rollupA.total_cost_usd}`);

    const rollupB = await rollupRepo.findOne({ where: { workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-B' } });
    assert.ok(rollupB, 'agent B gets its own row, not merged with agent A');
    assert.equal(rollupB.runs_total, 1);
    assert.equal(rollupB.runs_with_usage, 0, 'uninstrumented row');
    assert.equal(rollupB.priced_runs, 0);

    step('getLongTermUsageStats AFTER sweep — merged (rollup + still-live) total unchanged from BEFORE (the core invariant)');
    const after = await usageSvc.getLongTermUsageStats({ workspaceId: ws.id, from: dayStart, to: dayStart });
    assert.equal(after.coverage.runs_total, before.coverage.runs_total);
    assert.equal(after.coverage.runs_with_usage, before.coverage.runs_with_usage);
    assert.equal(after.totals.input_tokens, before.totals.input_tokens);
    assert.equal(after.totals.output_tokens, before.totals.output_tokens);
    assert.equal(after.totals.cache_read_input_tokens, before.totals.cache_read_input_tokens);
    assert.equal(after.totals.cache_creation_input_tokens, before.totals.cache_creation_input_tokens);
    assert.equal(after.priced_runs, before.priced_runs);
    // float 필드는 epsilon으로 비교한다 — before/after가 서로 다른 계산
    // 경로를 타므로(before는 live 테이블 하나의 SQL SUM, after는 롤업 컬럼
    // SUM + 더 작아진 두 row-set에 대한 live 테이블 SUM) 수치적으로는
    // 같아도 bit 단위까지 같으리란 보장은 없다.
    assert.ok(
      Math.abs(after.totals.total_cost_usd - before.totals.total_cost_usd) < 1e-9,
      `cost invariant broken: before=${before.totals.total_cost_usd} after=${after.totals.total_cost_usd}`,
    );
    assert.ok(
      Math.abs(after.avg_cost_per_run_usd_priced_only - before.avg_cost_per_run_usd_priced_only) < 1e-9,
    );

    step('a second sweep tick on a NEW batch for the same (workspace, day, agent) increments the existing rollup row instead of overwriting it');
    await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-A',
      startedAt: dayStart, endedAt: dayStart, expiresAt: past,
      usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.005 },
    });
    await monitorSvc._sweepEnded();
    const rollupAAfter2ndSweep = await rollupRepo.findOne({ where: { workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-A' } });
    assert.equal(rollupAAfter2ndSweep.id, rollupA.id, 'same row, incremented — not a fresh row');
    assert.equal(rollupAAfter2ndSweep.runs_total, 3);
    assert.equal(rollupAAfter2ndSweep.input_tokens, 1000 + 2000 + 500);
    assert.ok(Math.abs(rollupAAfter2ndSweep.total_cost_usd - 0.035) < 1e-9, `got ${rollupAAfter2ndSweep.total_cost_usd}`);

    await subRepo.delete({ subagent_id: live1.subagent_id });
    await rollupRepo.delete({ workspace_id: ws.id, usage_date: day });
  });

  // ── Group 5: _sweepEnded() 재진입 가드 (ticket 3c6422f1) ─────────────────
  await t.test('_sweepEnded() re-entrancy guard — an overlapping second tick is skipped before touching the DB, not double-folded into the rollup', async () => {
    const monitorModule = await import(
      'file://' + path.join(DIST_ROOT, 'services', 'subagent-monitor.service.js')
    );
    const monitorSvc = app.get(monitorModule.SubagentMonitorService);
    const rollupRepo = ds.getRepository('AgentUsageDailyRollup');

    assert.equal(monitorSvc.isSweeping, false, 'guard starts clear');

    // 다른 그룹들과 격리된 고정 날짜 + 전용 agent_id.
    const day = '2021-03-09';
    const dayStart = new Date(`${day}T09:00:00.000Z`);
    const past = new Date(Date.now() - 60_000);

    step('seed exactly 1 expired row — without the guard, an overlapping second tick would fold it into the rollup twice (222 tokens instead of 111)');
    const seeded = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-reentrancy',
      startedAt: dayStart, endedAt: dayStart, expiresAt: past,
      usage: { input_tokens: 111, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.001 },
    });

    step('spy on the repo scan the guard is supposed to prevent — call count proves the 2nd tick never reached the DB, not just "coincidentally found nothing"');
    const origFind = monitorSvc.subagents.find.bind(monitorSvc.subagents);
    let findCalls = 0;
    monitorSvc.subagents.find = (...args) => { findCalls += 1; return origFind(...args); };

    step('fire two _sweepEnded() calls with no await between them — the exact overlap the ticket describes (one tick running past 5min into the next)');
    const p1 = monitorSvc._sweepEnded();
    const p2 = monitorSvc._sweepEnded();
    await Promise.all([p1, p2]);
    monitorSvc.subagents.find = origFind;

    assert.equal(findCalls, 1, 'the overlapping call returned before its first DB read — only the winning call scanned for stale rows');
    assert.equal(monitorSvc.isSweeping, false, 'flag resets to false once the winning call finishes — no permanent lockout');

    step('the row was folded into the rollup exactly once — no lost-update / double-count from the overlap');
    assert.equal(await subRepo.findOne({ where: { subagent_id: seeded.subagent_id } }), null, 'swept exactly once');
    const rollup = await rollupRepo.findOne({ where: { workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-reentrancy' } });
    assert.ok(rollup, 'rollup row created by the winning call');
    assert.equal(rollup.runs_total, 1, 'exactly 1 run folded in — the guarded call contributed 0');
    assert.equal(rollup.input_tokens, 111, 'not double-counted (would be 222 without the guard)');

    step('a later, non-overlapping call still runs normally — the guard only blocks true overlap, not future ticks');
    await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-reentrancy',
      startedAt: dayStart, endedAt: dayStart, expiresAt: past,
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    await monitorSvc._sweepEnded();
    const rollupAfter3rd = await rollupRepo.findOne({ where: { workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-reentrancy' } });
    assert.equal(rollupAfter3rd.runs_total, 2, 'sequential (non-overlapping) call still increments normally');

    await rollupRepo.delete({ workspace_id: ws.id, usage_date: day, agent_id: 'rollup-agent-reentrancy' });
  });

  await t.test('getLongTermUsageStats — unbounded `from` sums all-time, an empty range returns zeros/nulls without crashing', async () => {
    const isolatedDay = '2019-06-01';
    const startedAt = new Date(`${isolatedDay}T00:00:00.000Z`);
    const seeded = await seedSubagent(subRepo, {
      workspaceId: ws.id, agentId: 'rollup-agent-alltime',
      startedAt, endedAt: startedAt, expiresAt: new Date(Date.now() - 60_000),
      usage: { input_tokens: 42, output_tokens: 7, total_cost_usd: 0.001 },
    });
    const monitorModule = await import(
      'file://' + path.join(DIST_ROOT, 'services', 'subagent-monitor.service.js')
    );
    const monitorSvc = app.get(monitorModule.SubagentMonitorService);
    await monitorSvc._sweepEnded();

    step('from omitted = all-time — the 2019 row is included with no lower bound');
    const allTime = await usageSvc.getLongTermUsageStats({ workspaceId: ws.id, to: startedAt });
    assert.equal(allTime.from, null);
    assert.ok(allTime.totals.input_tokens >= 42, 'includes the 2019 row');

    step('a date range matching nothing returns zeros, not a crash — null avg cost since priced_runs is 0');
    const empty = await usageSvc.getLongTermUsageStats({
      workspaceId: ws.id,
      from: new Date('2015-01-01T00:00:00.000Z'),
      to: new Date('2015-01-02T00:00:00.000Z'),
    });
    assert.equal(empty.coverage.runs_total, 0);
    assert.equal(empty.priced_runs, 0);
    assert.equal(empty.avg_cost_per_run_usd_priced_only, null);
    assert.equal(empty.totals.input_tokens, 0);

    const rollupRepo = ds.getRepository('AgentUsageDailyRollup');
    await rollupRepo.delete({ workspace_id: ws.id, usage_date: isolatedDay });
    await subRepo.delete({ subagent_id: seeded.subagent_id }); // sweep이 이미 reap했으면 no-op — 어느 쪽이든 무해
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));

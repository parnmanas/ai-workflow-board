// QA flow: workflow-health/long-term-usage controller wiring (ticket 090abc77 —
// exposes 8d5c6f5d's AgentUsageService.getLongTermUsageStats over HTTP).
//
// getLongTermUsageStats() itself (rollup+live merge, disjoint invariant,
// day-alignment) is already exhaustively covered at the service layer by
// agent-usage-stats.test.mjs — this file does NOT re-test that math. It proves
// only the new HTTP surface this ticket adds, none of which agent-usage-stats
// exercises (that file calls the service directly, bypassing every guard):
//   - AdminGuard + WorkspaceGuard composition (the first controller in the
//     codebase to combine these two) actually resolves req.currentWorkspaceId
//     from both the X-Workspace-Id header and the ?workspace_id= query param.
//   - missing workspace_id / malformed from|to query params 400 instead of
//     500ing or silently misbehaving.
//   - the endpoint is workspace-scoped end-to-end through the real guard —
//     two workspaces' rollup rows stay isolated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createUser, createWorkspace } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_WORKFLOW_HEALTH_LTU_PORT || '7915';

test('workflow-health/long-term-usage: guard composition, validation, workspace scoping', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const admin = await createUser(app, getDataSourceToken, { name: 'ltu-admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const wsA = await createWorkspace(app, getDataSourceToken, 'ltu-ws-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'ltu-ws-b');

  const base = `http://localhost:${port}/api/admin/workflow-health/long-term-usage`;
  const authed = (extra = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

  await t.test('no workspace_id (header or query) → 400, not 500 or a silently-empty 200', async () => {
    const res = await fetch(base, authed());
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /workspace_id/);
  });

  await t.test('malformed from/to → 400 naming the offending param', async () => {
    const resFrom = await fetch(`${base}?from=not-a-date`, authed({ 'x-workspace-id': wsA.id }));
    assert.equal(resFrom.status, 400);
    assert.match((await resFrom.json()).error, /from/);

    const resTo = await fetch(`${base}?to=also-not-a-date`, authed({ 'x-workspace-id': wsA.id }));
    assert.equal(resTo.status, 400);
    assert.match((await resTo.json()).error, /to/);
  });

  step('seed one persisted rollup row in wsA only (wsB stays empty)');
  const rollupRepo = ds.getRepository('AgentUsageDailyRollup');
  await rollupRepo.save(rollupRepo.create({
    workspace_id: wsA.id,
    usage_date: '2026-01-15',
    agent_id: 'ltu-fixture-agent',
    runs_total: 3,
    runs_with_usage: 3,
    priced_runs: 2,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 4.5,
  }));

  await t.test('X-Workspace-Id header resolves scoping — wsA sees the row, wsB does not', async () => {
    const resA = await fetch(`${base}?from=2026-01-01&to=2026-01-31`, authed({ 'x-workspace-id': wsA.id }));
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.totals.input_tokens, 1000);
    assert.equal(bodyA.totals.total_cost_usd, 4.5);
    assert.equal(bodyA.priced_runs, 2);

    const resB = await fetch(`${base}?from=2026-01-01&to=2026-01-31`, authed({ 'x-workspace-id': wsB.id }));
    assert.equal(resB.status, 200);
    assert.equal((await resB.json()).totals.input_tokens, 0);
  });

  await t.test('?workspace_id= query param resolves scoping too (EventSource-style callers)', async () => {
    const res = await fetch(`${base}?workspace_id=${wsA.id}&from=2026-01-01&to=2026-01-31`, authed());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).totals.input_tokens, 1000);
  });

  await t.test('from omitted → all-time, from:null echoed back', async () => {
    const res = await fetch(base, authed({ 'x-workspace-id': wsA.id }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.from, null);
    assert.equal(body.totals.input_tokens, 1000);
  });

  await rollupRepo.delete({ workspace_id: wsA.id, usage_date: '2026-01-15' });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));

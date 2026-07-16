// Regression: the ticket detail panel's **Activity** and **User (pending)**
// tabs must render an agent as its canonical `<Manager>/<Agent>` display —
// never the bare leaf name (ticket 51b1519d).
//
// Two denormalized snapshot fields feed those tabs, and each is fixed on a
// different side because they have different shapes:
//
//   1. Activity tab → `ActivityLog.actor_name`. Carries a companion
//      `actor_id`, so ActivityService re-resolves it on READ. This fixes rows
//      already persisted with a bare name (the high-churn activity_logs table
//      is deliberately never backfilled) AND leaves non-agent actors (users,
//      system labels) untouched.
//
//   2. User (pending) tab → `Ticket.pending_set_by`. A lone display string
//      with NO id to re-resolve on read, so the MCP write paths (`pend_ticket`
//      / `update_ticket` pending toggle) stamp the canonical name at WRITE via
//      resolveCallerDisplayName. Verified end-to-end through the real /mcp
//      transport so the API-key → caller.agentId → Manager/Agent chain the
//      production dispatch rides is what the assertion covers.
//
// Imports the compiled server from dist/ (built by `npm run build`).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createUser,
  createApiKey,
  setupKanbanScene,
  createTicket,
} from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

const BASE_PORT = parseInt(process.env.QA_AGENT_FULLNAME_PORT || '7881', 10);

const { app, modules } = await bootApp({ port: BASE_PORT });
after(() => { void app.close().catch(() => {}); });
const { getDataSourceToken, ActivityService } = modules;
const ds = app.get(getDataSourceToken());

// ── Shared scene: one workspace, a managed agent (has a manager → prefixed
//    display), an unmanaged standalone agent (bare display), a human user, and
//    a ticket to hang activity / pending state on. ────────────────────────────
const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'fullname' });

const manager = await createAgent(app, getDataSourceToken, ws.id, { name: 'Mgr', type: 'manager' });
const managed = await createAgent(app, getDataSourceToken, ws.id, { name: 'Coder' });
await ds.getRepository('Agent').update({ id: managed.id }, { manager_agent_id: manager.id });
const standalone = await createAgent(app, getDataSourceToken, ws.id, { name: 'Solo' });
const user = await createUser(app, getDataSourceToken, { name: 'Human' });

const MANAGED_DISPLAY = `${manager.name}/${managed.name}`;

const ticket = await createTicket(app, getDataSourceToken, {
  columnId: columns.todo.id,
  workspaceId: ws.id,
  title: 'fullname display',
  assigneeId: managed.id,
});

// ─── Activity tab (READ-side resolution) ─────────────────────────────────────
test('Activity tab: actor_name re-resolves to <Manager>/<Agent> from actor_id', async () => {
  const activityService = app.get(ActivityService);

  // Rows deliberately written with WRONG/bare actor_name to prove the read side
  // — not a write mutation — supplies the canonical name.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'managed', actor_id: managed.id, actor_name: 'Coder-bare-leaf',
  });
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'standalone', actor_id: standalone.id, actor_name: 'stale-whatever',
  });
  // System actor: no actor_id → the stored label must survive verbatim.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'moved',
    field_changed: 'system', actor_id: '', actor_name: 'BacklogPromotionService',
  });
  // Human actor: actor_id is a User id (never an Agent) → name untouched.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'user', actor_id: user.id, actor_name: user.name,
  });
  // Already-canonical agent row: must stay identical (idempotent).
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'already-full', actor_id: managed.id, actor_name: MANAGED_DISPLAY,
  });

  const rows = await activityService.getTicketActivity(ticket.id);
  const byField = new Map(rows.map(r => [r.field_changed, r]));

  // managed agent → manager-prefixed display
  assert.equal(byField.get('managed')?.actor_name, MANAGED_DISPLAY,
    `managed actor must read back as "${MANAGED_DISPLAY}", got "${byField.get('managed')?.actor_name}"`);
  assert.ok(byField.get('managed')?.actor_name.includes('/'), 'managed display must carry the manager prefix');

  // standalone (no manager) → bare name, no prefix
  assert.equal(byField.get('standalone')?.actor_name, standalone.name,
    'unmanaged agent must resolve to its bare name');
  assert.ok(!byField.get('standalone')?.actor_name.includes('/'), 'unmanaged agent must NOT gain a prefix');

  // system + user actors keep their stored label
  assert.equal(byField.get('system')?.actor_name, 'BacklogPromotionService',
    'system label (no actor_id) must survive verbatim');
  assert.equal(byField.get('user')?.actor_name, user.name,
    'user actor_id (not an agent) must not be clobbered');

  // idempotent on already-canonical rows
  assert.equal(byField.get('already-full')?.actor_name, MANAGED_DISPLAY,
    'already-canonical row must be unchanged');

  // The persisted (fallback) row is STILL bare — proves this is a READ-side
  // projection, not a write mutation.
  const stored = await ds.getRepository('ActivityLog').findOne({
    where: { ticket_id: ticket.id, field_changed: 'managed' },
  });
  assert.equal(stored.actor_name, 'Coder-bare-leaf',
    'persisted row must remain bare; only the read projection is canonicalized');
});

// ─── User (pending) tab (WRITE-side stamp), end-to-end via /mcp ──────────────
test('User tab: pend_ticket stamps pending_set_by as <Manager>/<Agent>', async () => {
  const key = await createApiKey(app, getDataSourceToken, managed.id, { workspaceId: ws.id, label: 'pend' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${BASE_PORT}`, apiKey: key.raw_key });
  after(() => { void client.close().catch(() => {}); });

  const pendTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'pend me',
    assigneeId: managed.id,
  });

  const result = await client.callTool('pend_ticket', { ticket_id: pendTicket.id, reason: 'need a human' });
  assert.ok(result && !result.isError, `pend_ticket must succeed, got ${JSON.stringify(result)}`);
  assert.equal(result.pending_set_by, MANAGED_DISPLAY,
    `returned pending_set_by must be "${MANAGED_DISPLAY}", got "${result.pending_set_by}"`);
  assert.ok(String(result.pending_set_by).includes('/'), 'pending_set_by must carry the manager prefix');

  const stored = await ds.getRepository('Ticket').findOne({ where: { id: pendTicket.id } });
  assert.equal(stored.pending_set_by, MANAGED_DISPLAY, 'persisted pending_set_by must be canonical too');
  assert.equal(stored.pending_user_action, true, 'ticket must be parked');
});

exitAfterTests();

// Regression: the ticket detail panel's **Activity** and **User (pending)**
// tabs must render an agent as its canonical display — never a bare leaf name
// or raw id (ticket 51b1519d).
//
// P4c-4: the Agent table is dropped, so a linked legacy uuid resolves to its
// **Host's bare name** (the Host IS the execution identity — unambiguous, not
// a leaf). The read-vs-write distinction below is unchanged: Activity
// re-resolves on READ via the companion actor_id, pending_set_by is stamped
// at WRITE (no id to re-resolve).
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
import { openSseStream } from './helpers/sse-listener.mjs';

// 부팅 포트는 OS 가 배정한다(0). 특정 번호에 붙어야 할 때만 env 로 고정한다.
const REQUESTED_PORT = parseInt(process.env.QA_AGENT_FULLNAME_PORT || '0', 10);

const { app, port, modules } = await bootApp({ port: REQUESTED_PORT });
after(() => { void app.close().catch(() => {}); });
const { getDataSourceToken, ActivityService } = modules;
const ds = app.get(getDataSourceToken());

// ── Shared scene: one workspace, a managed agent (has a manager → prefixed
//    display), its Runtime Host identity (bare display), a human user, and
//    a ticket to hang activity / pending state on. ────────────────────────────
const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'fullname' });

const manager = await createAgent(app, getDataSourceToken, ws.id, { name: 'Mgr', type: 'manager' });
const managed = await createAgent(app, getDataSourceToken, ws.id, {
  name: 'Coder',
  type: 'hermes',
  hosted: false,
});
// P4c-4: managed→manager 연결은 api_keys 페어링 링크다 (Agent 행 없음).
await createApiKey(app, getDataSourceToken, managed.id, {
  workspaceId: ws.id, hostId: manager.id, label: 'managed-link',
});
const user = await createUser(app, getDataSourceToken, { name: 'Human' });

// P4c-4: linked uuid 는 Host bare name 으로 해소된다 (runbook agent-display-name P4c-4 단서).
const MANAGED_DISPLAY = manager.name;

const ticket = await createTicket(app, getDataSourceToken, {
  columnId: columns.todo.id,
  workspaceId: ws.id,
  title: 'fullname display',
  assigneeId: managed.id,
});

// ─── Activity tab (READ-side resolution) ─────────────────────────────────────
test('Activity tab: actor_name re-resolves to the Host bare name from actor_id', async () => {
  const activityService = app.get(ActivityService);

  // Rows deliberately written with WRONG/bare actor_name to prove the read side
  // — not a write mutation — supplies the canonical name.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'managed', actor_id: managed.id, actor_name: 'Coder-bare-leaf',
  });
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'runtime-host', actor_id: manager.id, actor_name: 'stale-whatever',
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
  // Stale prefixed row: the read projection re-resolves via actor_id, so the
  // old `<Manager>/<Agent>` text reads back as the current Host name.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'already-full', actor_id: managed.id, actor_name: 'Mgr/Coder',
  });

  const rows = await activityService.getTicketActivity(ticket.id);
  const byField = new Map(rows.map(r => [r.field_changed, r]));

  // linked managed id → its Host's bare name (unambiguous: no leaf on screen)
  assert.equal(byField.get('managed')?.actor_name, MANAGED_DISPLAY,
    `managed actor must read back as "${MANAGED_DISPLAY}", got "${byField.get('managed')?.actor_name}"`);
  assert.ok(!byField.get('managed')?.actor_name.includes('/'), 'linked display is the bare Host name, not a prefixed pair');

  // Runtime Host (no parent host) → bare name, no prefix
  assert.equal(byField.get('runtime-host')?.actor_name, manager.name,
    'Runtime Host must resolve to its bare name');
  assert.ok(!byField.get('runtime-host')?.actor_name.includes('/'),
    'Runtime Host must NOT gain a prefix');

  // system + user actors keep their stored label
  assert.equal(byField.get('system')?.actor_name, 'BacklogPromotionService',
    'system label (no actor_id) must survive verbatim');
  assert.equal(byField.get('user')?.actor_name, user.name,
    'user actor_id (not an agent) must not be clobbered');

  // stale prefixed text is re-resolved to the current canonical display
  assert.equal(byField.get('already-full')?.actor_name, MANAGED_DISPLAY,
    'stale prefixed row must read back as the current Host display');

  // The persisted (fallback) row is STILL bare — proves this is a READ-side
  // projection, not a write mutation.
  const stored = await ds.getRepository('ActivityLog').findOne({
    where: { ticket_id: ticket.id, field_changed: 'managed' },
  });
  assert.equal(stored.actor_name, 'Coder-bare-leaf',
    'persisted row must remain bare; only the read projection is canonicalized');
});

// ─── User (pending) tab (WRITE-side stamp), end-to-end via /mcp ──────────────
test('User tab: pend_ticket stamps pending_set_by as the Host bare name', async () => {
  // P4c-4: 호출자 키 자체가 host 바인딩이다 (단일 행 — 해소가 결정적이다).
  const key = await createApiKey(app, getDataSourceToken, managed.id, { workspaceId: ws.id, hostId: manager.id, label: 'pend' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
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
  assert.ok(!String(result.pending_set_by).includes('/'), 'pending_set_by is the bare Host display');

  const stored = await ds.getRepository('Ticket').findOne({ where: { id: pendTicket.id } });
  assert.equal(stored.pending_set_by, MANAGED_DISPLAY, 'persisted pending_set_by must be canonical too');
  assert.equal(stored.pending_user_action, true, 'ticket must be parked');
});

// ─── User (pending) tab: the OTHER write path — update_ticket toggle ─────────
// pend_ticket is not the only stamp site: update_ticket's
// `pending_user_action: false→true` branch (ticket-crud-tools.ts) also writes
// pending_set_by via resolveCallerDisplayName. Exercise it end-to-end through
// the real /mcp transport so the API-key → caller.agentId → Manager/Agent chain
// is what the assertion covers, and assert BOTH the returned ticket and the
// persisted row carry the canonical name.
test('User tab: update_ticket pending toggle stamps pending_set_by as the Host bare name', async () => {
  const key = await createApiKey(app, getDataSourceToken, managed.id, { workspaceId: ws.id, hostId: manager.id, label: 'upd-pend' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  after(() => { void client.close().catch(() => {}); });

  const updTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'park via update_ticket',
    assigneeId: managed.id,
  });

  const result = await client.callTool('update_ticket', {
    ticket_id: updTicket.id,
    pending_user_action: true,
    pending_reason: 'blocked on a human decision',
  });
  assert.ok(result && !result.isError, `update_ticket must succeed, got ${JSON.stringify(result)}`);
  // Returned ticket (loadTicketFull) must already reflect the canonical stamp.
  assert.equal(result.pending_set_by, MANAGED_DISPLAY,
    `returned pending_set_by must be "${MANAGED_DISPLAY}", got "${result.pending_set_by}"`);
  assert.ok(!String(result.pending_set_by).includes('/'), 'returned pending_set_by is the bare Host display');

  const stored = await ds.getRepository('Ticket').findOne({ where: { id: updTicket.id } });
  assert.equal(stored.pending_user_action, true, 'ticket must be parked via update_ticket');
  assert.equal(stored.pending_set_by, MANAGED_DISPLAY,
    `persisted pending_set_by must be canonical too, got "${stored.pending_set_by}"`);
});

// ─── Activity tab: REALTIME path (SSE board_update), not just the read ───────
// getTicketActivity canonicalizes on read, but the ticket completion condition
// also demands the *realtime* path stay consistent — otherwise a live consumer
// sees the bare leaf until it refetches. logActivity emits 'activity', the
// event-registry board_update.map projects actor_id→canonical, and the frame
// lands on the SSE wire. Drive it truly end-to-end through /api/events/stream.
test('Realtime board_update SSE: actor_name is the canonical Host display', async () => {
  const key = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: ws.id, label: 'sse-sub' });
  // No boardId → the board_update filter (`!id.boardId || …`) delivers all.
  const sse = await openSseStream(port, key.raw_key, {});
  after(() => sse.close());

  const activityService = app.get(ActivityService);
  // Stamp the BARE leaf name at write time — the realtime frame must still
  // arrive canonicalized, exactly like the durable read path.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'updated',
    field_changed: 'sse-managed', actor_id: managed.id, actor_name: 'Coder-bare-leaf',
  });

  const frame = await sse.waitFor(
    'board_update',
    (d) => d.ticket_id === ticket.id && d.field_changed === 'sse-managed',
    8000,
  );
  assert.equal(frame.data.actor_name, MANAGED_DISPLAY,
    `realtime board_update.actor_name must be canonical "${MANAGED_DISPLAY}", got "${frame.data.actor_name}"`);
  assert.ok(!String(frame.data.actor_name).includes('/'),
    'realtime actor_name is the bare Host display');

  // Non-agent actor (system label, no actor_id) must ride the wire verbatim —
  // the projection only touches ids that resolve to an Agent row.
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'moved',
    field_changed: 'sse-system', actor_id: '', actor_name: 'BacklogPromotionService',
  });
  const sysFrame = await sse.waitFor(
    'board_update',
    (d) => d.ticket_id === ticket.id && d.field_changed === 'sse-system',
    8000,
  );
  assert.equal(sysFrame.data.actor_name, 'BacklogPromotionService',
    'system label (no actor_id) must survive the realtime path verbatim');
});

exitAfterTests();

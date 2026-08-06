// Regression test — ticket 6793ce22 (follow-up to d35b8ac8).
//
// GET /api/agents (AgentsController.list → _enrichLiveData) used to compute
// `subagents.active` from `Subagent.ended_at` alone. That column is only
// updated by the agent-manager's fire-and-forget `/end` POST or its 5-min
// reconcile backstop, so an already-exited strand whose row hadn't caught up
// yet was miscounted as active — the same staleness d35b8ac8 already fixed
// for the dispatch gate (TriggerLoopService) and the twin detector
// (RespawnStormDetectorService), both via AgentStatusService.hasLiveRoleStrand.
//
// This proves the same cross-check now applies to the REST rollup:
//   - a ticket-kind row with ended_at=null but a RELEASED seat is excluded
//     from `active` (the bug repro)
//   - a ticket-kind row with ended_at=null and a live seat still counts
//   - a plain ended_at=null/exit-code-set row (no seat ever recorded) keeps
//     the old ended_at-only behavior unaffected
//   - a chat-kind row (no ticket_id/role — hasLiveRoleStrand doesn't apply)
//     also keeps the old ended_at-only behavior, so live chat/oneshot
//     subagents are never undercounted by the new cross-check
//
// Design mirrors agents-leak.test.mjs (in-process NestJS boot, admin token,
// GET /api/agents) + respawn-storm-detector.test.mjs's seedSubagent /
// AgentStatusService.setCurrentTask/clearCurrentTask pattern.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-subagents-active-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.SUBAGENTS_ACTIVE_PORT || '7797';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

const BASE_URL = makeBaseUrl(parseInt(process.env.PORT, 10));

async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('file://' + path.join(distRoot, 'app.module.js'));
    const { AuthService } = await import('file://' + path.join(distRoot, 'services', 'auth.service.js'));
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    const { AgentStatusService } = await import(
      'file://' + path.join(distRoot, 'modules', 'agents', 'agent-status.service.js')
    );
    return { NestFactory, AppModule, AuthService, getDataSourceToken, AgentStatusService };
  } catch (err) {
    throw new Error(
      'Test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

let subCounter = 0;
// Direct-insert helper (mirrors respawn-storm-detector.test.mjs's
// seedSubagent) — started_at/ended_at are plain @Column Date fields, not
// @CreateDateColumn, so a specific value can be written on insert.
async function seedSubagent(subRepo, { agentId, workspaceId, kind, ticketId = null, role = null, endedAt = null }) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-active-fixture-${subCounter}-${randomUUID()}`,
    agent_id: agentId,
    workspace_id: workspaceId,
    kind,
    session_key: ticketId ? `${ticketId}:${role}` : `chat-${subCounter}`,
    pid: 1000 + subCounter,
    started_at: new Date(Date.now() - 60_000),
    ticket_id: ticketId,
    ticket_title: ticketId ? 'subagents-active probe' : null,
    role,
    ended_at: endedAt,
    exit_code: endedAt ? 0 : null,
    signal: null,
    duration_ms: endedAt ? 60_000 : null,
    line_count: 0,
  }));
}

describe('agents subagents.active — hasLiveRoleStrand cross-check (ticket 6793ce22)', async () => {
  let app;
  let adminToken;
  let ws;
  let subRepo;
  let agentStatus;
  let testAgents;

  const ADMIN_EMAIL = `subagents-active-admin-${randomUUID()}@awb.local`;

  before(async () => {
    const { NestFactory, AppModule, AuthService, getDataSourceToken, AgentStatusService } = await loadServerModules();

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');

    const authService = app.get(AuthService);
    agentStatus = app.get(AgentStatusService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const wsRepo = dataSource.getRepository('Workspace');
    const agentRepo = dataSource.getRepository('Agent');
    subRepo = dataSource.getRepository('Subagent');

    const adminUser = await userRepo.save(userRepo.create({
      name: 'subagents-active-admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    ws = await wsRepo.save(wsRepo.create({ name: 'Subagents Active WS', description: 'regression test' }));

    // One agent per scenario keeps each subagents.{active,total} assertion
    // unambiguous (exactly one Subagent row per agent).
    const mkAgent = (name) => agentRepo.save(agentRepo.create({
      name: `${name}-${randomUUID()}`,
      description: 'regression test agent',
      type: 'custom',
      is_active: 1,
      is_online: 0,
      workspace_id: ws.id,
    }));

    const [liveTicket, staleTicket, endedTicket, liveChat] = await Promise.all([
      mkAgent('live-ticket'),
      mkAgent('stale-ticket'),
      mkAgent('ended-ticket'),
      mkAgent('live-chat'),
    ]);

    const ticketIdFor = () => randomUUID();

    // ── Scenario 1: genuinely live ticket-kind strand ──────────────────────
    // Row ended_at=null AND a live AgentStatusService seat → active.
    const liveTicketId = ticketIdFor();
    await agentStatus.setCurrentTask(liveTicket.id, liveTicketId, 'assignee');
    await seedSubagent(subRepo, {
      agentId: liveTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: liveTicketId, role: 'assignee', endedAt: null,
    });

    // ── Scenario 2 (the bug repro): exited-but-not-yet-reconciled ──────────
    // Row ended_at=null (agent-manager hasn't POSTed /end yet) BUT the seat
    // was already released (clear_current_task fired) — must NOT count as
    // active under the fix; the OLD ended_at-only check would have counted it.
    const staleTicketId = ticketIdFor();
    await agentStatus.setCurrentTask(staleTicket.id, staleTicketId, 'assignee');
    agentStatus.clearCurrentTask(staleTicket.id, staleTicketId);
    await seedSubagent(subRepo, {
      agentId: staleTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: staleTicketId, role: 'assignee', endedAt: null,
    });

    // ── Scenario 3 (baseline, unaffected by the fix): properly ended ───────
    // No seat ever recorded, ended_at set — must NOT count as active, same
    // as before the fix.
    await seedSubagent(subRepo, {
      agentId: endedTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: ticketIdFor(), role: 'assignee', endedAt: new Date(),
    });

    // ── Scenario 4 (regression guard): live chat-kind subagent ─────────────
    // No ticket_id/role at all (chat/oneshot never carry a ticket-role seat),
    // no AgentStatusService seat ever set — must still count as active via
    // the ended_at-only fallback, proving the cross-check doesn't undercount
    // non-ticket subagent kinds.
    await seedSubagent(subRepo, {
      agentId: liveChat.id, workspaceId: ws.id, kind: 'chat', endedAt: null,
    });

    testAgents = { liveTicket, staleTicket, endedTicket, liveChat };
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // No process.exit here — see agents-leak.test.mjs; the suite runs with
    // --test-force-exit, which hands the real node:test exit code through.
  });

  it('live ticket-kind strand (unended row + live seat) counts as active', async () => {
    const res = await apiRequest(BASE_URL, '/agents', { token: adminToken, workspaceId: ws.id });
    assert.equal(res.status, 200);
    const row = res.data.find((a) => a.id === testAgents.liveTicket.id);
    assert.ok(row, 'live-ticket agent should be present in the listing');
    assert.equal(row.subagents.total, 1);
    assert.equal(row.subagents.active, 1, 'a live seat + unended row must count as active');
  });

  it('exited-but-not-reconciled strand (unended row, released seat) is NOT counted active', async () => {
    const res = await apiRequest(BASE_URL, '/agents', { token: adminToken, workspaceId: ws.id });
    assert.equal(res.status, 200);
    const row = res.data.find((a) => a.id === testAgents.staleTicket.id);
    assert.ok(row, 'stale-ticket agent should be present in the listing');
    assert.equal(row.subagents.total, 1, 'the row still shows up in total (registry unaffected)');
    assert.equal(
      row.subagents.active, 0,
      'ended_at=null alone must not count as active once the seat was released — this is the ticket 6793ce22 fix',
    );
  });

  it('a properly ended row (no seat ever recorded) is NOT counted active — unaffected baseline', async () => {
    const res = await apiRequest(BASE_URL, '/agents', { token: adminToken, workspaceId: ws.id });
    assert.equal(res.status, 200);
    const row = res.data.find((a) => a.id === testAgents.endedTicket.id);
    assert.ok(row, 'ended-ticket agent should be present in the listing');
    assert.equal(row.subagents.total, 1);
    assert.equal(row.subagents.active, 0);
  });

  it('a live chat-kind subagent (no ticket-role seat to check) still counts as active', async () => {
    const res = await apiRequest(BASE_URL, '/agents', { token: adminToken, workspaceId: ws.id });
    assert.equal(res.status, 200);
    const row = res.data.find((a) => a.id === testAgents.liveChat.id);
    assert.ok(row, 'live-chat agent should be present in the listing');
    assert.equal(row.subagents.total, 1);
    assert.equal(
      row.subagents.active, 1,
      'chat/oneshot subagents have no ticket-role seat to cross-check — must keep the ended_at-only signal',
    );
  });
});

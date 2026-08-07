// 회귀 테스트 — 티켓 6793ce22 (d35b8ac8의 후속).
//
// GET /api/agents (AgentsController.list → _enrichLiveData)는 REST 응답의
// `subagents.active`를 `Subagent.ended_at` 단독으로 계산해왔다. 이 컬럼은
// agent-manager의 fire-and-forget `/end` POST 또는 5분 주기 reconcile
// 백스톱으로만 갱신되므로, 이미 종료된 strand의 행이 한동안 미종료 상태로
// 남아 active로 과대 집계됐다 — dispatch 게이트(TriggerLoopService)와 twin
// detector(RespawnStormDetectorService)에서 d35b8ac8이 이미 고친 것과 동일한
// staleness다(둘 다 AgentStatusService.hasLiveRoleStrand로 해소).
//
// 이 테스트는 동일한 교차검증이 REST 응답에도 적용됨을 증명한다:
//   - ticket-kind 행이 ended_at=null이지만 seat이 해제된 경우 → active에서
//     제외(핵심 버그 재현)
//   - ticket-kind 행이 ended_at=null이고 seat이 살아있는 경우 → 그대로 카운트
//   - ended_at이 설정된(정상 종료, seat 기록 없음) 행 → 기존 ended_at 단독
//     동작 그대로 유지
//   - chat-kind 행(ticket_id/role 없음 — hasLiveRoleStrand 적용 대상 아님)도
//     기존 ended_at 단독 동작을 유지해, 새 교차검증이 살아있는 chat/oneshot을
//     과소 집계하지 않음을 보장
//
// 설계는 agents-leak.test.mjs(인프로세스 NestJS 부팅, admin 토큰,
// GET /api/agents)와 respawn-storm-detector.test.mjs의 seedSubagent /
// AgentStatusService.setCurrentTask/clearCurrentTask 패턴을 그대로 따른다.

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
// 직접 삽입 헬퍼(respawn-storm-detector.test.mjs의 seedSubagent를 참고) —
// started_at/ended_at은 @CreateDateColumn이 아닌 일반 @Column Date 필드라
// insert 시점에 특정 값을 바로 기록할 수 있다.
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

    // 시나리오별로 agent를 하나씩 분리해 subagents.{active,total} 검증을
    // 모호함 없이 만든다(agent당 Subagent 행이 정확히 1개).
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

    // ── 시나리오 1: 실제로 살아있는 ticket-kind strand ──────────────────────
    // 행이 ended_at=null이고 AgentStatusService seat도 살아있음 → active.
    const liveTicketId = ticketIdFor();
    await agentStatus.setCurrentTask(liveTicket.id, liveTicketId, 'assignee');
    await seedSubagent(subRepo, {
      agentId: liveTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: liveTicketId, role: 'assignee', endedAt: null,
    });

    // ── 시나리오 2(핵심 버그 재현): 종료됐지만 아직 reconcile 안 됨 ─────────
    // 행은 ended_at=null(agent-manager가 아직 /end를 POST하지 않음)이지만
    // seat은 이미 해제됐다(clear_current_task 발생) — 수정 후에는 active로
    // 집계되면 안 된다; 기존 ended_at 단독 검사였다면 active로 집계됐을 것.
    const staleTicketId = ticketIdFor();
    await agentStatus.setCurrentTask(staleTicket.id, staleTicketId, 'assignee');
    agentStatus.clearCurrentTask(staleTicket.id, staleTicketId);
    await seedSubagent(subRepo, {
      agentId: staleTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: staleTicketId, role: 'assignee', endedAt: null,
    });

    // ── 시나리오 3(기존 동작 불변, 정상 종료): ended_at이 설정된 행 ─────────
    // seat을 기록한 적이 없고 ended_at이 설정됨 — 수정 전과 마찬가지로
    // active로 집계되면 안 된다.
    await seedSubagent(subRepo, {
      agentId: endedTicket.id, workspaceId: ws.id, kind: 'ticket',
      ticketId: ticketIdFor(), role: 'assignee', endedAt: new Date(),
    });

    // ── 시나리오 4(회귀 가드): 살아있는 chat-kind 서브에이전트 ──────────────
    // ticket_id/role 자체가 없고(chat/oneshot은 ticket-role seat을 갖지 않음)
    // AgentStatusService seat도 설정한 적 없음 — 그래도 기존 ended_at 단독
    // fallback으로 active로 집계돼야 한다(비-ticket 종류를 과소 집계하지
    // 않음을 증명).
    await seedSubagent(subRepo, {
      agentId: liveChat.id, workspaceId: ws.id, kind: 'chat', endedAt: null,
    });

    testAgents = { liveTicket, staleTicket, endedTicket, liveChat };
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // 여기서는 process.exit를 호출하지 않는다 — agents-leak.test.mjs 참고;
    // 스위트가 --test-force-exit로 실행되므로 node:test가 계산한 실제 종료
    // 코드가 그대로 전달된다.
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

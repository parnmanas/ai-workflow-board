// Slot credential resolution + provisioning (P4c-4 회귀).
//
// P4c-4가 Agent 테이블과 함께 `GET managed-agents/:id/credential` 을 지우면서,
// 매니저의 spawn_agent/restart_agent credential fetch가 전부 404가 됐다. 그
// 이후 슬롯에 credential을 적어도 cli-home에 절대 써지지 않아 디스패치는
// "Not logged in"으로 죽고, 되는 건 credential 전용 경로가 따로 있는 Agent
// Session뿐이었다 ("같은 UI인데 어떤 건 되고 어떤 건 안 되고").
//
// 고정하는 계약:
//   1. resolver가 팀 슬롯(오케스트레이터/멤버)·미션 임시 멤버·티켓 assignee·
//      챗 참가자 spec에서 identity → {credential_id, host, account} 를 찾는다.
//   2. 컨트롤러가 모르는 identity 404 / credential 없음 204 /
//      타 호스트 403 / 타 계정 403 / 행 삭제 404 를 정확히 돌려준다.
//   3. provisionSlotIdentity가 이미 materialize된 identity는 조용히 건너뛰고
//      (heartbeat-skip), 나머지는 spawn_agent를 쏜다. 절대 throw하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { resolveSlotCredentialSources } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'agent-manager', 'slot-credential-resolver.js')).href
);
const { AgentManagerCommandService } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'agent-manager', 'agent-manager-command.service.js')).href
);
const { AgentManagerController } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'agent-manager', 'agent-manager.controller.js')).href
);
const { runtimeIdentityKey } = await import(
  pathToFileURL(path.join(DIST, 'common', 'runtime-spec.js')).href
);

const SPEC = (over = {}) => ({
  manager_agent_id: 'host-1',
  cli: 'claude',
  model: 'opus',
  working_dir: '/repo',
  folder_scope: 'shared',
  credential_id: 'cred-1',
  cli_runtime_profile: null,
  runtime_config: { strategy: 'single', permission_mode: 'approve' },
  ...over,
});

/** getRepository(EntityClass) → canned rows. */
function stubDataSource({ members = [], teams = [], missions = [], tickets = [], participants = [], rooms = [] } = {}) {
  const byName = {
    OrchestrationTeamMember: members,
    OrchestrationTeam: teams,
    OrchestrationMission: missions,
    Ticket: tickets,
    ChatRoomParticipant: participants,
    ChatRoom: rooms,
  };
  const match = (rows, where) =>
    rows.filter((r) =>
      Object.entries(where || {}).every(([k, v]) => {
        // TypeORM FindOperator (In([...])) — 값 객체의 value 배열로 포함 판정.
        if (v !== null && typeof v === 'object' && Array.isArray(v.value)) return v.value.includes(r?.[k]);
        return r?.[k] === v;
      }),
    );
  return {
    getRepository(cls) {
      const rows = byName[cls?.name] ?? [];
      return {
        find: async (opts = {}) => {
          let out = match(rows, opts.where);
          if (opts.order) {
            const [[k, dir]] = Object.entries(opts.order);
            out = [...out].sort((a, b) =>
              dir === 'DESC' ? String(b?.[k] > a?.[k] ? 1 : -1) : String(a?.[k] > b?.[k] ? 1 : -1),
            );
          }
          return opts.take ? out.slice(0, opts.take) : out;
        },
        findOne: async (opts = {}) => match(rows, opts.where)[0] ?? null,
      };
    },
  };
}

// ── 1. resolver ──────────────────────────────────────────────────────────

test('팀 멤버 슬롯에서 credential/host/account를 찾는다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-abc', spec: SPEC(), role_label: 'dev' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  const out = await resolveSlotCredentialSources(ds, 'rt-abc');
  assert.equal(out.length, 1);
  assert.equal(out[0].credential_id, 'cred-1');
  assert.equal(out[0].manager_agent_id, 'host-1');
  assert.equal(out[0].account_id, 'w1');
});

test('팀 오케스트레이터 슬롯도 찾는다', async () => {
  const ds = stubDataSource({
    teams: [{ id: 't1', account_id: null, name: 'G', orchestrator_agent_id: 'rt-orch', orchestrator_spec: SPEC({ credential_id: 'cred-g' }) }],
  });
  const out = await resolveSlotCredentialSources(ds, 'rt-orch');
  assert.equal(out.length, 1);
  assert.equal(out[0].credential_id, 'cred-g');
  assert.equal(out[0].account_id, null);
});

test('미션 임시 멤버를 찾는다', async () => {
  const ds = stubDataSource({
    missions: [{
      id: 'm1', account_id: 'w2',
      extra_member_specs: [{ agent_id: 'rt-extra', role_label: 'r', capabilities: '', max_concurrent: 1, spec: SPEC({ credential_id: 'cred-x', manager_agent_id: 'host-9' }) }],
    }],
  });
  const out = await resolveSlotCredentialSources(ds, 'rt-extra');
  assert.equal(out.length, 1);
  assert.equal(out[0].credential_id, 'cred-x');
  assert.equal(out[0].manager_agent_id, 'host-9');
  assert.equal(out[0].account_id, 'w2');
});

test('티켓 assignee를 찾고 done 티켓은 건너뛴다', async () => {
  const ds = stubDataSource({
    tickets: [
      { id: 't-old', status: 'done', archived_at: null, assignee_key: 'rt-t', assignee: SPEC(), account_id: 'w1', updated_at: '2020-01-01' },
      { id: 't-new', status: 'in_progress', archived_at: null, assignee_key: 'rt-t', assignee: SPEC({ credential_id: 'cred-t' }), account_id: 'w1', updated_at: '2026-01-01' },
    ],
  });
  const out = await resolveSlotCredentialSources(ds, 'rt-t');
  assert.equal(out.length, 1);
  assert.equal(out[0].credential_id, 'cred-t');
  assert.equal(out[0].label.startsWith('ticket'), true);
});

test('챗 참가자 inline spec을 방 계정과 함께 찾는다', async () => {
  const ds = stubDataSource({
    participants: [{ room_id: 'room-1', participant_id: 'rt-c', runtime_spec: SPEC({ credential_id: 'cred-c' }), joined_at: '2026-01-01' }],
    rooms: [{ id: 'room-1', account_id: 'w3' }],
  });
  const out = await resolveSlotCredentialSources(ds, 'rt-c');
  assert.equal(out.length, 1);
  assert.equal(out[0].credential_id, 'cred-c');
  assert.equal(out[0].account_id, 'w3');
});

test('어느 표면에도 없는 identity는 빈 목록이다', async () => {
  const out = await resolveSlotCredentialSources(stubDataSource(), 'rt-nope');
  assert.deepEqual(out, []);
});

test('spec이 깨진 행은 조용히 건너뛴다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-bad', spec: 'garbage', role_label: '' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  assert.deepEqual(await resolveSlotCredentialSources(ds, 'rt-bad'), []);
});

// ── 2. provisionSlotIdentity ─────────────────────────────────────────────

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function provisionService({ credentials = undefined, issueImpl = null } = {}) {
  const inst = {
    mode: 'manager',
    agent_id: 'host-1',
    host_id: 'host-1',
    instance_id: 'i1',
    started_at: '2026-01-01',
    agent_credentials: credentials,
  };
  const svc = new AgentManagerCommandService(
    { list: () => [inst] },
    { record() {} },
    noopLog,
    {},
    {},
  );
  const calls = [];
  svc.issue = async (instance, command, args, issuedBy) => {
    calls.push({ instance, command, args, issuedBy });
    if (issueImpl) return issueImpl();
    return { command_id: 'c1', issued_at: new Date(0).toISOString() };
  };
  return { svc, calls };
}

test('이미 materialize된 identity는 spawn 없이 건너뛴다', async () => {
  const spec = { manager_agent_id: 'host-1', cli: 'claude', model: 'opus', working_dir: '/repo', credential_id: 'cred-1', runtime_config: null };
  const key = runtimeIdentityKey(spec);
  const { svc, calls } = provisionService({
    credentials: [{ agent_id: key, cli: 'claude', kind: 'subscription', expires_at_ms: null, refresh_token_present: true }],
  });
  const r = await svc.provisionSlotIdentity(spec, { accountId: 'w1', label: 't/dev', issuedBy: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0, 'materialized identity must not re-spawn');
});

test('스냅샷이 없으면 spawn_agent를 쏘고 절대 throw하지 않는다', async () => {
  const { svc, calls } = provisionService({ credentials: [] });
  const r = await svc.provisionSlotIdentity(
    { manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/repo', credential_id: 'cred-1', runtime_config: null },
    { accountId: 'w1', label: 't/dev', issuedBy: 'test' },
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'spawn_agent');
  assert.equal(calls[0].args.credential_id, 'cred-1');
  assert.equal(calls[0].args.account_id, 'w1');
  assert.ok(String(calls[0].args.agent_id).startsWith('rt-'), 'identity key minted from spec');
});

test('operator_home 스냅샷 + 슬롯 credential이면 재프로비저닝한다', async () => {
  const spec = { manager_agent_id: 'host-1', cli: 'claude', working_dir: '/repo', credential_id: 'cred-1' };
  const key = runtimeIdentityKey(spec);
  const { svc, calls } = provisionService({
    credentials: [{ agent_id: key, cli: 'claude', kind: 'operator_home', expires_at_ms: null, refresh_token_present: false }],
  });
  const r = await svc.provisionSlotIdentity(spec, { accountId: 'w1', issuedBy: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined);
  assert.equal(calls.length, 1);
});

test('호스트 오프라인이면 조용히 실패 분류한다', async () => {
  const svc = new AgentManagerCommandService({ list: () => [] }, { record() {} }, noopLog, {}, {});
  const r = await svc.provisionSlotIdentity(
    { manager_agent_id: 'host-9', cli: 'claude', working_dir: '/repo' },
    { accountId: 'w1', issuedBy: 'test' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'manager_offline');
});

test('spec이 나쁘면 거절한다', async () => {
  const { svc } = provisionService();
  const r = await svc.provisionSlotIdentity(
    { manager_agent_id: '', cli: '', working_dir: 'relative/path' },
    { accountId: 'w1', issuedBy: 'test' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_spec');
});

// ── 3. 컨트롤러 라우트 + 핸들러 ──────────────────────────────────────────

function fakeRes() {
  const out = { statusCode: 200, body: undefined };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
    send(body) {
      out.body = body;
      return this;
    },
    setHeader() {},
  };
}

function controllerWith({ ds, credRow = undefined }) {
  const boom = new Proxy({}, { get: (_t, prop) => () => { throw new Error(`must not call ${String(prop)}`); } });
  // 생성자 순서: registry, pairing, apiKeyService, subagentMonitor, logService,
  // commandLedger, sudoTickets, privileged, commands, agentStatus, dispatcher,
  // runSkillSnapshots, childRuns, hostRepo, credentialRepo, ticketRepo,
  // accountRepo, dataSource
  return new AgentManagerController(
    boom, boom, boom, boom, noopLog, boom, boom, boom, boom, boom, boom, boom, boom,
    /* hostRepo */ {},
    /* credentialRepo */ { findOne: async () => credRow ?? null },
    /* ticketRepo */ {},
    /* accountRepo */ {},
    /* dataSource */ ds,
  );
}

const CRED_FIELDS = JSON.stringify({ credentials_json: '{"x":1}' });

test('라우트가 GET api/agent-manager/managed-agents/:id/credential 으로 등록돼 있다', async () => {
  const handler = AgentManagerController.prototype.getManagedAgentCredential;
  assert.equal(typeof handler, 'function', '핸들러가 존재해야 한다');
  const { PATH_METADATA, METHOD_METADATA } = await import(
    pathToFileURL(path.join(__dirname, '..', 'node_modules', '@nestjs', 'common', 'constants.js')).href
  ).catch(async () =>
    import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'node_modules', '@nestjs', 'common', 'constants.js')).href),
  );
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'api/agent-manager/managed-agents/:id/credential');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 0, '읽기 경로는 GET이어야 한다');
});

test('슬롯 credential이 복호화돼 그대로 내려간다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-abc', spec: SPEC(), role_label: 'dev' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  const c = controllerWith({ ds, credRow: { id: 'cred-1', provider: 'claude_subscription', account_id: 'w1', encrypted_data: CRED_FIELDS } });
  const res = fakeRes();
  await c.getManagedAgentCredential('rt-abc', 'w1', undefined, { currentHostId: 'host-1' }, res);
  assert.equal(res.out.statusCode, 200);
  assert.equal(res.out.body.credential_id, 'cred-1');
  assert.equal(res.out.body.provider, 'claude_subscription');
  assert.deepEqual(res.out.body.fields, { credentials_json: '{"x":1}' });
});

test('credential 없는 슬롯은 204, 모르는 identity는 404다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-nocred', spec: SPEC({ credential_id: null }), role_label: '' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  const c = controllerWith({ ds });
  const res204 = fakeRes();
  await c.getManagedAgentCredential('rt-nocred', 'w1', undefined, { currentHostId: 'host-1' }, res204);
  assert.equal(res204.out.statusCode, 204);
  const res404 = fakeRes();
  await c.getManagedAgentCredential('rt-nope', 'w1', undefined, { currentHostId: 'host-1' }, res404);
  assert.equal(res404.out.statusCode, 404);
});

test('타 호스트·타 계정은 403이다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-abc', spec: SPEC(), role_label: '' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  const c = controllerWith({ ds, credRow: { id: 'cred-1', provider: 'claude_subscription', account_id: 'w1', encrypted_data: CRED_FIELDS } });
  const resHost = fakeRes();
  await c.getManagedAgentCredential('rt-abc', 'w1', undefined, { currentHostId: 'host-OTHER' }, resHost);
  assert.equal(resHost.out.statusCode, 403);
  const resAccount = fakeRes();
  await c.getManagedAgentCredential('rt-abc', 'w-OTHER', undefined, { currentHostId: 'host-1' }, resAccount);
  assert.equal(resAccount.out.statusCode, 403);
});

test('credential 행이 지워졌으면 404다', async () => {
  const ds = stubDataSource({
    members: [{ team_id: 't1', agent_id: 'rt-abc', spec: SPEC(), role_label: '' }],
    teams: [{ id: 't1', account_id: 'w1', name: 'T' }],
  });
  const c = controllerWith({ ds, credRow: undefined });
  const res = fakeRes();
  await c.getManagedAgentCredential('rt-abc', 'w1', undefined, { currentHostId: 'host-1' }, res);
  assert.equal(res.out.statusCode, 404);
});

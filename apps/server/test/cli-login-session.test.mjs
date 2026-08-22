// 티켓 b2e79108 — Codex/Claude CLI device-auth 자동 로그인.
//
// 이 파일은 세 계층을 검증한다:
//   1. CliLoginSessionService — 순수 로직(소유권 검증, 상태 전이, credential
//      암호화 생성, 토큰 원문이 절대 응답/세션 오브젝트에 실리지 않음).
//   2. CliLoginAgentController — 매니저→서버 progress 엔드포인트의 자체 검증
//      (currentAgentId 없음/잘못된 status)과 서비스 위임.
//   3. 실제 AppModule을 부팅한 라우팅 스모크 테스트 — CredentialsModule이
//      AgentManagerModule을 정말로 import해서 DI가 깨지지 않았는지, 그리고
//      cli_login_start 가 진짜 agent_manager_command SSE로 나가는지 확인한다.
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY = `test-encryption-key-${randomUUID()}`;

const { CliLoginSessionService } = await import('../dist/modules/credentials/cli-login-session.service.js');
const { CliLoginAgentController } = await import('../dist/modules/credentials/cli-login-agent.controller.js');
const { TERMINAL_CLI_LOGIN_SESSION_STATUSES } = await import('../dist/entities/CliLoginSession.js');

// ─── stubs ──────────────────────────────────────────────────────────────

function sessionRepoStub() {
  const rows = new Map();
  let seq = 0;
  return {
    create(partial) {
      return { id: `session-${++seq}`, ...partial };
    },
    save: async (row) => {
      rows.set(row.id, row);
      return row;
    },
    findOne: async ({ where }) => rows.get(where.id) || null,
    // reapStale()'s createQueryBuilder chain — the test seeds `rows` with
    // exactly the sessions it wants swept, so the stub just returns
    // everything currently stored rather than interpreting the SQL predicate.
    createQueryBuilder() {
      const qb = {
        where: () => qb,
        andWhere: () => qb,
        getMany: async () => Array.from(rows.values()),
      };
      return qb;
    },
    rows,
  };
}

function credRepoStub() {
  const saved = [];
  let seq = 0;
  return {
    create(partial) {
      return { id: `cred-${++seq}`, ...partial };
    },
    save: async (row) => {
      saved.push(row);
      return row;
    },
    saved,
  };
}

function commandServiceStub(issueImpl) {
  const calls = [];
  return {
    issue: async (inst, command, args, issuedBy) => {
      calls.push({ inst, command, args, issuedBy });
      if (issueImpl) return issueImpl(inst, command, args, issuedBy);
      return { command_id: 'cmd-xyz', issued_at: new Date().toISOString() };
    },
    calls,
  };
}

function instanceRegistryStub(instances) {
  return { list: () => instances };
}

function logServiceStub() {
  return { warn() {}, error() {}, info() {}, debug() {} };
}

function liveInstance(overrides = {}) {
  return {
    instance_id: 'inst-1',
    agent_id: 'manager-agent-1',
    workspace_id: 'workspace-1',
    mode: 'manager',
    hostname: 'host-1',
    ...overrides,
  };
}

function service({ instances = [liveInstance()], issueImpl, sessions, creds } = {}) {
  const sessionRepo = sessions || sessionRepoStub();
  const credRepo = creds || credRepoStub();
  const commandService = commandServiceStub(issueImpl);
  const instanceRegistry = instanceRegistryStub(instances);
  const logService = logServiceStub();
  return {
    instance: new CliLoginSessionService(sessionRepo, credRepo, commandService, instanceRegistry, logService),
    sessionRepo,
    credRepo,
    commandService,
  };
}

// ─── CliLoginSessionService.startSession ───────────────────────────────

test('startSession rejects an unsupported cli before touching the registry/command service', async () => {
  const { instance, commandService } = service();
  await assert.rejects(
    () => instance.startSession({ workspaceId: 'w1', isGlobal: false, cli: 'claude', credentialName: 'x', instanceId: 'inst-1', triggeredById: 'u1' }),
    /Unsupported cli "claude"/,
  );
  assert.equal(commandService.calls.length, 0);
});

test('startSession rejects a missing credential name', async () => {
  const { instance } = service();
  await assert.rejects(
    () => instance.startSession({ workspaceId: 'w1', isGlobal: false, cli: 'codex', credentialName: '  ', instanceId: 'inst-1', triggeredById: 'u1' }),
    /credential_name is required/,
  );
});

test('startSession rejects when no live manager instance matches instanceId', async () => {
  const { instance } = service({ instances: [] });
  await assert.rejects(
    () => instance.startSession({ workspaceId: 'w1', isGlobal: false, cli: 'codex', credentialName: 'Codex', instanceId: 'inst-missing', triggeredById: 'u1' }),
    /not currently online/,
  );
});

test('startSession happy path: creates a starting session, issues cli_login_start, stamps the returned command_id', async () => {
  const { instance, commandService, sessionRepo } = service();
  const session = await instance.startSession({
    workspaceId: 'w1',
    isGlobal: false,
    cli: 'codex',
    credentialName: 'My Codex',
    instanceId: 'inst-1',
    triggeredById: 'user-1',
  });

  assert.equal(session.status, 'starting');
  assert.equal(session.instance_id, 'inst-1');
  assert.equal(session.manager_agent_id, 'manager-agent-1');
  assert.equal(session.command_id, 'cmd-xyz');
  assert.ok(session.started_at);

  assert.equal(commandService.calls.length, 1);
  assert.equal(commandService.calls[0].command, 'cli_login_start');
  assert.deepEqual(commandService.calls[0].args, { session_id: session.id, cli: 'codex' });
  assert.equal(commandService.calls[0].issuedBy, 'user-1');

  // Persisted row must carry the same command_id (not just the return value).
  assert.equal(sessionRepo.rows.get(session.id).command_id, 'cmd-xyz');
});

// ─── CliLoginSessionService.applyProgress ──────────────────────────────

async function seededStarting(overrides = {}) {
  const s = service();
  const session = await s.instance.startSession({
    workspaceId: 'w1',
    isGlobal: false,
    cli: 'codex',
    credentialName: 'My Codex',
    instanceId: 'inst-1',
    triggeredById: 'user-1',
  });
  Object.assign(session, overrides);
  await s.sessionRepo.save(session);
  return { ...s, session };
}

test('applyProgress: unknown session id is a 404', async () => {
  const { instance } = service();
  await assert.rejects(
    () => instance.applyProgress({ sessionId: 'nope', callerAgentId: 'manager-agent-1', commandId: 'cmd-xyz', status: 'awaiting_user' }),
    (err) => err.status === 404,
  );
});

test('applyProgress: caller must be the manager that owns the session (ownership check)', async () => {
  const { instance, session } = await seededStarting();
  await assert.rejects(
    () => instance.applyProgress({ sessionId: session.id, callerAgentId: 'some-other-manager', commandId: session.command_id, status: 'awaiting_user' }),
    (err) => err.status === 403,
  );
});

test('applyProgress: a mismatched command_id is rejected as stale/superseded', async () => {
  const { instance, session } = await seededStarting();
  await assert.rejects(
    () => instance.applyProgress({ sessionId: session.id, callerAgentId: 'manager-agent-1', commandId: 'some-other-command', status: 'awaiting_user' }),
    (err) => err.status === 409,
  );
});

test('applyProgress: awaiting_user records the verification url + code', async () => {
  const { instance, session } = await seededStarting();
  const updated = await instance.applyProgress({
    sessionId: session.id,
    callerAgentId: 'manager-agent-1',
    commandId: session.command_id,
    status: 'awaiting_user',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  });
  assert.equal(updated.status, 'awaiting_user');
  assert.equal(updated.verification_url, 'https://auth.openai.com/codex/device');
  assert.equal(updated.user_code, 'ABCD-1234');
});

for (const status of TERMINAL_CLI_LOGIN_SESSION_STATUSES) {
  test(`applyProgress: a report for an already-terminal session (${status}) is an idempotent no-op, not an error`, async () => {
    const { instance, session } = await seededStarting({ status, finished_at: new Date() });
    const result = await instance.applyProgress({
      sessionId: session.id,
      callerAgentId: 'manager-agent-1',
      commandId: session.command_id,
      status: 'awaiting_user',
      userCode: 'late-duplicate',
    });
    assert.equal(result.status, status, 'terminal status must not be overwritten by a late/duplicate report');
    assert.notEqual(result.user_code, 'late-duplicate');
  });
}

test('applyProgress: succeeded requires credential_fields.auth_json', async () => {
  const { instance, session } = await seededStarting();
  await assert.rejects(
    () => instance.applyProgress({ sessionId: session.id, callerAgentId: 'manager-agent-1', commandId: session.command_id, status: 'succeeded', credentialFields: {} }),
    (err) => err.status === 400 && /auth_json/.test(err.message),
  );
});

test('applyProgress: succeeded encrypts + stores a codex_subscription credential and never echoes the raw secret back', async () => {
  const { instance, session, credRepo } = await seededStarting();
  const SECRET = `sk-test-secret-${randomUUID()}`;
  const updated = await instance.applyProgress({
    sessionId: session.id,
    callerAgentId: 'manager-agent-1',
    commandId: session.command_id,
    status: 'succeeded',
    credentialFields: { auth_json: JSON.stringify({ access_token: SECRET }) },
  });

  assert.equal(updated.status, 'succeeded');
  assert.ok(updated.created_credential_id);
  assert.equal(credRepo.saved.length, 1);
  assert.equal(credRepo.saved[0].provider, 'codex_subscription');
  assert.equal(credRepo.saved[0].workspace_id, 'w1');
  assert.notEqual(credRepo.saved[0].encrypted_data, JSON.stringify({ auth_json: JSON.stringify({ access_token: SECRET }) }));
  assert.match(credRepo.saved[0].encrypted_data, /^enc:/);

  // The session object returned to the (eventual) HTTP caller must never
  // carry the raw token — only the created credential's id.
  assert.doesNotMatch(JSON.stringify(updated), new RegExp(SECRET));
});

test('applyProgress: succeeded on a GLOBAL session creates a workspace_id=null credential', async () => {
  const s = service();
  const session = await s.instance.startSession({
    workspaceId: '',
    isGlobal: true,
    cli: 'codex',
    credentialName: 'Global Codex',
    instanceId: 'inst-1',
    triggeredById: 'admin-1',
  });
  await s.instance.applyProgress({
    sessionId: session.id,
    callerAgentId: 'manager-agent-1',
    commandId: session.command_id,
    status: 'succeeded',
    credentialFields: { auth_json: '{}' },
  });
  assert.equal(s.credRepo.saved[0].workspace_id, null);
});

for (const status of ['failed', 'timed_out', 'cancelled']) {
  test(`applyProgress: manager-reported ${status} sets status + error_detail + finished_at`, async () => {
    const { instance, session } = await seededStarting();
    const updated = await instance.applyProgress({
      sessionId: session.id,
      callerAgentId: 'manager-agent-1',
      commandId: session.command_id,
      status,
      errorDetail: `boom-${status}`,
    });
    assert.equal(updated.status, status);
    assert.equal(updated.error_detail, `boom-${status}`);
    assert.ok(updated.finished_at);
  });
}

// ─── CliLoginSessionService.cancelSession ──────────────────────────────

test('cancelSession is idempotent once a session is already terminal', async () => {
  const { instance, session } = await seededStarting({ status: 'succeeded', finished_at: new Date() });
  const result = await instance.cancelSession(session.id, 'w1');
  assert.equal(result.status, 'succeeded');
});

test('cancelSession dispatches cli_login_cancel best-effort and marks the session cancelled even if dispatch fails', async () => {
  const { instance, session, commandService } = await seededStarting();
  commandService.issue = async () => {
    throw new Error('manager offline');
  };
  const result = await instance.cancelSession(session.id, 'w1');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error_detail, 'Cancelled by user');
});

// ─── CliLoginSessionService.reapStale ──────────────────────────────────

test('reapStale marks every non-terminal session it is handed as timed_out', async () => {
  const sessionRepo = sessionRepoStub();
  const old = sessionRepo.create({
    workspace_id: 'w1',
    is_global: false,
    cli: 'codex',
    credential_name: 'x',
    status: 'awaiting_user',
    manager_agent_id: 'manager-agent-1',
    instance_id: 'inst-1',
    triggered_by_id: 'u1',
    command_id: 'c1',
  });
  await sessionRepo.save(old);
  const s = service({ sessions: sessionRepo });
  const reaped = await s.instance.reapStale(1000);
  assert.equal(reaped, 1);
  assert.equal(sessionRepo.rows.get(old.id).status, 'timed_out');
  assert.match(sessionRepo.rows.get(old.id).error_detail, /auto-reaped/);
});

// ─── CliLoginAgentController ───────────────────────────────────────────

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('CliLoginAgentController.progress: no currentAgentId on the request → 401', async () => {
  const controller = new CliLoginAgentController({ applyProgress: async () => ({}) });
  const res = response();
  await controller.progress('session-1', { status: 'awaiting_user' }, {}, res);
  assert.equal(res.statusCode, 401);
});

test('CliLoginAgentController.progress: an invalid status is rejected before calling the service', async () => {
  let called = false;
  const controller = new CliLoginAgentController({ applyProgress: async () => { called = true; } });
  const res = response();
  await controller.progress('session-1', { status: 'bogus' }, { currentAgentId: 'manager-1' }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('CliLoginAgentController.progress: delegates to the service and returns metadata only (no credential_fields echo)', async () => {
  const calls = [];
  const controller = new CliLoginAgentController({
    applyProgress: async (args) => {
      calls.push(args);
      return { id: 'session-1', status: 'succeeded' };
    },
  });
  const res = response();
  await controller.progress(
    'session-1',
    { status: 'succeeded', command_id: 'cmd-1', credential_fields: { auth_json: 'SECRET-XYZ' } },
    { currentAgentId: 'manager-1' },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, session_id: 'session-1', status: 'succeeded' });
  assert.doesNotMatch(JSON.stringify(res.body), /SECRET-XYZ/);
  assert.equal(calls[0].callerAgentId, 'manager-1');
  assert.equal(calls[0].credentialFields.auth_json, 'SECRET-XYZ');
});

test('CliLoginAgentController.progress: a service error carrying .status maps to that HTTP status', async () => {
  const controller = new CliLoginAgentController({
    applyProgress: async () => {
      const err = new Error('caller is not the manager that owns this login session');
      err.status = 403;
      throw err;
    },
  });
  const res = response();
  await controller.progress('session-1', { status: 'failed' }, { currentAgentId: 'manager-1' }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /not the manager/);
});

// ─── Routed smoke test — proves the module wiring is real ──────────────

test('routed: POST /api/credentials/cli-login/start dispatches a real agent_manager_command and persists a starting session', async () => {
  process.env.DB_TYPE = 'sqlite';
  process.env.NODE_ENV = 'test';
  process.env.MCP_DEV_MODE = 'true';
  process.env.AGENT_DEV_MODE = 'true';
  process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), `awb-cli-login-route-${process.pid}-${randomUUID()}.db`);

  const [
    { NestFactory },
    { AppModule },
    { AuthService },
    { getDataSourceToken },
    { InstanceRegistryService },
    { activityEvents },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('../dist/app.module.js'),
    import('../dist/services/auth.service.js'),
    import('@nestjs/typeorm'),
    import('../dist/modules/agent-manager/instance-registry.service.js'),
    import('../dist/services/activity.service.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const auth = app.get(AuthService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const workspaceRepo = dataSource.getRepository('Workspace');

    const admin = await userRepo.save(userRepo.create({
      name: 'Login Admin',
      email: `login-admin-${randomUUID()}@example.test`,
      role: 'admin',
      status: 'active',
      password_hash: await auth.hashPassword('admin-password'),
    }));
    const nonAdmin = await userRepo.save(userRepo.create({
      name: 'Login User',
      email: `login-user-${randomUUID()}@example.test`,
      role: 'user',
      status: 'active',
      permissions: JSON.stringify(['admin.credentials']),
      password_hash: await auth.hashPassword('user-password'),
    }));
    const workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'Login Workspace' }));

    const registry = app.get(InstanceRegistryService);
    const instanceId = `inst-${randomUUID()}`;
    const managerAgentId = `agent-${randomUUID()}`;
    registry.upsert({
      instance_id: instanceId,
      agent_id: managerAgentId,
      workspace_id: workspace.id,
      mode: 'manager',
      hostname: 'test-host',
      plugin_version: '1.0.0',
      cli: 'claude',
      cli_adapters: ['codex'],
      pid: 12345,
      started_at: new Date().toISOString(),
      runtime_capabilities: { codex: { installed: true, healthy: true, version: '0.147.0', reason: null, capabilities: {} } },
    });

    const adminToken = auth.createSession(admin.id);
    const nonAdminToken = auth.createSession(nonAdmin.id);
    const baseUrl = `http://127.0.0.1:${port}/api/credentials`;

    // The instance picker route surfaces the fake manager with its
    // capability report.
    const instancesRes = await fetch(`${baseUrl}/cli-login/instances?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const instancesBody = await instancesRes.json();
    assert.equal(instancesRes.status, 200);
    const found = instancesBody.find((i) => i.instance_id === instanceId);
    assert.ok(found, 'freshly-upserted manager instance must appear in the picker list');
    assert.equal(found.codex_installed, true);
    assert.equal(found.codex_healthy, true);

    // Global scope requires MANAGE_GLOBAL_CREDENTIALS — same gate as
    // POST /api/credentials (완료 기준: "credential 생성 권한과 동일 게이트").
    const deniedGlobal = await fetch(`${baseUrl}/cli-login/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', cli: 'codex', credential_name: 'x', instance_id: instanceId }),
    });
    assert.equal(deniedGlobal.status, 403);

    // Unknown instance_id → 404, not a 500/silent success.
    const missingInstance = await fetch(`${baseUrl}/cli-login/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspace.id, cli: 'codex', credential_name: 'x', instance_id: 'does-not-exist' }),
    });
    assert.equal(missingInstance.status, 404);

    let capturedCommand = null;
    activityEvents.once('agent_manager_command', (payload) => {
      capturedCommand = payload;
    });

    const started = await fetch(`${baseUrl}/cli-login/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspace.id, cli: 'codex', credential_name: 'My Codex', instance_id: instanceId }),
    });
    const startedBody = await started.json();
    assert.equal(started.status, 201);
    assert.equal(startedBody.status, 'starting');
    assert.equal(startedBody.cli, 'codex');

    assert.ok(capturedCommand, 'starting a login must emit a real agent_manager_command over the shared activityEvents bus');
    assert.equal(capturedCommand.command, 'cli_login_start');
    assert.equal(capturedCommand.agent_id, managerAgentId);
    assert.equal(capturedCommand.args.session_id, startedBody.id);
    assert.equal(capturedCommand.args.cli, 'codex');

    // GET reflects the same session back to the same workspace.
    const fetched = await fetch(`${baseUrl}/cli-login/${startedBody.id}?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const fetchedBody = await fetched.json();
    assert.equal(fetched.status, 200);
    assert.equal(fetchedBody.id, startedBody.id);
    assert.equal(fetchedBody.status, 'starting');
  } finally {
    await app.close();
  }
});

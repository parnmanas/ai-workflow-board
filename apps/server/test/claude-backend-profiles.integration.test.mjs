import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), `awb-claude-profiles-${process.pid}-${Date.now()}.db`);
process.env.PORT = '7837';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

const baseUrl = makeBaseUrl(Number(process.env.PORT));
let app;
let ds;
let auth;
let rebac;
let adminToken;
let ownerToken;
let memberToken;
let outsiderToken;
let workspace;
let owner;
let member;
let board;
let agent;
let ticket;
let profileA;
let profileB;
const secretCredentialId = randomUUID();

async function createUser(name, role = 'user') {
  const repo = ds.getRepository('User');
  const user = await repo.save(repo.create({
    name,
    email: `${name}-${randomUUID()}@awb.local`,
    role,
    status: 'active',
  }));
  return { user, token: auth.createSession(user.id) };
}

async function createProfile(token, id, name, credential_ref) {
  return apiRequest(baseUrl, '/admin/claude-backend-profiles', {
    token,
    method: 'POST',
    body: {
      id,
      name,
      kind: 'claude-backend',
      protocol: 'anthropic-compatible',
      base_url: `http://127.0.0.1/${id}`,
      model: `model-${id}`,
      ...(credential_ref ? { credential_ref, credential_required: true } : {}),
    },
  });
}

before(async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const { AppModule } = await import('../dist/app.module.js');
  const { AuthService } = await import('../dist/services/auth.service.js');
  const { ReBACService } = await import('../dist/services/rebac.service.js');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(Number(process.env.PORT), '0.0.0.0');
  ds = app.get(getDataSourceToken());
  auth = app.get(AuthService);
  rebac = app.get(ReBACService);

  ({ token: adminToken } = await createUser('profile-admin', 'admin'));
  ({ user: owner, token: ownerToken } = await createUser('profile-owner'));
  ({ user: member, token: memberToken } = await createUser('profile-member'));
  ({ token: outsiderToken } = await createUser('profile-outsider'));

  workspace = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'Profile integration workspace',
    cli_runtime_profiles: JSON.stringify([{
      id: 'legacy-profile',
      kind: 'claude-backend',
      protocol: 'anthropic-compatible',
      base_url: 'http://legacy.invalid',
      model: 'legacy-model',
    }]),
  }));
  await rebac.grant({ type: 'user', id: owner.id }, 'owner', { type: 'workspace', id: workspace.id });
  await rebac.grant({ type: 'user', id: member.id }, 'member', { type: 'workspace', id: workspace.id });

  board = await ds.getRepository('Board').save(ds.getRepository('Board').create({
    workspace_id: workspace.id, name: 'Profiles board',
  }));
  // PATCH /agents/:id 는 cli_runtime_profile 검증을 통과한 뒤 runtime host /
  // runtime_config 도 재검증한다. 프로필 핀이 실제로 저장되는 경로를 보려면
  // 이 에이전트가 그 검증까지 통과해야 하므로 manager 와 최소 config 를 준다.
  const profilesManager = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    name: 'Profiles manager', type: 'manager', workspace_id: null,
  }));
  agent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    workspace_id: workspace.id,
    name: 'Profiles agent',
    type: 'claude',
    manager_agent_id: profilesManager.id,
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  }));
  // 루트 티켓은 컬럼에 놓여 있어야 한다 — PATCH /tickets/:id 의 후속 처리가
  // 컬럼을 전제하므로, 컬럼 없는 티켓으로는 프로필 핀 저장 경로를 볼 수 없다.
  const column = await ds.getRepository('BoardColumn').save(ds.getRepository('BoardColumn').create({
    board_id: board.id, name: 'To Do', position: 0, kind: 'active',
  }));
  ticket = await ds.getRepository('Ticket').save(ds.getRepository('Ticket').create({
    workspace_id: workspace.id, title: 'Profiles run', column_id: column.id,
  }));

  await ds.getRepository('Credential').save(ds.getRepository('Credential').create({
    id: secretCredentialId,
    workspace_id: null,
    name: 'secret credential',
    provider: 'anthropic',
    encrypted_data: 'TOP-SECRET-CIPHERTEXT',
  }));
  let response = await createProfile(adminToken, 'profile-a', 'Profile A', secretCredentialId);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  profileA = response.data;
  response = await createProfile(adminToken, 'profile-b', 'Profile B');
  assert.equal(response.status, 201, JSON.stringify(response.data));
  profileB = response.data;
});

after(async () => {
  if (app) await app.close();
});

describe('Claude backend profile integration', () => {
  // 티켓 e616dbfc — 워크스페이스 스코프가 사라진 자리. 쓰기는 여전히 관리자
  // 전용이고, 읽기는 워크스페이스 배정과 무관하게 로그인한 사용자면 누구나
  // 같은 전역 목록을 본다. 자격증명 값·참조는 어느 표면에도 실리지 않는다.
  it('쓰기는 AdminGuard, 읽기는 로그인만 — 전역 카탈로그는 모두에게 같은 목록', async () => {
    for (const token of [ownerToken, memberToken, outsiderToken]) {
      const denied = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token });
      assert.equal(denied.status, 403);
    }
    const adminRead = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    assert.equal(adminRead.status, 200);
    assert.equal(JSON.stringify(adminRead.data).includes(secretCredentialId), false);
    assert.equal(JSON.stringify(adminRead.data).includes('TOP-SECRET-CIPHERTEXT'), false);

    // 비관리자 읽기 표면. 이게 없으면 프로필 핀 드롭다운이 비관리자에게
    // 통째로 빈 목록이 된다(관리자 라우트는 AdminGuard 라서 403).
    const expected = new Set([profileA.id, profileB.id]);
    for (const [label, token] of [['owner', ownerToken], ['member', memberToken], ['outsider', outsiderToken]]) {
      const catalog = await apiRequest(baseUrl, '/claude-backend-profiles', { token });
      assert.equal(catalog.status, 200, `${label}: ${JSON.stringify(catalog.data)}`);
      const ids = new Set(catalog.data.profiles.map(row => row.id));
      assert.ok([...expected].every(id => ids.has(id)), `${label} 은 전역 프로필을 모두 봐야 합니다.`);
      // 워크스페이스 배정 흔적이 응답에 남으면 안 된다.
      assert.equal('allowed_profile_ids' in catalog.data, false);
      const serialized = JSON.stringify(catalog.data);
      assert.equal(serialized.includes(secretCredentialId), false, `${label}: credential_ref 가 새면 안 됩니다.`);
      assert.equal(serialized.includes('TOP-SECRET-CIPHERTEXT'), false);
      assert.equal(serialized.includes('credential_status'), true, '설정 여부는 상태 문자열로만 노출한다');
    }
    // 인증 없는 호출은 여전히 거부.
    assert.equal((await apiRequest(baseUrl, '/claude-backend-profiles', {})).status, 401);
  });

  // 예전에는 워크스페이스 allow-set 이 Board/Agent/run 핀의 권위였고, 비워두면
  // 전역에 존재하는 프로필이라도 거부됐다. 이제 권위는 전역 목록 하나뿐이므로
  // (a) 전역에 없는 id 는 여전히 400 이고 (b) 전역에 있으면 배정 없이도 통과한다.
  it('전역 목록이 Board/Agent/run 핀의 유일한 권위다', async () => {
    for (const [pathName, body] of [
      [`/boards/${board.id}`, { cli_runtime_profile: 'legacy-profile' }],
      [`/agents/${agent.id}`, { cli_runtime_profile: 'legacy-profile' }],
      [`/tickets/${ticket.id}`, { cli_runtime_profile: 'legacy-profile' }],
    ]) {
      const denied = await apiRequest(baseUrl, pathName, {
        token: adminToken, method: 'PATCH', body,
      });
      assert.equal(denied.status, 400, `${pathName}: ${JSON.stringify(denied.data)}`);
      assert.match(denied.data.error, /does not exist$/, '에러 문구에 워크스페이스 스코프가 남으면 안 됩니다.');
    }

    // profileB 는 어떤 워크스페이스에도 배정된 적이 없다 — 예전 계약이라면 400.
    for (const pathName of [`/boards/${board.id}`, `/agents/${agent.id}`, `/tickets/${ticket.id}`]) {
      const accepted = await apiRequest(baseUrl, pathName, {
        token: adminToken, method: 'PATCH', body: { cli_runtime_profile: profileB.id },
      });
      assert.equal(accepted.status, 200, `${pathName}: ${JSON.stringify(accepted.data)}`);
    }
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, profileB.id);

    const { globalRuntimeProfiles } = await import('../dist/common/claude-backend-registry.js');
    const ids = (await globalRuntimeProfiles(ds)).map(row => row.id);
    assert.ok(ids.includes(profileA.id) && ids.includes(profileB.id));

    // 뒤 테스트에 영향이 없도록 핀을 되돌린다.
    for (const pathName of [`/boards/${board.id}`, `/agents/${agent.id}`, `/tickets/${ticket.id}`]) {
      await apiRequest(baseUrl, pathName, {
        token: adminToken, method: 'PATCH', body: { cli_runtime_profile: null },
      });
    }
  });

  it('rejects a missing credential_ref, accepts an existing credential, and clears an optional selection', async () => {
    const missingCredentialId = randomUUID();
    const rejected = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileA.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { credential_ref: missingCredentialId, credential_required: true },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.equal(rejected.data.error, 'credential_ref does not exist');
    assert.equal(
      (await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({ id: profileA.id })).credential_ref,
      secretCredentialId,
    );

    const replacementCredentialId = randomUUID();
    await ds.getRepository('Credential').save(ds.getRepository('Credential').create({
      id: replacementCredentialId,
      workspace_id: null,
      name: 'replacement credential',
      provider: 'anthropic',
      encrypted_data: 'REPLACEMENT-CIPHERTEXT',
    }));
    const accepted = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileA.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { credential_ref: replacementCredentialId, credential_required: true },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(JSON.stringify(accepted.data).includes(replacementCredentialId), false);
    assert.equal(
      (await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({ id: profileA.id })).credential_ref,
      replacementCredentialId,
    );

    const cleared = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileA.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { credential_ref: null, credential_required: false },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.equal(
      (await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({ id: profileA.id })).credential_ref,
      null,
    );
  });

  it('목록 응답을 편집 payload로 사용해도 omit_effort와 기존 필드가 재조회 후 유지된다', async () => {
    let listed = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    const editPayload = listed.data.profiles.find(profile => profile.id === profileB.id);
    assert.ok(editPayload);
    assert.equal(editPayload.credential_status, 'missing');

    let saved = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileB.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: {
        ...editPayload,
        name: 'Profile B edited',
        base_url: 'http://127.0.0.1/profile-b-edited',
        model: 'model-profile-b-edited',
        omit_effort: true,
        credential_required: false,
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.omit_effort, true);

    listed = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    let reloaded = listed.data.profiles.find(profile => profile.id === profileB.id);
    assert.deepEqual(
      {
        name: reloaded.name,
        base_url: reloaded.base_url,
        model: reloaded.model,
        omit_effort: reloaded.omit_effort,
        credential_required: reloaded.credential_required,
      },
      {
        name: 'Profile B edited',
        base_url: 'http://127.0.0.1/profile-b-edited',
        model: 'model-profile-b-edited',
        omit_effort: true,
        credential_required: false,
      },
    );

    saved = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileB.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { ...reloaded, omit_effort: false },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    listed = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    reloaded = listed.data.profiles.find(profile => profile.id === profileB.id);
    assert.equal(reloaded.omit_effort, false);
  });

  it('blocks referenced deletion, then replaces every selector/default reference transactionally', async () => {
    await ds.getRepository('Board').update({ id: board.id }, { cli_runtime_profile: profileA.id });
    await ds.getRepository('Agent').update({ id: agent.id }, { cli_runtime_profile: profileA.id });
    await ds.getRepository('Ticket').update({ id: ticket.id }, { cli_runtime_profile: profileA.id });
    await apiRequest(baseUrl, '/admin/claude-backend-profiles/default', {
      token: adminToken, method: 'PATCH', body: { profile_id: profileA.id },
    });

    const blocked = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileA.id}`, {
      token: adminToken, method: 'DELETE', body: {},
    });
    assert.equal(blocked.status, 409);
    assert.equal(JSON.stringify(blocked.data).includes(secretCredentialId), false);

    const replaced = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileA.id}`, {
      token: adminToken,
      method: 'DELETE',
      body: { replacement_profile_id: profileB.id },
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    assert.equal(await ds.getRepository('ClaudeBackendProfile').countBy({ id: profileA.id }), 0);
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, profileB.id);

    const response = await createProfile(adminToken, 'profile-global', 'Profile Global');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const globalProfile = response.data;
    await apiRequest(baseUrl, '/admin/claude-backend-profiles/default', {
      token: adminToken, method: 'PATCH', body: { profile_id: globalProfile.id },
    });

    const detached = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileB.id}`, {
      token: adminToken, method: 'DELETE', body: { detach: true },
    });
    assert.equal(detached.status, 200, JSON.stringify(detached.data));
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, globalProfile.id);

    // detach 뒤에는 어떤 핀도 남지 않으므로 전역 기본값으로 떨어져야 한다.
    const { resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js');
    const resolved = await resolveClaudeBackendProfileForDispatch(ds, [
      { source: 'run', value: null },
      { source: 'agent', value: null },
      { source: 'board', value: null },
    ]);
    assert.equal(resolved?.id, globalProfile.id);
  });

  it('migrates identical legacy ids with different payloads without loss and never exposes credential identity', async () => {
    const wsRepo = ds.getRepository('Workspace');
    const legacyA = await wsRepo.save(wsRepo.create({
      name: 'legacy collision A',
      cli_runtime_profiles: JSON.stringify([{
        id: 'same-id', kind: 'claude-backend', protocol: 'anthropic-compatible',
        base_url: 'http://legacy-a.invalid', model: 'a',
      }]),
      default_cli_runtime_profile: 'same-id',
    }));
    const legacyB = await wsRepo.save(wsRepo.create({
      name: 'legacy collision B',
      cli_runtime_profiles: JSON.stringify([{
        id: 'same-id', kind: 'claude-backend', protocol: 'anthropic-compatible',
        base_url: 'http://legacy-b.invalid', model: 'b',
      }]),
      default_cli_runtime_profile: 'same-id',
    }));
    const { BackfillGlobalClaudeBackendProfiles1760000000066 } =
      await import('../dist/database/migrations/1760000000066-BackfillGlobalClaudeBackendProfiles.js');
    const runner = ds.createQueryRunner();
    await new BackfillGlobalClaudeBackendProfiles1760000000066().up(runner);
    // 워크스페이스 기본값 포인터가 사라졌으므로(티켓 e616dbfc) 승격된 전역 행을
    // 직접 확인한다. 같은 레거시 id 라도 payload 가 다르면 별개 행이어야 한다 —
    // 하나가 다른 하나를 덮어쓰면 프로필 정의가 조용히 유실된다.
    const promoted = await ds.getRepository('ClaudeBackendProfile').find();
    const promotedA = promoted.find(row => row.base_url === 'http://legacy-a.invalid');
    const promotedB = promoted.find(row => row.base_url === 'http://legacy-b.invalid');
    assert.ok(promotedA, 'legacy A payload 가 승격되지 않았습니다.');
    assert.ok(promotedB, 'legacy B payload 가 승격되지 않았습니다.');
    assert.notEqual(promotedA.id, promotedB.id, '충돌한 레거시 id 는 서로 다른 전역 id 로 갈라져야 합니다.');
    assert.equal(promotedA.model, 'a');
    assert.equal(promotedB.model, 'b');

    // 멱등성: 다시 돌려도 fingerprint dedupe 로 행이 늘지 않아야 한다.
    const before = promoted.length;
    await new BackfillGlobalClaudeBackendProfiles1760000000066().up(runner);
    assert.equal(await ds.getRepository('ClaudeBackendProfile').count(), before);

    const adminList = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    const serialized = JSON.stringify(adminList.data);
    assert.equal(serialized.includes(secretCredentialId), false);
    assert.equal(serialized.includes('TOP-SECRET-CIPHERTEXT'), false);
    const invalid = await createProfile(adminToken, 'bad-secret', 'Bad secret', 'plaintext-secret-value');
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(invalid.data).includes('plaintext-secret-value'), false);
  });

  it('validates and persists cli_runtime_profile on POST /agents (create), mirroring PATCH', async () => {
    const response = await createProfile(adminToken, 'profile-create-agent', 'Profile Create Agent');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const createProfileRow = response.data;

    const wsRepo = ds.getRepository('Workspace');
    const createWorkspace = await wsRepo.save(wsRepo.create({ name: 'Create-agent profile workspace' }));
    await rebac.grant({ type: 'user', id: owner.id }, 'owner', { type: 'workspace', id: createWorkspace.id });
    const managerAgent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
      name: 'Create-agent manager', type: 'manager',
    }));
    const runtime_config = { strategy: 'single', permission_mode: 'trusted' };

    const rejected = await apiRequest(baseUrl, '/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'bad-profile-agent', type: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: randomUUID(),
      },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.equal(await ds.getRepository('Agent').countBy({ name: 'bad-profile-agent' }), 0);

    const created = await apiRequest(baseUrl, '/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'good-profile-agent', type: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: createProfileRow.id,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.cli_runtime_profile, createProfileRow.id);

    const withNone = await apiRequest(baseUrl, '/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'none-profile-agent', type: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: 'none',
      },
    });
    assert.equal(withNone.status, 201, JSON.stringify(withNone.data));
    assert.equal(withNone.data.cli_runtime_profile, 'none');

    const inherited = await apiRequest(baseUrl, '/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'inherit-profile-agent', type: 'claude', manager_agent_id: managerAgent.id,
        runtime_config,
      },
    });
    assert.equal(inherited.status, 201, JSON.stringify(inherited.data));
    assert.equal(inherited.data.cli_runtime_profile, null);
  });

  it('validates and persists cli_runtime_profile on POST /admin/agent-manager/agents (create) — the actual "Create managed agent" UI endpoint', async () => {
    const response = await createProfile(adminToken, 'profile-create-managed-agent', 'Profile Create Managed Agent');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const createProfileRow = response.data;

    const wsRepo = ds.getRepository('Workspace');
    const createWorkspace = await wsRepo.save(wsRepo.create({ name: 'Create-managed-agent profile workspace' }));
    await rebac.grant({ type: 'user', id: owner.id }, 'owner', { type: 'workspace', id: createWorkspace.id });
    const managerAgent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
      name: 'Create-managed-agent manager', type: 'manager',
    }));
    const runtime_config = { strategy: 'single', permission_mode: 'trusted' };

    const rejected = await apiRequest(baseUrl, '/admin/agent-manager/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'bad-profile-managed-agent', cli: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: randomUUID(),
      },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.equal(await ds.getRepository('Agent').countBy({ name: 'bad-profile-managed-agent' }), 0);

    const created = await apiRequest(baseUrl, '/admin/agent-manager/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'good-profile-managed-agent', cli: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: createProfileRow.id,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.cli_runtime_profile, createProfileRow.id);

    const withNone = await apiRequest(baseUrl, '/admin/agent-manager/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'none-profile-managed-agent', cli: 'claude', manager_agent_id: managerAgent.id,
        runtime_config, cli_runtime_profile: 'none',
      },
    });
    assert.equal(withNone.status, 201, JSON.stringify(withNone.data));
    assert.equal(withNone.data.cli_runtime_profile, 'none');

    const inherited = await apiRequest(baseUrl, '/admin/agent-manager/agents', {
      token: adminToken,
      workspaceId: createWorkspace.id,
      method: 'POST',
      body: {
        name: 'inherit-profile-managed-agent', cli: 'claude', manager_agent_id: managerAgent.id,
        runtime_config,
      },
    });
    assert.equal(inherited.status, 201, JSON.stringify(inherited.data));
    assert.equal(inherited.data.cli_runtime_profile, null);
  });
});

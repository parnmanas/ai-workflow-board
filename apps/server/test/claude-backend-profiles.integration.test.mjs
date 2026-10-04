import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), `awb-claude-profiles-${process.pid}-${Date.now()}.db`);
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

// 요청 포트가 0(OS 배정)이라 listen 전에는 URL 을 만들 수 없다 — 이 파일은
// bootApp 을 쓰지 않고 NestJS 를 인라인으로 띄우므로, 바인딩된 뒤 실제 포트로
// 직접 채운다(ticket f2d82793).
let baseUrl;
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
/* P4c-4: agent fixture 삭제 (Agent 행 없음). 보드 제거 후 Board / Ticket 핀도
   없다 — 프로필 핀은 RuntimeSpec(`cli_runtime_profile`) 에만 실린다. */
let host;
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
  baseUrl = makeBaseUrl(app.getHttpServer().address().port);
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

  // RuntimeSpec 검증(POST /runtime-specs/validate)은 Host 존재부터 본다.
  host = await ds.getRepository('RuntimeHost').save(ds.getRepository('RuntimeHost').create({
    name: 'profiles-host', hostname: 'fixture', workspace_id: workspace.id, is_active: 1,
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
  // Board / Ticket 핀은 보드 제거와 함께 사라졌다 — 남은 핀 표면은 RuntimeSpec
  // 이고, 그 쓰기 전 검증이 POST /runtime-specs/validate 다.
  it('전역 목록이 RuntimeSpec 핀의 유일한 권위다 (Board/Agent 핀 표면 삭제)', async () => {
    const spec = (cli_runtime_profile) => ({
      manager_agent_id: host.id, cli: 'claude', working_dir: '/srv/profiles', cli_runtime_profile,
      runtime_config: { strategy: 'single', permission_mode: 'strict' },
    });
    const denied = await apiRequest(baseUrl, '/runtime-specs/validate', {
      token: adminToken, method: 'POST', body: { workspace_id: workspace.id, spec: spec('legacy-profile') },
    });
    assert.equal(denied.status, 400, JSON.stringify(denied.data));
    assert.match(denied.data.error, /does not exist$/, '에러 문구에 워크스페이스 스코프가 남으면 안 됩니다.');

    // profileB 는 어떤 워크스페이스에도 배정된 적이 없다 — 예전 계약이라면 400.
    // 검증은 로그인만 요구하므로 워크스페이스 멤버도 같은 판정을 받는다.
    for (const token of [adminToken, memberToken]) {
      const accepted = await apiRequest(baseUrl, '/runtime-specs/validate', {
        token, method: 'POST', body: { workspace_id: workspace.id, spec: spec(profileB.id) },
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      assert.equal(accepted.data.spec.cli_runtime_profile, profileB.id);
    }

    const { globalRuntimeProfiles } = await import('../dist/common/claude-backend-registry.js');
    const ids = (await globalRuntimeProfiles(ds)).map(row => row.id);
    assert.ok(ids.includes(profileA.id) && ids.includes(profileB.id));
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
    // credential_ref 자리에 비밀값을 넣어도 거부 응답에 그 값이 되돌아오면 안 된다.
    const invalid = await createProfile(adminToken, 'bad-secret', 'Bad secret', 'plaintext-secret-value');
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(invalid.data).includes('plaintext-secret-value'), false);
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

  // Board / Ticket 핀이 사라져 남은 참조자는 전역 기본값뿐이다
  // (claude-backend-profiles.controller.ts impact()).
  it('blocks referenced deletion, then replaces the default reference transactionally', async () => {
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
    assert.equal(await ds.getRepository('ClaudeBackendProfile').countBy({ id: profileB.id }), 0);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, globalProfile.id);

    // detach 뒤에는 어떤 핀도 남지 않으므로 전역 기본값으로 떨어져야 한다.
    const { resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js');
    const resolved = await resolveClaudeBackendProfileForDispatch(ds, [
      { source: 'agent', value: null },
    ]);
    assert.equal(resolved?.id, globalProfile.id);
  });

  // 1760000000066-BackfillGlobalClaudeBackendProfiles 는 보드 제거와 함께
  // 삭제됐다(Board/Ticket 핀을 리맵하던 마이그레이션) — 그 up()/down() 계약
  // 테스트 2건도 함께 제거.
  // P4c-4: POST /agents + POST /admin/agent-manager/agents 삭제 — 생성 시 핀 테스트 제거.
});

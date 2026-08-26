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
    claude_backend_profiles_migrated: true,
  }));
  await rebac.grant({ type: 'user', id: owner.id }, 'owner', { type: 'workspace', id: workspace.id });
  await rebac.grant({ type: 'user', id: member.id }, 'member', { type: 'workspace', id: workspace.id });

  board = await ds.getRepository('Board').save(ds.getRepository('Board').create({
    workspace_id: workspace.id, name: 'Profiles board',
  }));
  agent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    workspace_id: workspace.id, name: 'Profiles agent', type: 'claude',
  }));
  ticket = await ds.getRepository('Ticket').save(ds.getRepository('Ticket').create({
    workspace_id: workspace.id, title: 'Profiles run',
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

  response = await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles`, {
    token: ownerToken,
    method: 'PATCH',
    body: { allowed_profile_ids: [profileA.id], default_profile_id: profileA.id },
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
});

after(async () => {
  if (app) await app.close();
});

describe('Claude backend profile integration', () => {
  it('enforces AdminGuard and member/owner workspace response scopes', async () => {
    for (const token of [ownerToken, memberToken, outsiderToken]) {
      const denied = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token });
      assert.equal(denied.status, 403);
    }
    const adminRead = await apiRequest(baseUrl, '/admin/claude-backend-profiles', { token: adminToken });
    assert.equal(adminRead.status, 200);
    assert.equal(JSON.stringify(adminRead.data).includes(secretCredentialId), false);
    assert.equal(JSON.stringify(adminRead.data).includes('TOP-SECRET-CIPHERTEXT'), false);

    const memberRead = await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles`, {
      token: memberToken,
    });
    assert.equal(memberRead.status, 200);
    assert.deepEqual(memberRead.data.profiles.map(row => row.id), [profileA.id]);
    assert.equal(JSON.stringify(memberRead.data).includes(profileB.id), false);

    const memberCatalog = await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles/catalog`, {
      token: memberToken,
    });
    assert.equal(memberCatalog.status, 403);
    const ownerCatalog = await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles/catalog`, {
      token: ownerToken,
    });
    assert.equal(ownerCatalog.status, 200);
    assert.deepEqual(new Set(ownerCatalog.data.profiles.map(row => row.id)), new Set([profileA.id, profileB.id]));
    assert.equal((await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles/catalog`, {
      token: adminToken,
    })).status, 200);
  });

  it('treats an intentionally empty allow-set as authoritative for Board, Agent, run and dispatch reads', async () => {
    const cleared = await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles`, {
      token: ownerToken,
      method: 'PATCH',
      body: { allowed_profile_ids: [], default_profile_id: null },
    });
    assert.equal(cleared.status, 200);

    for (const [pathName, body] of [
      [`/boards/${board.id}`, { cli_runtime_profile: 'legacy-profile' }],
      [`/agents/${agent.id}`, { cli_runtime_profile: 'legacy-profile' }],
      [`/tickets/${ticket.id}`, { cli_runtime_profile: 'legacy-profile' }],
    ]) {
      const denied = await apiRequest(baseUrl, pathName, {
        token: adminToken, method: 'PATCH', body,
      });
      assert.equal(denied.status, 400, `${pathName}: ${JSON.stringify(denied.data)}`);
    }

    const { authoritativeWorkspaceRuntimeProfiles } = await import('../dist/common/claude-backend-registry.js');
    const refreshed = await ds.getRepository('Workspace').findOneByOrFail({ id: workspace.id });
    assert.equal(refreshed.claude_backend_profiles_migrated, true);
    assert.deepEqual(await authoritativeWorkspaceRuntimeProfiles(ds, refreshed), []);
  });

  it('rejects a missing credential_ref on update without changing the profile and accepts an existing credential', async () => {
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

  it('converges legacy-only and mismatched workspace defaults when replacing a profile', async () => {
    let response = await createProfile(adminToken, 'profile-legacy-b', 'Profile Legacy B');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const legacyProfile = response.data;
    response = await createProfile(adminToken, 'profile-authoritative-c', 'Profile Authoritative C');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const replacementProfile = response.data;

    const workspaceRepo = ds.getRepository('Workspace');
    const legacyOnly = await workspaceRepo.save(workspaceRepo.create({
      name: 'Legacy-only default workspace',
      default_claude_backend_profile_id: null,
      default_cli_runtime_profile: legacyProfile.id,
      claude_backend_profiles_migrated: true,
    }));
    const mismatched = await workspaceRepo.save(workspaceRepo.create({
      name: 'Mismatched default workspace',
      default_claude_backend_profile_id: replacementProfile.id,
      default_cli_runtime_profile: legacyProfile.id,
      claude_backend_profiles_migrated: true,
    }));

    const replaced = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${legacyProfile.id}`, {
      token: adminToken,
      method: 'DELETE',
      body: { replacement_profile_id: replacementProfile.id },
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));

    for (const workspaceId of [legacyOnly.id, mismatched.id]) {
      const converged = await workspaceRepo.findOneByOrFail({ id: workspaceId });
      assert.equal(converged.default_claude_backend_profile_id, replacementProfile.id);
      assert.equal(converged.default_cli_runtime_profile, replacementProfile.id);
    }

    const { resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js');
    const resolved = await resolveClaudeBackendProfileForDispatch(
      ds,
      await workspaceRepo.findOneByOrFail({ id: legacyOnly.id }),
      [],
    );
    assert.equal(resolved?.id, replacementProfile.id);
  });

  it('blocks referenced deletion, then replaces every selector/default/allow reference transactionally', async () => {
    await apiRequest(baseUrl, `/workspaces/${workspace.id}/claude-backend-profiles`, {
      token: ownerToken,
      method: 'PATCH',
      body: { allowed_profile_ids: [profileA.id], default_profile_id: profileA.id },
    });
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
    assert.equal((await ds.getRepository('Workspace').findOneByOrFail({ id: workspace.id })).default_claude_backend_profile_id, profileB.id);
    assert.equal((await ds.getRepository('Workspace').findOneByOrFail({ id: workspace.id })).default_cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, profileB.id);
    assert.equal(await ds.getRepository('WorkspaceClaudeBackendProfile').countBy({
      workspace_id: workspace.id, profile_id: profileB.id,
    }), 1);
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
    const detachedWorkspace = await ds.getRepository('Workspace').findOneByOrFail({ id: workspace.id });
    assert.equal(detachedWorkspace.default_claude_backend_profile_id, null);
    assert.equal(detachedWorkspace.default_cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, null);
    assert.equal(await ds.getRepository('WorkspaceClaudeBackendProfile').countBy({
      workspace_id: workspace.id,
    }), 0);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, globalProfile.id);

    const { resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js');
    const resolved = await resolveClaudeBackendProfileForDispatch(ds, detachedWorkspace, [
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
      claude_backend_profiles_migrated: false,
    }));
    const legacyB = await wsRepo.save(wsRepo.create({
      name: 'legacy collision B',
      cli_runtime_profiles: JSON.stringify([{
        id: 'same-id', kind: 'claude-backend', protocol: 'anthropic-compatible',
        base_url: 'http://legacy-b.invalid', model: 'b',
      }]),
      default_cli_runtime_profile: 'same-id',
      claude_backend_profiles_migrated: false,
    }));
    const { BackfillGlobalClaudeBackendProfiles1760000000066 } =
      await import('../dist/database/migrations/1760000000066-BackfillGlobalClaudeBackendProfiles.js');
    const runner = ds.createQueryRunner();
    await new BackfillGlobalClaudeBackendProfiles1760000000066().up(runner);
    const migratedA = await wsRepo.findOneByOrFail({ id: legacyA.id });
    const migratedB = await wsRepo.findOneByOrFail({ id: legacyB.id });
    assert.equal(migratedA.claude_backend_profiles_migrated, true);
    assert.equal(migratedB.claude_backend_profiles_migrated, true);
    assert.notEqual(migratedA.default_claude_backend_profile_id, migratedB.default_claude_backend_profile_id);
    const rows = await ds.getRepository('ClaudeBackendProfile').findByIds([
      migratedA.default_claude_backend_profile_id,
      migratedB.default_claude_backend_profile_id,
    ]);
    assert.deepEqual(new Set(rows.map(row => row.base_url)), new Set(['http://legacy-a.invalid', 'http://legacy-b.invalid']));

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
    const assigned = await apiRequest(baseUrl, `/workspaces/${createWorkspace.id}/claude-backend-profiles`, {
      token: ownerToken,
      method: 'PATCH',
      body: { allowed_profile_ids: [createProfileRow.id], default_profile_id: createProfileRow.id },
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

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
    const assigned = await apiRequest(baseUrl, `/workspaces/${createWorkspace.id}/claude-backend-profiles`, {
      token: ownerToken,
      method: 'PATCH',
      body: { allowed_profile_ids: [createProfileRow.id], default_profile_id: createProfileRow.id },
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

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

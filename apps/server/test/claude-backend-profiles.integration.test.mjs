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
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, profileB.id);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, profileB.id);
    assert.equal(await ds.getRepository('WorkspaceClaudeBackendProfile').countBy({
      workspace_id: workspace.id, profile_id: profileB.id,
    }), 1);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, profileB.id);

    const detached = await apiRequest(baseUrl, `/admin/claude-backend-profiles/${profileB.id}`, {
      token: adminToken, method: 'DELETE', body: { detach: true },
    });
    assert.equal(detached.status, 200, JSON.stringify(detached.data));
    assert.equal((await ds.getRepository('Workspace').findOneByOrFail({ id: workspace.id })).default_claude_backend_profile_id, null);
    assert.equal((await ds.getRepository('Board').findOneByOrFail({ id: board.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Agent').findOneByOrFail({ id: agent.id })).cli_runtime_profile, null);
    assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).cli_runtime_profile, null);
    assert.equal(await ds.getRepository('WorkspaceClaudeBackendProfile').countBy({
      workspace_id: workspace.id,
    }), 0);
    assert.equal((await ds.getRepository('SystemSetting').findOneByOrFail({
      key: 'claude_backend_profiles.default',
    })).value, '');
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
});

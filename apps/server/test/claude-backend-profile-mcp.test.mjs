import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(
  os.tmpdir(),
  `awb-claude-profile-mcp-${process.pid}-${Date.now()}.db`,
);
process.env.NODE_ENV = 'test';

let ds;
let tools;
let managerAgent;
let workspace;

before(async () => {
  const { DataSource } = await import('typeorm');
  const { buildDataSourceOptions } = await import('../dist/db.js');
  tools = await import('../dist/modules/mcp/tools/claude-backend-profile-tools.js');
  ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();

  managerAgent = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
    name: 'Profile manager',
    type: 'manager',
    workspace_id: null,
  }));
  workspace = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'Profile MCP workspace',
  }));
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

describe('Claude backend profile MCP operations', () => {
  it('allows DB-backed full-scope keys bound to any existing Agent', async () => {
    const managerCaller = {
      agentId: managerAgent.id,
      source: 'db',
      scope: 'full',
    };
    assert.equal(
      await tools.requireAgentRegistryAccess(ds, managerCaller),
      null,
    );

    const ordinary = await ds.getRepository('Agent').save(
      ds.getRepository('Agent').create({
        name: 'Ordinary profile operator',
        type: 'claude',
        workspace_id: workspace.id,
      }),
    );
    assert.equal(
      await tools.requireAgentRegistryAccess(ds, {
        agentId: ordinary.id,
        source: 'db',
        scope: 'full',
        workspaceId: '00000000-0000-0000-0000-000000000000',
      }),
      null,
    );
  });

  it('rejects callers without a DB-backed full-scope existing-Agent identity', async () => {
    const valid = {
      agentId: managerAgent.id,
      source: 'db',
      scope: 'full',
    };
    const unauthorized = /DB-backed, full-scope MCP key bound to an Agent/;
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, source: 'env' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, source: 'dev-mode' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { ...valid, scope: 'write' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, { source: 'db', scope: 'full' }),
      unauthorized,
    );
    assert.match(
      await tools.requireAgentRegistryAccess(ds, {
        ...valid,
        agentId: '00000000-0000-0000-0000-000000000000',
      }),
      unauthorized,
    );
  });

  it('upserts once, reuses on retry, and refuses a same-name overwrite', async () => {
    const input = {
      name: 'Local vLLM - qwen3-coder-next',
      base_url: 'http://192.168.0.6:8000',
      model: 'qwen3-coder-next',
      protocol: 'anthropic-compatible',
    };
    const first = await tools.upsertClaudeBackendProfile(ds, input);
    const retry = await tools.upsertClaudeBackendProfile(ds, input);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.profile.id, first.profile.id);
    assert.equal(
      await ds.getRepository('ClaudeBackendProfile').count({
        where: { name: input.name },
      }),
      1,
    );
    await assert.rejects(
      tools.upsertClaudeBackendProfile(ds, {
        ...input,
        base_url: 'http://127.0.0.1:8000',
      }),
      /refusing to overwrite/,
    );
  });

  it('updates an existing profile without changing its UUID or assignments', async () => {
    const current = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });
    await ds.getRepository('WorkspaceClaudeBackendProfile').save(
      ds.getRepository('WorkspaceClaudeBackendProfile').create({
        workspace_id: workspace.id,
        profile_id: current.id,
      }),
    );

    const result = await tools.updateClaudeBackendProfile(ds, current.id, {
      base_url: 'http://127.0.0.1:8000',
      protocol: 'openai-compatible',
      config: {
        adapter: {
          module: 'claude_openai_adapter',
          base_url: 'http://127.0.0.1:18080',
        },
      },
    });

    assert.equal(result.changed, true);
    assert.equal(result.profile.id, current.id);
    assert.equal(result.profile.base_url, 'http://127.0.0.1:8000');
    assert.equal(result.profile.protocol, 'openai-compatible');
    assert.equal(result.profile.model, 'qwen3-coder-next');
    const retry = await tools.updateClaudeBackendProfile(ds, current.id, {
      base_url: 'http://127.0.0.1:8000',
      protocol: 'openai-compatible',
      config: {
        adapter: {
          module: 'claude_openai_adapter',
          base_url: 'http://127.0.0.1:18080',
        },
      },
    });
    assert.equal(retry.changed, false);
    const listed = await tools.listClaudeBackendProfiles(ds, workspace.id);
    assert.equal(listed.allowed_profile_ids.includes(current.id), true);
  });

  it('rejects an invalid update without changing the stored profile', async () => {
    const current = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });

    await assert.rejects(
      tools.updateClaudeBackendProfile(ds, current.id, {
        credential_ref: '00000000-0000-0000-0000-000000000000',
      }),
      /credential_ref does not identify an existing Credential/,
    );
    const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      id: current.id,
    });
    assert.equal(stored.credential_ref, current.credential_ref);
  });

  it('rejects a workspace credential incompatible with existing assignments without changing the profile', async () => {
    const ownerWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Credential owner workspace' }),
    );
    const otherWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Other assigned workspace' }),
    );
    const profile = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Shared assigned profile',
      base_url: 'http://shared.invalid',
      model: 'shared-model',
      protocol: 'anthropic-compatible',
    });
    await tools.assignWorkspaceBackendProfile(ds, ownerWorkspace.id, profile.profile.id, false);
    await tools.assignWorkspaceBackendProfile(ds, otherWorkspace.id, profile.profile.id, false);
    const credential = await ds.getRepository('Credential').save(
      ds.getRepository('Credential').create({
        workspace_id: ownerWorkspace.id,
        name: 'First workspace credential',
        provider: 'anthropic',
        encrypted_data: 'test-only',
      }),
    );

    await assert.rejects(
      tools.updateClaudeBackendProfile(ds, profile.profile.id, {
        base_url: 'http://must-not-be-saved.invalid',
        credential_ref: credential.id,
      }),
      /credential is not owned by every assigned workspace/,
    );
    const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      id: profile.profile.id,
    });
    assert.equal(stored.base_url, 'http://shared.invalid');
    assert.equal(stored.credential_ref, null);
  });

  it('serializes a credential update against a concurrent foreign workspace assignment', async () => {
    const ownerWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Race credential owner' }),
    );
    const foreignWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Race foreign workspace' }),
    );
    const credential = await ds.getRepository('Credential').save(
      ds.getRepository('Credential').create({
        workspace_id: ownerWorkspace.id,
        name: 'Race owner credential',
        provider: 'anthropic',
        encrypted_data: 'test-only',
      }),
    );
    const profile = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Concurrent credential profile',
      base_url: 'http://before-race.invalid',
      model: 'race-model',
      protocol: 'anthropic-compatible',
    });
    await tools.assignWorkspaceBackendProfile(
      ds,
      ownerWorkspace.id,
      profile.profile.id,
      false,
    );

    const [update, assignment] = await Promise.allSettled([
      tools.updateClaudeBackendProfile(ds, profile.profile.id, {
        base_url: 'http://after-race.invalid',
        credential_ref: credential.id,
      }),
      tools.assignWorkspaceBackendProfile(
        ds,
        foreignWorkspace.id,
        profile.profile.id,
        false,
      ),
    ]);

    assert.equal(update.status, 'fulfilled');
    assert.equal(assignment.status, 'rejected');
    assert.match(assignment.reason.message, /credential is not owned by this workspace/);
    const stored = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      id: profile.profile.id,
    });
    assert.equal(stored.base_url, 'http://after-race.invalid');
    assert.equal(stored.credential_ref, credential.id);
    assert.equal(
      await ds.getRepository('WorkspaceClaudeBackendProfile').count({
        where: {
          workspace_id: foreignWorkspace.id,
          profile_id: profile.profile.id,
        },
      }),
      0,
    );
  });

  it('assigns idempotently, preserves other links, and exposes safe verification', async () => {
    const primary = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });
    const other = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Other profile',
      base_url: 'http://other.invalid',
      model: 'other-model',
      protocol: 'anthropic-compatible',
    });
    await tools.assignWorkspaceBackendProfile(
      ds,
      workspace.id,
      other.profile.id,
      false,
    );

    const first = await tools.assignWorkspaceBackendProfile(
      ds,
      workspace.id,
      primary.id,
      true,
    );
    const retry = await tools.assignWorkspaceBackendProfile(
      ds,
      workspace.id,
      primary.id,
      true,
    );
    assert.equal(first.changed, true);
    assert.equal(retry.changed, false);
    assert.deepEqual(
      new Set(retry.allowed_profile_ids),
      new Set([primary.id, other.profile.id]),
    );
    assert.equal(retry.default_profile_id, primary.id);

    const listed = await tools.listClaudeBackendProfiles(ds, workspace.id);
    assert.equal(listed.default_profile_id, primary.id);
    assert.equal(
      listed.profiles.some(profile => 'credential_ref' in profile),
      false,
    );
  });

  it('assigns concurrent retries successfully with exactly one link', async () => {
    const concurrentWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({
        name: 'Concurrent profile assignment workspace',
      }),
    );
    const primary = await ds.getRepository('ClaudeBackendProfile').findOneByOrFail({
      name: 'Local vLLM - qwen3-coder-next',
    });

    const results = await Promise.all([
      tools.assignWorkspaceBackendProfile(
        ds,
        concurrentWorkspace.id,
        primary.id,
        true,
      ),
      tools.assignWorkspaceBackendProfile(
        ds,
        concurrentWorkspace.id,
        primary.id,
        true,
      ),
    ]);

    assert.equal(results.length, 2);
    assert.equal(
      results.every(result =>
        result.allowed_profile_ids.includes(primary.id) &&
        result.default_profile_id === primary.id
      ),
      true,
    );
    assert.equal(
      await ds.getRepository('WorkspaceClaudeBackendProfile').count({
        where: {
          workspace_id: concurrentWorkspace.id,
          profile_id: primary.id,
        },
      }),
      1,
    );
  });

  it('rejects missing workspace and profile ids without writing links', async () => {
    const count = await ds.getRepository('WorkspaceClaudeBackendProfile').count();
    await assert.rejects(
      tools.assignWorkspaceBackendProfile(
        ds,
        '00000000-0000-0000-0000-000000000000',
        'missing',
        true,
      ),
      /Workspace not found/,
    );
    await assert.rejects(
      tools.assignWorkspaceBackendProfile(ds, workspace.id, 'missing', true),
      /profile not found/,
    );
    assert.equal(
      await ds.getRepository('WorkspaceClaudeBackendProfile').count(),
      count,
    );
  });

  it('rejects assigning a profile backed by another workspace credential', async () => {
    const otherWorkspace = await ds.getRepository('Workspace').save(
      ds.getRepository('Workspace').create({ name: 'Credential owner' }),
    );
    const credential = await ds.getRepository('Credential').save(
      ds.getRepository('Credential').create({
        workspace_id: otherWorkspace.id,
        name: 'Foreign credential',
        provider: 'anthropic',
        encrypted_data: 'test-only',
      }),
    );
    const foreign = await tools.upsertClaudeBackendProfile(ds, {
      name: 'Foreign credential profile',
      base_url: 'http://foreign.invalid',
      model: 'foreign-model',
      protocol: 'anthropic-compatible',
      credential_ref: credential.id,
    });
    const count = await ds.getRepository('WorkspaceClaudeBackendProfile').count();

    await assert.rejects(
      tools.assignWorkspaceBackendProfile(
        ds,
        workspace.id,
        foreign.profile.id,
        false,
      ),
      /credential is not owned by this workspace/,
    );
    assert.equal(
      await ds.getRepository('WorkspaceClaudeBackendProfile').count(),
      count,
    );
  });
});

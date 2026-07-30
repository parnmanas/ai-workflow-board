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

let app;
let ds;
let tools;
let managerAgent;
let workspace;

before(async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const { AppModule } = await import('../dist/app.module.js');
  tools = await import('../dist/modules/mcp/tools/claude-backend-profile-tools.js');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  ds = app.get(getDataSourceToken());

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
  if (app) await app.close();
});

describe('Claude backend profile MCP operations', () => {
  it('allows only DB-backed, full-scope manager identities', async () => {
    const valid = {
      agentId: managerAgent.id,
      source: 'db',
      scope: 'full',
    };
    assert.equal(await tools.requireManagerRegistryAccess(ds, valid), null);
    assert.match(
      await tools.requireManagerRegistryAccess(ds, { ...valid, source: 'env' }),
      /Unauthorized/,
    );
    assert.match(
      await tools.requireManagerRegistryAccess(ds, { ...valid, scope: 'write' }),
      /Unauthorized/,
    );
    const regular = await ds.getRepository('Agent').save(ds.getRepository('Agent').create({
      name: 'Regular agent',
      type: 'claude',
      workspace_id: workspace.id,
    }));
    assert.match(
      await tools.requireManagerRegistryAccess(ds, { ...valid, agentId: regular.id }),
      /Unauthorized/,
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
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createUser,
  createWorkspace,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.AGENT_RUNTIME_CONFIG_PORT || '7907';

function makeClient(port, token, workspaceId) {
  return async (body) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/admin/agent-manager/agents`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Workspace-Id': workspaceId,
        },
        body: JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  };
}

async function createAgentIdentity(port, token, workspaceId, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Workspace-Id': workspaceId,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function patchAgentIdentity(port, token, workspaceId, agentId, body) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': workspaceId,
      },
      body: JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('executable Agent creation requires a Runtime Host and explicit runtime config', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-config');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host',
    type: 'manager',
  });
  const admin = await createUser(app, getDataSourceToken, {
    name: 'runtime-admin',
    role: 'admin',
  });
  const token = app.get(AuthService).createSession(admin.id);
  const createManagedAgent = makeClient(port, token, workspace.id);

  const missingHost = await createManagedAgent({
    name: 'Hermes without host',
    cli: 'hermes',
    working_dir: 'D:\\work',
    runtime_config: {
      strategy: 'single',
      permission_mode: 'approve',
    },
  });
  assert.equal(missingHost.status, 400);
  assert.equal(missingHost.body.error, 'runtime_host_required');

  const missingConfig = await createManagedAgent({
    name: 'Hermes without config',
    cli: 'hermes',
    manager_agent_id: manager.id,
    working_dir: 'D:\\work',
  });
  assert.equal(missingConfig.status, 400);
  assert.equal(missingConfig.body.error, 'runtime_config_invalid');

  const created = await createManagedAgent({
    name: 'Hermes worker',
    cli: 'hermes',
    manager_agent_id: manager.id,
    working_dir: 'D:\\work',
    runtime_config: {
      strategy: 'delegated',
      permission_mode: 'approve',
      max_children: 3,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.manager_agent_id, manager.id);
  assert.equal(created.body.type, 'hermes');
  assert.deepEqual(created.body.runtime_config, {
    strategy: 'delegated',
    permission_mode: 'approve',
    max_children: 3,
  });

  const detached = await patchAgentIdentity(
    port,
    token,
    workspace.id,
    created.body.id,
    { manager_agent_id: null },
  );
  assert.equal(detached.status, 400);
  assert.equal(detached.body.error, 'runtime_host_required');

  const unsupportedStrategy = await patchAgentIdentity(
    port,
    token,
    workspace.id,
    created.body.id,
    {
      type: 'codex',
      runtime_config: {
        strategy: 'delegated',
        permission_mode: 'strict',
      },
    },
  );
  assert.equal(unsupportedStrategy.status, 400);
  assert.equal(unsupportedStrategy.body.error, 'runtime_config_invalid');

  const standaloneViaGenericApi = await createAgentIdentity(
    port,
    token,
    workspace.id,
    {
      name: 'Standalone Claude',
      type: 'claude',
      working_dir: 'D:\\work',
      runtime_config: {
        strategy: 'single',
        permission_mode: 'approve',
      },
    },
  );
  assert.equal(standaloneViaGenericApi.status, 400);
  assert.equal(standaloneViaGenericApi.body.error, 'runtime_host_required');

  const managerViaGenericApi = await createAgentIdentity(
    port,
    token,
    workspace.id,
    {
      name: 'Another Runtime Host',
      type: 'manager',
    },
  );
  assert.equal(managerViaGenericApi.status, 201, JSON.stringify(managerViaGenericApi.body));
  assert.equal(managerViaGenericApi.body.type, 'manager');
  assert.equal(managerViaGenericApi.body.workspace_id, null);
  assert.equal(managerViaGenericApi.body.runtime_config, null);

  const dataSource = app.get(getDataSourceToken());
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-config-mcp',
  });
  const mcp = new McpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: managerKey.raw_key,
  });
  t.after(async () => { await mcp.close(); });

  const mcpMissingHost = await mcp.callTool('create_agent', {
    name: 'MCP standalone Hermes',
    workspace_id: workspace.id,
    type: 'hermes',
    runtime_config: {
      strategy: 'single',
      permission_mode: 'approve',
    },
  });
  assert.equal(mcpMissingHost.isError, true);
  assert.equal(mcpMissingHost.error.error, 'runtime_host_required');

  const mcpCreated = await mcp.callTool('create_agent', {
    name: 'MCP hosted Hermes',
    workspace_id: workspace.id,
    type: 'hermes',
    manager_agent_id: manager.id,
    runtime_config: {
      strategy: 'swarm',
      permission_mode: 'strict',
      max_children: 4,
    },
  });
  assert.equal(mcpCreated.type, 'hermes');
  assert.equal(mcpCreated.manager_agent_id, manager.id);
  assert.deepEqual(mcpCreated.runtime_config, {
    strategy: 'swarm',
    permission_mode: 'strict',
    max_children: 4,
  });

  const mcpDetached = await mcp.callTool('update_agent', {
    agent_id: mcpCreated.id,
    manager_agent_id: null,
  });
  assert.equal(mcpDetached.isError, true);
  assert.equal(mcpDetached.error.error, 'runtime_host_required');

  const legacyHosted = await createAgent(app, getDataSourceToken, workspace.id, {
    name: 'legacy-hosted',
    type: 'codex',
    hosted: false,
  });
  const legacyStandalone = await createAgent(app, getDataSourceToken, workspace.id, {
    name: 'legacy-standalone',
    type: 'claude',
    hosted: false,
  });
  await dataSource.getRepository('Agent').update(
    { id: legacyHosted.id },
    { manager_agent_id: manager.id, runtime_config: null },
  );

  const migrationModule = await import(
    '../../dist/database/migrations/1760000000067-BackfillAgentRuntimeConfig.js'
  );
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await new migrationModule.BackfillAgentRuntimeConfig1760000000067().up(queryRunner);
  } finally {
    await queryRunner.release();
  }

  const hostedAfter = await dataSource.getRepository('Agent').findOneByOrFail({
    id: legacyHosted.id,
  });
  assert.deepEqual(hostedAfter.runtime_config, {
    strategy: 'single',
    permission_mode: 'approve',
  });
  assert.equal(hostedAfter.is_active, 1);

  const standaloneAfter = await dataSource.getRepository('Agent').findOneByOrFail({
    id: legacyStandalone.id,
  });
  assert.equal(standaloneAfter.is_active, 0);
  assert.equal(
    standaloneAfter.role_prompt_meta?.runtime_diagnostic,
    'runtime_host_required',
  );
});

exitAfterTests();

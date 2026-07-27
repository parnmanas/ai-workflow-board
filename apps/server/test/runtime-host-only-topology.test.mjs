import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createUser,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { AgentStatusService } from '../dist/modules/agents/agent-status.service.js';
import { AgentManagerCommandService } from '../dist/modules/agent-manager/agent-manager-command.service.js';

process.env.PORT = process.env.RUNTIME_HOST_ONLY_PORT || '7909';

test('only Runtime Hosts can advertise execution presence or receive dispatch streams', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-host-only');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host',
    type: 'manager',
  });
  const hosted = await createAgent(app, getDataSourceToken, workspace.id, {
    name: 'hosted',
    type: 'hermes',
  });
  const detached = await createAgent(app, getDataSourceToken, workspace.id, {
    name: 'detached',
    type: 'claude',
  });
  const dataSource = app.get(getDataSourceToken());
  await dataSource.getRepository('Agent').update(
    { id: hosted.id },
    {
      manager_agent_id: manager.id,
      runtime_config: {
        strategy: 'single',
        permission_mode: 'approve',
      },
    },
  );

  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-host',
  });
  const detachedKey = await createApiKey(app, getDataSourceToken, detached.id, {
    workspaceId: workspace.id,
    label: 'detached',
  });

  const legacyHeartbeat = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': detachedKey.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'legacy-proxy',
        agent_id: detached.id,
        mode: 'proxy',
        hostname: 'legacy',
        plugin_version: 'legacy',
        cli: 'claude',
        cli_adapters: ['claude'],
        pid: 1,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(legacyHeartbeat.status, 400);
  assert.equal((await legacyHeartbeat.json()).error, 'runtime_host_mode_required');

  const managerHeartbeat = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': managerKey.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'runtime-host',
        agent_id: manager.id,
        mode: 'manager',
        hostname: 'host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['hermes'],
        agent_ids: [hosted.id],
        pid: 2,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(managerHeartbeat.status, 201, await managerHeartbeat.text());

  const directStream = await fetch(
    `http://127.0.0.1:${port}/api/events/stream?token=${encodeURIComponent(detachedKey.raw_key)}`,
  );
  assert.equal(directStream.status, 401);
  const directStreamError = await directStream.json();
  assert.equal(
    directStreamError.message ?? directStreamError.error,
    'Runtime Host credentials are required',
  );

  assert.equal(
    app.get(AgentStatusService).isReachable(detached.id, true),
    false,
    'a standalone DB online flag must not become an execution route',
  );
  const spawn = await app
    .get(AgentManagerCommandService)
    .issueSpawnAgent(detached.id, 'test');
  assert.deepEqual(spawn, { ok: false, reason: 'runtime_host_required' });

  const admin = await createUser(app, getDataSourceToken, {
    name: 'runtime-admin',
    role: 'admin',
  });
  const token = app.get(AuthService).createSession(admin.id);
  const sessionsResponse = await fetch(
    `http://127.0.0.1:${port}/api/events/active-agent-sessions`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json();
  assert.equal(sessions[detached.id], undefined);
  assert.equal(sessions[hosted.id].length, 1);
  assert.equal(sessions[hosted.id][0].source, 'manager');
});

test('server topology sources contain no executable proxy or daemon modes', () => {
  const files = [
    'apps/server/src/modules/agent-manager/instance-registry.service.ts',
    'apps/server/src/modules/agent-manager/agent-manager.controller.ts',
    'apps/server/src/modules/events/events.controller.ts',
    'apps/server/src/modules/events/types.ts',
    'apps/server/src/modules/agents/agent-status.service.ts',
    'apps/server/src/modules/chat-rooms/room-messaging.service.ts',
  ];
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /mode:\s*['"]daemon['"]/);
  assert.doesNotMatch(source, /mode:\s*['"]proxy['"]/);
  assert.doesNotMatch(source, /source:\s*['"]proxy['"]/);
  assert.doesNotMatch(source, /agentMainSession|_resolveRoutingTargetSession|main_pinned|is_main/);
  assert.doesNotMatch(source, /agent\.is_online\s*\|\|\s*this\.connectivity\.isReachable/);
});

exitAfterTests();

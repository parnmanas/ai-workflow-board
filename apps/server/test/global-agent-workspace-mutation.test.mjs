import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp } from './helpers/boot.mjs';
import { createWorkspace, createAgent } from './helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadDist = (...parts) => import('file://' + path.join(__dirname, '..', 'dist', ...parts));

function fakeRes() {
  return {
    _status: 200, _json: undefined,
    status(code) { this._status = code; return this; },
    json(value) { this._json = value; return this; },
  };
}

test('agent workspace mutation stores explicit global scope as null', async (t) => {
  const { app, modules } = await bootApp({ port: 7897 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ws = await createWorkspace(app, modules.getDataSourceToken, 'global-mutation');
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'global candidate', type: 'claude' });

  const { AgentsController } = await loadDist('modules', 'agents', 'agents.controller.js');
  const agentsController = app.get(AgentsController);
  let res = fakeRes();
  await agentsController.update(
    agent.id,
    { workspace_id: null },
    { currentUser: { id: 'admin', role: 'admin', permissions: [] } },
    ws.id,
    res,
  );
  assert.equal(res._status, 200);
  assert.equal((await ds.getRepository('Agent').findOne({ where: { id: agent.id } })).workspace_id, null);

  await ds.getRepository('Agent').update(agent.id, { workspace_id: ws.id });
  const { AgentManagerController } = await loadDist('modules', 'agent-manager', 'agent-manager.controller.js');
  const managerController = app.get(AgentManagerController);
  res = fakeRes();
  await managerController.setManagedAgentWorkspace(agent.id, { workspace_id: '' }, res);
  assert.equal(res._status, 200);
  assert.equal((await ds.getRepository('Agent').findOne({ where: { id: agent.id } })).workspace_id, null);

  await ds.getRepository('Agent').update(agent.id, { workspace_id: '' });
  const { NormalizeGlobalAgentWorkspace1760000000074 } = await loadDist(
    'database', 'migrations', '1760000000074-NormalizeGlobalAgentWorkspace.js',
  );
  const queryRunner = ds.createQueryRunner();
  try {
    await new NormalizeGlobalAgentWorkspace1760000000074().up(queryRunner);
  } finally {
    await queryRunner.release();
  }
  assert.equal((await ds.getRepository('Agent').findOne({ where: { id: agent.id } })).workspace_id, null);
});

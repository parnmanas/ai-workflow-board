import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource, TableColumn } from 'typeorm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentTemplate } = require('../dist/entities/AgentTemplate');
const { RuntimeHost } = require('../dist/entities/RuntimeHost');
const { Action } = require('../dist/entities/Action');
const { runtimeIdentityKey } = require('../dist/common/runtime-spec');
const { ApiKey } = require('../dist/entities/ApiKey');
const { AgentTemplatesController } = require('../dist/modules/agent-manager/agent-templates.controller');
const { AgentTemplates1760000000090 } = require('../dist/database/migrations/1760000000090-AgentTemplates');

async function database() {
  const db = new DataSource({ type: 'sqljs', entities: [AgentTemplate, RuntimeHost, ApiKey, Action], synchronize: true });
  await db.initialize(); return db;
}

test('Agent templates CRUD persists preferences and rejects Agent ownership/folders', async () => {
  const db = await database();
  try {
    const hosts = db.getRepository(RuntimeHost);
    const host = await hosts.save(hosts.create({ name: 'host', hostname: 'host' }));
    const controller = new AgentTemplatesController(db.getRepository(AgentTemplate), hosts);
    const input = { name: 'Code', host_id: host.id, cli: 'codex', model: 'test-model', effort: 'high', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
    const saved = await controller.create(input);
    assert.equal(saved.model, 'test-model'); assert.equal(saved.effort, 'high');
    for (const field of ['working_dir', 'agent_id', 'workspace_id', 'role_prompt']) {
      await assert.rejects(controller.create({ ...input, [field]: '/tmp/repo' }), /Only name/);
      await assert.rejects(controller.update(saved.id, { [field]: '/tmp/repo' }), /Only name/);
    }
    await assert.rejects(controller.create({ ...input, host_id: 'missing' }), /Host not found/);
    await assert.rejects(controller.create({ ...input, cli: 'unknown' }), /Unknown executable runtime/);
    await assert.rejects(controller.create({ ...input, runtime_config: { strategy: 'wrong' } }), /strategy/);
    await controller.update(saved.id, { name: 'Updated', effort: null });
    assert.equal((await controller.list())[0].name, 'Updated');
    assert.equal((await controller.list())[0].effort, null);
    await controller.remove(saved.id); assert.deepEqual(await controller.list(), []);
    await assert.rejects(controller.update(saved.id, { name: 'gone' }), /not found/);
    const columns = (await db.createQueryRunner().getTable('agent_templates')).columns.map((c) => c.name);
    assert.equal(columns.includes('working_dir'), false);
  } finally { await db.destroy(); }
});

test('cleanup preserves host keys and inline execution specs, drops legacy ownership idempotently', async () => {
  const db = await database();
  try {
    const qr = db.createQueryRunner();
    await qr.query('CREATE TABLE agents (id varchar PRIMARY KEY, name varchar, type varchar, workspace_id varchar, working_dir varchar)');
    await qr.query("INSERT INTO agents VALUES ('manager-old', 'Host', 'manager', NULL, '/obsolete')");
    await qr.query('CREATE TABLE workspaces (id varchar PRIMARY KEY, assistant_agent_id varchar, name varchar)');
    await qr.query("INSERT INTO workspaces VALUES ('ws', 'manager-old', 'preserved')");
    await qr.addColumn('api_keys', new TableColumn({ name: 'agent_id', type: 'varchar', isNullable: true }));
    await qr.query("INSERT INTO api_keys (id, name, key, agent_id) VALUES ('key', 'pair', 'hashed-secret', 'manager-old')");
    await qr.query('CREATE TABLE chat_room_participants (id varchar PRIMARY KEY, runtime_spec text)');
    const spec = { manager_agent_id: 'manager-old', cli: 'codex', working_dir: '/execution', model: 'm' };
    await qr.query('INSERT INTO chat_room_participants VALUES (?, ?)', ['p', JSON.stringify(spec)]);
    await qr.query('CREATE TABLE agent_skill_assignments (id varchar, workspace_id varchar, agent_id varchar, skill_id varchar, skill_version_id varchar, board_id varchar, role_slug varchar, assigned_by varchar, created_at datetime)');
    await qr.query("INSERT INTO agent_skill_assignments VALUES ('keep', 'ws', 'rt-0123456789abcdef', 'skill', 'v', '', '', 'u', CURRENT_TIMESTAMP), ('drop', 'ws', 'old-agent', 'skill', 'v', '', '', 'u', CURRENT_TIMESTAMP)");
    await qr.query('CREATE TABLE outreach_channels (id varchar PRIMARY KEY, classifier_agent_id varchar)');
    const migration = new AgentTemplates1760000000090();
    await migration.up(qr); await migration.up(qr);
    assert.equal(await qr.hasTable('agents'), false);
    assert.equal(await qr.hasTable('agent_skill_assignments'), false);
    assert.deepEqual((await qr.query('SELECT id, runtime_key FROM runtime_skill_assignments')), [{ id: 'keep', runtime_key: 'rt-0123456789abcdef' }]);
    assert.equal(await qr.hasColumn('outreach_channels', 'classifier_agent_id'), false);
    assert.equal(await qr.hasColumn('outreach_channels', 'classifier_runtime'), true);
    assert.equal(await qr.hasColumn('api_keys', 'agent_id'), false);
    assert.equal(await qr.hasColumn('workspaces', 'assistant_agent_id'), false);
    assert.equal((await qr.query('SELECT host_id FROM api_keys'))[0].host_id, 'manager-old');
    assert.equal((await qr.query('SELECT name FROM workspaces'))[0].name, 'preserved');
    assert.deepEqual(JSON.parse((await qr.query('SELECT runtime_spec FROM chat_room_participants'))[0].runtime_spec), spec);
    assert.equal(await qr.hasColumn('agent_templates', 'working_dir'), false);
  } finally { await db.destroy(); }
});


test('action target keys are derived from runtime specs and have no legacy DB columns', async () => {
  const db = await database();
  try {
    const spec = { manager_agent_id: 'h', cli: 'codex', working_dir: '/repo', folder_scope: 'shared', model: null, credential_id: null, cli_runtime_profile: null, label: '', role_prompt: '', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
    const actions = db.getRepository(Action);
    const row = await actions.save(actions.create({ workspace_id: 'w', name: 'Run', target_runtimes: [spec], target_agent_id: 'obsolete-agent' }));
    const loaded = await actions.findOneByOrFail({ id: row.id });
    assert.equal(loaded.target_agent_id, runtimeIdentityKey(spec));
    assert.deepEqual(JSON.parse(loaded.target_agent_ids), [runtimeIdentityKey(spec)]);
    const runner = db.createQueryRunner();
    assert.equal(await runner.hasColumn('actions', 'target_agent_id'), false);
    assert.equal(await runner.hasColumn('actions', 'target_agent_ids'), false);
    assert.ok(await runner.hasColumn('actions', 'target_runtimes'));
  } finally { await db.destroy(); }
});

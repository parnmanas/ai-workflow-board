import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../dist/db.js';
import { SingleInstanceWork1760000000094 } from '../dist/database/migrations/1760000000094-SingleInstanceWork.js';
import { INSTANCE_CONTEXT_ID } from '../dist/common/instance-context.js';

async function fixture(t) {
  const base = buildDataSourceOptions();
  const ds = new DataSource({ type: 'sqljs', entities: base.entities, synchronize: true, autoSave: false });
  await ds.initialize();
  t.after(() => ds.destroy());
  const save = (name, data) => ds.getRepository(name).save(ds.getRepository(name).create(data));
  const a = await save('Account', { name: 'old-A', knowledge_memory: 'Keep shared instructions A' });
  const b = await save('Account', { name: 'old-B', knowledge_memory: 'Keep shared instructions B' });
  await ds.query('CREATE TABLE relation_tuples (id varchar PRIMARY KEY, object_type varchar, object_id varchar)');
  await ds.query('INSERT INTO relation_tuples VALUES (?, ?, ?)', ['membership', 'account', a.id]);
  return { ds, save, a, b };
}
async function migrate(ds) {
  const runner = ds.createQueryRunner();
  await runner.startTransaction();
  try {
    await new SingleInstanceWork1760000000094().up(runner);
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally { await runner.release(); }
}

test('removes old owners and memberships while preserving work IDs, contents and timestamps', async t => {
  const { ds, save, a, b } = await fixture(t);
  const credential = await save('Credential', { account_id: a.id, name: 'token', provider: 'github', encrypted_data: 'opaque-ciphertext' });
  const project = await save('Project', { account_id: b.id, name: 'repo', credential_id: credential.id, repo_url: 'https://example.test/repo' });
  const ticket = await save('Ticket', { account_id: b.id, title: 'keep me', description: 'workspace_id and old account names in prose stay intact', project_id: project.id });
  const before = await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id });
  await migrate(ds);
  assert.deepEqual({ ...await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id }) }, { ...before, account_id: INSTANCE_CONTEXT_ID });
  assert.equal((await ds.getRepository('Project').findOneByOrFail({ id: project.id })).credential_id, credential.id);
  assert.equal((await ds.getRepository('Credential').findOneByOrFail({ id: credential.id })).encrypted_data, 'opaque-ciphertext');
  assert.deepEqual((await ds.getRepository('Account').find()).map(row => row.id), [INSTANCE_CONTEXT_ID]);
  assert.equal(await ds.createQueryRunner().hasTable('relation_tuples'), false);
  const defaults = await ds.getRepository('Account').findOneByOrFail({ id: INSTANCE_CONTEXT_ID });
  assert.match(defaults.knowledge_memory, /Keep shared instructions A/);
  assert.match(defaults.knowledge_memory, /Keep shared instructions B/);
});

test('merges usage totals without dropping historical token counts', async t => {
  const { ds, save, a, b } = await fixture(t);
  await save('AgentUsageDailyRollup', { account_id: a.id, usage_date: '2026-10-22', agent_id: 'agent', input_tokens: 12, total_cost_usd: 0.5, runs_total: 2 });
  await save('AgentUsageDailyRollup', { account_id: b.id, usage_date: '2026-10-22', agent_id: 'agent', input_tokens: 30, total_cost_usd: 0.75, runs_total: 3 });
  await migrate(ds);
  const rows = await ds.getRepository('AgentUsageDailyRollup').find();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 42);
  assert.equal(rows[0].runs_total, 5);
  assert.equal(rows[0].total_cost_usd, 1.25);
});

test('ambiguous catalog keys abort the entire transaction without deleting work or memberships', async t => {
  const { ds, save, a, b } = await fixture(t);
  await save('WorkflowFunction', { account_id: a.id, key: 'same', name: 'A' });
  await save('WorkflowFunction', { account_id: b.id, key: 'same', name: 'B' });
  await assert.rejects(migrate(ds), /UNIQUE/);
  assert.equal(await ds.getRepository('Account').count(), 2);
  assert.equal(await ds.getRepository('WorkflowFunction').count(), 2);
  assert.equal((await ds.query('SELECT count(*) AS count FROM relation_tuples'))[0].count, 1);
});

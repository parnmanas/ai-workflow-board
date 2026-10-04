import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource, Table, TableColumn, TableForeignKey } from 'typeorm';
import { ApiKey } from '../dist/entities/ApiKey.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { DropAgentTable1760000000089 } from '../dist/database/migrations/1760000000089-DropAgentTable.js';
import { buildDataSourceOptions } from '../dist/db.js';

const MANAGER_ID = '11111111-1111-4111-8111-111111111111';

async function fixture(t) {
  const postgres = process.env.DB_TYPE === 'postgres';
  const options = postgres ? buildDataSourceOptions() : { type: 'sqljs' };
  const schema = `host_backfill_${randomUUID().replaceAll('-', '')}`;
  let admin;
  if (postgres) {
    admin = new DataSource({ ...options, entities: [], migrations: [], synchronize: false });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  }
  const ds = new DataSource({ ...options, entities: [ApiKey, RuntimeHost], migrations: [],
    ...(postgres ? { schema, extra: { ...options.extra, options: `-c search_path=${schema},public` } } : {}),
    synchronize: true });
  await ds.initialize();
  const runner = ds.createQueryRunner();
  t.after(async () => {
    await runner.release();
    await ds.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  await runner.createTable(new Table({ name: 'agents', columns: [
    { name: 'id', type: 'varchar', isPrimary: true },
    { name: 'name', type: 'varchar' },
    { name: 'type', type: 'varchar' },
    { name: 'is_active', type: 'int', default: 1 },
    { name: 'last_seen_at', type: postgres ? 'timestamp' : 'datetime', isNullable: true },
  ] }));
  await runner.query(`INSERT INTO agents (id,name,type) VALUES ('${MANAGER_ID}','Legacy manager','manager'), ('child','Child','codex')`);
  await runner.addColumn('api_keys', new TableColumn({ name: 'agent_id', type: 'varchar', isNullable: true }));
  await runner.createForeignKey('api_keys', new TableForeignKey({ columnNames: ['agent_id'],
    referencedTableName: 'agents', referencedColumnNames: ['id'], onDelete: 'SET NULL' }));
  const repo = ds.getRepository(ApiKey);
  const keys = {
    create: (input) => input,
    findOneByOrFail: (where) => repo.findOneByOrFail(where),
    async save(input) {
      const { agent_id, ...current } = input;
      const row = await repo.save(repo.create(current));
      const sql = postgres ? 'UPDATE api_keys SET agent_id = $1 WHERE id = $2' : 'UPDATE api_keys SET agent_id = ? WHERE id = ?';
      await runner.query(sql, [agent_id, row.id]);
      return row;
    },
  };
  const key = await keys.save(keys.create({ name: 'agent-manager:legacy', key: randomUUID(),
    agent_id: MANAGER_ID, workspace_id: 'ws-1' }));
  const child = await keys.save(keys.create({ name: 'child', key: randomUUID(), agent_id: 'child' }));
  return { ds, runner, keys, key, child };
}

test('Agent deletion preserves pre-P0 manager identity and key without promoting child credentials', async (t) => {
  const { ds, runner, keys, key, child } = await fixture(t);
  const migration = new DropAgentTable1760000000089();
  await migration.up(runner);
  assert.equal(await runner.hasTable('agents'), false);
  const host = await ds.getRepository(RuntimeHost).findOneByOrFail({ id: MANAGER_ID });
  assert.equal(host.name, 'Legacy manager');
  assert.equal(host.workspace_id, 'ws-1');
  assert.equal((await keys.findOneByOrFail({ id: key.id })).host_id, host.id);
  assert.equal((await keys.findOneByOrFail({ id: child.id })).host_id, null);
  await migration.up(runner);
  assert.equal(await ds.getRepository(RuntimeHost).count(), 1);
});

test('Agent deletion retains an existing Host identity and binds other manager keys to it', async (t) => {
  const { ds, runner, keys, key } = await fixture(t);
  const host = await ds.getRepository(RuntimeHost).save({ name: 'Existing host', hostname: 'configured' });
  const linked = await keys.save(keys.create({ name: 'linked', key: randomUUID(), agent_id: MANAGER_ID, host_id: host.id }));
  await new DropAgentTable1760000000089().up(runner);
  assert.equal((await keys.findOneByOrFail({ id: key.id })).host_id, host.id);
  assert.equal((await keys.findOneByOrFail({ id: linked.id })).host_id, host.id);
  assert.equal(await ds.getRepository(RuntimeHost).count(), 1);
  assert.equal((await ds.getRepository(RuntimeHost).findOneByOrFail({ id: host.id })).hostname, 'configured');
});

test('conflicting manager Host bindings abort before dropping legacy identities', async (t) => {
  const { runner, keys } = await fixture(t);
  for (const hostId of ['host-a', 'host-b']) {
    await keys.save(keys.create({ name: hostId, key: randomUUID(), agent_id: MANAGER_ID, host_id: hostId }));
  }
  await assert.rejects(new DropAgentTable1760000000089().up(runner), /conflicting Runtime Host bindings/);
  assert.equal(await runner.hasTable('agents'), true);
});

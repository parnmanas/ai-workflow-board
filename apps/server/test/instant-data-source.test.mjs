import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DataSource, EntitySchema } from 'typeorm';
import { InstantDataSource } from '../dist/database/instant-data-source.js';
import { computeSchemaFingerprint } from '../dist/modules/migration/migration-crypto.js';

const entity = new EntitySchema({
  name: 'Clock', tableName: 'clock', columns: {
    id: { type: Number, primary: true },
    instant: { type: Date, nullable: true },
    created_at: { type: Date, createDate: true },
    updated_at: { type: Date, updateDate: true },
  }, indices: [{ columns: ['instant'] }],
});

// No connection required: verify that changing the physical PG type does not
// change cross-dialect migration fingerprints or shared decorator metadata.
test('Date metadata stays portable while PostgreSQL storage uses instants', async () => {
  const pg = new InstantDataSource({ type: 'postgres', entities: [entity] });
  const sqlite = new InstantDataSource({ type: 'sqljs', entities: [entity] });
  await pg.buildMetadatas();
  await sqlite.initialize();
  try {
    assert.equal(computeSchemaFingerprint(pg), computeSchemaFingerprint(sqlite));
    for (const c of pg.getMetadata('Clock').columns.filter(c => c.type === Date)) {
      assert.equal(pg.driver.normalizeType(c), 'timestamp with time zone');
    }
    await sqlite.synchronize();
    const date = new Date('2026-11-01T05:30:00Z');
    await sqlite.getRepository('Clock').save({ id: 1, instant: date });
    assert.equal((await sqlite.getRepository('Clock').findOneByOrFail({ id: 1 })).instant.toISOString(), date.toISOString());
    assert.equal(new DataSource({ type: 'postgres' }).driver.normalizeType({ type: Date }), 'timestamp without time zone');
  } finally { await sqlite.destroy(); }
});

const isPg = process.env.DB_TYPE === 'postgres';
test('MySQL retains its native Date mapping without requiring a live server', async () => {
  // A connector placeholder is sufficient for metadata-only checks; no pool is
  // opened and this does not claim coverage of a live MySQL transaction.
  const options = { type: 'mysql', database: 'metadata_only', connectorPackage: 'mysql2', driver: { createPool() { throw new Error('unexpected connection'); } }, entities: [entity] };
  const native = new DataSource(options);
  const instant = new InstantDataSource(options);
  await native.buildMetadatas();
  await instant.buildMetadatas();
  assert.equal(computeSchemaFingerprint(instant), computeSchemaFingerprint(native));
  assert.equal(instant.driver.normalizeType, native.driver.normalizeType);
  assert.equal(instant.driver.normalizeType(instant.getMetadata('Clock').findColumnWithPropertyName('instant')), 'datetime');
});

test('Postgres legacy conversion, timezone-independent comparisons and restart', { skip: !isPg }, async () => {
  const schema = `qa_instant_${process.pid}`;
  const pgEntity = new EntitySchema({ ...entity.options, columns: { ...entity.options.columns, created_at: { createDate: true }, updated_at: { updateDate: true } } });
  const connection = {
    type: 'postgres', host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'ai_workflow',
  };
  const admin = new DataSource(connection);
  await admin.initialize();
  const oldTZ = process.env.TZ;
  const oldLegacy = process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE;
  let source;
  const options = (zone) => ({ ...connection, schema, entities: [pgEntity], synchronize: true,
    extra: { options: `-c timezone=${zone} -c search_path=${schema},public` } });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    process.env.TZ = 'Asia/Seoul';
    delete process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE;
    const legacy = new DataSource(options('Asia/Seoul'));
    await legacy.initialize();
    const instant = new Date('2026-10-23T12:00:00Z');
    await legacy.getRepository('Clock').save({ id: 1, instant });
    await legacy.query(`UPDATE clock SET created_at = '2026-10-23 21:00:00.123456'`);
    await legacy.destroy();
    source = new InstantDataSource(options('Asia/Seoul'));
    await source.initialize();
    assert.equal((await source.getRepository('Clock').findOneByOrFail({ id: 1 })).instant.toISOString(), instant.toISOString());
    assert.equal((await source.query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS value FROM clock`))[0].value, '2026-10-23 12:00:00.123456');
    const types = await source.query(`SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='clock' AND column_name <> 'id'`, [schema]);
    assert.ok(types.every(x => x.data_type === 'timestamp with time zone'));
    await source.destroy();
    source = undefined;

    // Separate Node processes exercise pg's actual Date serialization/parsing,
    // crossing three process TZs with three independent database session TZs.
    const script = `
      const { InstantDataSource } = require('./dist/database/instant-data-source.js');
      const { EntitySchema } = require('typeorm');
      const config = JSON.parse(process.env.INSTANT_TEST_CONFIG);
      config.entities = [new EntitySchema(${JSON.stringify(pgEntity.options, (_k, v) => v === Date ? '__DATE__' : v === Number ? '__NUMBER__' : v)})];
      for (const c of Object.values(config.entities[0].options.columns)) if (c.type === '__DATE__') c.type = Date; else if (c.type === '__NUMBER__') c.type = Number;
      (async () => {
        const ds = new InstantDataSource(config); await ds.initialize();
        const repo = ds.getRepository('Clock');
        await repo.save([{id: 2, instant: new Date('2026-11-01T05:30:00Z')}, {id: 3, instant: new Date('2026-11-01T06:30:00Z')}, {id: 4, instant: null}]);
        const rows = await repo.find({ order: {id:'ASC'} });
        if (rows[0].instant.toISOString() !== '2026-10-23T12:00:00.000Z' || rows[2].instant - rows[1].instant !== 3600000 || rows[3].instant !== null) throw Error('round trip');
        const count = await repo.createQueryBuilder('c').where('c.instant < :cutoff', {cutoff: new Date('2026-11-01T06:00:00Z')}).getCount();
        if (count !== 2) throw Error('comparison');
        if (Math.abs(Date.now() - rows[1].created_at.getTime()) > 30000) throw Error('DB now clock');
        await repo.update(2, {instant: new Date('2026-11-01T05:30:00Z')});
        if (Math.abs(Date.now() - (await repo.findOneByOrFail({id:2})).updated_at.getTime()) > 30000) throw Error('DB update clock');
        await repo.delete([2,3,4]); await ds.destroy();
      })().catch(e=>{console.error(e); process.exitCode=1});`;
    for (const processTZ of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      for (const dbTZ of ['UTC', 'Asia/Seoul', 'America/New_York']) {
        const child = spawnSync(process.execPath, ['-e', script], {
          cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
          env: { ...process.env, TZ: processTZ, INSTANT_TEST_CONFIG: JSON.stringify(options(dbTZ)) },
        });
        assert.equal(child.status, 0, `${processTZ}/${dbTZ}: ${child.stderr}`);
      }
    }
    source = new InstantDataSource(options('UTC'));
    await source.initialize();
    assert.equal((await source.driver.createSchemaBuilder().log()).upQueries.length, 0, 'restart must not rebuild columns or indexes');
  } finally {
    if (source?.isInitialized) await source.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
    if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
    if (oldLegacy === undefined) delete process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE; else process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE = oldLegacy;
  }
});

test('unsafe legacy timestamps abort atomically; explicit writer zone and schema boundaries', { skip: !isPg }, async () => {
  const schema = `qa_instant_guard_${process.pid}`;
  const base = { type: 'postgres', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'ai_workflow' };
  const admin = new DataSource(base);
  await admin.initialize();
  const previous = { TZ: process.env.TZ, AWB_LEGACY_TIMESTAMP_TIMEZONE: process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE };
  const entities = ['a_clock', 'z_clock'].map(name => new EntitySchema({ name, tableName: name, columns: { id: { type: Number, primary: true }, at: { type: Date, nullable: true } } }));
  const options = (zone) => ({ ...base, schema, entities, synchronize: true, extra: { options: `-c timezone=${zone} -c search_path=${schema},public` } });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const legacy = new DataSource(options('America/New_York'));
    await legacy.initialize();
    await legacy.query(`INSERT INTO a_clock VALUES (1, '2026-10-23 12:00:00'); INSERT INTO z_clock VALUES (1, '2026-11-01 01:30:00'); CREATE TABLE external_clock (at timestamp);`);
    await legacy.destroy();
    process.env.TZ = 'America/New_York';
    delete process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE;
    for (const wall of ['2026-11-01 01:30:00', '2026-03-08 02:30:00']) {
      await admin.query(`UPDATE "${schema}".z_clock SET at=$1`, [wall]);
      await assert.rejects(new InstantDataSource(options('America/New_York')).initialize(), /DST fold\/gap/);
      const types = await admin.query('SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND column_name=$2', [schema, 'at']);
      assert.ok(types.every(x => x.data_type === 'timestamp without time zone'), 'earlier table conversion rolls back too');
    }
    await admin.query(`UPDATE "${schema}".z_clock SET at='2026-10-23 21:00:00';`);
    process.env.TZ = 'Asia/Seoul';
    await assert.rejects(new InstantDataSource(options('UTC')).initialize(), /differs from PostgreSQL/);
    process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE = 'Invalid/Zone';
    await assert.rejects(new InstantDataSource(options('UTC')).initialize(), /Invalid AWB_LEGACY/);
    process.env.AWB_LEGACY_TIMESTAMP_TIMEZONE = 'Asia/Seoul';
    const source = new InstantDataSource(options('UTC'));
    await source.initialize();
    try {
      assert.equal((await source.getRepository('z_clock').findOneByOrFail({ id: 1 })).at.toISOString(), '2026-10-23T12:00:00.000Z');
      const external = await source.query(`SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='external_clock'`, [schema]);
      assert.equal(external[0].data_type, 'timestamp without time zone');
    } finally { await source.destroy(); }
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

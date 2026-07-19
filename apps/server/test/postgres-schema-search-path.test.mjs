// Regression test — ticket caa919be
//
// The Postgres QA matrix creates one DB_SCHEMA per test process. TypeORM's
// `schema` option directs synchronize there, but does not change PostgreSQL's
// search_path; raw unqualified DATA-migration DDL then looked in public and
// failed with `relation "agents" does not exist`. Keep both settings aligned.

import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file://' + path.join(__dirname, '..', 'dist', 'db.js');
const originalEnv = {
  DB_TYPE: process.env.DB_TYPE,
  DB_SCHEMA: process.env.DB_SCHEMA,
};

process.env.DB_TYPE = 'postgres';
delete process.env.DB_SCHEMA;
const { buildDataSourceOptions } = await import(dbUrl);

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('sets schema and connection search_path together for isolated Postgres QA', () => {
  process.env.DB_SCHEMA = 'qa_1234_7800';
  const options = buildDataSourceOptions();
  assert.equal(options.schema, 'qa_1234_7800');
  assert.deepEqual(options.extra, { options: '-c search_path=qa_1234_7800,public' });
});

it('preserves the default Postgres search_path when DB_SCHEMA is unset', () => {
  delete process.env.DB_SCHEMA;
  const options = buildDataSourceOptions();
  assert.equal(options.schema, undefined);
  assert.equal(options.extra, undefined);
});

it('rejects unsafe DB_SCHEMA values before interpolating pg connection options', () => {
  process.env.DB_SCHEMA = 'qa_safe -c role=admin';
  assert.throws(() => buildDataSourceOptions(), /Invalid DB_SCHEMA identifier/);
});

it('rejects uppercase DB_SCHEMA because PostgreSQL folds an unquoted search_path', () => {
  process.env.DB_SCHEMA = 'QA_Flows';
  assert.throws(() => buildDataSourceOptions(), /Invalid DB_SCHEMA identifier/);
});

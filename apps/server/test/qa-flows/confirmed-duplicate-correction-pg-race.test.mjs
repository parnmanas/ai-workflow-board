// Regression (Postgres): two server instances correcting the same confirmed
// duplicate link at once. Under READ COMMITTED both may read the old canonical
// id, so TicketDuplicateService.correctConfirmedLink clears it with a
// compare-and-set (`WHERE canonical_ticket_id = <old>`) — exactly one caller may
// win, write the decision row and the activity row; the other must fail.
//
// sql.js serializes transactions in-process (db.ts serializeSqljsTransactions),
// so the race only exists on Postgres. Runs when DB_TYPE=postgres (the CI
// `test:qa:pg` matrix) and self-skips otherwise.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

// Isolated schema for this test process (mirrors helpers/boot.mjs).
const SCHEMA = `qa_dupfix_${process.pid}`;

const pgConfig = () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ai_workflow',
});

let ds1;
let ds2;

after(async () => {
  try { if (ds1?.isInitialized) await ds1.destroy(); } catch { /* best-effort */ }
  try { if (ds2?.isInitialized) await ds2.destroy(); } catch { /* best-effort */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client(pgConfig());
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* best-effort cleanup */ }
  }
});

test('two Postgres connections race confirmed-link correction → exactly one wins', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);
  const { Client } = await import('pg');
  const admin = new Client(pgConfig());
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  await admin.end();
  process.env.DB_SCHEMA = SCHEMA;

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { TicketDuplicateService } = await import(
    'file://' + path.join(DIST, 'modules', 'tickets', 'ticket-duplicate.service.js')
  );
  const { DataSource } = await import('typeorm');

  // Two independent DataSources = two server instances (separate pools).
  ds1 = new DataSource(buildDataSourceOptions());
  ds2 = new DataSource(buildDataSourceOptions());
  await ds1.initialize();
  await ds2.initialize();

  const ws = await ds1.getRepository(entities.Account).save({ name: `correction-${randomUUID()}` });
  const canonical = await ds1.getRepository(entities.Ticket).save({
    account_id: ws.id, status: 'in_progress', title: 'canonical',
  });
  const report = await ds1.getRepository(entities.Ticket).save({
    account_id: ws.id, status: 'done', title: 'independent', canonical_ticket_id: canonical.id,
  });

  const results = await Promise.allSettled([
    new TicketDuplicateService(ds1).correctConfirmedLink(report.id, 'one', 'one'),
    new TicketDuplicateService(ds2).correctConfirmedLink(report.id, 'two', 'two'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);

  const after = await ds1.getRepository(entities.Ticket).findOneBy({ id: report.id });
  assert.equal(after.canonical_ticket_id, null);
  assert.equal(await ds1.getRepository(entities.ActivityLog).count({
    where: { ticket_id: report.id, action: 'duplicate_link_corrected' },
  }), 1);
  assert.equal(await ds1.getRepository(entities.TicketDuplicateDecision).count({
    where: { report_ticket_id: report.id, outcome: 'corrected_independent' },
  }), 1);
});

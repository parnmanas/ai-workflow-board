// Regression (Postgres): durable dispatch outbox — the dual-DB CAS + transaction
// -abort-avoidance claims the ticket requires be verified on REAL Postgres
// (ticket 3c3b17a3, reviewer production-rollout blocker #2).
//
// The sql.js suite (dispatch-intent-idempotency / -pre-index-repair) exercises a
// single in-process DataSource. That cannot validate two things that only matter
// on Postgres / multi-instance:
//
//   1. MULTI-INSTANCE CAS — two SEPARATE DataSources (separate connections/pools,
//      i.e. two server instances) racing recordDispatched for the same (ticket,
//      role) must still land EXACTLY ONE open row. The partial UNIQUE index is the
//      cross-connection arbiter; bare `ON CONFLICT DO NOTHING` (.orIgnore()) makes
//      the loser a silent no-op.
//
//   2. TRANSACTION NOT ABORTED — on Postgres, a unique-violation raised inside a
//      transaction poisons the whole transaction ("current transaction is aborted,
//      commands ignored until end of transaction block"). That is exactly why the
//      insert path uses statement-level `ON CONFLICT DO NOTHING` instead of
//      catching a thrown violation: a losing insert inside a caller's `manager`
//      transaction must leave that transaction still USABLE. This asserts both the
//      failure mode (a caught bare unique violation DOES abort the tx) and that
//      ON CONFLICT DO NOTHING does NOT.
//
// SKIP semantics: runs only when DB_TYPE=postgres (the CI `test:qa:pg` matrix).
// Under the default sql.js run it self-skips with a clear message, so it is green
// everywhere and executes for real only where a Postgres server is present. This
// environment (the assignee's sandbox) has NO Postgres — so this file is authored
// against the same pg harness the existing test:qa:pg matrix uses and is verified
// to load + self-skip locally; the live green must come from the CI pg matrix.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

// Isolated schema for this test process (mirrors helpers/boot.mjs). Keyed on pid
// so a reused pid can't inherit stale tables. Only touched when IS_PG.
const SCHEMA = `qa_pgrace_${process.pid}`;

let ds1;
let ds2;
let adminClient;

after(async () => {
  try { if (ds1?.isInitialized) await ds1.destroy(); } catch { /* best-effort */ }
  try { if (ds2?.isInitialized) await ds2.destroy(); } catch { /* best-effort */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'ai_workflow',
      });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* best-effort cleanup */ }
  }
});

const dispatchArgs = (ticketId, role, triggerId) => ({
  workspaceId: 'ws1', boardId: 'b1', ticketId, role, agentId: 'agentX',
  triggerSource: 'column_move', triggerId,
});
const logStub = { warn() {}, info() {}, error() {}, debug() {} };

test('two DataSources race recordDispatched → exactly ONE open row (multi-instance CAS)', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  adminClient = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await adminClient.connect();
  await adminClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await adminClient.query(`CREATE SCHEMA "${SCHEMA}"`);
  await adminClient.end();

  process.env.DB_SCHEMA = SCHEMA;

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const { DispatchIntent } = await import('file://' + path.join(DIST, 'entities', 'DispatchIntent.js'));
  const { DispatchIntentService, DISPATCH_INTENT_STATUS } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
  );
  const { DataSource } = await import('typeorm');
  const OPEN = [DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT];

  // Two independent DataSources = two server instances (separate pools).
  ds1 = new DataSource(buildDataSourceOptions());
  ds2 = new DataSource(buildDataSourceOptions());
  await ds1.initialize();     // synchronize → creates dispatch_intents + partial unique index
  await ds2.initialize();     // synchronize is idempotent — schema already present

  // Confirm the partial UNIQUE index DDL landed on real Postgres (the ticket's
  // "partial-index DDL verified on Postgres" requirement).
  const idxRows = await ds1.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = $1 AND indexname = 'uniq_dispatch_intent_open_ticket_role'`,
    [SCHEMA],
  );
  assert.equal(idxRows.length, 1, 'partial unique index exists on Postgres');
  assert.match(String(idxRows[0].indexdef), /UNIQUE/i, 'index is UNIQUE');
  // Postgres 는 부분 인덱스 predicate 를 `WHERE ((status)::text <> 'resolved'::text)` 로
  // 정규화한다 (varchar → text 캐스트 삽입 + `!=`→`<>` 치환). 따라서 연산자가 컬럼명
  // 바로 뒤에 오도록 요구하면 매칭에 실패한다. 캐스트/괄호를 허용하도록 느슨히 매칭하며
  // sqlite 의 `WHERE status != 'resolved'` 형태도 동일 정규식으로 커버한다.
  assert.match(String(idxRows[0].indexdef), /WHERE .*status.*(?:<>|!=).*'resolved'/i, 'index is PARTIAL on open rows');

  const svc1 = new DispatchIntentService(ds1, logStub);
  const svc2 = new DispatchIntentService(ds2, logStub);
  const repo = ds1.getRepository(DispatchIntent);

  // The race: two instances record a dispatch for the same (ticket, role) at once.
  const T = 't-pg-cas';
  await Promise.all([
    svc1.recordDispatched(dispatchArgs(T, 'assignee', 'trig-A')),
    svc2.recordDispatched(dispatchArgs(T, 'assignee', 'trig-B')),
  ]);

  const all = await repo.find({ where: { ticket_id: T, role: 'assignee' } });
  const open = all.filter((r) => OPEN.includes(r.status));
  assert.equal(open.length, 1, 'multi-instance double-emit yields exactly ONE open intent');
  assert.equal(all.length, 1, 'no orphan/duplicate rows across instances');
  assert.equal(open[0].status, DISPATCH_INTENT_STATUS.IN_FLIGHT, 'surviving row is in_flight');
});

test('bare ON CONFLICT DO NOTHING does NOT abort the enclosing transaction (why not throw-catch)', { skip: SKIP }, async () => {
  const { DispatchIntent } = await import('file://' + path.join(DIST, 'entities', 'DispatchIntent.js'));
  const { DISPATCH_INTENT_STATUS } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
  );

  const T = 't-pg-tx';
  // Commit a first open row so any second open insert conflicts on the partial index.
  await ds1.getRepository(DispatchIntent).save(ds1.getRepository(DispatchIntent).create({
    id: randomUUID(), ticket_id: T, role: 'assignee',
    status: DISPATCH_INTENT_STATUS.IN_FLIGHT, next_attempt_at: new Date(),
  }));

  // ── Failure mode (the reason ON CONFLICT is used): a bare unique-violation
  //    caught inside a tx leaves the Postgres transaction ABORTED — the next
  //    statement in the same tx fails with "current transaction is aborted".
  let abortedAfterCaughtViolation = false;
  try {
    await ds1.transaction(async (mgr) => {
      try {
        await mgr.getRepository(DispatchIntent).insert({
          id: randomUUID(), ticket_id: T, role: 'assignee',
          status: DISPATCH_INTENT_STATUS.PENDING, next_attempt_at: new Date(),
        });
      } catch { /* swallow the unique violation, as a naive throw-catch upsert would */ }
      // Same-tx follow-up: on Postgres this throws because the tx is poisoned.
      await mgr.getRepository(DispatchIntent).count();
    });
  } catch (e) {
    if (/aborted/i.test(String(e?.message))) abortedAfterCaughtViolation = true;
  }
  assert.ok(
    abortedAfterCaughtViolation,
    'a caught bare unique violation aborts the PG tx — this is the throw-catch failure ON CONFLICT avoids',
  );

  // ── The fix: statement-level ON CONFLICT DO NOTHING (.orIgnore()) — a losing
  //    insert is a silent no-op and the SAME transaction stays fully usable.
  const survivedCount = await ds1.transaction(async (mgr) => {
    await mgr.getRepository(DispatchIntent)
      .createQueryBuilder()
      .insert()
      .into(DispatchIntent)
      .values({
        id: randomUUID(), ticket_id: T, role: 'assignee',
        status: DISPATCH_INTENT_STATUS.PENDING, next_attempt_at: new Date(),
      })
      .orIgnore()          // → INSERT ... ON CONFLICT DO NOTHING (Postgres)
      .execute();          // conflicts on the partial unique index → DO NOTHING, no throw
    // Same-tx follow-up MUST succeed — the tx was not aborted.
    return mgr.getRepository(DispatchIntent).count({ where: { ticket_id: T, role: 'assignee' } });
  });
  assert.equal(typeof survivedCount, 'number', 'ON CONFLICT DO NOTHING keeps the tx usable — same-tx query succeeds');
  assert.equal(survivedCount, 1, 'the losing insert added no row — still exactly one open row');
});

// Regression (Postgres): OrchestrationReaperService.remindAwaitingConfirmInner()
// (apps/server/src/modules/orchestration/orchestration-reaper.service.ts) joins
// OrchestrationMission.id — a `uuid` PK on Postgres — against
// OrchestrationStep.mission_id, which is `varchar` on both backends. Postgres
// has no implicit uuid<->varchar cast and raises "operator does not exist:
// uuid = character varying", so the whole sweep threw on every tick.
//
// The failure was silent by construction: remindAwaitingConfirm() deliberately
// swallows its own errors (so a late sweep cannot zero out the accounting of
// the sweeps before it) and only logs `confirm reminder sweep failed: …`.
// Production on rolf logged exactly that line every 5 minutes while no confirm
// reminder had ever been sent.
//
// Why the existing coverage missed it: orchestration-reaper-behavior.test.mjs
// drives runOnce() against in-memory fake repositories, so the candidate query
// is never compiled by a database at all. sqljs is loose-typed and would not
// reproduce it either — only real Postgres does.
//
// This asserts the sweep selects the CORRECT candidate, not merely that it
// stops throwing: a cast applied to the wrong side of the join silently matches
// zero rows instead of erroring, which a throw-only assertion would pass. The
// fixture therefore includes three decoys that must all be rejected, one of
// them rejected *by the join itself* (a gate whose mission is paused) so a
// vacuous join cannot pass either.
//
// SKIP semantics: runs only when DB_TYPE=postgres (the `test:qa:pg` matrix),
// self-skipping elsewhere — same pattern as
// qa-flows/prompt-audit-report-pg-cast.test.mjs.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

const SCHEMA = `qa_confirmremind_${process.pid}`;

let ds;

function pgConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  };
}

after(async () => {
  try { if (ds?.isInitialized) await ds.destroy(); } catch { /* best-effort */ }
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

test('confirm reminder sweep joins uuid mission PK to varchar mission_id and picks the right gate on real Postgres', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const admin = new Client(pgConfig());
  await admin.connect();
  // Keep uuid-ossp pinned to public so this disposable schema cannot strand it.
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  await admin.end();

  process.env.DB_SCHEMA = SCHEMA;
  // Shrink the reminder window so a 10-minute-old gate is already overdue, and
  // push the two stall timeouts to their ceiling so the other sweeps in
  // runOnce() stay out of this fixture's way.
  process.env.ORCHESTRATION_CONFIRM_REMINDER_MS = String(60_000);
  process.env.ORCHESTRATION_RUNNING_STALL_TIMEOUT_MS = String(24 * 60 * 60_000);
  process.env.ORCHESTRATION_PLANNING_TIMEOUT_MS = String(24 * 60 * 60_000);

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { OrchestrationReaperService } = await import(
    'file://' + path.join(DIST, 'modules', 'orchestration', 'orchestration-reaper.service.js')
  );
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  // synchronize puts mission.id down as a real `uuid` and step.mission_id as
  // `varchar` — production's exact type asymmetry, which is the whole point.
  await ds.initialize();

  const missionRepo = ds.getRepository(entities.OrchestrationMission);
  const stepRepo = ds.getRepository(entities.OrchestrationStep);
  const eventRepo = ds.getRepository(entities.OrchestrationEvent);
  const teamRepo = ds.getRepository(entities.OrchestrationTeam);

  const idTypes = await ds.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1
        AND ((table_name = 'orchestration_missions' AND column_name = 'id')
          OR (table_name = 'orchestration_steps' AND column_name = 'mission_id'))`,
    [SCHEMA],
  );
  const typeOf = (t, c) => idTypes.find((r) => r.table_name === t && r.column_name === c)?.data_type;
  assert.equal(typeOf('orchestration_missions', 'id'), 'uuid', 'fixture must reproduce the uuid PK');
  assert.equal(
    typeOf('orchestration_steps', 'mission_id'), 'character varying',
    'fixture must reproduce the varchar FK — if this ever becomes uuid the cast can go',
  );

  const ws = 'ws-confirm-remind';
  const team = 'team-confirm-remind';
  const now = new Date();
  const overdue = new Date(now.getTime() - 10 * 60_000);

  const running = await missionRepo.save(missionRepo.create({
    workspace_id: ws, team_id: team, title: 'running mission', status: 'running',
  }));
  const paused = await missionRepo.save(missionRepo.create({
    workspace_id: ws, team_id: team, title: 'paused mission', status: 'paused',
  }));

  const gate = (missionId, key, extra) => stepRepo.create({
    mission_id: missionId, workspace_id: ws, team_id: team, step_key: key, title: key,
    status: 'awaiting_user', visit: 1, dispatched_at: overdue, ...extra,
  });

  // The one that must be reminded.
  const eligible = await stepRepo.save(gate(running.id, 'eligible'));
  // Decoy 1 — rejected by the JOIN: the gate is overdue but its mission is not
  // running. If the join were dropped or matched nothing meaningful, this row
  // would either slip through or the whole result would be empty.
  await stepRepo.save(gate(paused.id, 'paused-mission'));
  // Decoy 2 — this pass's reminder is already claimed.
  await stepRepo.save(gate(running.id, 'already-reminded', { confirm_reminded_visit: 1 }));
  // Decoy 3 — opened just now, still inside the window.
  await stepRepo.save(gate(running.id, 'too-recent', { dispatched_at: now }));

  const warnings = [];
  const logService = {
    info() {}, debug() {}, error(cat, msg) { warnings.push(`ERROR ${cat}: ${msg}`); },
    warn(cat, msg) { warnings.push(`${cat}: ${msg}`); },
  };
  const claimed = [];
  const sent = [];
  const confirmNotify = {
    async claimReminder(step) { claimed.push(step.id); return true; },
    async sendReminder(mission, step, waitedMs) { sent.push({ step: step.id, mission: mission.id, waitedMs }); },
  };
  const missionsSvc = { async recordEvent() {} };
  const runner = {};
  const instanceQuiesce = { async isQuiesced() { return false; } };

  const reaper = new OrchestrationReaperService(
    missionRepo, stepRepo, eventRepo, teamRepo,
    missionsSvc, runner, logService, instanceQuiesce, confirmNotify,
  );

  const result = await reaper.runOnce(now);

  assert.deepEqual(
    warnings.filter((w) => w.includes('confirm reminder sweep failed')), [],
    'the candidate query must compile on Postgres — this is the line production logged every sweep',
  );
  assert.equal(result.confirm_reminders, 1, 'exactly the one eligible gate is reminded');
  assert.deepEqual(sent.map((s) => s.step), [eligible.id], 'the reminder goes to the eligible gate, not a decoy');
  assert.deepEqual(claimed, [eligible.id], 'no decoy is even claimed');
  assert.ok(
    sent[0].waitedMs >= 9 * 60_000,
    `waited time is measured from the anchor, got ${sent[0].waitedMs}ms`,
  );
});

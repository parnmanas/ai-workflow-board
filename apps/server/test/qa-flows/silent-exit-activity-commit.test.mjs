// QA flow: the silent-exit warning's activity row commits with the comment, and
// its 'activity' event goes out only after that commit (ticket 8d940c31).
//
// `/api/agent/tickets/:id/silent-exit-comment` creates (or dedupe-bumps) the
// warning comment inside a transaction. Its activity row used to be written by
// the non-transactional logActivity(), which also emitted 'activity' at once:
//   - Postgres: the row autocommitted on another pooled connection, so it
//     outlived a rolled-back comment, and listeners (board_update SSE,
//     TicketDispatchService) ran before the comment was visible to them.
//   - sql.js: the row and the listeners' writes ran in the transaction's queue
//     turn, and the event was already out when the transaction rolled back.
//
// For the created (201) and the dedupe (200) path this flow asserts:
//   1. the activity row is written by the transaction that wrote the comment,
//      and the event follows that transaction's commit;
//   2. the stored row is the emitted row and keeps actor_id='system';
//   3. when that commit fails, no comment change, activity row or event remains.
// A TypeORM subscriber binds to the query runner that wrote the probe comment
// and observes (or fails) that runner's writes and commit. That is exact on
// sql.js, whose one shared runner the transaction queue serializes, and on the
// Postgres matrix, where the old logActivity() wrote on a different runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAccount, createTicket } from '../helpers/fixtures.mjs';

const PROBE = 'silent-exit-activity-probe';
// Schema-qualified on the Postgres matrix.
const COMMENT_WRITE = /^\s*(?:INSERT INTO|UPDATE)\s+(?:"[^"]+"\.)?"comments"/i;
const ACTIVITY_WRITE = /^\s*INSERT INTO\s+(?:"[^"]+"\.)?"activity_logs"/i;

async function postSilentExit(port, ticketId, body) {
  const resp = await fetch(
    `http://127.0.0.1:${port}/api/agent/tickets/${encodeURIComponent(ticketId)}/silent-exit-comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, body: json };
}

// Same exit code + role → same fingerprint → the dedupe path.
function silentExit(exitCode, cycle) {
  return {
    content: `${PROBE}: subagent exited (cycle ${cycle}) — exit ${exitCode}`,
    exit_code: exitCode,
    role: 'assignee',
    cycle_trigger_id: `trigger-${cycle}`,
    actor_name: 'agent-manager',
  };
}

test('silent-exit activity row commits with the comment and is emitted after the commit', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const commentRepo = ds.getRepository('Comment');
  const activityRepo = ds.getRepository('ActivityLog');

  const account = await createAccount(app, getDataSourceToken, 'silent-exit-activity');
  const ticket = await createTicket(app, getDataSourceToken, {
    accountId: account.id,
    status: 'in_progress',
    title: 'silent-exit activity commit test',
  });
  const commentActivityCount = () =>
    activityRepo.count({ where: { ticket_id: ticket.id, entity_type: 'comment' } });

  // In order: the probe comment write, this ticket's activity rows written by
  // the same runner, the end of that runner's transaction, and this ticket's
  // comment activity events.
  const timeline = [];
  const emitted = [];
  let probeRunner = null;
  let failProbeCommit = false;
  // Savepoint releases fire the same hooks; only the outer transaction ends here.
  const endsProbeTransaction = (event) => event.queryRunner === probeRunner && !event.queryRunner.isTransactionActive;
  const subscriber = {
    afterQuery(event) {
      if (!event.success) return;
      const params = event.parameters || [];
      if (COMMENT_WRITE.test(event.query) && params.some((p) => typeof p === 'string' && p.includes(PROBE))) {
        probeRunner = event.queryRunner;
        timeline.push('comment write');
      } else if (ACTIVITY_WRITE.test(event.query) && event.queryRunner === probeRunner && params.includes(ticket.id)) {
        timeline.push('activity write');
      }
    },
    beforeTransactionCommit(event) {
      if (!failProbeCommit || event.queryRunner !== probeRunner) return;
      failProbeCommit = false;
      throw new Error('injected commit failure');
    },
    afterTransactionCommit(event) {
      if (!endsProbeTransaction(event)) return;
      probeRunner = null;
      timeline.push('commit');
    },
    afterTransactionRollback(event) {
      if (!endsProbeTransaction(event)) return;
      probeRunner = null;
      timeline.push('rollback');
    },
  };
  ds.subscribers.push(subscriber);
  t.after(() => { ds.subscribers.splice(ds.subscribers.indexOf(subscriber), 1); });
  const onActivity = (row) => {
    if (row.ticket_id !== ticket.id || row.entity_type !== 'comment') return;
    timeline.push(`activity ${row.action}`);
    emitted.push(row);
  };
  activityEvents.on('activity', onActivity);
  t.after(() => { activityEvents.off('activity', onActivity); });

  step('Created warning: the activity row is emitted after the comment commits');
  timeline.length = 0;
  const created = await postSilentExit(port, ticket.id, silentExit(143, 1));
  assert.equal(created.status, 201);
  assert.deepEqual(timeline, ['comment write', 'activity write', 'commit', 'activity created']);
  const createdRows = await activityRepo.find({
    where: { ticket_id: ticket.id, entity_type: 'comment', entity_id: created.body.id, action: 'created' },
  });
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0].actor_id, 'system', 'the warning keeps its system actor');
  assert.equal(emitted.at(-1).id, createdRows[0].id, 'the event carries the committed row');

  step('Deduped warning: the repeat-count row is emitted after the bump commits');
  timeline.length = 0;
  const bumped = await postSilentExit(port, ticket.id, silentExit(143, 2));
  assert.equal(bumped.status, 200);
  assert.equal(bumped.body.id, created.body.id);
  assert.equal(bumped.body.repeat_count, 2);
  assert.deepEqual(timeline, ['comment write', 'activity write', 'commit', 'activity updated']);
  const bumpRows = await activityRepo.find({
    where: { ticket_id: ticket.id, entity_type: 'comment', entity_id: created.body.id, action: 'updated' },
  });
  assert.equal(bumpRows.length, 1);
  assert.equal(bumpRows[0].actor_id, 'system');
  assert.equal(bumpRows[0].new_value, '2');
  assert.equal(emitted.at(-1).id, bumpRows[0].id);

  const activityRowsBefore = await commentActivityCount();
  const eventsBefore = emitted.length;

  step('Created warning whose commit fails: no comment, activity row or event');
  timeline.length = 0;
  failProbeCommit = true;
  const lostCreate = await postSilentExit(port, ticket.id, silentExit(137, 3));
  assert.equal(lostCreate.status, 500);
  assert.deepEqual(timeline, ['comment write', 'activity write', 'rollback']);
  assert.equal((await commentRepo.find({ where: { ticket_id: ticket.id } })).length, 1, 'the exit-137 warning rolled back');
  assert.equal(await commentActivityCount(), activityRowsBefore, 'its activity row rolled back with it');
  assert.equal(emitted.length, eventsBefore);

  step('Deduped warning whose commit fails: the bump, its activity row and event are all gone');
  timeline.length = 0;
  failProbeCommit = true;
  const lostBump = await postSilentExit(port, ticket.id, silentExit(143, 4));
  assert.equal(lostBump.status, 500);
  assert.deepEqual(timeline, ['comment write', 'activity write', 'rollback']);
  const kept = await commentRepo.findOne({ where: { id: created.body.id } });
  assert.equal(kept.repeat_count, 2);
  assert.match(kept.content, /cycle 2/);
  assert.equal(await commentActivityCount(), activityRowsBefore);
  assert.equal(emitted.length, eventsBefore);

  step('The next warning after the failed commits goes through normally');
  timeline.length = 0;
  const next = await postSilentExit(port, ticket.id, silentExit(137, 5));
  assert.equal(next.status, 201);
  assert.deepEqual(timeline, ['comment write', 'activity write', 'commit', 'activity created']);
  assert.equal((await commentRepo.find({ where: { ticket_id: ticket.id } })).length, 2);
  assert.equal(await commentActivityCount(), activityRowsBefore + 1);

  exitAfterTests(0);
});

// Behavioral test for WorkspaceScheduleService.runOnce() / runNow() / CRUD —
// drives the scheduler sweep against in-memory fake repos with a fixed `now`
// (ticket 8845be79). Direct sibling of qa-schedule-behavior.test.mjs /
// security-schedule-behavior.test.mjs. Covers:
//
//   • due schedule → opens a fresh room, seats target agent + 'system' user,
//     sends task_prompt, advances next_run_at, stamps last_run_at/last_room_id.
//   • Idempotency / overlap — next_run_at advanced BEFORE dispatch, so a second
//     sweep at the SAME `now` re-dispatches nothing (cursor moved past).
//   • run-now manual trigger fires regardless of `enabled` and does NOT disturb
//     next_run_at; still stamps last_room_id.
//   • disabled schedule is never swept (negative case).
//   • orphan self-heal — an enabled schedule with next_run_at=null gets a cursor
//     computed forward WITHOUT firing on the same sweep.
//   • a missing/cross-workspace target agent fails that schedule WITHOUT stalling
//     the sweep (next_run_at still advanced so it retries).
//   • CRUD validation — cadence both/neither, required target_agent_id /
//     task_prompt, computeNextRun cron/interval/disabled.
//
// Imports the compiled service from dist/ (built by `npm run build`) and injects
// stub repos + a sendMessage spy — the seams the service exposes via its
// constructor and the `now` param on runOnce()/computeNextRun().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceScheduleService } from '../dist/modules/workspace-schedule/workspace-schedule.service.js';

const MIN = 60_000;
const NOW = new Date('2026-06-29T12:00:00Z');

const noopLog = { info() {}, warn() {}, error() {} };

// Stub schedule repo over a plain-object row array. Handles the two find shapes
// runOnce uses: { enabled, next_run_at: IsNull() } and
// { enabled, next_run_at: LessThanOrEqual(now) } (+ order/take). save() records
// ids — the service mutates the same row reference it read.
function makeScheduleRepo(rows) {
  return {
    rows,
    saves: [],
    deletes: [],
    create(obj) {
      return { ...obj };
    },
    async find(opts = {}) {
      const where = opts.where || {};
      const op = where.next_run_at;
      let res = rows.filter((r) => {
        if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
        if (op) {
          const threshold = op._value;
          if (threshold === undefined || threshold === null) {
            if (r.next_run_at !== null && r.next_run_at !== undefined) return false;
          } else {
            const thresh = new Date(threshold).getTime();
            if (!(r.next_run_at && new Date(r.next_run_at).getTime() <= thresh)) return false;
          }
        }
        return true;
      });
      if (opts.order?.next_run_at) {
        res = res.slice().sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at));
      }
      if (opts.take) res = res.slice(0, opts.take);
      return res;
    },
    async findOne({ where }) {
      return rows.find((r) => r.id === where.id && (where.workspace_id === undefined || r.workspace_id === where.workspace_id)) || null;
    },
    async save(row) {
      this.saves.push(row.id);
      if (!rows.includes(row)) rows.push(row);
      return row;
    },
    async delete(criteria) {
      this.deletes.push(criteria.id);
    },
    // create()/update() validation paths don't hit createQueryBuilder, but list() does.
    createQueryBuilder() {
      const self = this;
      const q = {
        _ws: null,
        where(_clause, params) { this._ws = params?.ws ?? null; return this; },
        andWhere() { return this; },
        orderBy() { return this; },
        async getMany() { return self.rows.filter((r) => this._ws === null || r.workspace_id === this._ws); },
      };
      return q;
    },
  };
}

// Room + participant repos record what the dispatch creates. roomRepo.save
// assigns a deterministic sequential id so last_room_id is checkable.
function makeRoomRepo() {
  let seq = 0;
  return {
    created: [],
    create(obj) { return { ...obj }; },
    async save(obj) {
      seq += 1;
      obj.id = `room-${seq}`;
      this.created.push(obj);
      return obj;
    },
  };
}

function makeParticipantRepo() {
  return {
    created: [],
    create(obj) { return { ...obj }; },
    async save(rowsOrRow) {
      const arr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
      this.created.push(...arr);
      return rowsOrRow;
    },
  };
}

function makeAgentRepo(agents) {
  return {
    async findOne({ where }) {
      return agents.find((a) => a.id === where.id) || null;
    },
  };
}

function makeMessaging() {
  return {
    calls: [],
    async sendMessage(roomId, workspaceId, senderType, senderId, senderName, content) {
      this.calls.push({ roomId, workspaceId, senderType, senderId, senderName, content });
      return { id: 'msg-1' };
    },
  };
}

function makeSchedule(over = {}) {
  return {
    id: 'sch-1',
    workspace_id: 'ws-1',
    board_id: null,
    name: 'nightly-task',
    target_agent_id: 'agent-1',
    task_prompt: 'do the thing',
    cron: null,
    interval_ms: 30 * MIN,
    enabled: true,
    next_run_at: new Date(NOW.getTime() - MIN), // due (1 min ago)
    last_run_at: null,
    last_room_id: null,
    triggered_by_type: 'user',
    created_by: '',
    ...over,
  };
}

function svcWith(rows, agents = [{ id: 'agent-1', workspace_id: 'ws-1', name: 'Bot' }]) {
  const scheduleRepo = makeScheduleRepo(rows);
  const roomRepo = makeRoomRepo();
  const participantRepo = makeParticipantRepo();
  const agentRepo = makeAgentRepo(agents);
  const messaging = makeMessaging();
  const svc = new WorkspaceScheduleService(scheduleRepo, roomRepo, participantRepo, agentRepo, messaging, noopLog);
  return { svc, scheduleRepo, roomRepo, participantRepo, agentRepo, messaging };
}

test('due schedule opens a room, seats agent + system, sends task_prompt, advances next_run_at', async () => {
  const sch = makeSchedule({ board_id: 'board-9' });
  const { svc, roomRepo, participantRepo, messaging } = svcWith([sch]);

  const { dispatched } = await svc.runOnce(NOW);

  assert.deepEqual(dispatched, ['sch-1'], 'the due schedule is dispatched');
  assert.equal(roomRepo.created.length, 1, 'one fresh room per run');
  assert.equal(roomRepo.created[0].workspace_id, 'ws-1');
  assert.equal(roomRepo.created[0].type, 'group');
  // agent + synthetic 'system' user seated
  const types = participantRepo.created.map((p) => `${p.participant_type}:${p.participant_id}`).sort();
  assert.deepEqual(types, ['agent:agent-1', 'user:system']);
  // task_prompt sent from a 'user'/'system' sender (the spawn-triggering shape)
  assert.equal(messaging.calls.length, 1, 'sendMessage called once');
  assert.equal(messaging.calls[0].content, 'do the thing');
  assert.equal(messaging.calls[0].senderType, 'user');
  assert.equal(messaging.calls[0].senderId, 'system');
  // stamps + cursor
  assert.equal(sch.last_room_id, 'room-1', 'last_room_id stamped');
  assert.ok(sch.last_run_at instanceof Date, 'last_run_at stamped');
  assert.equal(new Date(sch.next_run_at).getTime(), NOW.getTime() + 30 * MIN, 'next_run_at = now + interval');
});

test('idempotency: a second sweep at the same `now` re-dispatches nothing (cursor advanced)', async () => {
  const sch = makeSchedule();
  const { svc, messaging } = svcWith([sch]);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.dispatched, ['sch-1'], 'first sweep fires');

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.dispatched, [], 'second sweep at same now fires nothing — next_run_at is past now');
  assert.equal(messaging.calls.length, 1, 'sendMessage still called exactly once total');
});

test('disabled schedule is never swept even when overdue', async () => {
  const sch = makeSchedule({ enabled: false, next_run_at: new Date(NOW.getTime() - 60 * MIN) });
  const { svc, messaging, roomRepo } = svcWith([sch]);

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'disabled schedule not dispatched');
  assert.equal(messaging.calls.length, 0, 'sendMessage never called');
  assert.equal(roomRepo.created.length, 0, 'no room opened');
});

test('orphan self-heal: enabled schedule with next_run_at=null gets a cursor WITHOUT firing', async () => {
  const sch = makeSchedule({ next_run_at: null });
  const { svc, messaging } = svcWith([sch]);

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'orphan is not fired on the heal sweep');
  assert.equal(messaging.calls.length, 0, 'sendMessage not called');
  assert.ok(sch.next_run_at instanceof Date, 'next_run_at computed forward');
  assert.equal(new Date(sch.next_run_at).getTime(), NOW.getTime() + 30 * MIN, 'cursor = now + interval');
});

test('missing target agent fails that schedule but does not stall the sweep (cursor advanced)', async () => {
  const sch = makeSchedule({ target_agent_id: 'ghost' });
  const { svc, messaging } = svcWith([sch]); // agent 'ghost' not in repo

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'bad-agent schedule is not counted dispatched');
  assert.equal(messaging.calls.length, 0, 'no message sent for a missing agent');
  assert.ok(new Date(sch.next_run_at).getTime() > NOW.getTime(), 'cursor still advanced so it retries next occurrence');
});

test('cross-workspace target agent is rejected (no dispatch)', async () => {
  const sch = makeSchedule({ target_agent_id: 'agent-x' });
  const { svc, messaging } = svcWith([sch], [{ id: 'agent-x', workspace_id: 'ws-OTHER', name: 'Foreign' }]);

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'cross-workspace agent not dispatched');
  assert.equal(messaging.calls.length, 0, 'no message sent across workspaces');
});

test('runNow fires regardless of enabled, stamps last_room_id, and does NOT disturb next_run_at', async () => {
  const futureCursor = new Date(NOW.getTime() + 30 * MIN);
  const sch = makeSchedule({ id: 'sch-rn', enabled: false, next_run_at: futureCursor });
  const { svc, messaging } = svcWith([sch]);

  const { schedule, dispatch } = await svc.runNow('sch-rn', 'ws-1', 'tester');
  assert.equal(messaging.calls.length, 1, 'sendMessage called by run-now even though disabled');
  assert.equal(dispatch.room_id, 'room-1');
  assert.equal(schedule.last_room_id, 'room-1', 'last_room_id stamped');
  assert.ok(schedule.last_run_at instanceof Date, 'last_run_at stamped');
  assert.equal(new Date(schedule.next_run_at).getTime(), futureCursor.getTime(), 'next_run_at NOT moved by a manual run');
});

test('create: rejects both/neither cadence, requires target_agent_id + task_prompt', async () => {
  const { svc } = svcWith([]);
  await assert.rejects(
    () => svc.create({ workspaceId: 'ws-1', name: 'x', targetAgentId: 'a', taskPrompt: 'p', cron: '0 3 * * *', intervalMs: 5 * MIN }),
    /exactly one of cron or interval_ms/,
  );
  await assert.rejects(
    () => svc.create({ workspaceId: 'ws-1', name: 'x', targetAgentId: 'a', taskPrompt: 'p' }),
    /one of cron or interval_ms is required/,
  );
  await assert.rejects(
    () => svc.create({ workspaceId: 'ws-1', name: 'x', targetAgentId: '', taskPrompt: 'p', intervalMs: 5 * MIN }),
    /target_agent_id is required/,
  );
  await assert.rejects(
    () => svc.create({ workspaceId: 'ws-1', name: 'x', targetAgentId: 'a', taskPrompt: '  ', intervalMs: 5 * MIN }),
    /task_prompt is required/,
  );
});

test('create: a valid interval schedule precomputes next_run_at forward', async () => {
  const { svc } = svcWith([]);
  const created = await svc.create({ workspaceId: 'ws-1', name: 'x', targetAgentId: 'a', taskPrompt: 'p', intervalMs: 5 * MIN });
  assert.ok(created.next_run_at instanceof Date, 'next_run_at precomputed');
  assert.ok(created.next_run_at.getTime() > Date.now() - 1000, 'cursor is in the (near) future');
  assert.equal(created.interval_ms, 5 * MIN);
  assert.equal(created.cron, null);
});

test('computeNextRun: cron vs interval vs disabled', () => {
  const { svc } = svcWith([]);
  const cronNext = svc.computeNextRun({ enabled: true, cron: '0 3 * * *', interval_ms: null }, new Date('2026-06-29T02:00:00Z'));
  assert.equal(cronNext.toISOString(), '2026-06-29T03:00:00.000Z', 'cron next firing');
  const intNext = svc.computeNextRun({ enabled: true, cron: null, interval_ms: 5 * MIN }, NOW);
  assert.equal(intNext.getTime(), NOW.getTime() + 5 * MIN, 'interval next firing');
  assert.equal(svc.computeNextRun({ enabled: false, cron: '0 3 * * *', interval_ms: null }, NOW), null, 'disabled → null');
});

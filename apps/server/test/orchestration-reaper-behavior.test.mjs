// Behavioral test for OrchestrationReaperService.runOnce() — drives the reaper
// against in-memory fake OrchestrationMission/Step/Event repositories (no DB)
// with a fixed `now`, exactly the seam the sibling reapers expose
// (qa-run-reaper-behavior.test.mjs, security-run-reaper-behavior.test.mjs).
//
// Focus: the mission-level "running + zero in-flight steps" wedge (ticket
// 954259e6) — every step reached a terminal status (or none is assigned) but
// the orchestrator never called complete_orchestration_mission, so the mission
// sits `running` forever with no in-flight step for reapStuckSteps to time out
// and no `planning` status for reapStalledPlanning to catch. reapStalledRunning
// closes that gap with the same re-brief/give-up loop reapStalledPlanning uses
// for the planning-phase equivalent:
//
//   • running, 0 in-flight, last activity past the timeout, no prior reaper
//     nudge                          -> nudged (reasonTag 'running_stall')
//   • running, 0 in-flight, within the timeout window            -> spared
//   • running, has an in-flight step (any age)                   -> spared,
//     belongs to reapStuckSteps instead
//   • not `running` (e.g. paused)                                -> never selected
//   • a wake of ANY kind (operator manual nudge, decideWake's own stall
//     message, or the reaper's prior attempt) inside the timeout window backs
//     off further reaper action
//   • RUNNING_STALL_NUDGE_LIMIT prior reaper nudges exhausted -> mission
//     failed, any dangling non-terminal steps cancelled, idempotent afterward
//
// Imports the compiled service from dist/ (built by `npm run build` in the
// test script) and injects fake repos + stub missions/runner services + a stub
// logger — the constructor seams the service exposes, mirroring how the QA/
// security reaper tests bypass Nest DI entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationReaperService } from '../dist/modules/orchestration/orchestration-reaper.service.js';

const MIN = 60_000;

function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && ('_value' in cond || '_type' in cond)) {
      const values = cond._value ?? cond._object ?? [];
      return values.includes(row[key]);
    }
    return row[key] === cond;
  });
}

function makeRepo(rows) {
  return {
    rows,
    saved: [],
    async find(opts = {}) {
      const { where, order, take } = opts;
      let out = rows.filter((r) => matches(r, where));
      if (order) {
        const [[key, dir]] = Object.entries(order);
        out = [...out].sort((a, b) => {
          const av = a[key] ? new Date(a[key]).getTime() : 0;
          const bv = b[key] ? new Date(b[key]).getTime() : 0;
          return dir === 'ASC' ? av - bv : bv - av;
        });
      }
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    async findOne({ where }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    // Rows returned by find()/findOne() are the same object references stored
    // in `rows`, so the service's in-place mutations are already reflected;
    // save() only needs to record that a write happened (mirrors the QA/
    // security fakes).
    async save(rowOrRows) {
      for (const r of Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]) this.saved.push(r.id);
      return rowOrRows;
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };

function makeMission(id, overrides = {}) {
  return {
    id,
    workspace_id: 'ws-1',
    team_id: 'team-1',
    title: `Mission ${id}`,
    status: 'running',
    room_id: 'room-1',
    result_summary: '',
    failure_reason: '',
    step_timeout_minutes: 90,
    started_at: null,
    finished_at: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeStep(id, missionId, status, overrides = {}) {
  return {
    id,
    mission_id: missionId,
    status,
    assignee_agent_id: 'agent-member',
    finished_at: null,
    started_at: null,
    dispatched_at: null,
    ...overrides,
  };
}

function makeEvent(id, missionId, type, data, createdAt) {
  return { id, mission_id: missionId, type, data, created_at: createdAt };
}

// `clock.now` is what the harness's nudgeOrchestrator stub stamps on the
// `orchestrator_woken` event it appends — the test sets it to whatever `now`
// it is about to pass into the matching runOnce() call, mirroring the real
// nudgeOrchestrator -> recordEvent -> eventRepo.save side effect.
function makeHarness({ missions = [], steps = [], events = [] } = {}) {
  const missionRepo = makeRepo(missions);
  const stepRepo = makeRepo(steps);
  const eventRepo = makeRepo(events);
  const teamRepo = makeRepo([]);
  const clock = { now: new Date() };
  const recordedEvents = [];
  const missionsStub = {
    async recordEvent(mission, input) {
      recordedEvents.push({ mission_id: mission.id, type: input.type, data: input.data ?? null });
    },
  };
  const nudges = [];
  let seq = 0;
  const runnerStub = {
    async nudgeOrchestrator(missionId, _workspaceId, _actor, note, reasonTag) {
      nudges.push({ missionId, note, reasonTag });
      events.push(makeEvent(`ev-nudge-${++seq}`, missionId, 'orchestrator_woken', { reason: reasonTag }, clock.now));
    },
    async failStepExternally() {
      throw new Error('unexpected failStepExternally call — this fixture has no in-flight step past its timeout');
    },
  };
  const svc = new OrchestrationReaperService(missionRepo, stepRepo, eventRepo, teamRepo, missionsStub, runnerStub, noopLog);
  return { svc, missionRepo, stepRepo, eventRepo, nudges, recordedEvents, clock };
}

test('reapStalledRunning: nudges exactly the stale zero-in-flight mission; fresh/busy/paused missions are spared', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const missions = [
    makeMission('stale-done', { started_at: new Date(NOW.getTime() - 200 * MIN) }),
    makeMission('fresh-done', { started_at: new Date(NOW.getTime() - 200 * MIN) }),
    // Has an in-flight step — reapStuckSteps' turf, not this branch's. Timeout
    // disabled (0) so reapStuckSteps itself stays a no-op in this fixture.
    makeMission('busy', { started_at: new Date(NOW.getTime() - 200 * MIN), step_timeout_minutes: 0 }),
    makeMission('paused-mission', { status: 'paused', started_at: new Date(NOW.getTime() - 200 * MIN) }),
  ];
  const steps = [
    makeStep('s-stale', 'stale-done', 'done', { finished_at: new Date(NOW.getTime() - 100 * MIN) }), // 100m > 20m default -> nudge
    makeStep('s-fresh', 'fresh-done', 'done', { finished_at: new Date(NOW.getTime() - 5 * MIN) }),    // 5m < 20m -> spare
    makeStep('s-busy', 'busy', 'dispatched', { dispatched_at: new Date(NOW.getTime() - 999 * MIN) }),  // in flight -> spare
    makeStep('s-paused', 'paused-mission', 'done', { finished_at: new Date(NOW.getTime() - 100 * MIN) }), // mission not running -> never selected
  ];
  const h = makeHarness({ missions, steps, events: [] });
  h.clock.now = NOW;

  const result = await h.svc.runOnce(NOW);

  assert.equal(result.missions_nudged, 1, 'exactly one mission is nudged');
  assert.equal(result.missions_failed, 0, 'nothing is failed on the first stale window');
  assert.deepEqual(h.nudges.map((n) => n.missionId), ['stale-done']);
  assert.equal(h.nudges[0].reasonTag, 'running_stall');

  const byId = Object.fromEntries(missions.map((m) => [m.id, m]));
  assert.equal(byId['stale-done'].status, 'running', 'nudged, not failed, on the first stale window');
  assert.equal(byId['fresh-done'].status, 'running', 'within the timeout window — untouched');
  assert.equal(byId['busy'].status, 'running', 'in-flight work present — left to reapStuckSteps');
  assert.equal(byId['paused-mission'].status, 'paused', 'not running — never selected');
});

test('reapStalledRunning: a wake of ANY kind inside the timeout window backs off reaper action', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m-recently-nudged', { started_at: new Date(NOW.getTime() - 200 * MIN) });
  const steps = [makeStep('s1', 'm-recently-nudged', 'failed', { finished_at: new Date(NOW.getTime() - 100 * MIN) })];
  // An operator's manual nudge 5 minutes ago — not counted toward the reaper's
  // own attempt limit (reason !== 'running_stall'), but still earns the
  // mission a fresh window to be answered before the reaper acts.
  const events = [makeEvent('ev-manual', 'm-recently-nudged', 'orchestrator_woken', { reason: 'manual' }, new Date(NOW.getTime() - 5 * MIN))];
  const h = makeHarness({ missions: [mission], steps, events });

  const result = await h.svc.runOnce(NOW);

  assert.equal(result.missions_nudged, 0, 'a recent wake of any kind blocks a reaper nudge');
  assert.equal(result.missions_failed, 0);
  assert.equal(mission.status, 'running');
});

test('wedge round trip: stalled running mission is nudged, backs off, nudges again, then fails once the limit is exhausted — and stays terminal after', async () => {
  const T0 = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m-wedge', { started_at: new Date(T0.getTime() - 200 * MIN) });
  const steps = [
    makeStep('s-done', 'm-wedge', 'done', { finished_at: new Date(T0.getTime() - 100 * MIN) }),
    // Never got picked up — dangling non-terminal work that must be cancelled
    // when the mission is finally failed.
    makeStep('s-dangling', 'm-wedge', 'pending', { assignee_agent_id: null }),
  ];
  const h = makeHarness({ missions: [mission], steps, events: [] });

  // Sweep 1: stale past the 20m default timeout, no prior nudges -> nudge.
  h.clock.now = T0;
  const r1 = await h.svc.runOnce(T0);
  assert.equal(r1.missions_nudged, 1, 'first sweep nudges the stalled mission');
  assert.equal(r1.missions_failed, 0);
  assert.equal(mission.status, 'running');

  // Sweep 2: immediately after — the nudge just recorded backs off a repeat.
  const r2 = await h.svc.runOnce(T0);
  assert.equal(r2.missions_nudged, 0, 'an immediate re-sweep does not pile a second nudge on top');
  assert.equal(r2.missions_failed, 0);

  // Sweep 3: a full window later with still no answer -> second nudge.
  const T1 = new Date(T0.getTime() + 21 * MIN);
  h.clock.now = T1;
  const r3 = await h.svc.runOnce(T1);
  assert.equal(r3.missions_nudged, 1, 'a second stale window earns a second nudge');
  assert.equal(mission.status, 'running');

  // Sweep 4: another full window later, still no answer -> nudge limit (2)
  // exhausted, mission fails and the dangling step is cancelled.
  const T2 = new Date(T1.getTime() + 21 * MIN);
  const r4 = await h.svc.runOnce(T2);
  assert.equal(r4.missions_nudged, 0);
  assert.equal(r4.missions_failed, 1, 'the mission is failed once the nudge limit is exhausted');
  assert.equal(mission.status, 'failed', 'mission escaped the running wedge via forced failure');
  assert.match(mission.failure_reason, /re-briefed 2 time\(s\)/);
  assert.ok(mission.finished_at instanceof Date && mission.finished_at.getTime() === T2.getTime());
  const dangling = steps.find((s) => s.id === 's-dangling');
  assert.equal(dangling.status, 'cancelled', 'the unassigned/never-dispatched step is closed out on fail');
  assert.equal(dangling.finished_at.getTime(), T2.getTime());
  assert.ok(
    h.recordedEvents.some((e) => e.mission_id === 'm-wedge' && e.type === 'mission_failed'),
    'a mission_failed timeline event is recorded',
  );

  // Sweep 5: the mission is terminal now — the team's open-mission slot is
  // free and a later sweep never revisits it (idempotent).
  const r5 = await h.svc.runOnce(new Date(T2.getTime() + 100 * MIN));
  assert.equal(r5.missions_nudged, 0);
  assert.equal(r5.missions_failed, 0, 'idempotent — a terminal mission is never revisited');
});

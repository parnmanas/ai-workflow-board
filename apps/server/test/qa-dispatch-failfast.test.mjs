// Behavioral test for QaRunService.startQaRun() dispatch handling (ticket
// acd24e5d). Two guarantees:
//   1. The dispatch send passes opts.bypassContentLimit=true and ships the full
//      rendered prompt even when it exceeds 10k (mirrors the 10,257-char INV-VIS
//      scenario, forced here via a long scenario.description).
//   2. If the dispatch send FAILS, the run is finalized to status='error' NOW
//      with the reason in the summary + finished_at stamped, and startQaRun
//      rethrows — instead of leaving a 'running' empty-room zombie for the reaper
//      to collect 40+ min later (the bug this ticket fixes).
//
// Stubs the constructor seams QaRunService exposes; no DB. buildRunProvision
// queries repos through dataSource but wraps them in try/catch (repo=null on
// throw), so a throwing dataSource stub is the simplest safe fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const identity = (o) => o;

function makeScenario() {
  return {
    id: 'scn-1',
    name: 'INV-VIS',
    workspace_id: 'ws-1',
    board_id: null,
    target_agent_id: 'agent-1',
    enabled: true,
    max_runs: 20,
    steps: [],
    qa_driver: 'game-client',
    qa_driver_config: {},
    // Force the rendered prompt past 10k, exactly like the real INV-VIS scenario
    // (10,257 chars) that triggered this ticket.
    description: 'x'.repeat(10300),
    workspace_folder: null,
    repo_ref: null,
    checkout_mode: null,
    build_mode: null,
    last_built_commit: null,
    build_target: null,
    target_environment: '',
  };
}

// dataSource: buildRunProvision degrades repo -> null on any throw.
const dataSource = { getRepository: () => ({ findOne: async () => { throw new Error('no repo'); } }) };

function makeRunRepo() {
  return {
    saves: [],
    create: identity,
    async save(row) { this.saves.push({ ...row }); return row; },
    async find() { return []; }, // _pruneOldRuns -> nothing to prune
  };
}

function makeSvc(sendMessageImpl) {
  const runRepo = makeRunRepo();
  const captured = { calls: [] };
  const scenarioRepo = { async findOne() { return makeScenario(); }, async update() {} };
  const agentRepo = { async findOne() { return { id: 'agent-1', name: 'GC-Agent', type: 'agent' }; } };
  const roomRepo = { create: identity, async save(r) { return { ...r, id: 'room-1' }; } };
  const participantRepo = { create: identity, async save() {} };
  const empty = {};
  const messaging = {
    async sendMessage(...args) {
      captured.calls.push(args);
      return sendMessageImpl(...args);
    },
  };
  const svc = new QaRunService(
    scenarioRepo,   // scenarioRepo
    runRepo,        // runRepo
    empty,          // batchRepo
    roomRepo,       // roomRepo
    participantRepo,// participantRepo
    empty,          // messageRepo
    empty,          // attachmentRepo
    empty,          // resourceRepo
    agentRepo,      // agentRepo
    dataSource,     // dataSource
    messaging,      // messaging
    noopLog,        // logService
    empty,          // failureTicketService
  );
  return { svc, runRepo, captured };
}

test('happy path: dispatch ships the full >10k prompt with bypassContentLimit=true', async () => {
  const { svc, runRepo, captured } = makeSvc(async () => ({ id: 'msg-1' }));

  const result = await svc.startQaRun({
    scenarioId: 'scn-1',
    triggeredByType: 'system',
    triggeredById: '',
  });

  assert.equal(result.run.status, 'running', 'run stays running on a successful dispatch');
  assert.equal(captured.calls.length, 1, 'sendMessage called exactly once');

  const [, , senderType, senderId, , content, , , type, opts] = captured.calls[0];
  assert.equal(senderType, 'user');
  assert.equal(senderId, 'system');
  assert.equal(type, 'message');
  assert.ok(content.length > 10000, `prompt is >10k (got ${content.length}) — the INV-VIS case`);
  assert.equal(opts?.bypassContentLimit, true, 'dispatch raises the content ceiling');
  assert.ok(opts && 'runProvision' in opts, 'runProvision hint is still shipped');

  // Only the initial running save — no error finalization on the happy path.
  assert.equal(runRepo.saves.length, 1);
  assert.equal(runRepo.saves[0].status, 'running');
});

test('send failure: run is finalized to error immediately and startQaRun rethrows', async () => {
  const sendErr = Object.assign(new Error('Message exceeds 10000 character limit'), { status: 400 });
  const { svc, runRepo } = makeSvc(async () => { throw sendErr; });

  await assert.rejects(
    () => svc.startQaRun({ scenarioId: 'scn-1', triggeredByType: 'system', triggeredById: '' }),
    /dispatch failed/,
    'dispatch failure rethrows so the caller / batch dispatcher sees it',
  );

  // Two saves: the initial running row, then the error finalization.
  assert.equal(runRepo.saves.length, 2, 'run saved twice (running -> error)');
  assert.equal(runRepo.saves[0].status, 'running', 'first save is the running row');

  const errRow = runRepo.saves[1];
  assert.equal(errRow.status, 'error', 'run finalized to error (no 45-min zombie)');
  assert.ok(errRow.finished_at instanceof Date, 'finished_at stamped');
  assert.match(errRow.summary, /\[dispatch failed\]/, 'summary carries the dispatch-failed marker');
  assert.match(errRow.summary, /Message exceeds 10000/, 'summary records the underlying failure reason');
  assert.match(errRow.summary, /\d+자/, 'summary records the rendered prompt length');
});

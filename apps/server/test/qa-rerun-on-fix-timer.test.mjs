// Regression guard for the a22862c6-class bug (ticket c1894c40): a one-shot
// setTimeout whose callback is the ONLY path forward, left unref'd. A running
// server always has a ref'd listening socket, so in production these timers
// fire normally — the drop only shows up when nothing else keeps the event
// loop alive: a `node --test --test-force-exit` process (this repo's test
// standard) or a process mid-shutdown after its listener has closed. Once an
// unref'd timer becomes the loop's LAST handle, the process can exit before
// its delay elapses and the callback never runs.
//
// Mirrors outreach-classifier-dispatch.test.mjs's style (the a22862c6 fix's
// own regression test): no NestJS DI, no HTTP server, only the class under
// test — so nothing besides the timer being tested keeps this process's
// event loop alive, and a reintroduced `.unref()` reproduces the drop instead
// of being masked by an ambient ref'd handle. MUST be verified on Node 22 —
// on Node 24 this bug class does not reproduce reliably (see ticket body).
//
// Two call sites, both gated by rerun_delay_seconds:
//   1. _handleActivity's legacy delayed-rerun timer (qa-rerun-on-fix.service.ts).
//   2. _gateOnDeployment's deployment-gate fallback-cap timer (same file).
// Both are driven through _handleActivity (the real activityEvents listener
// entry point), not called directly, so the routing logic that picks between
// them is exercised too.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { QaRerunOnFixService } from '../dist/modules/qa/qa-rerun-on-fix.service.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { QaScenario } from '../dist/entities/QaScenario.js';
import { Deployment } from '../dist/entities/Deployment.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// A chainable TypeORM query-builder stub covering exactly what
// _handleActivity's atomic claim (update/set/where/andWhere/execute) and
// findLatestDeployment (where/andWhere/orderBy/addOrderBy/getOne) call.
function chainable(getOneResult) {
  const qb = {};
  for (const m of ['update', 'set', 'where', 'andWhere', 'orderBy', 'addOrderBy']) qb[m] = () => qb;
  qb.execute = async () => ({ affected: 1 });
  qb.getOne = async () => getOneResult;
  return qb;
}

function makeTicket(overrides = {}) {
  return {
    id: 'fix-ticket-1',
    column_id: 'done-col',
    terminal_entered_at: new Date(),
    labels: JSON.stringify(['qa-failure', 'auto', 'qa-scenario:scenario-1']),
    ...overrides,
  };
}

function makeScenario(overrides = {}) {
  return {
    id: 'scenario-1',
    name: 'Timer regression scenario',
    workspace_id: 'ws-1',
    target_environment: '',
    on_failure_ticket: {
      enabled: true,
      rerun_on_fix: true,
      max_rerun_attempts: 3,
      rerun_delay_seconds: 0.05,
    },
    ...overrides,
  };
}

// deployment=null keeps the deployment gate unsatisfied so _gateOnDeployment
// falls through to registering the fallback-cap timer.
function makeDataSource({ ticket, column, scenario, deployment = null }) {
  return {
    getRepository(entity) {
      if (entity === Ticket) {
        return {
          async findOne() { return ticket; },
          createQueryBuilder() { return chainable(); },
        };
      }
      if (entity === BoardColumn) {
        return { async findOne() { return column; } };
      }
      if (entity === QaScenario) {
        return { async findOne() { return scenario; } };
      }
      if (entity === Deployment) {
        return { createQueryBuilder() { return chainable(deployment); } };
      }
      throw new Error(`unstubbed repo requested for ${entity?.name || entity}`);
    },
  };
}

function makeQaRunService(onStart) {
  const calls = [];
  return {
    calls,
    async startQaRun(args) {
      calls.push(args);
      onStart?.(args);
      return { run: { id: `run-${calls.length}` } };
    },
  };
}

test('legacy delayed rerun timer (rerun_delay_seconds > 0) fires the rerun', async () => {
  const ticket = makeTicket();
  const column = { id: 'done-col', kind: 'terminal' };
  const scenario = makeScenario();
  const ds = makeDataSource({ ticket, column, scenario });

  const started = deferred();
  const qaRunService = makeQaRunService(started.resolve);
  const service = new QaRerunOnFixService(ds, qaRunService, noopLog);

  await service._handleActivity({ action: 'moved', ticket_id: ticket.id });
  assert.equal(qaRunService.calls.length, 0, 'the rerun is deferred behind the timer, not fired synchronously');

  // Awaits the SAME promise only the timer's callback resolves — no manual
  // polling setTimeout here, since that would itself ref the event loop and
  // mask a reintroduced .unref() (see file header).
  await started.promise;

  assert.equal(qaRunService.calls.length, 1, 'the delayed timer fired exactly once');
  assert.equal(qaRunService.calls[0].scenarioId, scenario.id);
  assert.equal(qaRunService.calls[0].rerunGeneration, 1, 'first rerun is generation 1');
});

test('deployment-gate fallback-cap timer (rerun_delay_seconds > 0) fires without a confirmed deploy', async () => {
  const ticket = makeTicket({
    id: 'fix-ticket-2',
    labels: JSON.stringify(['qa-failure', 'auto', 'qa-scenario:scenario-2']),
  });
  const column = { id: 'done-col', kind: 'terminal' };
  const scenario = makeScenario({
    id: 'scenario-2',
    target_environment: 'gate-env',
    on_failure_ticket: {
      enabled: true,
      rerun_on_fix: true,
      max_rerun_attempts: 3,
      rerun_delay_seconds: 0.05,
      deployment_gate: true,
    },
  });
  const ds = makeDataSource({ ticket, column, scenario, deployment: null });

  const started = deferred();
  const qaRunService = makeQaRunService(started.resolve);
  const service = new QaRerunOnFixService(ds, qaRunService, noopLog);

  await service._handleActivity({ action: 'moved', ticket_id: ticket.id });
  assert.equal(qaRunService.calls.length, 0, 'no deploy yet — the rerun is gated, not fired synchronously');

  await started.promise;

  assert.equal(qaRunService.calls.length, 1, 'the fallback-cap timer fired without a confirmed deploy');
  assert.equal(qaRunService.calls[0].scenarioId, scenario.id);
  assert.equal(qaRunService.calls[0].rerunGeneration, 1);
});

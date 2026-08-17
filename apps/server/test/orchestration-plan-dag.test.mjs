// Orchestration plan validation + progress classification (pure logic).
//
// These two functions are the load-bearing correctness surface of the whole
// feature and they run BEFORE anything is persisted or dispatched:
//
//   validatePlan()        — rejects a plan the engine could never execute
//                           (unknown dependency, self-edge, cycle) and returns
//                           the dependency-first order the engine dispatches in.
//   computePlanProgress() — decides, after every state change, what may be
//                           dispatched now, what is still waiting, and what can
//                           NEVER run because an upstream step died.
//
// The failure they exist to prevent is silent: a plan with a cycle, or a
// dependent whose upstream failed, leaves a mission "running" with zero
// activity and no error anywhere — the operator only finds out when the reaper
// eventually times a step out, or never.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { validatePlan, computePlanProgress } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href
);

const steps = (...defs) => defs.map((d) => ({ instructions: '', ...d }));

test('validatePlan — accepts a well-formed DAG and returns dependency-first order', () => {
  const result = validatePlan(
    steps(
      { step_key: 'ship', title: 'Ship', depends_on: ['api', 'ui'] },
      { step_key: 'api', title: 'API' },
      { step_key: 'ui', title: 'UI', depends_on: ['api'] },
    ),
    { maxSteps: 60 },
  );
  assert.ok(!('error' in result), `expected valid plan, got ${JSON.stringify(result)}`);
  const order = result.steps.map((s) => s.step_key);
  assert.deepEqual(order, ['api', 'ui', 'ship'], 'dependencies come before their dependents');
});

test('validatePlan — peers keep the orchestrator\'s authored order', () => {
  const result = validatePlan(
    steps(
      { step_key: 'zeta', title: 'Z' },
      { step_key: 'alpha', title: 'A' },
      { step_key: 'mid', title: 'M' },
    ),
    { maxSteps: 60 },
  );
  assert.ok(!('error' in result));
  assert.deepEqual(
    result.steps.map((s) => s.step_key),
    ['zeta', 'alpha', 'mid'],
    'independent steps are not re-sorted alphabetically or otherwise',
  );
});

test('validatePlan — rejects an empty plan', () => {
  const result = validatePlan([], { maxSteps: 60 });
  assert.ok('error' in result);
  assert.match(result.error, /at least one step/);
});

test('validatePlan — rejects a plan over the mission step budget', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ step_key: `s${i}`, title: `S${i}` }));
  const result = validatePlan(many, { maxSteps: 4 });
  assert.ok('error' in result);
  assert.match(result.error, /exceeding the mission limit of 4/);
});

test('validatePlan — rejects a malformed step_key', () => {
  const result = validatePlan(steps({ step_key: 'Bad Key!', title: 'x' }), { maxSteps: 60 });
  assert.ok('error' in result);
  assert.match(result.error, /invalid step_key/);
});

test('validatePlan — rejects duplicate step keys', () => {
  const result = validatePlan(
    steps({ step_key: 'api', title: 'one' }, { step_key: 'api', title: 'two' }),
    { maxSteps: 60 },
  );
  assert.ok('error' in result);
  assert.match(result.error, /duplicate step_key "api"/);
});

test('validatePlan — rejects a step with no title', () => {
  const result = validatePlan(steps({ step_key: 'api', title: '   ' }), { maxSteps: 60 });
  assert.ok('error' in result);
  assert.match(result.error, /has no title/);
});

test('validatePlan — rejects a dependency on a step that does not exist', () => {
  const result = validatePlan(
    steps({ step_key: 'ui', title: 'UI', depends_on: ['nonexistent'] }),
    { maxSteps: 60 },
  );
  assert.ok('error' in result);
  assert.match(result.error, /depends on unknown step "nonexistent"/);
});

test('validatePlan — rejects a self-edge', () => {
  const result = validatePlan(steps({ step_key: 'ui', title: 'UI', depends_on: ['ui'] }), { maxSteps: 60 });
  assert.ok('error' in result);
  assert.match(result.error, /depends on itself/);
});

test('validatePlan — rejects a cycle and names the steps involved', () => {
  // The core "mission runs forever with nothing dispatchable" guard.
  const result = validatePlan(
    steps(
      { step_key: 'a', title: 'A', depends_on: ['c'] },
      { step_key: 'b', title: 'B', depends_on: ['a'] },
      { step_key: 'c', title: 'C', depends_on: ['b'] },
    ),
    { maxSteps: 60 },
  );
  assert.ok('error' in result);
  assert.match(result.error, /dependency cycle/);
  for (const key of ['a', 'b', 'c']) {
    assert.match(result.error, new RegExp(`\\b${key}\\b`), `cycle report should name ${key}`);
  }
});

test('validatePlan — a cycle disjoint from a valid subgraph is still rejected', () => {
  const result = validatePlan(
    steps(
      { step_key: 'standalone', title: 'fine' },
      { step_key: 'x', title: 'X', depends_on: ['y'] },
      { step_key: 'y', title: 'Y', depends_on: ['x'] },
    ),
    { maxSteps: 60 },
  );
  assert.ok('error' in result, 'a partially-valid plan must not slip through');
  assert.match(result.error, /dependency cycle/);
  assert.doesNotMatch(result.error, /standalone/, 'only the cyclic steps are named');
});

test('computePlanProgress — root steps are dispatchable, dependents wait', () => {
  const progress = computePlanProgress([
    { step_key: 'api', status: 'pending', depends_on: [] },
    { step_key: 'ui', status: 'pending', depends_on: [] },
    { step_key: 'ship', status: 'pending', depends_on: ['api', 'ui'] },
  ]);
  assert.deepEqual(progress.dispatchable.sort(), ['api', 'ui']);
  assert.deepEqual(progress.waiting, ['ship']);
  assert.equal(progress.allTerminal, false);
});

test('computePlanProgress — a dependent unlocks only when EVERY dependency is satisfied', () => {
  const partial = computePlanProgress([
    { step_key: 'api', status: 'done', depends_on: [] },
    { step_key: 'ui', status: 'running', depends_on: [] },
    { step_key: 'ship', status: 'pending', depends_on: ['api', 'ui'] },
  ]);
  assert.deepEqual(partial.dispatchable, [], 'one finished dependency is not enough');
  assert.deepEqual(partial.waiting, ['ship']);
  assert.deepEqual(partial.inFlight, ['ui']);

  const complete = computePlanProgress([
    { step_key: 'api', status: 'done', depends_on: [] },
    { step_key: 'ui', status: 'done', depends_on: [] },
    { step_key: 'ship', status: 'pending', depends_on: ['api', 'ui'] },
  ]);
  assert.deepEqual(complete.dispatchable, ['ship']);
});

test('computePlanProgress — a SKIPPED dependency satisfies its dependents', () => {
  // Otherwise an orchestrator that drops an unnecessary step would strand
  // everything downstream of it forever.
  const progress = computePlanProgress([
    { step_key: 'api', status: 'skipped', depends_on: [] },
    { step_key: 'ship', status: 'pending', depends_on: ['api'] },
  ]);
  assert.deepEqual(progress.dispatchable, ['ship']);
});

test('computePlanProgress — a failed dependency poisons its dependents', () => {
  const progress = computePlanProgress([
    { step_key: 'api', status: 'failed', depends_on: [] },
    { step_key: 'ship', status: 'pending', depends_on: ['api'] },
  ]);
  assert.deepEqual(progress.newlyBlocked, ['ship']);
  assert.deepEqual(progress.dispatchable, []);
  assert.deepEqual(progress.waiting, []);
});

test('computePlanProgress — poison propagates only one level per pass', () => {
  // The runner re-runs propagation after saving, so transitive blocking
  // converges across passes; this pins the per-pass behaviour it relies on.
  const first = computePlanProgress([
    { step_key: 'a', status: 'failed', depends_on: [] },
    { step_key: 'b', status: 'pending', depends_on: ['a'] },
    { step_key: 'c', status: 'pending', depends_on: ['b'] },
  ]);
  assert.deepEqual(first.newlyBlocked, ['b'], 'c is still merely waiting until b is marked blocked');
  assert.deepEqual(first.waiting, ['c']);

  const second = computePlanProgress([
    { step_key: 'a', status: 'failed', depends_on: [] },
    { step_key: 'b', status: 'blocked', depends_on: ['a'] },
    { step_key: 'c', status: 'pending', depends_on: ['b'] },
  ]);
  assert.deepEqual(second.newlyBlocked, ['c']);
});

test('computePlanProgress — a dangling dependency is treated as satisfied, not as poison', () => {
  // A replan can leave a reference to a key that no longer exists. Treating it
  // as poison would silently strand real work; treating it as satisfied keeps
  // the mission moving and lets the orchestrator notice.
  const progress = computePlanProgress([
    { step_key: 'ship', status: 'pending', depends_on: ['removed-in-replan'] },
  ]);
  assert.deepEqual(progress.dispatchable, ['ship']);
  assert.deepEqual(progress.newlyBlocked, []);
});

test('computePlanProgress — allTerminal only once nothing is open', () => {
  assert.equal(
    computePlanProgress([
      { step_key: 'a', status: 'done', depends_on: [] },
      { step_key: 'b', status: 'failed', depends_on: [] },
      { step_key: 'c', status: 'skipped', depends_on: [] },
    ]).allTerminal,
    true,
  );
  assert.equal(
    computePlanProgress([
      { step_key: 'a', status: 'done', depends_on: [] },
      { step_key: 'b', status: 'dispatched', depends_on: [] },
    ]).allTerminal,
    false,
  );
});

test('computePlanProgress — null depends_on behaves like an empty list', () => {
  const progress = computePlanProgress([{ step_key: 'a', status: 'pending', depends_on: null }]);
  assert.deepEqual(progress.dispatchable, ['a']);
});

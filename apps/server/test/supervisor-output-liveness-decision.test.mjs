// Unit test — TicketSupervisor force_respawn decision (ticket fdc69c13).
//
// The exit-143 deathloop: `_tick()` used to escalate to force_respawn based
// SOLELY on `my_last_update_at` (ticket-write staleness). A big foundation
// ticket's assignee spends 30+ min exploring/editing code — emitting tokens the
// whole time — without touching the ticket, so the server misread a live worker
// as wedged and killed it every resend tick (~300s), forever. `decideForceRespawn`
// is the extracted pure core of the fix: given the stale-row signals, it decides
// force vs non-force. These cases lock the DoD contract:
//   (a) a live worker (fresh output-liveness) is NEVER force_respawned;
//   (b) a genuinely silent session is STILL force_respawned (backstop intact);
//   (c) after MAX consecutive fruitless forces the circuit-breaker opens.
// Mirrors the dist-import harness used by qa-warm-build-freshness.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { decideForceRespawn } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'ticket-supervisor.service.js')
);

// Mirrors SUPERVISOR_FORCE_RESPAWN_MAX in ticket-supervisor.service.ts. The
// function takes maxForce as an input so the test is independent of the
// in-code constant, but we exercise it at the real default.
const MAX = 5;

test('DoD(a): live worker (fresh output-liveness) is NEVER force_respawned', () => {
  // The exact deathloop victim: ticket-write stale, but output flowing.
  const d = decideForceRespawn({ isStuck: false, hasRecentOutput: true, forceCount: 0, maxForce: MAX });
  assert.equal(d.forceRespawn, false, 'a working (output-emitting) strand must not be force-respawned');
  assert.equal(d.resetBreaker, true, 'fresh output means the session is alive → reset the breaker');
});

test('DoD(a) hardened: fresh output overrides even a spent force budget', () => {
  // Even if the breaker would otherwise trip, a strand that just produced
  // output is alive and must survive — output-liveness has precedence.
  const d = decideForceRespawn({ isStuck: false, hasRecentOutput: true, forceCount: MAX + 3, maxForce: MAX });
  assert.equal(d.forceRespawn, false);
  assert.equal(d.circuitOpen, false, 'a live worker is not a "circuit open" situation');
  assert.equal(d.resetBreaker, true);
});

test('DoD(b): genuinely silent session (no output) IS force_respawned — backstop intact', () => {
  const d = decideForceRespawn({ isStuck: false, hasRecentOutput: false, forceCount: 0, maxForce: MAX });
  assert.equal(d.forceRespawn, true, 'a truly silent/wedged session must still be recovered via force_respawn');
  assert.equal(d.circuitOpen, false);
  assert.equal(d.resetBreaker, false);
});

test('DoD(c): circuit-breaker opens after MAX consecutive fruitless forces', () => {
  // Simulate the real _tick loop: a silent session that never recovers. Each
  // tick increments forceCount (the caller does entry.forceCount += 1 on force).
  let forceCount = 0;
  const forced = [];
  for (let tick = 0; tick < MAX + 3; tick++) {
    const d = decideForceRespawn({ isStuck: false, hasRecentOutput: false, forceCount, maxForce: MAX });
    if (d.forceRespawn) { forced.push(tick); forceCount += 1; }
    if (forceCount >= MAX) {
      // Once the budget is spent, every further tick must refuse to force AND
      // signal circuit-open.
      const after = decideForceRespawn({ isStuck: false, hasRecentOutput: false, forceCount, maxForce: MAX });
      assert.equal(after.forceRespawn, false, 'no more force_respawn once the budget is spent');
      assert.equal(after.circuitOpen, true, 'circuit must report OPEN so the flag is written');
      break;
    }
  }
  assert.equal(forced.length, MAX, `exactly ${MAX} force_respawns before the breaker trips`);
});

test('existing stuck-detector throttle preserved: isStuck → non-force (no regression on b55e4421)', () => {
  const d = decideForceRespawn({ isStuck: true, hasRecentOutput: false, forceCount: 0, maxForce: MAX });
  assert.equal(d.forceRespawn, false, 'stuck-flagged tickets keep their existing force suppression');
  // isStuck alone must NOT reset the breaker (that is an output-liveness signal).
  assert.equal(d.resetBreaker, false);
});

test('isStuck AND fresh output → non-force (both suppressors agree)', () => {
  const d = decideForceRespawn({ isStuck: true, hasRecentOutput: true, forceCount: 2, maxForce: MAX });
  assert.equal(d.forceRespawn, false);
});

test('boundary: forceCount just below MAX still forces; at MAX stops', () => {
  assert.equal(
    decideForceRespawn({ isStuck: false, hasRecentOutput: false, forceCount: MAX - 1, maxForce: MAX }).forceRespawn,
    true,
    'one force left in the budget → still force',
  );
  assert.equal(
    decideForceRespawn({ isStuck: false, hasRecentOutput: false, forceCount: MAX, maxForce: MAX }).forceRespawn,
    false,
    'budget exactly spent → stop forcing',
  );
});

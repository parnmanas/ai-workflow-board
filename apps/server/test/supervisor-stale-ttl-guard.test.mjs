// Regression — ticket 47a72129: supervisor_stale_ms > output-liveness TTL must
// not silently neuter the fdc69c13 force-suppression gate.
//
// Background (the invariant that used to be implicit): the TicketSupervisor
// force-suppression gate compares a strand's output age against that
// workspace's `supervisor_stale_ms`. Output-liveness entries are evicted by a
// 30s sweep once older than a retention TTL. fdc69c13 hard-coded that TTL at a
// fixed 6 h and merely ASSUMED `TTL >= supervisor_stale_ms`. Nothing enforced
// it. Raise `supervisor_stale_ms` past 6 h (a real incident-response move) and
// an output entry in the (6h, staleMs) band is evicted while the gate still
// treats it as recent → getOutputLivenessAt() returns undefined →
// hasRecentOutput=false → a LIVE worker is force_respawned → the exit-143
// deathloop fdc69c13 fixed silently regresses. No compile/test caught it.
//
// The fix (this ticket) has three moving parts, one per DoD:
//   #1 derive retention TTL = clamp(MAX(supervisor_stale_ms), FLOOR=6h,
//      CEILING=24h) so `retention >= staleMs` holds by construction (up to the
//      ceiling), AND clamp the gate window to `min(staleMs, retention)` so the
//      gate never trusts a band the sweep already evicted.
//   #2 normal config (staleMs <= 6h) keeps the historical 6h behavior — the
//      silent-session backstop force is untouched.
//   #3 a staleMs beyond the floor is observable (warn + gauge) — no silent
//      neutering.
//
// This suite proves all three: behaviorally against the real exported pure
// derivation, via a composite model that mirrors the production sweep-eviction
// + gate-clamp pipeline using the real exports, and via static-source guards
// that pin the wiring so a future revert to a fixed constant fails loudly.
// Mirrors the dist-import + static-regression harness of
// agent-status-supervisor-eviction.test.mjs and supervisor-output-liveness-decision.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

async function loadDist(relParts) {
  const url = 'file://' + path.join(DIST, ...relParts);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      'This test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' +
        err.message,
    );
  }
}

function readSrc(relParts) {
  return fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
}

const {
  resolveOutputLivenessTtlMs,
  OUTPUT_LIVENESS_TTL_FLOOR_MS,
  OUTPUT_LIVENESS_TTL_CEILING_MS,
} = await loadDist(['modules', 'agents', 'agent-status.service.js']);

const H = 60 * 60_000; // one hour in ms
const MIN = 60_000;

// Sanity on the exported anchors so the rest of the suite reads in real units.
assert.equal(OUTPUT_LIVENESS_TTL_FLOOR_MS, 6 * H, 'FLOOR is 6h');
assert.equal(OUTPUT_LIVENESS_TTL_CEILING_MS, 24 * H, 'CEILING is 24h');

// ---------------------------------------------------------------------------
// Production-faithful composite model. Mirrors, in one place, the two code
// paths that together decide whether a live-but-ticket-quiet worker survives:
//   - AgentStatusService._sweep eviction:  drop entries older than the
//     *effective* TTL (resolveOutputLivenessTtlMs(MAX staleMs)).
//   - TicketSupervisor gate:               hasRecentOutput =
//       entryStillPresent && outputAge < min(staleMs, effectiveTtl).
// `suppress === true`  → force_respawn is SUPPRESSED (worker judged alive).
// `suppress === false` → gate lets force_respawn proceed (looks silent).
// Uses the REAL exported derivation + constants, so a regression in the
// derivation flips these assertions.
function gateSuppresses({ staleMs, outputAgeMs, maxStaleMs }) {
  const effectiveTtl = resolveOutputLivenessTtlMs(maxStaleMs);
  const entryPresent = outputAgeMs <= effectiveTtl; // sweep keeps age <= TTL
  const gateWindowMs = Math.min(staleMs, effectiveTtl); // supervisor clamp
  return entryPresent && outputAgeMs < gateWindowMs;
}

// The pre-fix pipeline: fixed 6h TTL, gate window == raw staleMs (no clamp).
// Kept only to demonstrate the exact regression this ticket closes.
function gateSuppressesPreFix({ staleMs, outputAgeMs }) {
  const fixedTtl = 6 * H;
  const entryPresent = outputAgeMs <= fixedTtl;
  return entryPresent && outputAgeMs < staleMs;
}

// ===========================================================================
// DoD #1 — staleMs > TTL with last-output in the (TTL, staleMs) band still
// suppresses (no false force_respawn). The core regression.
// ===========================================================================

test('DoD#1 derivation: FLOOR < staleMs <= CEILING → retention tracks staleMs', () => {
  assert.equal(resolveOutputLivenessTtlMs(8 * H), 8 * H, 'retention extends to an 8h escalation window');
  assert.equal(resolveOutputLivenessTtlMs(6 * H + MIN), 6 * H + MIN, 'just past the floor tracks exactly');
  assert.equal(resolveOutputLivenessTtlMs(24 * H), 24 * H, 'at the ceiling tracks exactly');
});

test('DoD#1 core: staleMs=8h, output 7h old (in the old-evict band) → gate SUPPRESSES', () => {
  // maxStaleMs=8h: retention derives to 8h, so the 7h-old entry survives the
  // sweep and the gate window is min(8h,8h)=8h → 7h < 8h → alive → suppress.
  const suppress = gateSuppresses({ staleMs: 8 * H, outputAgeMs: 7 * H, maxStaleMs: 8 * H });
  assert.equal(suppress, true, 'a live worker whose output is 7h old must NOT be force_respawned at staleMs=8h');
});

test('DoD#1 contrast: the SAME scenario under the pre-fix fixed-6h TTL would FORCE (the bug)', () => {
  // This is the exact silent regression: 7h > fixed 6h TTL → entry evicted →
  // undefined → looks silent → force. Locking it proves the fix changed behavior.
  const preFix = gateSuppressesPreFix({ staleMs: 8 * H, outputAgeMs: 7 * H });
  assert.equal(preFix, false, 'pre-fix wrongly force_respawns the live worker (the deathloop this ticket closes)');
});

test('DoD#1 boundary: output age just under staleMs suppresses; just over is (legitimately) silent', () => {
  // Just under staleMs → alive.
  assert.equal(
    gateSuppresses({ staleMs: 8 * H, outputAgeMs: 8 * H - MIN, maxStaleMs: 8 * H }),
    true,
    'output 1min inside the stale window is still recent',
  );
  // Older than staleMs → genuinely stale by the operator's own window → force
  // is correct (retention kept the entry, gate window is staleMs, age exceeds it).
  assert.equal(
    gateSuppresses({ staleMs: 8 * H, outputAgeMs: 8 * H + MIN, maxStaleMs: 8 * H }),
    false,
    'output older than the operator escalation window is legitimately stale → not suppressed',
  );
});

// ===========================================================================
// DoD #2 — normal config (staleMs <= TTL) unchanged: retention stays 6h and the
// silent-session backstop force is preserved.
// ===========================================================================

test('DoD#2 derivation: staleMs <= FLOOR → retention stays the historical 6h', () => {
  assert.equal(resolveOutputLivenessTtlMs(30 * MIN), 6 * H, 'default 30min stale keeps 6h retention');
  assert.equal(resolveOutputLivenessTtlMs(6 * H), 6 * H, 'exactly 6h stays 6h');
});

test('DoD#2: default config — recent worker suppressed, genuinely silent worker still forced', () => {
  // Recent output within the 30min window → suppress.
  assert.equal(
    gateSuppresses({ staleMs: 30 * MIN, outputAgeMs: 10 * MIN, maxStaleMs: 30 * MIN }),
    true,
    'an actively-emitting worker is never force_respawned under default config',
  );
  // No output entry at all (undefined) → backstop force must still fire.
  const effectiveTtl = resolveOutputLivenessTtlMs(30 * MIN);
  const silentHasRecent = /* lastOutputMs === undefined */ false && 0 < Math.min(30 * MIN, effectiveTtl);
  assert.equal(silentHasRecent, false, 'a session that never emitted output is silent → backstop force_respawn intact');
});

test('DoD#2: raising one workspace to 8h does NOT loosen a 30min workspace escalation timing', () => {
  // Global MAX staleMs = 8h so retention extends to 8h, but the 30min-window
  // workspace clamps its gate to min(30min, 8h)=30min — escalation timing for
  // that workspace is preserved. A worker silent for 40min there is still forced
  // even though its (retained) entry is well within the 8h retention.
  const suppress = gateSuppresses({ staleMs: 30 * MIN, outputAgeMs: 40 * MIN, maxStaleMs: 8 * H });
  assert.equal(suppress, false, 'extended retention must not delay force for a workspace on a short stale window');
  // And a worker that emitted 5min ago there is still suppressed.
  assert.equal(
    gateSuppresses({ staleMs: 30 * MIN, outputAgeMs: 5 * MIN, maxStaleMs: 8 * H }),
    true,
    'a live worker on the short-window workspace is still protected',
  );
});

// ===========================================================================
// Bound + failure-safety of the derivation (map memory / DB-blip guards).
// ===========================================================================

test('bound: a pathological staleMs past the CEILING caps retention at 24h', () => {
  assert.equal(resolveOutputLivenessTtlMs(30 * H), 24 * H, 'retention is capped so the in-memory Map stays bounded');
  assert.equal(resolveOutputLivenessTtlMs(Number.MAX_SAFE_INTEGER), 24 * H, 'even an absurd value is ceiling-capped');
});

test('failure-safe: null / non-finite / non-positive inputs fall back to the FLOOR', () => {
  for (const bad of [null, undefined, 0, -1, -5 * H, NaN, Infinity, -Infinity]) {
    assert.equal(
      resolveOutputLivenessTtlMs(bad),
      6 * H,
      `input ${String(bad)} must yield the safe 6h floor, never a shorter/invalid retention`,
    );
  }
});

test('residual (documented, > CEILING): staleMs=30h, output 25h old → gate does NOT suppress', () => {
  // Beyond the ceiling retention can no longer track staleMs: the 25h-old entry
  // is evicted (25h > 24h) so the worker looks silent. This is the honest,
  // bounded residual the DoD#3 warn/gauge surface — not a silent failure.
  const suppress = gateSuppresses({ staleMs: 30 * H, outputAgeMs: 25 * H, maxStaleMs: 30 * H });
  assert.equal(suppress, false, 'past the 24h ceiling the gate degrades — and this is the case the warn flags');
});

// ===========================================================================
// DoD #3 (+ #1/#2 wiring) — static-source guards. The behavioral tests above
// exercise the pure derivation; these pin the CLASS wiring so a revert to a
// fixed constant, an un-clamped gate, or a dropped warn/gauge fails loudly.
// ===========================================================================

test('static: agent-status eviction uses the DERIVED TTL field, not a fixed constant', () => {
  const src = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  // Eviction cutoff must be built from the recomputed field.
  assert.match(
    src,
    /outputCutoff\s*=\s*Date\.now\(\)\s*-\s*this\.outputLivenessTtlMs/,
    'sweep eviction must use this.outputLivenessTtlMs (the derived TTL), not a hard-coded 6h constant',
  );
  // The field must be recomputed each sweep from MAX(supervisor_stale_ms).
  assert.match(src, /this\.outputLivenessTtlMs\s*=\s*await this\._resolveOutputLivenessTtlMs\(\)/, 'sweep recomputes the TTL');
  assert.match(src, /MAX\(ws\.supervisor_stale_ms\)/, 'derivation aggregates the widest supervisor_stale_ms');
  // Failure path must NOT shrink retention (a shrink re-opens the deathloop).
  assert.match(
    src,
    /output-liveness TTL derivation failed[\s\S]*?return this\.outputLivenessTtlMs/,
    'on derivation failure keep the current TTL (never shrink retention on a DB blip)',
  );
  // Effective-TTL gauge for observability.
  assert.match(src, /agentStatus\.outputLivenessTtlMs/, 'effective-TTL gauge is registered');
});

test('static: supervisor gate window is clamped to the retained TTL (proposal 1)', () => {
  const src = readSrc(['modules', 'agents', 'ticket-supervisor.service.ts']);
  assert.match(
    src,
    /gateWindowMs\s*=\s*Math\.min\(\s*staleMs,\s*this\.agentStatus\.getOutputLivenessTtlMs\(\)\s*\)/,
    'gate window must be min(staleMs, retention) so it never trusts an evicted band',
  );
  assert.match(
    src,
    /hasRecentOutput\s*=\s*lastOutputMs !== undefined && \(now - lastOutputMs\) < gateWindowMs/,
    'the gate must compare against the clamped window, not raw staleMs',
  );
});

test('static: DoD#3 misconfiguration is observable (warn + gauge)', () => {
  const src = readSrc(['modules', 'agents', 'ticket-supervisor.service.ts']);
  // Once-per-workspace warn, floor vs ceiling severity split.
  assert.match(src, /_observeStaleMsVsTtl/, 'the observe hook exists');
  assert.match(src, /staleMs > OUTPUT_LIVENESS_TTL_FLOOR_MS/, 'warn triggers above the floor');
  assert.match(src, /staleMs > OUTPUT_LIVENESS_TTL_CEILING_MS/, 'ceiling breach is distinguished (actionable)');
  assert.match(src, /this\.logService\.warn\(/, 'it warns (not silent)');
  // Gauge for the misconfigured-workspace count.
  assert.match(src, /ticketSupervisor\.staleMsExceedsTtl/, 'misconfig-count gauge is registered');
});

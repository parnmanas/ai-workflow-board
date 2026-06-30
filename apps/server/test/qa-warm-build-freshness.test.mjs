// Unit test — warm-build freshness flip (ticket be2f998a).
// `decideRunFreshness` is the consumer that the warm-build stamp feeds: on a
// genuine PASS, completeRun() advances the scenario's `last_built_commit`
// (commit 416d7eb), and THIS pure function reads it to flip the NEXT run of the
// scenario cold → warm. Before the stamp ever lands, every `cold_then_warm` +
// `reuse` run sees `last_built_commit=null` and cold-rebuilds (~35min) forever —
// the exact bug this ticket fixes. These cases lock the contract end-to-end:
// the stamp is only meaningful iff a non-empty `last_built_commit` yields 'warm'
// here, and a missing/empty one stays 'cold' (safe). Mirrors the dist-import
// harness used by workspace-folder-traversal-guard.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { decideRunFreshness } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'workspace-folder-options.js')
);

// The live workspace-374bb2e3 scenario config that exposed the bug.
const base = { checkout_mode: 'reuse', build_mode: 'cold_then_warm' };

test('cold_then_warm + reuse, nothing stamped yet → COLD (first run / pre-stamp bug state)', () => {
  assert.equal(decideRunFreshness({ ...base, last_built_commit: null }), 'cold');
  assert.equal(decideRunFreshness({ ...base, last_built_commit: '' }), 'cold');
});

test('cold_then_warm + reuse, last_built_commit stamped → WARM (the flip completeRun enables)', () => {
  // After a PASS, completeRun stamps the scenario commit; the next run reads it here.
  assert.equal(decideRunFreshness({ ...base, last_built_commit: 'ea3f9687f' }), 'warm');
});

test('fresh checkout forces COLD even with a stamped commit (wipe → no warm Library/)', () => {
  assert.equal(
    decideRunFreshness({ checkout_mode: 'fresh', build_mode: 'cold_then_warm', last_built_commit: 'ea3f9687f' }),
    'cold',
  );
});

test('always_cold / always_warm override the stamp (precedence above last_built_commit)', () => {
  assert.equal(decideRunFreshness({ ...base, build_mode: 'always_cold', last_built_commit: 'sha' }), 'cold');
  assert.equal(decideRunFreshness({ ...base, build_mode: 'always_warm', last_built_commit: null }), 'warm');
});

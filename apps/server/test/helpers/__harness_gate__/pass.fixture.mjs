// Harness-gate fixture: a PASSING flow file that exercises the real
// exitAfterTests() helper. Run by test-harness-gate.test.mjs under
// `node --test --test-force-exit`; it must exit 0.
//
// Named `.fixture.mjs` (not `.test.mjs`) so node:test auto-discovery and the
// qa-flows directory globs never pick it up — only the gate spawns it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exitAfterTests } from '../boot.mjs';

test('harness gate — passing assertion stays green', () => {
  assert.equal(1 + 1, 2);
  exitAfterTests();
});

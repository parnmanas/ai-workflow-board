// Harness-gate fixture: a FAILING flow file that exercises the real
// exitAfterTests() helper. Run by test-harness-gate.test.mjs under
// `node --test --test-force-exit`; the deliberately broken assertion must
// make it exit NON-ZERO. If exitAfterTests() ever reintroduces a hardcoded
// process.exit(0), this fixture would exit 0 and the gate would catch it.
//
// Named `.fixture.mjs` (not `.test.mjs`) so node:test auto-discovery and the
// qa-flows directory globs never pick it up — only the gate spawns it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exitAfterTests } from '../boot.mjs';

test('harness gate — broken assertion must turn the run red', () => {
  assert.equal(999, 0, 'deliberately broken — the gate proves this is NOT masked');
  exitAfterTests();
});

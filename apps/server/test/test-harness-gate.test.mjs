// Meta-regression: proves the qa-flows test harness is an actual gate.
//
// History: the shared exitAfterTests() helper used to end every flow file with
// `setImmediate(() => process.exit(0))`. Under `node --test` that hardcoded
// exit-0 raced node:test's async completion and force-exited 0 BEFORE a failed
// assertion was recorded — so a deliberately broken test still reported
// `pass 1 / fail 0 / exit 0`. The whole self-test suite was silently
// non-gating. (ticket fc84ec30.)
//
// The fix: drop the process.exit from the helper and launch every flow file
// with `--test-force-exit`, which tears down NestJS/TypeORM handles AND exits
// with the REAL code node:test computed.
//
// This test guards that fix from regressing by spawning the real harness over
// two fixtures that call the real exitAfterTests():
//   - fail.fixture.mjs (broken assertion) MUST exit non-zero, else failures are
//     being masked again — the exact false-positive this ticket removed.
//   - pass.fixture.mjs (sound assertion) MUST exit 0, guarding against a
//     false-negative that would make the suite cry wolf.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'helpers', '__harness_gate__');

// Spawn `node --test --test-force-exit <fixture>` exactly the way qa.controller
// and the package.json scripts launch flow files, and resolve the exit code.
function runFixture(file) {
  return new Promise((resolve) => {
    // This gate itself runs under `node --test`, which exports NODE_TEST_CONTEXT
    // into the environment. If the child inherited it, node:test would detect a
    // "recursive" run, skip the fixture, and exit 0 — masking the very failure
    // we're checking for. Strip it so the child runs as a fresh test runner,
    // exactly like qa.controller (which spawns from the non-test server process).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const proc = spawn(
      process.execPath,
      ['--test', '--test-force-exit', '--test-reporter=spec', path.join(FIXTURES, file)],
      { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv },
    );
    let out = '';
    proc.stdout?.on('data', (c) => (out += c));
    proc.stderr?.on('data', (c) => (out += c));
    // Safety ceiling: a fixture that hangs means --test-force-exit isn't doing
    // its job — surface it as a failure rather than wedging the suite.
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('a broken assertion under the flow harness exits non-zero (gate is live)', async () => {
  const { code, out } = await runFixture('fail.fixture.mjs');
  assert.notEqual(
    code,
    0,
    `fail.fixture must exit non-zero — a 0 here means exitAfterTests()/--test-force-exit is masking failures again.\n--- child output ---\n${out}`,
  );
  // And the reporter actually recorded the failure (not just a non-zero from a crash).
  assert.match(out, /fail 1|not ok|✖/, `expected a recorded test failure in child output:\n${out}`);
});

test('a sound assertion under the flow harness exits 0 (no false negatives)', async () => {
  const { code, out } = await runFixture('pass.fixture.mjs');
  assert.equal(code, 0, `pass.fixture must exit 0; got ${code}.\n--- child output ---\n${out}`);
});

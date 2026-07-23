// Regression guard — ticket 02a18e6e, a recurrence-prevention follow-up to
// ticket 0b4f089d, which found 5 apps/server/test/*.test.mjs files that
// existed on disk but were registered in no package.json script, so
// `npm test` silently never ran them (0 CI coverage, nobody noticed).
//
// This is a purely static diff between two sources of truth — no app boot,
// no subprocess, just fs + JSON parsing, so it stays cheap enough to run on
// every `npm test`:
//   - fs:           every *.test.mjs file under test/ (top-level) and
//                    test/qa-flows/
//   - package.json: every script's command text, tokenized on whitespace
//
// Two directions matter:
//   1. orphan   — a file on disk that no script references (the 0b4f089d
//      bug class: it exists, but npm test/test:qa silently never touches
//      it — this file is added registering 9 more instances of exactly
//      that bug, found live in test/qa-flows/ while writing this guard).
//   2. dangling — a script references a test/*.mjs path that doesn't exist
//      on disk (the mirror-image typo/rename/delete bug).
//
// This file must itself appear in package.json's `test` script argument
// list, exactly like every other top-level file here — otherwise this guard
// is itself an instance of the bug it exists to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const QA_FLOWS_DIR = path.join(__dirname, 'qa-flows');
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

// A script's command text is shell-quoted (package.json scripts run under a
// shell), so split on whitespace and strip one layer of surrounding quotes —
// good enough for the `'npm run X'` delegation marker run-suite.mjs expects
// (see test/run-suite.mjs) and every bare test/*.mjs path.
function tokenize(command) {
  return command.split(/\s+/).map((tok) => tok.replace(/^["']|["']$/g, ''));
}

const TEST_PATH_RE = /^test\/(?:qa-flows\/)?[A-Za-z0-9_-]+\.test\.mjs$/;

function collectReferencedTestPaths(scripts) {
  const refs = new Set();
  for (const command of Object.values(scripts)) {
    for (const tok of tokenize(command)) {
      if (TEST_PATH_RE.test(tok)) refs.add(tok);
    }
  }
  return refs;
}

function listTestFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
}

test('every top-level test/*.test.mjs file is referenced by some package.json script', () => {
  const refs = collectReferencedTestPaths(readPackageScripts());
  const orphans = listTestFiles(__dirname).filter((f) => !refs.has(`test/${f}`));
  assert.deepEqual(
    orphans,
    [],
    `orphaned top-level test file(s) — exist on disk but no package.json script references them, ` +
      `so npm test silently skips them (ticket 0b4f089d bug class): ${orphans.join(', ')}`,
  );
});

test('every test/qa-flows/*.test.mjs file is referenced by some package.json script', () => {
  const refs = collectReferencedTestPaths(readPackageScripts());
  const orphans = listTestFiles(QA_FLOWS_DIR).filter((f) => !refs.has(`test/qa-flows/${f}`));
  assert.deepEqual(
    orphans,
    [],
    `orphaned test/qa-flows file(s) — exist on disk but no package.json script references them: ${orphans.join(', ')}`,
  );
});

test('every test/*.mjs path referenced from package.json scripts exists on disk', () => {
  const refs = collectReferencedTestPaths(readPackageScripts());
  const dangling = [...refs].filter((ref) => !fs.existsSync(path.join(SERVER_ROOT, ref)));
  assert.deepEqual(
    dangling,
    [],
    `dangling test reference(s) — package.json points at a test/*.mjs path with no file on disk ` +
      `(stale/renamed/typo?): ${dangling.join(', ')}`,
  );
});

test('this guard file is itself registered in the `test` script (self-coverage)', () => {
  const scripts = readPackageScripts();
  const selfRef = `test/${SELF_BASENAME}`;
  const testScriptTokens = tokenize(scripts.test ?? '');
  assert.ok(
    testScriptTokens.includes(selfRef),
    `${selfRef} must be listed in package.json's "test" script — otherwise this guard doesn't ` +
      `cover itself and could silently stop running`,
  );
});

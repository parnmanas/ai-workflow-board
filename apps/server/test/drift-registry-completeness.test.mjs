// Regression guard — ticket 1c95b365, a completeness-guard follow-up to
// ticket 4a48a0b8 (which added prompt-template-drift-check.ts).
//
// prompt-template-drift-check.ts's own header says a new content-refresh
// migration "must add itself to DRIFT_REGISTRY below to be covered", but
// nothing enforced that. A migration that exports a PRIOR_* snapshot and
// forgets to register itself drops out of drift-check coverage with zero
// signal: build passes, tests pass, and boot's migrations_applied /
// migrations_registered counts shrink together so they still look
// consistent — the exact silent-gap class this health check exists to
// catch, just one layer up.
//
// Purely static source-text matching (same style as
// test-registration-completeness.test.mjs) — no app boot, no TS compile:
//   - migrations/*.ts: every file exporting `export const PRIOR_...`
//   - prompt-template-drift-check.ts: the DRIFT_REGISTRY array literal body
//
// Non-vacuity: temporarily delete one DRIFT_REGISTRY entry and this test
// fails, naming that migration's file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(SERVER_ROOT, 'src/database/migrations');
const DRIFT_CHECK_FILE = path.join(SERVER_ROOT, 'src/database/prompt-template-drift-check.ts');

const PRIOR_EXPORT_RE = /^export const PRIOR_\w+/m;
const CLASS_NAME_RE = /^export class (\w+)/m;

function findPriorExportingMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }))
    .filter(({ source }) => PRIOR_EXPORT_RE.test(source))
    .map(({ file, source }) => {
      const match = source.match(CLASS_NAME_RE);
      assert.ok(match, `${file} exports a PRIOR_* snapshot but has no "export class" line to name it by`);
      return { file, className: match[1] };
    });
}

function extractDriftRegistryBody() {
  const source = fs.readFileSync(DRIFT_CHECK_FILE, 'utf8');
  const start = source.indexOf('export const DRIFT_REGISTRY');
  assert.ok(start >= 0, `DRIFT_REGISTRY declaration not found in ${DRIFT_CHECK_FILE}`);
  const end = source.indexOf('\n];', start);
  assert.ok(end >= 0, `could not find DRIFT_REGISTRY's closing "];" in ${DRIFT_CHECK_FILE}`);
  return source.slice(start, end);
}

test('every migration exporting a PRIOR_* snapshot is registered in DRIFT_REGISTRY', () => {
  const priorExportingMigrations = findPriorExportingMigrations();
  assert.ok(
    priorExportingMigrations.length > 0,
    'sanity check failed: found zero PRIOR_*-exporting migrations on disk — the scan itself is broken, ' +
      'not proof of completeness',
  );

  const registryBody = extractDriftRegistryBody();
  const missing = priorExportingMigrations.filter((m) => !registryBody.includes(`new ${m.className}()`));
  assert.deepEqual(
    missing.map((m) => m.file),
    [],
    'migration(s) export a PRIOR_* content snapshot but are missing from DRIFT_REGISTRY in ' +
      'prompt-template-drift-check.ts, so the prompt-template drift health check silently skips them: ' +
      `${missing.map((m) => m.file).join(', ')}`,
  );
});

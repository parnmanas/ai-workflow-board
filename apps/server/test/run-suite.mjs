#!/usr/bin/env node
// test/run-suite.mjs — sequential test-suite runner that continues past a
// failing step instead of aborting (ticket 84329e4b).
//
// package.json used to chain each test file with shell `&&`, so a single
// failing file silently skipped every file after it (e.g. ~90 files never
// ran). Steps here still run strictly one at a time, in order — most files
// boot a real NestJS app on a hardcoded port (see test/qa-flows/README.md)
// and rely on the pid+port-keyed sql.js DB path in test/helpers/boot.mjs;
// both assume exactly one `node --test` process is alive at a time, so this
// intentionally does not parallelize. It just no longer stops at the first
// failure, and prints a pass/fail summary at the end.
//
// Each positional arg is one step:
//   - a path ending in .test.mjs → run via `node --test --test-force-exit <path>`
//   - "npm run <script>"         → delegate to that npm script as one unit
//     (used to nest test:qa inside test without duplicating its file list)
//
// Usage: node test/run-suite.mjs <step> [step...]

import { spawn } from 'node:child_process';

function normalizeSteps(rawSteps) {
  const normalized = [];
  for (let i = 0; i < rawSteps.length; i++) {
    // POSIX shells use single quotes for grouping, but cmd.exe treats them as
    // ordinary characters. npm therefore passes `'npm run test:qa'` as three
    // argv entries on Windows. Reassemble that package.json form so the same
    // suite definition works on both platforms.
    if (
      rawSteps[i].startsWith("'npm")
      && rawSteps[i + 1] === 'run'
      && rawSteps[i + 2]?.endsWith("'")
    ) {
      normalized.push(
        `${rawSteps[i].slice(1)} run ${rawSteps[i + 2].slice(0, -1)}`,
      );
      i += 2;
      continue;
    }
    normalized.push(rawSteps[i]);
  }
  return normalized;
}

const steps = normalizeSteps(process.argv.slice(2));
if (steps.length === 0) {
  console.error('usage: node test/run-suite.mjs <test-file-or-"npm run X"> [...]');
  process.exit(1);
}

function runStep(step) {
  return new Promise((resolve) => {
    let child;
    if (step.endsWith('.test.mjs')) {
      child = spawn(process.execPath, ['--test', '--test-force-exit', step], {
        stdio: 'inherit',
        // Defensive: an inherited PORT from the caller's shell would leak
        // into bootApp() and could collide with whatever that value binds
        // to. Each file picks its own default port via a QA_*_PORT env
        // (see test/helpers/boot.mjs) when PORT isn't already set.
        env: { ...process.env, PORT: '' },
      });
    } else if (step.startsWith('npm run ')) {
      const script = step.slice('npm run '.length);
      child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', 'run', script], { stdio: 'inherit' })
        : spawn('npm', ['run', script], { stdio: 'inherit' });
    } else {
      console.error(`[run-suite] unrecognized step: "${step}"`);
      resolve(1);
      return;
    }
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[run-suite] failed to run "${step}": ${err.message}`);
      resolve(1);
    });
  });
}

const results = [];
for (const step of steps) {
  results.push({ step, code: await runStep(step) });
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${'='.repeat(60)}`);
console.log(`run-suite: ${results.length - failed.length}/${results.length} steps passed`);
if (failed.length > 0) {
  console.log(`failed (${failed.length}):`);
  for (const r of failed) console.log(`  - ${r.step} (exit ${r.code})`);
}
console.log('='.repeat(60));

process.exit(failed.length > 0 ? 1 : 0);

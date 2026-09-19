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
// step 은 둘 중 하나다:
//   - .test.mjs 로 끝나는 경로 → `node --test --test-force-exit <path>` 로 실행
//   - "npm run <script>"      → 그 npm 스크립트를 한 step 으로 위임
//     (test:qa 의 파일 목록을 test 안에 복사하지 않고 중첩시키는 데 쓴다)
//
// 실행 목록을 주는 방법은 두 가지다 (티켓 5dc241d8):
//   node test/run-suite.mjs --suite <name>   test/suites/<name>.txt 에서 읽는다.
//                                            package.json 의 스크립트가 쓰는 형태.
//   node test/run-suite.mjs <step> [step...] step 을 인자로 직접 나열한다.
//                                            런북·임시 실행이 쓰는 기존 형태로 유지된다.
//
// package.json 이 파일 목록을 직접 들고 있던 시절에는 그 한 줄이 1만 자를 넘어
// 서로 무관한 테스트 추가끼리도 항상 병합 충돌이 났다. 매니페스트 형식과 그
// 이유는 test/helpers/suite-manifest.mjs 헤더 참조.

import { spawn } from 'node:child_process';
import { readSuiteSteps, suiteManifestPath } from './helpers/suite-manifest.mjs';

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

// `--suite <name>` 이면 매니페스트에서 읽고, 아니면 위치 인자를 그대로 step 으로 쓴다.
// 매니페스트를 못 읽으면 반드시 0 이 아닌 코드로 죽어야 한다 — 조용히 0 step 을
// 돌고 끝나면 CI 가 초록으로 보이면서 실제로는 아무것도 안 돈다.
function resolveSteps(argv) {
  if (argv[0] !== '--suite') return normalizeSteps(argv);

  const suite = argv[1];
  if (!suite) {
    console.error('usage: node test/run-suite.mjs --suite <name>');
    process.exit(1);
  }
  if (argv.length > 2) {
    console.error(
      `[run-suite] --suite 는 단독으로 쓴다 — 남은 인자: ${argv.slice(2).join(' ')}`,
    );
    process.exit(1);
  }

  try {
    return readSuiteSteps(suite);
  } catch (err) {
    console.error(
      `[run-suite] 스위트 매니페스트를 읽지 못했다 (${suiteManifestPath(suite)}): ${err.message}`,
    );
    process.exit(1);
  }
}

const steps = resolveSteps(process.argv.slice(2));
if (steps.length === 0) {
  console.error('usage: node test/run-suite.mjs --suite <name> | <step> [step...]');
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

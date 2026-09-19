// 등록 완전성 가드 — 티켓 02a18e6e, 티켓 0b4f089d 의 재발 방지 후속.
// 0b4f089d 에서 apps/server/test/*.test.mjs 5개가 디스크에는 있는데 어떤
// package.json 스크립트에도 등록돼 있지 않아 `npm test` 가 조용히 건너뛰고
// 있었다(CI 커버리지 0, 아무도 몰랐다).
//
// 판정 로직 자체는 test/helpers/registration-audit.mjs 에 순수 함수로 있고,
// 여기서는 ① 실제 저장소 상태를 그 감사에 통과시키고 ② 감사가 공허하지 않음을
// 합성 fixture 로 고정한다.
//
// 등록의 기준은 "어딘가에 적혀 있다" 가 아니라 **실제로 도는가** 다:
//   - 디스크:      test/ (최상위) 와 test/qa-flows/ 아래 모든 *.test.mjs
//   - 등록 원천:   ① 진입점에서 도달 가능한 매니페스트(test/suites/*.txt)의 step
//                  ② 도달 가능한 package.json 스크립트 커맨드의 토큰 (아직 파일을
//                     직접 나열하는 test:catalog-scope 같은 스크립트가 있다)
// 아무도 `--suite` 로 부르지 않는 매니페스트에 경로를 적는 것은 등록이 아니다 —
// 그 목록은 npm test / npm run test:qa 어디서도 돌지 않는다.
//
// 보는 방향은 넷이다:
//   1. orphan      — 디스크에 있는데 도는 등록이 없는 파일. 0b4f089d 의 버그 클래스.
//   2. dangling    — 등록은 있는데 그 경로에 파일이 없는 경우(오타·rename·삭제).
//   3. unreachable — 존재하지만 아무 진입점에서도 도달되지 않는 매니페스트.
//   4. broken      — --suite 가 없는 매니페스트를 가리키는 스크립트.
//
// 티켓 5dc241d8 로 실행 목록이 package.json 한 줄에서 test/suites/*.txt 로
// 옮겨졌다. 옮긴 이유가 병합 충돌 제거이므로, 이 가드는 매니페스트가 그
// 성질을 유지하는지도 함께 본다 — 경로가 사전순이어야 새 등록이 파일 이름에
// 따라 서로 다른 hunk 에 떨어진다. 끝에 몰아 붙이기 시작하면 매니페스트로
// 옮긴 의미가 사라지므로 여기서 막는다.
//
// 이 파일 자신도 `test` 스위트에 등록돼 있어야 한다 — 아니면 이 가드가 바로
// 자기가 잡으려는 버그의 사례가 된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listSuiteNames,
  parseSuiteManifest,
  readSuiteSteps,
  suiteFromScriptCommand,
  suiteManifestPath,
} from './helpers/suite-manifest.mjs';
import {
  DELEGATION_RE,
  TEST_ENTRY_SCRIPTS,
  TEST_PATH_RE,
  auditRegistration,
} from './helpers/registration-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const QA_FLOWS_DIR = path.join(__dirname, 'qa-flows');
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

function listTestFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
}

// 실제 저장소 상태를 감사 입력으로 모은다.
function auditRepo() {
  return auditRegistration({
    scripts: readPackageScripts(),
    manifests: new Map(listSuiteNames().map((s) => [s, readSuiteSteps(s)])),
    entryScripts: TEST_ENTRY_SCRIPTS,
    diskTestPaths: [
      ...listTestFiles(__dirname).map((f) => `test/${f}`),
      ...listTestFiles(QA_FLOWS_DIR).map((f) => `test/qa-flows/${f}`),
    ],
  });
}

test('최상위 test/*.test.mjs 는 모두 실제로 도는 곳에 등록돼 있다', () => {
  const orphans = auditRepo().orphans.filter((p) => !p.startsWith('test/qa-flows/'));
  assert.deepEqual(
    orphans,
    [],
    '고아가 된 최상위 테스트 파일 — 디스크에는 있는데 도달 가능한 매니페스트에도 '
      + `package.json 에도 등록이 없어 npm test 가 조용히 건너뛴다(티켓 0b4f089d 버그 클래스): ${orphans.join(', ')}`,
  );
});

test('test/qa-flows/*.test.mjs 는 모두 실제로 도는 곳에 등록돼 있다', () => {
  const orphans = auditRepo().orphans.filter((p) => p.startsWith('test/qa-flows/'));
  assert.deepEqual(
    orphans,
    [],
    `고아가 된 qa-flows 테스트 파일 — 디스크에는 있는데 도는 등록이 없다: ${orphans.join(', ')}`,
  );
});

test('등록된 test/*.mjs 경로는 모두 디스크에 실재한다', () => {
  const { dangling } = auditRepo();
  assert.deepEqual(
    dangling,
    [],
    '끊어진 등록 — 매니페스트나 package.json 이 가리키는 경로에 파일이 없다'
      + `(오래됨/rename/오타?): ${dangling.join(', ')}`,
  );
});

test('이 가드 파일 자신이 test 스위트에 등록돼 있다 (자기 커버리지)', () => {
  const suite = suiteFromScriptCommand(readPackageScripts().test);
  assert.ok(suite, 'package.json 의 "test" 스크립트가 --suite <name> 형태여야 한다');

  const selfRef = `test/${SELF_BASENAME}`;
  assert.ok(
    readSuiteSteps(suite).includes(selfRef),
    `${selfRef} 는 test/suites/${suite}.txt 에 있어야 한다 — 없으면 이 가드가 자기 자신을 `
      + '덮지 못한 채 조용히 안 돌 수 있다',
  );
});

test('--suite 를 쓰는 스크립트는 모두 실재하는 매니페스트를 가리킨다', () => {
  const { brokenSuiteTargets } = auditRepo();
  assert.deepEqual(
    brokenSuiteTargets,
    [],
    '--suite 가 없는 매니페스트를 가리킨다 — 그 스크립트는 실행 목록 없이 죽는다: '
      + brokenSuiteTargets.join(', '),
  );
});

// 역방향. 위의 orphan 검사가 "적혀 있으면 등록" 으로 세지 않게 하려면 매니페스트가
// 실제로 불리는지도 봐야 한다. 이게 없으면 아무도 호출하지 않는 test/suites/dead.txt
// 에 새 테스트를 적어 두는 것만으로 orphan 검사를 통과하면서 그 테스트는 npm test /
// npm run test:qa 어디서도 돌지 않는다.
test('모든 매니페스트는 진입점에서 도달 가능하다 — 안 불리는 목록은 등록이 아니다', () => {
  const { unreachableSuites } = auditRepo();
  assert.deepEqual(
    unreachableSuites,
    [],
    '아무 진입점에서도 도달하지 않는 매니페스트 — 여기 적은 등록은 실행되지 않는다. '
      + 'package.json 스크립트로 --suite 연결을 만들거나, 그 스크립트를 '
      + `registration-audit.mjs 의 TEST_ENTRY_SCRIPTS 에 선언하라: ${unreachableSuites.join(', ')}`,
  );
});

test('선언된 진입점 스크립트는 모두 package.json 에 실재한다', () => {
  const { missingEntryScripts } = auditRepo();
  assert.deepEqual(
    missingEntryScripts,
    [],
    'TEST_ENTRY_SCRIPTS 에 있는데 package.json 에 없는 스크립트 — 오타나 삭제 잔재라면 '
      + `도달 계산이 조용히 비면서 멀쩡한 매니페스트가 unreachable 로 뒤집힌다: ${missingEntryScripts.join(', ')}`,
  );
});

test('매니페스트 step 은 인식 가능한 두 형태 중 하나다', () => {
  const bad = [];
  for (const suite of listSuiteNames()) {
    for (const step of readSuiteSteps(suite)) {
      if (!TEST_PATH_RE.test(step) && !DELEGATION_RE.test(step)) bad.push(`${suite}.txt: ${step}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    'run-suite 가 모르는 step — test/*.test.mjs 경로이거나 "npm run <script>" 여야 한다'
      + `(run-suite 는 이런 step 을 실패로 세고 넘어간다): ${bad.join(' | ')}`,
  );
});

test('매니페스트는 중복 없이 사전순이다 — 이게 병합 충돌을 막는 성질이다', () => {
  const problems = [];
  for (const suite of listSuiteNames()) {
    const steps = readSuiteSteps(suite);

    const duplicated = steps.filter((s, i) => steps.indexOf(s) !== i);
    if (duplicated.length > 0) {
      problems.push(`${suite}.txt 에 중복 step: ${[...new Set(duplicated)].join(', ')}`);
    }

    // 정규 순서 = 테스트 경로 사전순 + 그 뒤에 npm run 위임 사전순. 새 등록이
    // 파일 이름으로 정해진 자리에 들어가야 독립적인 추가 두 개가 서로 다른
    // hunk 가 되고, 끝에 몰아 붙이는 순간 다시 같은 줄에서 충돌한다.
    const canonical = [
      ...steps.filter((s) => s.startsWith('test/')).sort(),
      ...steps.filter((s) => !s.startsWith('test/')).sort(),
    ];
    if (JSON.stringify(steps) !== JSON.stringify(canonical)) {
      const at = steps.findIndex((s, i) => s !== canonical[i]);
      problems.push(
        `${suite}.txt 가 사전순이 아니다 — ${at + 1}번째 step 이 "${steps[at]}", 기대는 "${canonical[at]}"`,
      );
    }
  }
  assert.deepEqual(problems, [], problems.join(' | '));
});

test('매니페스트 파서는 주석과 빈 줄을 버린다', () => {
  assert.deepEqual(
    parseSuiteManifest('# 머리말\n\n  test/a.test.mjs  \n\n#끝\nnpm run test:qa\n'),
    ['test/a.test.mjs', 'npm run test:qa'],
  );
  assert.deepEqual(parseSuiteManifest('# 주석뿐\n\n'), [], '주석만 있으면 step 이 없다');
});

// ── 감사 자체가 공허하지 않음을 고정한다 (합성 fixture) ────────────────────
// 위의 검사들은 저장소가 건강하면 전부 초록이라, 판정 로직이 망가져도 초록일 수
// 있다. 아래는 "잡혀야 하는 상태" 를 직접 만들어 실제로 잡히는지 본다.

const FIXTURE_ENTRY = ['test'];

function fixtureAudit({ scripts, manifests, diskTestPaths }) {
  return auditRegistration({
    scripts,
    manifests: new Map(Object.entries(manifests)),
    entryScripts: FIXTURE_ENTRY,
    diskTestPaths,
  });
}

// 리뷰에서 지적된 우회 사례 그대로다. dead.txt 는 디스크에 있고 형식도 멀쩡하지만
// 어떤 스크립트도 --suite dead 로 부르지 않는다. 예전 구현은 test/suites/*.txt 를
// 전부 읽어 참조 집합에 넣었기 때문에 buried 가 "등록됨" 으로 통과했고, 실제로는
// npm test 어디서도 돌지 않았다.
test('아무도 부르지 않는 매니페스트에 적힌 경로는 등록으로 세지 않는다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: {
      test: ['test/live.test.mjs'],
      dead: ['test/buried.test.mjs'],
    },
    diskTestPaths: ['test/live.test.mjs', 'test/buried.test.mjs'],
  });

  assert.deepEqual(
    audit.orphans,
    ['test/buried.test.mjs'],
    'dead.txt 에만 적힌 테스트는 고아여야 한다 — 적혀 있다는 이유로 등록으로 세면 '
      + '그 테스트는 영영 돌지 않으면서 가드는 초록이 된다',
  );
  assert.deepEqual(audit.unreachableSuites, ['dead'], 'dead 매니페스트 자체도 신고돼야 한다');
  assert.ok(!audit.referenced.has('test/buried.test.mjs'));
});

// 대조군. 같은 fixture 에서 dead 를 실제로 부르는 연결만 만들어 주면 둘 다 조용해야
// 한다 — 아니면 위 테스트가 "항상 빨간" 검사를 확인하고 있는 셈이 된다.
test('그 매니페스트를 실제로 부르는 연결이 생기면 등록으로 인정된다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:dead': 'node test/run-suite.mjs --suite dead',
    },
    manifests: {
      test: ['test/live.test.mjs', 'npm run test:dead'],
      dead: ['test/buried.test.mjs'],
    },
    diskTestPaths: ['test/live.test.mjs', 'test/buried.test.mjs'],
  });

  assert.deepEqual(audit.orphans, []);
  assert.deepEqual(audit.unreachableSuites, []);
});

// 우회의 두 번째 형태. 매니페스트를 부르는 스크립트가 있긴 한데 그 스크립트를
// 아무도 부르지 않는 경우다. "모든 매니페스트가 --suite 대상이기만 하면 된다" 로
// 검사하면 이쪽이 그대로 빠져나간다.
test('부르는 스크립트가 있어도 그 스크립트가 도달 불가능하면 등록이 아니다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:orphaned-script': 'node test/run-suite.mjs --suite dead',
    },
    manifests: {
      test: ['test/live.test.mjs'],
      dead: ['test/buried.test.mjs'],
    },
    diskTestPaths: ['test/live.test.mjs', 'test/buried.test.mjs'],
  });

  assert.deepEqual(audit.orphans, ['test/buried.test.mjs']);
  assert.deepEqual(audit.unreachableSuites, ['dead']);
});

test('도달 계산은 npm 라이프사이클과 매니페스트 중첩 위임을 따라간다', () => {
  const audit = fixtureAudit({
    scripts: {
      pretest: 'npm run build && node test/run-suite.mjs --suite pretest',
      test: 'node test/run-suite.mjs --suite test',
      posttest: 'node test/run-suite.mjs --suite posttest',
      'pretest:qa': 'node test/run-suite.mjs --suite pretest-qa',
      'test:qa': 'node test/run-suite.mjs --suite test-qa',
      build: 'nest build',
    },
    manifests: {
      pretest: ['test/pre.test.mjs'],
      test: ['test/live.test.mjs', 'npm run test:qa'],
      posttest: ['test/post.test.mjs'],
      'pretest-qa': ['test/qa-pre.test.mjs'],
      'test-qa': ['test/qa-flows/deep.test.mjs'],
    },
    diskTestPaths: [
      'test/pre.test.mjs',
      'test/live.test.mjs',
      'test/post.test.mjs',
      'test/qa-pre.test.mjs',
      'test/qa-flows/deep.test.mjs',
    ],
  });

  assert.deepEqual(audit.orphans, [], 'pre/post 훅과 중첩 위임 너머의 등록도 도달해야 한다');
  assert.deepEqual(audit.unreachableSuites, []);
});

test('도달 가능한 스크립트가 직접 나열한 파일도 등록으로 센다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:inline': 'node --test test/inline.test.mjs',
    },
    manifests: { test: ['test/live.test.mjs', 'npm run test:inline'] },
    diskTestPaths: ['test/live.test.mjs', 'test/inline.test.mjs'],
  });

  assert.deepEqual(audit.orphans, [], '러너를 안 쓰는 스크립트라도 도달하면 등록이다');
});

test('없는 파일을 가리키는 등록은 dangling 으로 잡힌다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs', 'test/gone.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.dangling, ['test/gone.test.mjs']);
});

// scripts 는 JSON.parse 결과라 Object.prototype 을 상속한다. 존재 판정을
// `scripts[name] !== undefined` 로 하면 toString 같은 이름이 실재 스크립트로
// 둔갑해, 진입점 오타가 신고되지 않고 조용히 무시된다.
test('상속된 Object.prototype 이름을 실재 스크립트로 착각하지 않는다', () => {
  const audit = auditRegistration({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: new Map([['test', ['test/live.test.mjs']]]),
    entryScripts: ['test', 'toString'],
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.missingEntryScripts, ['toString']);
  assert.ok(!audit.runnableScripts.has('toString'));
});

test('진입점 오타는 매니페스트를 뒤집기 전에 따로 신고된다', () => {
  const audit = auditRegistration({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: new Map([['test', ['test/live.test.mjs']]]),
    entryScripts: ['test', 'test:오타'],
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.missingEntryScripts, ['test:오타']);
});

// 목록이 package.json 을 떠났으니, 매니페스트를 못 읽는 상황이 곧 "아무 테스트도
// 안 도는 상황" 이다. 그때 run-suite 가 0 으로 끝나면 CI 는 초록인데 커버리지는
// 0 이 된다 — 등록 완전성 가드가 막으려던 것과 같은 결과이므로 여기서 함께 막는다.
function runSuiteExitCode(...args) {
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-suite.mjs'), ...args],
    { cwd: SERVER_ROOT, encoding: 'utf8' },
  );
  return res.status;
}

test('없는 스위트를 부르면 run-suite 가 0 이 아닌 코드로 죽는다', () => {
  assert.notEqual(
    runSuiteExitCode('--suite', '__5dc241d8-존재하지-않는-스위트__'),
    0,
    '매니페스트가 없는데 성공으로 끝났다 — step 0 개를 돌고 CI 가 초록이 된다',
  );
});

test('빈 매니페스트도 성공으로 끝나지 않는다', (t) => {
  const suite = '__5dc241d8-빈-매니페스트__';
  const file = suiteManifestPath(suite);
  t.after(() => fs.rmSync(file, { force: true }));

  fs.writeFileSync(file, '# step 이 한 줄도 없다\n\n');
  assert.notEqual(
    runSuiteExitCode('--suite', suite),
    0,
    '빈 매니페스트가 성공으로 끝났다 — 아무것도 안 돌고 통과로 보인다',
  );
});

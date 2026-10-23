// 등록 완전성 가드 — 티켓 02a18e6e, 티켓 0b4f089d 의 재발 방지 후속.
// 0b4f089d 에서 apps/server/test/*.test.mjs 5개가 디스크에는 있는데 어떤
// package.json 스크립트에도 등록돼 있지 않아 `npm test` 가 조용히 건너뛰고
// 있었다(CI 커버리지 0, 아무도 몰랐다).
//
// 판정 로직 자체는 test/helpers/registration-audit.mjs 에 순수 함수로 있고,
// 여기서는 ① 실제 저장소 상태를 그 감사에 통과시키고 ② 감사가 공허하지 않음을
// 합성 fixture 로 고정한다.
//
// 등록의 기준은 "어딘가에 적혀 있다" 가 아니라 **CI 에서 실제로 도는가** 다:
//   - 디스크:      test/ 아래 모든 *.test.mjs. 러너가 아는 자리는 test/ 바로 아래와
//                  test/qa-flows/ 뿐이라, 다른 하위 디렉터리의 파일은 따로 신고한다.
//   - 등록의 뿌리: CI 가 apps/server 에서 부르는 npm 스크립트(CI_ENTRY_SCRIPTS).
//                  이 목록은 ci.yml 과 대조해 고정한다(helpers/ci-workflow.mjs).
//   - 등록 원천:   ① 그 뿌리에서 도달하는 매니페스트(test/suites/*.txt)의 step
//                  ② 그 뿌리에서 도달하는 스크립트가 `node --test` · 러너에 직접 준 경로
// 사람이 쓰는 단독 스크립트(test:catalog-scope 처럼 node --test 를 직접 부르는 것,
// test:qa:fast 처럼 자기 매니페스트를 여는 것)에만 적힌 파일은 등록이 아니다 — CI 는
// 그 스크립트를 부르지 않는다. 티켓 6ad5989a 에서 그런 파일 셋이 CI 에서 한 번도
// 돌지 않은 채 이 가드를 통과하고 있었다.
//
// 보는 방향:
//   1. orphan      — 디스크에 있는데 CI 가 도는 등록이 없는 파일. 0b4f089d 의 버그 클래스.
//   2. misplaced   — 러너 · 가드가 모르는 자리의 테스트 파일.
//   3. dangling    — 경로는 적혀 있는데 그 경로에 파일이 없는 경우(오타·rename·삭제).
//   4. delegation  — 없는 스크립트로 가는 `npm run`.
//   5. dead        — 어떤 스크립트도 --suite 로 열지 않는 매니페스트.
//   6. broken      — --suite 가 없는 매니페스트를 가리키는 스크립트.
//   7. CI 대조     — CI_ENTRY_SCRIPTS 가 ci.yml 이 명령 하나뿐인 step 으로, main push 마다
//                    도는 잡에서 부르는 것과 같은가(helpers/ci-workflow.mjs).
//   8. 예외        — 일부러 CI 밖에 둔 파일(CI_EXEMPT_TESTS)에 사유가 있고, 아직 필요한가.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalSteps,
  listSuiteNames,
  parseSuiteManifest,
  readSuiteSteps,
  suiteFromScriptCommand,
  suiteManifestPath,
} from './helpers/suite-manifest.mjs';
import {
  CI_ENTRY_SCRIPTS,
  CI_EXEMPT_TESTS,
  DELEGATION_RE,
  TEST_PATH_RE,
  auditRegistration,
  compareCiEntries,
} from './helpers/registration-audit.mjs';
import { ciServerNpmInvocations, npmrcProblems } from './helpers/ci-workflow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));
const CI_WORKFLOW = path.resolve(SERVER_ROOT, '..', '..', '.github', 'workflows', 'ci.yml');
const AUDIT_MODULE = path.join(__dirname, 'helpers', 'registration-audit.mjs');

// orphan 을 찾았을 때 고치는 길. 단독 스크립트에 경로를 적거나 그 스크립트를 진입점에
// 보태는 것은 길이 아니다 — 그게 티켓 6ad5989a 가 막은 우회다.
const ORPHAN_FIX_TAIL = '넣은 뒤 apps/server 에서 npm run test:suites:sort 를 돌려라. 죽은 테스트면 '
  + '지우고, 일부러 CI 밖에 두는 것이면 registration-audit.mjs 의 CI_EXEMPT_TESTS 에 사유와 함께 '
  + `적어라. CI 는 apps/server 에서 ${CI_ENTRY_SCRIPTS.join(' · ')} 만 부르므로 단독 npm 스크립트에만 `
  + '적힌 파일은 등록이 아니다';

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

function readManifests() {
  return new Map(listSuiteNames().map((s) => [s, readSuiteSteps(s)]));
}

// test/ 아래 모든 *.test.mjs — 하위 디렉터리까지. 러너가 모르는 자리의 파일도 찾아야
// "아무 데도 적을 수 없어 안 도는" 파일을 신고할 수 있다.
function listDiskTestPaths() {
  return fs
    .readdirSync(__dirname, { recursive: true })
    .map((p) => String(p).split(path.sep).join('/'))
    .filter((p) => p.endsWith('.test.mjs'))
    .map((p) => `test/${p}`);
}

// 실제 저장소 상태를 감사 입력으로 모은다.
function auditRepo() {
  return auditRegistration({
    scripts: readPackageScripts(),
    manifests: readManifests(),
    ciEntryScripts: CI_ENTRY_SCRIPTS,
    exemptions: CI_EXEMPT_TESTS,
    diskTestPaths: listDiskTestPaths(),
  });
}

test('최상위 test/*.test.mjs 는 모두 CI 가 도는 곳에 등록돼 있다', () => {
  const orphans = auditRepo().orphans.filter((p) => !p.startsWith('test/qa-flows/'));
  assert.deepEqual(
    orphans,
    [],
    `고아가 된 최상위 테스트 파일 — CI 가 한 번도 돌리지 않는다(티켓 0b4f089d 버그 클래스): ${orphans.join(', ')}. `
      + `sqlite 로 도는 파일은 test/suites/test.txt 에, Postgres 가 필요한 파일은 test-qa-pg.txt 에 ${ORPHAN_FIX_TAIL}`,
  );
});

test('test/qa-flows/*.test.mjs 는 모두 CI 가 도는 곳에 등록돼 있다', () => {
  const orphans = auditRepo().orphans.filter((p) => p.startsWith('test/qa-flows/'));
  assert.deepEqual(
    orphans,
    [],
    `고아가 된 qa-flows 테스트 파일 — CI 가 한 번도 돌리지 않는다: ${orphans.join(', ')}. `
      + `sqlite 로 도는 파일은 test/suites/test-qa.txt 에, Postgres 가 필요한 파일은 test-qa-pg.txt 에 ${ORPHAN_FIX_TAIL}`,
  );
});

test('테스트 파일은 러너가 아는 경로(test/ · test/qa-flows/ 바로 아래)에만 있다', () => {
  const { misplacedTests } = auditRepo();
  assert.deepEqual(
    misplacedTests,
    [],
    '러너와 이 가드가 모르는 경로의 테스트 파일 — 매니페스트에 적을 수도 없어 CI 에서 한 번도 돌지 '
      + '않는다. test/ 나 test/qa-flows/ 바로 아래에, 이름은 A-Z a-z 0-9 _ . - 로 둔다. 일부러 둔 '
      + `fixture 면 registration-audit.mjs 의 CI_EXEMPT_TESTS 에 사유와 함께 적는다: ${misplacedTests.join(', ')}`,
  );
});

test('적힌 test/*.mjs 경로는 모두 디스크에 실재한다', () => {
  const { dangling, namedAt } = auditRepo();
  assert.deepEqual(
    dangling,
    [],
    '끊어진 경로 — 가리키는 파일이 없다(오래됨/rename/오타?): '
      + dangling.map((p) => `${p} (${namedAt.get(p).join(', ')})`).join('; '),
  );
});

test('npm run 위임은 모두 실재하는 스크립트로 간다', () => {
  const { missingDelegations } = auditRepo();
  assert.deepEqual(
    missingDelegations,
    [],
    `없는 스크립트로 가는 위임 — 그 step 은 CI 에서 "Missing script" 로 죽는다: ${missingDelegations.join('; ')}`,
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

test('모든 매니페스트는 어떤 스크립트가 연다 — 아무도 안 여는 목록은 지운다', () => {
  const { deadSuites } = auditRepo();
  assert.deepEqual(
    deadSuites,
    [],
    '어떤 package.json 스크립트도 --suite 로 열지 않는 매니페스트 — 여기 적은 것은 아무 데서도 '
      + '돌지 않는다. 지우거나, `node test/run-suite.mjs --suite <이름>` 스크립트를 만들고 CI '
      + '매니페스트에 `npm run <그 스크립트>` step 으로 이어라. 사람용 부분집합이면 여는 스크립트만 '
      + `두어도 되지만, 거기 적은 파일은 CI 매니페스트에도 있어야 한다: ${deadSuites.join(', ')}`,
  );
});

test('선언된 CI 진입점 스크립트는 모두 package.json 에 실재한다', () => {
  const { missingEntryScripts } = auditRepo();
  assert.deepEqual(
    missingEntryScripts,
    [],
    'CI_ENTRY_SCRIPTS 에 있는데 package.json 에 없는 스크립트 — 오타나 삭제 잔재라면 '
      + `도달 계산이 조용히 비면서 멀쩡한 파일이 전부 고아로 뒤집힌다: ${missingEntryScripts.join(', ')}`,
  );
});

// 이 대조가 없으면 CI_ENTRY_SCRIPTS 는 다시 "CI 가 부른다고 믿는 목록" 이 된다. 티켓
// 6ad5989a 의 버그가 바로 그 믿음이 틀린 경우였다 — 진입점 목록에 CI 가 부르지 않는
// 단독 스크립트가 섞여 있었다.
test('CI 진입점 목록은 ci.yml 이 apps/server 에서 명령 하나뿐인 step 으로 부르는 테스트 스크립트와 같다', () => {
  assert.ok(fs.existsSync(CI_WORKFLOW), `CI 워크플로가 없다: ${CI_WORKFLOW}`);
  const { invoked, uncounted } = ciServerNpmInvocations(fs.readFileSync(CI_WORKFLOW, 'utf8'));
  const { notInvoked, undeclared } = compareCiEntries({
    declared: CI_ENTRY_SCRIPTS,
    invoked,
    scripts: readPackageScripts(),
    manifests: readManifests(),
  });

  const seen = uncounted.map(({ job, script, why }) => `${script} (${job}: ${why})`);
  assert.deepEqual(
    notInvoked,
    [],
    'CI_ENTRY_SCRIPTS 에 있는데 .github/workflows/ci.yml 이 apps/server 에서 그렇게 부르지 않는 스크립트 — '
      + '그 스크립트로만 닿는 파일이 등록으로 세어지지만 CI 에서 돌지 않거나, 돌아도 실패가 CI 를 '
      + `빨갛게 하지 못할 수 있다: ${notInvoked.join(', ')}. 센 호출: ${[...invoked].sort().join(', ') || '없음'}. `
      + `찾았지만 세지 않은 호출: ${seen.join('; ') || '없음'}. ci.yml 에서 그 스크립트를 명령 하나뿐인 step 으로, `
      + 'main push 마다 도는 잡에서 부르게 하거나 목록에서 빼라. 잡의 if: 를 바꿨고 여전히 매번 돈다면 '
      + 'helpers/ci-workflow.mjs 의 ALWAYS_RUN_CONDITIONS 에 보태라. 찾은 호출이 없다면 그 step 의 모양을 '
      + 'helpers/ci-workflow.mjs 가 못 읽는 것일 수 있다',
  );
  assert.deepEqual(
    undeclared,
    [],
    'ci.yml 이 apps/server 에서 main push 와 PR 마다 부르고 테스트를 도는데 CI_ENTRY_SCRIPTS 에 없는 스크립트 — '
      + `그 스크립트로만 닿는 파일이 고아로 잘못 신고된다. 목록에 보태라: ${undeclared.join(', ')}`,
  );
});

// npm 은 작업 디렉터리와 저장소 루트의 .npmrc 를 읽는다. 거기서 ignore-scripts · script-shell 같은
// 것을 켜면 CI 의 모든 npm 호출에서 pre/post 스위트가 빠지거나 스크립트가 아무것도 하지 않는다 —
// ci.yml 대조가 볼 수 없는 자리라 여기서 본다.
test('저장소의 .npmrc 는 npm 이 스크립트를 도는 방식을 바꾸지 않는다', () => {
  const problems = [path.resolve(SERVER_ROOT, '..', '..', '.npmrc'), path.join(SERVER_ROOT, '.npmrc')]
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => npmrcProblems(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(SERVER_ROOT, file)}: ${line}`));
  assert.deepEqual(
    problems,
    [],
    '.npmrc 가 스크립트를 도는 방식을 바꾼다 — CI 의 npm test · npm run test:qa:pg 가 pre/post 스위트를 빼거나 '
      + `아무것도 안 하고 끝날 수 있다: ${problems.join('; ')}`,
  );
});

test('CI 밖에 둔 예외는 모두 사유가 있고, 아직 필요하다', () => {
  const { exemptionsWithoutReason, staleExemptions } = auditRepo();
  assert.deepEqual(
    exemptionsWithoutReason,
    [],
    `사유 없이 CI_EXEMPT_TESTS 에 둔 파일 — 왜 CI 밖인지 적어라: ${exemptionsWithoutReason.join(', ')}`,
  );
  assert.deepEqual(
    staleExemptions,
    [],
    '낡은 CI_EXEMPT_TESTS 항목 — registered 는 이미 CI 매니페스트에 들어갔고, missing 은 파일이 '
      + `없다. registration-audit.mjs 에서 그 줄을 지워라: ${JSON.stringify(staleExemptions)}`,
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
    // 순서의 정의는 suite-manifest.mjs 한 곳에 있다 — 여기서 다시 계산하면
    // test/sort-suites.mjs 가 정규화한 파일을 이 가드가 거부할 수 있다.
    const canonical = canonicalSteps(steps);
    if (JSON.stringify(steps) !== JSON.stringify(canonical)) {
      const at = steps.findIndex((s, i) => s !== canonical[i]);
      problems.push(
        `${suite}.txt 가 사전순이 아니다 — ${at + 1}번째 step 이 "${steps[at]}", 기대는 "${canonical[at]}"`,
      );
    }
  }
  // 어긋난 항목만 알려주고 끝내면 고치는 사람이 손으로 줄을 옮기게 되는데, 그
  // 판단이 바로 이 가드가 반복해서 잡는 대상이다(셸 `sort` 도 눈도 틀린다).
  // 조치 명령을 함께 찍어 줄을 옮기는 대신 스크립트를 돌리게 한다.
  assert.deepEqual(
    problems,
    [],
    problems.length > 0
      ? `${problems.join(' | ')} — 고치려면 apps/server 에서 \`npm run test:suites:sort\` 를 돌려라`
      : '',
  );
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

const FIXTURE_CI_ENTRY = ['test'];

function fixtureAudit({ scripts, manifests, diskTestPaths, exemptions }) {
  return auditRegistration({
    scripts,
    manifests: new Map(Object.entries(manifests)),
    ciEntryScripts: FIXTURE_CI_ENTRY,
    exemptions,
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
  assert.deepEqual(audit.deadSuites, ['dead'], 'dead 매니페스트 자체도 신고돼야 한다');
  assert.ok(!audit.registered.has('test/buried.test.mjs'));
});

// 대조군. 같은 fixture 에서 dead 를 실제로 부르는 연결만 만들어 주면 둘 다 조용해야
// 한다 — 아니면 위 테스트가 "항상 빨간" 검사를 확인하고 있는 셈이 된다.
test('그 매니페스트를 CI 진입점에서 부르는 연결이 생기면 등록으로 인정된다', () => {
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
  assert.deepEqual(audit.deadSuites, []);
});

// 우회의 두 번째 형태. 매니페스트를 부르는 스크립트가 있긴 한데 CI 가 그 스크립트를
// 부르지 않는 경우다. 그 매니페스트는 사람이 쓰는 목록일 수 있으니 죽은 목록은
// 아니지만, 거기 적힌 파일은 등록이 아니다.
test('매니페스트를 여는 스크립트가 있어도 CI 가 그 스크립트를 안 부르면 등록이 아니다', () => {
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
  assert.deepEqual(audit.deadSuites, [], '스크립트가 여는 목록은 죽은 목록이 아니다');
});

// 티켓 6ad5989a 의 버그 그대로다. test:catalog-scope 처럼 node --test 를 직접 부르는
// 단독 스크립트가 진입점으로 선언돼 있어, 거기에만 적힌 파일이 "등록됨" 으로
// 통과했다. CI 는 그 스크립트를 부르지 않으므로 그 파일은 CI 에서 한 번도 안 돌았다.
test('단독 스크립트에만 적힌 파일은 등록이 아니다 — CI 는 그 스크립트를 부르지 않는다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:solo': 'node --test test/live.test.mjs test/solo.test.mjs',
    },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/solo.test.mjs'],
  });

  assert.deepEqual(
    audit.orphans,
    ['test/solo.test.mjs'],
    '단독 스크립트에 적혀 있다는 이유로 등록으로 세면 CI 에서 안 도는 파일이 가드를 통과한다',
  );
  assert.ok(!audit.registered.has('test/solo.test.mjs'));
  assert.ok(!audit.runnableScripts.has('test:solo'), '단독 스크립트는 CI 도달 집합에 들어가지 않는다');
  assert.deepEqual(audit.dangling, []);
});

// 대조군 — 같은 파일이 CI 매니페스트에도 있으면 단독 스크립트는 편의일 뿐 상관없다.
test('같은 파일이 CI 매니페스트에도 있으면 단독 스크립트가 있어도 조용하다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:solo': 'node --test test/solo.test.mjs',
    },
    manifests: { test: ['test/live.test.mjs', 'test/solo.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/solo.test.mjs'],
  });

  assert.deepEqual(audit.orphans, []);
});

// test:qa:fast 의 모양이다. 자기 매니페스트를 여는 사람용 부분집합은 남겨 두되, 거기에만
// 적힌 파일은 등록이 아니다.
test('사람용 부분집합 매니페스트에만 적힌 파일은 등록이 아니다', () => {
  const scripts = {
    test: 'node test/run-suite.mjs --suite test',
    'test:fast': 'node test/run-suite.mjs --suite fast',
  };
  const onlyInFast = fixtureAudit({
    scripts,
    manifests: { test: ['test/live.test.mjs'], fast: ['test/live.test.mjs', 'test/quick.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/quick.test.mjs'],
  });
  assert.deepEqual(onlyInFast.orphans, ['test/quick.test.mjs']);
  assert.deepEqual(onlyInFast.deadSuites, []);

  const subset = fixtureAudit({
    scripts,
    manifests: { test: ['test/live.test.mjs', 'test/quick.test.mjs'], fast: ['test/quick.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/quick.test.mjs'],
  });
  assert.deepEqual(subset.orphans, [], 'CI 등록 파일의 부분집합이면 조용하다');
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
  assert.deepEqual(audit.deadSuites, []);
});

// 커맨드 안의 위임(매니페스트 step 이 아니라 스크립트 커맨드의 `npm run` · `npm test`)도
// 따라간다. 위임이 커맨드 끝에 있어도 마찬가지다.
test('커맨드 안의 npm run · npm test 위임을 커맨드 끝에 있어도 따라간다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test && npm run test:extra',
      'test:extra': 'node --test test/extra.test.mjs && npm run lint --workspace client',
    },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/extra.test.mjs'],
  });
  assert.deepEqual(audit.orphans, []);
  assert.ok(audit.runnableScripts.has('test:extra'));
  assert.deepEqual(audit.missingDelegations, [], '-w/--workspace 로 다른 패키지에 가는 npm 호출은 이 package.json 위임이 아니다');

  const viaNpmTest = auditRegistration({
    scripts: { ci: 'echo start; npm test', test: 'node test/run-suite.mjs --suite test' },
    manifests: new Map([['test', ['test/live.test.mjs']]]),
    ciEntryScripts: ['ci'],
    diskTestPaths: ['test/live.test.mjs'],
  });
  assert.deepEqual(viaNpmTest.orphans, [], '`npm test` 도 test 스크립트로의 위임이다');
});

// npm 은 pre/post 를 한 겹만 펼친다 — `npm test` 는 prepretest 를 돌리지 않는다.
test('pre 훅의 pre 훅은 돌지 않는다', () => {
  const audit = fixtureAudit({
    scripts: {
      prepretest: 'node test/run-suite.mjs --suite deeper',
      pretest: 'node test/run-suite.mjs --suite pretest',
      test: 'node test/run-suite.mjs --suite test',
    },
    manifests: { deeper: ['test/deeper.test.mjs'], pretest: ['test/pre.test.mjs'], test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/deeper.test.mjs', 'test/pre.test.mjs', 'test/live.test.mjs'],
  });
  assert.deepEqual(audit.orphans, ['test/deeper.test.mjs']);
});

// 매니페스트가 자기 스크립트로 위임하면(런타임에는 끝없이 재귀한다) 감사라도 끝나야 한다.
// 감사가 동기 루프라 같은 프로세스에서 돌리면 멈췄을 때 테스트 타임아웃도 못 끊는다 —
// 그래서 자식 프로세스에 시간 제한을 걸어 돌린다.
test('순환 위임에서도 도달 계산이 끝난다', () => {
  const code = `
    const { auditRegistration } = await import(${JSON.stringify(pathToFileURL(AUDIT_MODULE).href)});
    const audit = auditRegistration({
      scripts: { test: 'node test/run-suite.mjs --suite test', 'test:a': 'npm run test:b', 'test:b': 'npm run test:a' },
      manifests: new Map([['test', ['test/live.test.mjs', 'npm run test', 'npm run test:a']]]),
      ciEntryScripts: ['test'],
      diskTestPaths: ['test/live.test.mjs'],
    });
    console.log(JSON.stringify([...audit.runnableScripts].sort()));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(res.status, 0, `감사가 끝나지 않았다(시간 제한) 또는 실패했다: ${res.signal ?? ''} ${res.stderr}`);
  assert.deepEqual(JSON.parse(res.stdout), ['test', 'test:a', 'test:b']);
});

test('CI 진입점에서 도달하는 스크립트가 직접 나열한 파일은 등록으로 센다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:inline': 'NODE_OPTIONS=--no-warnings node --test test/inline.test.mjs',
      'test:runner-args': 'node ./test/run-suite.mjs test/direct.test.mjs',
    },
    manifests: { test: ['test/live.test.mjs', 'npm run test:inline', 'npm run test:runner-args'] },
    diskTestPaths: ['test/live.test.mjs', 'test/inline.test.mjs', 'test/direct.test.mjs'],
  });

  assert.deepEqual(
    audit.orphans,
    [],
    'node --test 나 러너에 경로를 직접 준 스크립트라도 CI 에서 도달하면 등록이다 — 환경 변수 대입 · ./ 이 앞에 붙어도',
  );
});

// 커맨드에 경로가 적혀 있다고 실행되는 것은 아니다. node --test · 러너의 인자만 실행이다.
test('echo 나 셸 주석에 적힌 경로는 등록이 아니다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test && echo test/echoed.test.mjs '
        + '&& node --test test/inline.test.mjs # test/commented.test.mjs',
    },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/echoed.test.mjs', 'test/inline.test.mjs', 'test/commented.test.mjs'],
  });

  assert.deepEqual(audit.orphans, ['test/commented.test.mjs', 'test/echoed.test.mjs']);
});

test('없는 파일을 가리키는 등록은 dangling 으로 잡히고, 적힌 곳이 함께 나온다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs', 'test/gone.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.dangling, ['test/gone.test.mjs']);
  assert.deepEqual(audit.namedAt.get('test/gone.test.mjs'), ['test/suites/test.txt']);
});

// 단독 스크립트는 등록이 아니지만, 없는 파일을 가리키면 그 스크립트는 고장이다.
test('단독 스크립트나 사람용 매니페스트가 없는 파일을 가리켜도 dangling 이다', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      'test:solo': 'node --test test/gone-solo.test.mjs',
      'test:fast': 'node test/run-suite.mjs --suite fast',
    },
    manifests: { test: ['test/live.test.mjs'], fast: ['test/gone-fast.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.dangling, ['test/gone-fast.test.mjs', 'test/gone-solo.test.mjs']);
  assert.deepEqual(audit.namedAt.get('test/gone-solo.test.mjs'), ['package.json test:solo']);
});

test('없는 스크립트로 가는 위임이 잡힌다 — --if-present 와 다른 패키지는 빼고', () => {
  const audit = fixtureAudit({
    scripts: {
      test: 'node test/run-suite.mjs --suite test',
      pretest: 'npm run nope && npm run maybe --if-present && npm run e2e -w client && npm run nope2 -- -w client '
        + '&& npm run e2e --prefix ../client && npm run e2e -C ../client && npm run e2e --workspace=client',
    },
    manifests: { test: ['test/live.test.mjs', 'npm run test:gone'] },
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.missingDelegations, [
    'package.json pretest → npm run nope',
    'package.json pretest → npm run nope2',
    'test/suites/test.txt → npm run test:gone',
  ], '`--` 뒤의 -w 는 스크립트 인자라 이 package.json 의 위임이다');
});

test('러너가 모르는 자리 · 이름의 테스트 파일은 따로 신고된다 — 일부러 둔 fixture 는 예외로', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: [
      'test/live.test.mjs',
      'test/unit/hidden.test.mjs',
      'test/qa-flows/deep/nested.test.mjs',
      'test/한글.test.mjs',
      'test/fixtures/sample.test.mjs',
    ],
    exemptions: { 'test/fixtures/sample.test.mjs': 'run-suite 가 읽는 fixture 다 — 테스트가 아니다' },
  });

  assert.deepEqual(audit.misplacedTests, [
    'test/qa-flows/deep/nested.test.mjs',
    'test/unit/hidden.test.mjs',
    'test/한글.test.mjs',
  ]);
  assert.deepEqual(audit.orphans, [], '자리부터 틀린 파일은 고아 목록에 섞지 않는다');
  assert.deepEqual(audit.staleExemptions, [], '디스크에 있는 fixture 의 예외는 낡지 않았다');
});

test('--suite 가 없는 매니페스트를 가리키면 broken 으로 잡힌다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test', 'test:x': 'node test/run-suite.mjs --suite nope' },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.brokenSuiteTargets, ['test:x -> nope']);
});

test('예외로 둔 파일은 고아로 신고하지 않는다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/broken.test.mjs', 'test/forgotten.test.mjs'],
    exemptions: { 'test/broken.test.mjs': '로드부터 실패한다 — 고치는 티켓이 따로 있다' },
  });

  assert.deepEqual(audit.orphans, ['test/forgotten.test.mjs'], '예외가 아닌 고아는 그대로 잡힌다');
  assert.deepEqual(audit.staleExemptions, []);
  assert.deepEqual(audit.exemptionsWithoutReason, []);
});

// 예외는 필요한 동안만 둔다. 그 파일을 고쳐 매니페스트에 넣었는데 예외가 남으면, 나중에
// 다시 매니페스트에서 빠져도 가드가 조용하다.
test('이미 CI 에 등록된 파일이나 없는 파일의 예외는 낡은 예외로 신고된다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs', 'test/fixed.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/fixed.test.mjs'],
    exemptions: {
      'test/fixed.test.mjs': '고쳐지기 전의 사유',
      'test/deleted.test.mjs': '지워지기 전의 사유',
    },
  });

  assert.deepEqual(audit.staleExemptions, [
    { path: 'test/deleted.test.mjs', problem: 'missing' },
    { path: 'test/fixed.test.mjs', problem: 'registered' },
  ]);
  assert.deepEqual(audit.orphans, []);
});

test('사유가 비었거나 글이 아닌 예외는 따로 신고된다', () => {
  const audit = fixtureAudit({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: { test: ['test/live.test.mjs'] },
    diskTestPaths: ['test/live.test.mjs', 'test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs'],
    exemptions: { 'test/a.test.mjs': '  ', 'test/b.test.mjs': '', 'test/c.test.mjs': true, 'test/d.test.mjs': null },
  });

  assert.deepEqual(audit.exemptionsWithoutReason, ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs']);
});

// scripts 는 JSON.parse 결과라 Object.prototype 을 상속한다. 존재 판정을
// `scripts[name] !== undefined` 로 하면 toString 같은 이름이 실재 스크립트로
// 둔갑해, 진입점 오타가 신고되지 않고 조용히 무시된다.
test('상속된 Object.prototype 이름을 실재 스크립트로 착각하지 않는다', () => {
  const audit = auditRegistration({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: new Map([['test', ['test/live.test.mjs']]]),
    ciEntryScripts: ['test', 'toString'],
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.missingEntryScripts, ['toString']);
  assert.ok(!audit.runnableScripts.has('toString'));
});

test('CI 진입점 오타는 따로 신고된다', () => {
  const audit = auditRegistration({
    scripts: { test: 'node test/run-suite.mjs --suite test' },
    manifests: new Map([['test', ['test/live.test.mjs']]]),
    ciEntryScripts: ['test', 'test:오타'],
    diskTestPaths: ['test/live.test.mjs'],
  });

  assert.deepEqual(audit.missingEntryScripts, ['test:오타']);
});

// 6ad5989a 의 재발 경로다. 단독 스크립트를 CI 진입점 목록에 다시 보태면, ci.yml 이 그것을
// 부르지 않는 한 대조가 빨개진다. (ci.yml 을 읽는 쪽의 fixture 는 ci-workflow.test.mjs.)
test('ci.yml 이 부르지 않는 진입점은 notInvoked 로 잡힌다', () => {
  const scripts = {
    test: 'node test/run-suite.mjs --suite test',
    'test:solo': 'node --test test/solo.test.mjs',
  };
  const { notInvoked, undeclared } = compareCiEntries({
    declared: ['test', 'test:solo'],
    invoked: new Set(['test']),
    scripts,
    manifests: new Map([['test', ['test/live.test.mjs']]]),
  });

  assert.deepEqual(notInvoked, ['test:solo']);
  assert.deepEqual(undeclared, []);
});

test('ci.yml 이 부르는 테스트 스크립트가 목록에 없으면 undeclared 로 잡힌다 — build 는 상관없다', () => {
  const scripts = {
    test: 'node test/run-suite.mjs --suite test',
    'test:new': 'node test/run-suite.mjs --suite test-new',
    build: 'nest build',
  };
  const { notInvoked, undeclared } = compareCiEntries({
    declared: ['test'],
    invoked: new Set(['test', 'test:new', 'build', 'test:not-in-package-json']),
    scripts,
    manifests: new Map([['test', ['test/live.test.mjs']], ['test-new', ['test/new.test.mjs']]]),
  });

  assert.deepEqual(notInvoked, []);
  assert.deepEqual(undeclared, ['test:new']);
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

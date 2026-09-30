// run-suite argv 계약 가드 — 티켓 9647c1ef.
//
// `b0ccd0aa` 가 package.json 의 `test` 를
//   node test/run-suite.mjs --suite test test/manager-installed-version-heartbeat.test.mjs
// 로 바꿨다. 러너는 `--suite` 를 단독으로만 받으므로 이 argv 를 즉시 거부했고,
// 277 step 본 스위트가 **한 step 도 실행되지 않은 채** exit 1 이 됐다. main CI 가
// 두 커밋 연속 red 였다.
//
// 그 상태를 잡는 가드가 없었다. 등록 감사
// (test/helpers/registration-audit.mjs)의 모델은 "등록의 도달 가능성" 이라 커맨드
// 안의 bare test 경로를 등록으로 센다 — 러너가 그 argv 자체를 거부한다는 사실은
// 모델 밖이다. 그래서 감사는 초록, 러너는 0 step. 정렬 가드도 이 축을 안 본다.
//
// 여기서 보는 축은 하나다: **package.json 의 커맨드가 러너에게 받아들여지는가.**
// 판정은 러너가 쓰는 것과 같은 함수(test/helpers/run-suite-argv.mjs 의
// classifyRunSuiteArgv)로 한다 — 두 벌이 되면 가드가 통과시킨 argv 를 러너가
// 거부하는, 고치는 쪽이 더 헷갈리는 상태가 만들어진다.
//
// 대상은 `TEST_ENTRY_SCRIPTS` 가 아니라 **러너를 부르는 모든 스크립트** 다. 사고
// 당사자인 `test` 는 그 목록에 있지만 `pretest`/`posttest`/`pretest:qa`/
// `pretest:qa:pg`/`test:qa` 는 없고, 러너를 부르는 커맨드는 도달 가능성과 무관하게
// 유효해야 한다 — 전수가 더 단순하고 더 넓다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NO_STEPS_USAGE,
  SUITE_NAME_MISSING,
  classifyRunSuiteArgv,
  extractRunSuiteArgvs,
  suiteNotAloneMessage,
} from './helpers/run-suite-argv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

// 사고 당시 커맨드 그대로. 문자열을 여기 리터럴로 박아 둬야 실패 증명이 소스
// 되돌림에 의존하지 않는다 (apps/server 유닛 테스트 대부분이 dist/ 를 import 하므로
// 소스만 되돌린 증명은 거짓 그린이 된다).
const BROKEN_COMMAND =
  'node test/run-suite.mjs --suite test test/manager-installed-version-heartbeat.test.mjs';
const FIXED_COMMAND = 'node test/run-suite.mjs --suite test';

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

// package.json 에서 러너 호출을 전수로 모은다. 한 커맨드가 `&&` 로 러너를 두 번
// 부를 수도 있으므로 호출 단위로 펼친다.
function runSuiteInvocations(scripts = readPackageScripts()) {
  const out = [];
  for (const [script, command] of Object.entries(scripts)) {
    for (const argv of extractRunSuiteArgvs(command)) out.push({ script, command, argv });
  }
  return out;
}

const verdictOf = (command) => extractRunSuiteArgvs(command).map(classifyRunSuiteArgv);

test('package.json 의 러너 호출은 전부 run-suite 의 argv 규칙을 통과한다', () => {
  // 거부 사유를 스크립트 이름·커맨드와 함께 찍는다. 이 사고는 "왜 0 step 인가" 를
  // 로그에서 못 읽어 두 커밋을 갔다.
  const rejected = runSuiteInvocations()
    .map((inv) => ({ ...inv, verdict: classifyRunSuiteArgv(inv.argv) }))
    .filter(({ verdict }) => verdict.kind === 'error')
    .map(({ script, command, verdict }) => `${script}: "${command}" → ${verdict.message}`);

  assert.deepEqual(
    rejected,
    [],
    '러너가 거부하는 argv 를 가진 스크립트 — 실행 목록이 한 step 도 안 돌고 exit 1 이 '
      + `된다(티켓 9647c1ef 버그 클래스): ${rejected.join(' | ')}`,
  );
});

// 위 검사가 공허해지는 길은 "러너 호출을 하나도 못 찾는 것" 이다. 러너 파일명이
// 바뀌거나 스크립트가 다른 방식으로 러너를 부르기 시작하면 추출이 0 개가 되면서
// 조용히 항상 초록이 된다.
test('러너 호출 추출이 공허하지 않다 — 사고 당사자 test 스크립트가 잡힌다', () => {
  const invocations = runSuiteInvocations();
  assert.ok(
    invocations.length > 0,
    'package.json 에서 run-suite 호출을 하나도 못 찾았다 — 러너 파일명이 바뀌었다면 '
      + 'test/helpers/run-suite-argv.mjs 의 추출 규칙을 함께 고쳐라. 그대로 두면 이 가드가 '
      + '항상 초록이 된다',
  );
  assert.ok(
    invocations.some((inv) => inv.script === 'test'),
    `"test" 스크립트가 러너를 부르지 않는다 — 사고가 난 자리다. 잡힌 스크립트: ${
      invocations.map((inv) => inv.script).join(', ')}`,
  );
});

// ── 판정이 실제로 잡는지 합성 fixture 로 고정한다 ──────────────────────────
// 위 두 검사는 저장소가 건강하면 초록이라, 판정 로직이 망가져도 초록일 수 있다.

test('사고 당시 커맨드는 거부되고, 되돌린 형태는 통과한다', () => {
  assert.deepEqual(
    verdictOf(BROKEN_COMMAND),
    [{
      kind: 'error',
      message: suiteNotAloneMessage(['test/manager-installed-version-heartbeat.test.mjs']),
    }],
    'b0ccd0aa 의 커맨드가 통과했다 — 이 가드는 잡으려던 사고를 그대로 흘려보낸다',
  );
  assert.deepEqual(
    verdictOf(FIXED_COMMAND),
    [{ kind: 'suite', suite: 'test' }],
    '되돌린 형태까지 거부하면 "항상 빨간" 검사를 확인하고 있는 셈이다',
  );
});

test('--suite 이름 누락도 거부된다', () => {
  assert.deepEqual(
    verdictOf('node test/run-suite.mjs --suite'),
    [{ kind: 'error', message: SUITE_NAME_MISSING }],
  );
});

test('인자 없이 러너만 부르면 거부된다', () => {
  assert.deepEqual(
    verdictOf('node test/run-suite.mjs'),
    [{ kind: 'error', message: NO_STEPS_USAGE }],
    '실행 목록이 없는 호출 — 0 step 을 돌고 끝나면 CI 가 초록으로 보인다',
  );
});

test('위치 인자 형태와 && 로 이어진 커맨드도 유효하게 뽑힌다', () => {
  // 런북·임시 실행이 쓰는 형태이고 test:mention-audit 이 실제로 이렇게 부른다.
  assert.deepEqual(
    verdictOf('npm run build && node test/run-suite.mjs test/qa-flows/mention-audit-retry.test.mjs'),
    [{ kind: 'steps', steps: ['test/qa-flows/mention-audit-retry.test.mjs'] }],
  );
  assert.deepEqual(
    verdictOf('npm run build && node test/run-suite.mjs --suite pretest'),
    [{ kind: 'suite', suite: 'pretest' }],
    '&& 앞 구간에 걸려 러너 호출을 놓치면 pretest 계열이 전부 검사 밖으로 빠진다',
  );
});

test('토큰을 감싼 따옴표는 벗기지 않고 러너의 Windows 재조립에 넘긴다', () => {
  // normalizeSteps 는 cmd.exe 가 쪼갠 `'npm run test:qa'` 를 따옴표로 되짚어
  // 재조립한다. 추출 단계에서 따옴표를 벗기면 그 경로가 조용히 죽는다.
  assert.deepEqual(
    verdictOf("node test/run-suite.mjs 'npm run test:qa'"),
    [{ kind: 'steps', steps: ['npm run test:qa'] }],
  );
});

test('러너를 부르지 않는 스크립트는 검사 대상이 아니다', () => {
  assert.deepEqual(
    extractRunSuiteArgvs('node --test test/catalog-scope.test.mjs'),
    [],
    'node --test 를 직접 부르는 스크립트에는 러너의 argv 규칙이 적용되지 않는다',
  );
  assert.deepEqual(extractRunSuiteArgvs(undefined), []);
});

// 순수 함수와 실제 CLI 가 갈리지 않음을 한 건 못 박는다. 이 방향만 안전하다 —
// 유효한 argv(`--suite test`)를 자식으로 돌리면 본 스위트 277 step 을 실제로
// 실행하고 test/suites/test.txt 에는 이 파일 자신도 들어가므로 무한 재귀가 된다.
test('거부되는 argv 를 CLI 로 돌리면 같은 문구로 0 이 아닌 코드로 죽는다', () => {
  const argv = extractRunSuiteArgvs(BROKEN_COMMAND)[0];
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-suite.mjs'), ...argv],
    { cwd: SERVER_ROOT, encoding: 'utf8' },
  );

  assert.notEqual(res.status, 0, `CLI 가 성공으로 끝났다 — stdout: ${res.stdout}`);
  assert.ok(
    res.stderr.includes(suiteNotAloneMessage([argv[argv.length - 1]])),
    `CLI 가 다른 이유로 죽었다 — 순수 함수와 CLI 의 판정이 갈렸을 수 있다. stderr: ${res.stderr}`,
  );
});

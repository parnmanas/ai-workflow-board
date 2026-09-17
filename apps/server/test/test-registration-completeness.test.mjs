// 등록 완전성 가드 — 티켓 02a18e6e, 티켓 0b4f089d 의 재발 방지 후속.
// 0b4f089d 에서 apps/server/test/*.test.mjs 5개가 디스크에는 있는데 어떤
// package.json 스크립트에도 등록돼 있지 않아 `npm test` 가 조용히 건너뛰고
// 있었다(CI 커버리지 0, 아무도 몰랐다).
//
// 두 출처의 정적 diff 다 — 앱 부팅도 서브프로세스도 없이 fs + 파싱만 하므로
// 매 `npm test` 마다 돌려도 싸다:
//   - 디스크:      test/ (최상위) 와 test/qa-flows/ 아래 모든 *.test.mjs
//   - 등록 원천:   ① test/suites/*.txt 매니페스트의 step 줄
//                  ② package.json 스크립트 커맨드의 토큰 (아직 파일을 직접
//                     나열하는 test:catalog-scope 같은 스크립트가 있다)
//
// 두 방향 모두 의미가 있다:
//   1. orphan   — 디스크에 있는데 아무 데서도 참조하지 않는 파일. 0b4f089d 의
//      버그 클래스로, 존재하지만 npm test/test:qa 가 영영 건드리지 않는다.
//   2. dangling — 참조는 있는데 그 경로에 파일이 없는 경우(오타·rename·삭제).
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
import { fileURLToPath } from 'node:url';
import {
  listSuiteNames,
  parseSuiteManifest,
  readSuiteSteps,
  suiteFromScriptCommand,
  suiteManifestPath,
} from './helpers/suite-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const QA_FLOWS_DIR = path.join(__dirname, 'qa-flows');
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

// 스크립트 커맨드는 셸에서 돈다. 공백으로 쪼개고 감싼 따옴표 한 겹을 벗기면
// 남아 있는 bare test/*.mjs 경로를 집기에 충분하다.
function tokenize(command) {
  return command.split(/\s+/).map((tok) => tok.replace(/^["']|["']$/g, ''));
}

const TEST_PATH_RE = /^test\/(?:qa-flows\/)?[A-Za-z0-9_.-]+\.test\.mjs$/;
const DELEGATION_RE = /^npm run [A-Za-z0-9:_-]+$/;

// 등록 원천 두 곳을 합친다. 한 곳만 보면 이관 도중/이후에 반대쪽에 남은 등록을
// orphan 으로 오판하거나, 반대로 못 잡는다.
function collectReferencedTestPaths() {
  const refs = new Set();
  for (const command of Object.values(readPackageScripts())) {
    for (const tok of tokenize(command)) {
      if (TEST_PATH_RE.test(tok)) refs.add(tok);
    }
  }
  for (const suite of listSuiteNames()) {
    for (const step of readSuiteSteps(suite)) {
      if (TEST_PATH_RE.test(step)) refs.add(step);
    }
  }
  return refs;
}

function listTestFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
}

test('최상위 test/*.test.mjs 는 모두 어딘가에 등록돼 있다', () => {
  const refs = collectReferencedTestPaths();
  const orphans = listTestFiles(__dirname).filter((f) => !refs.has(`test/${f}`));
  assert.deepEqual(
    orphans,
    [],
    '고아가 된 최상위 테스트 파일 — 디스크에는 있는데 매니페스트에도 package.json 에도 '
      + `등록이 없어 npm test 가 조용히 건너뛴다(티켓 0b4f089d 버그 클래스): ${orphans.join(', ')}`,
  );
});

test('test/qa-flows/*.test.mjs 는 모두 어딘가에 등록돼 있다', () => {
  const refs = collectReferencedTestPaths();
  const orphans = listTestFiles(QA_FLOWS_DIR).filter((f) => !refs.has(`test/qa-flows/${f}`));
  assert.deepEqual(
    orphans,
    [],
    `고아가 된 qa-flows 테스트 파일 — 디스크에는 있는데 등록이 없다: ${orphans.join(', ')}`,
  );
});

test('등록된 test/*.mjs 경로는 모두 디스크에 실재한다', () => {
  const refs = collectReferencedTestPaths();
  const dangling = [...refs].filter((ref) => !fs.existsSync(path.join(SERVER_ROOT, ref)));
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
  const missing = [];
  for (const [name, command] of Object.entries(readPackageScripts())) {
    const suite = suiteFromScriptCommand(command);
    if (suite && !fs.existsSync(suiteManifestPath(suite))) missing.push(`${name} -> ${suite}`);
  }
  assert.deepEqual(
    missing,
    [],
    `--suite 가 없는 매니페스트를 가리킨다 — 그 스크립트는 실행 목록 없이 죽는다: ${missing.join(', ')}`,
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
});

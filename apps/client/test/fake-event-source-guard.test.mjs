// 로컬 FakeEventSource 재정의 방지 가드 (source: 티켓 85d74e89, 이 가드는 티켓 879eea38).
//
// test/helpers/boardStream.mjs 의 installFakeEventSource() 추출(474bc091) 당시 로컬
// FakeEventSource 중복 정의 5곳을 공용 헬퍼 호출로 치환했지만, 그 작업이 진행되던 도중
// 병행 브랜치(06b2b990)가 새 테스트 파일에 같은 정의를 손으로 또 추가해 여섯 번째 중복이
// 재발했다(85d74e89 후속 치환) — 리뷰 시점의 경쟁에만 의존해 발견됐다. 이 가드는
// apps/client/test/ 아래 모든 *.mjs 파일을 훑어, 공용 헬퍼 파일 밖에서 FakeEventSource 를
// 로컬로 (재)정의하는 코드가 있으면 pretest 단계에서 즉시 실패시킨다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const CANONICAL_HELPER = path.join(__dirname, 'helpers', 'boardStream.mjs');

// class/function/const/let/var 로 FakeEventSource 를 직접 정의(대입)하는 형태를 잡는다.
// `const { FakeEventSource } = installFakeEventSource()` 같은 구조분해는 `{` 가 \s+ 를
// 끊어 매치되지 않는다 — 공용 헬퍼에서 값을 꺼내 쓰는 정상 패턴이므로 의도적으로 통과시킨다.
const FORBIDDEN_RE =
  /\bclass\s+FakeEventSource\b|\bfunction\s+FakeEventSource\s*\(|\b(?:const|let|var)\s+FakeEventSource\s*=/;

function relativeForReport(absPath) {
  return path.relative(CLIENT_ROOT, absPath).split(path.sep).join('/');
}

function listMjsFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMjsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

// 검사 본문 — 파일 하나의 (경로, 내용) 을 받아 위반 메시지 또는 null 을 반환하는 순수 함수.
// 아래 디렉터리 스캔과 음성 테스트가 이 함수 하나를 공유한다.
function checkContentForForbiddenDefinition(absPath, content) {
  if (path.resolve(absPath) === path.resolve(CANONICAL_HELPER)) return null;
  if (!FORBIDDEN_RE.test(content)) return null;
  return (
    `${relativeForReport(absPath)} 에 로컬 FakeEventSource (재)정의가 있습니다 — ` +
    `test/helpers/boardStream.mjs 의 installFakeEventSource() 를 사용하세요.`
  );
}

function scanDirForForbiddenDefinitions(dir) {
  const violations = [];
  for (const absPath of listMjsFilesRecursive(dir)) {
    const violation = checkContentForForbiddenDefinition(absPath, fs.readFileSync(absPath, 'utf8'));
    if (violation) violations.push(violation);
  }
  return violations;
}

test('apps/client/test/ 아래 어떤 *.mjs 파일도 공용 헬퍼 밖에서 FakeEventSource 를 로컬로 재정의하지 않는다', () => {
  const violations = scanDirForForbiddenDefinitions(TEST_DIR);
  assert.deepEqual(violations, [], `로컬 FakeEventSource 재정의가 발견되었습니다:\n${violations.join('\n')}`);
});

test('검사 본문은 기존 파일 내용에 사후 주입된 금지 패턴을 잡아낸다 (음성 테스트)', () => {
  const targetPath = path.join(TEST_DIR, 'cli-credential-import.test.mjs');
  const originalContent = fs.readFileSync(targetPath, 'utf8');

  assert.equal(
    checkContentForForbiddenDefinition(targetPath, originalContent),
    null,
    'sanity: 정상 상태의 cli-credential-import.test.mjs 는 위반이 없어야 한다 (검사가 항상 true 를 반환하는 게 아님을 증명)',
  );

  // 금지 패턴 리터럴은 문자열을 이어붙여 조립한다 — 그대로 쓰면 이 가드 파일 자신의 소스에
  // 검사 대상 리터럴이 그대로 나타나, 위 첫 번째 test(TEST_DIR 전체 스캔)가 이 파일 자신을
  // 오탐으로 잡는다.
  const injectedDefinition = ['class', 'FakeEventSource', '{ constructor() {} }'].join(' ');
  const injectedContent = `${originalContent}\n\n${injectedDefinition}\n`;

  const violation = checkContentForForbiddenDefinition(targetPath, injectedContent);
  assert.ok(
    violation && violation.includes('cli-credential-import.test.mjs'),
    '기존 파일 내용 뒤에 금지 패턴을 주입하면 검사 본문이 해당 파일을 위반으로 잡아내야 한다',
  );
});

test('스캔 대상 디렉터리에 미등록 금지 패턴을 담은 합성 .test.mjs 를 두면 readdir/파일선택/스캔 경로가 실제로 이를 탐지한다 (non-vacuous)', () => {
  // apps/client/test/ 자체가 아니라 격리된 임시 디렉터리를 스캔 대상으로 쓴다 — node:test 는
  // pretest 로 나열된 여러 *.test.mjs 파일을 별도 프로세스로 동시 실행하므로(실측 확인됨),
  // 진짜 test/ 트리에 .test.mjs 파일을 잠깐이라도 흘리면 동시 실행 중인
  // test-registration-guard.test.mjs 가 "등록되지 않은 테스트 파일"로 오탐할 레이스가 생긴다.
  // scanDirForForbiddenDefinitions 는 dir 인자를 그대로 받는 범용 함수이므로, 임시 디렉터리를
  // 넘겨도 위 첫 번째 test 와 동일한 readdir·파일선택·정규식 적용 코드 경로를 그대로 구동한다.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-fake-event-source-guard-'));
  try {
    fs.writeFileSync(
      path.join(sandbox, 'clean.test.mjs'),
      "import { installFakeEventSource } from './helpers/boardStream.mjs';\n",
    );
    const injectedDefinition = ['class', 'FakeEventSource', '{ constructor() {} }'].join(' ');
    fs.writeFileSync(path.join(sandbox, 'synthetic-probe.test.mjs'), `${injectedDefinition}\n`);

    const violations = scanDirForForbiddenDefinitions(sandbox);

    assert.equal(
      violations.length,
      1,
      `synthetic 디렉터리(clean 1개 + 위반 1개)에서 정확히 1개 위반만 나와야 한다 — readdir 이 두 파일을 ` +
        `실제로 순회했다는 증거: ${JSON.stringify(violations)}`,
    );
    assert.ok(violations[0].includes('synthetic-probe.test.mjs'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

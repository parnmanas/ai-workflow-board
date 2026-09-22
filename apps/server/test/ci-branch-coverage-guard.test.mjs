// Regression guard — 2026-08-20 의존성 감사.
//
// scripts/audit-ci-branch-coverage.mjs 는 "배포되는 브랜치가 ci.yml 의 push
// 트리거에 있는가" 를 검사해서, dependency-audit(취약점·install script·액션 SHA)
// 이 배포 브랜치에서도 실제로 돌게 강제한다. 그 감사에서 발견된 구멍이 원인:
// 당시 배포 브랜치이던 production.private 이 ci.yml push 트리거에 없었고, PR 도
// 거치지 않아(머지 후 직접 push) 의존성 감사가 단 한 번도 돈 적이 없었다.
// (2026-09 형상에서 배포 대상은 main 이다 — ticket 128d62cd, 아래 마지막 테스트 참조.)
//
// 이 파일이 지키는 것은 **가드 스크립트 자신의 파서**다. 가드는 의존성 없이
// 들여쓰기 기반으로 워크플로 YAML 을 읽는데, 그 파서가 조용히 망가지면 가장
// 위험한 실패 모드가 나온다 — branches 를 못 찾고 null 을 돌려주면 가드는
// "필터 없음 = 전 브랜치 커버" 로 해석하고 **exit 0 으로 통과한다**. 즉 파서
// 버그가 곧 침묵하는 false-pass 다. 그래서 파서를 직접 단언한다.
//
// 앱 부팅도 서브프로세스도 없다 — 순수 문자열 파싱이라 매 `npm test` 에 싸다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployBranches, pushBranches } from '../../../scripts/audit-ci-branch-coverage.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml');

test('실제 ci.yml 에서 main 과 production.private 을 둘 다 읽어낸다', () => {
  const branches = pushBranches(fs.readFileSync(CI_YML, 'utf8'));
  assert.notEqual(
    branches,
    null,
    'ci.yml 의 push branches 를 파싱하지 못했다 — 가드가 조용히 통과(false-pass)하게 된다',
  );
  assert.ok(branches.includes('main'), `main 이 push 트리거에 없다: ${JSON.stringify(branches)}`);
  assert.ok(
    branches.includes('production.private'),
    `production.private 이 push 트리거에서 사라졌다 — 그 브랜치가 되살아나 push 되면 감사 없이 나간다(안전망, ci.yml 주석 참조): ${JSON.stringify(branches)}`,
  );
});

test('배포 브랜치가 빠지면 파서가 그 부재를 드러낸다 (가드가 FAIL 할 수 있어야 한다)', () => {
  // 지금의 배포 브랜치는 main 이므로 그걸 지워 본다 — 파서가 부재를 보고해야
  // 커버리지 가드가 실제로 FAIL 할 수 있다.
  const stripped = fs.readFileSync(CI_YML, 'utf8').replace('      - main\n', '');
  const branches = pushBranches(stripped);
  assert.notEqual(branches, null, '브랜치 목록이 여전히 파싱돼야 한다');
  assert.ok(
    !branches.includes('main'),
    '제거했는데도 파서가 main 을 보고한다 — 가드가 절대 FAIL 하지 않는다',
  );
  assert.ok(branches.includes('production.private'), '나머지 항목은 그대로 읽혀야 한다');
});

// 가드의 **불변식 자체** — "배포되는 브랜치는 전부 ci.yml push 트리거 안에 있다".
// 파서만 단언하면 목록 쪽 드리프트를 놓친다: 배포 대상이 바뀌었는데 트리거를 따라
// 고치지 않으면 그 브랜치에선 dependency-audit 이 안 돈다(2026-08-20 이 정확히 그
// 상태였다). 반대 방향의 드리프트 — 목록이 **사라진 브랜치**를 가리켜 정기 감사가
// fetch 실패로 fail-closed 되는 것 — 은 ticket 128d62cd 에서 13일간 실제로 일어났다.
test('deployBranches() 의 모든 배포 대상이 ci.yml push 트리거 안에 있다', () => {
  const ciBranches = pushBranches(fs.readFileSync(CI_YML, 'utf8'));
  assert.notEqual(ciBranches, null, 'ci.yml 의 push branches 를 파싱하지 못했다');
  for (const branch of deployBranches()) {
    assert.ok(
      ciBranches.includes(branch),
      `배포 대상 ${branch} 가 ci.yml push 트리거에 없다 — 그 브랜치에선 dependency-audit 이 돌지 않는다: ${JSON.stringify(ciBranches)}`,
    );
  }
});

test('주석·빈 줄이 섞여도 리스트 항목만 뽑는다', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches:',
    '      # 배포 브랜치 — 아래 주석 참조',
    '      - main',
    '',
    '      - production.private',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.deepEqual(pushBranches(yaml), ['main', 'production.private']);
});

test('branches 필터가 없으면 null — 전 브랜치 커버로 해석된다', () => {
  const yaml = ['name: CI', '', 'on:', '  push:', '  workflow_dispatch:', '', 'jobs:'].join('\n');
  assert.equal(pushBranches(yaml), null);
});

test('push 트리거 자체가 없으면 null', () => {
  const yaml = ['name: CI', '', 'on:', '  pull_request:', '', 'jobs:'].join('\n');
  assert.equal(pushBranches(yaml), null);
});

test('다른 트리거의 branches 를 push 것으로 오인하지 않는다', () => {
  const yaml = [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '    branches:',
    '      - never-deployed',
    '  push:',
    '    branches:',
    '      - main',
    '',
    'jobs:',
  ].join('\n');
  assert.deepEqual(pushBranches(yaml), ['main']);
});

// Regression guard — 2026-08-21 의존성 감사.
//
// scripts/audit-cron-coverage.mjs 는 "의존성 감사가 **시간축으로도** 도는가" 를
// 검사한다. 그 감사에서 발견된 구멍이 원인: ci.yml 트리거가 전부 이벤트 구동
// (push/PR/dispatch)이라, 의존성을 건드리지 않는 기간에는 새로 나온 advisory 를
// 아무도 평가하지 않았다. `npm audit` 의 판정 대상은 "lockfile 변경" 이 아니라
// "그 버전에 대한 advisory" 이고, 후자는 우리 커밋과 무관하게 늘어난다.
//
// 이 파일이 지키는 것은 **가드 스크립트 자신의 파서**다 — ci-branch-coverage-guard
// 와 같은 이유다. 파서가 조용히 망가지면 가장 위험한 실패 모드가 나온다:
//   - scheduleCrons() 가 cron 을 못 읽으면 → 가드는 "schedule 없음" 으로 FAIL 하니
//     그나마 시끄럽게 죽는다.
//   - jobConditions() 가 잡을 하나도 못 읽으면 → 검사할 대상이 없어 **조용히
//     통과**한다. 그래서 main() 에 "잡 0개면 FAIL" 을 두고, 여기서 파서가 실제
//     ci.yml 의 잡들을 읽어내는지 직접 단언한다.
//
// 앱 부팅도 서브프로세스도 없다 — 순수 문자열 파싱이라 매 `npm test` 에 싸다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CRON_ONLY_JOBS,
  jobConditions,
  scheduleCrons,
  skipsSchedule,
} from '../../../scripts/audit-cron-coverage.mjs';
import { deployBranches } from '../../../scripts/audit-ci-branch-coverage.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const readCi = () => fs.readFileSync(CI_YML, 'utf8');

test('실제 ci.yml 에 schedule cron 이 살아 있다', () => {
  const crons = scheduleCrons(readCi());
  assert.ok(
    crons.length > 0,
    'ci.yml 에서 cron 을 읽지 못했다 — 정기 재감사가 사라졌거나 파서가 깨졌다',
  );
  for (const c of crons) {
    assert.match(c, /^\S+ \S+ \S+ \S+ \S+$/, `cron 식 형태가 아니다: ${JSON.stringify(c)}`);
  }
});

test('schedule 트리거를 지우면 파서가 그 부재를 드러낸다 (가드가 FAIL 할 수 있어야 한다)', () => {
  const stripped = readCi().replace(/^\s{2}schedule:\n\s{4}- cron:.*\n/m, '');
  assert.deepEqual(
    scheduleCrons(stripped),
    [],
    '제거했는데도 파서가 cron 을 보고한다 — 가드가 절대 FAIL 하지 않는다',
  );
});

test('실제 ci.yml 의 잡을 전부 읽어내고, dependency-audit 외에는 schedule 을 스킵한다', () => {
  const conditions = jobConditions(readCi());
  const names = Object.keys(conditions);

  assert.ok(
    names.length > 1,
    `잡을 ${names.length}개만 읽었다 — 파서가 깨지면 가드가 검사 대상 없이 침묵 통과한다`,
  );
  assert.ok(names.includes('dependency-audit'), `dependency-audit 잡을 못 읽었다: ${names}`);

  for (const name of names) {
    if (CRON_ONLY_JOBS.includes(name)) continue;
    assert.ok(
      skipsSchedule(conditions[name]),
      `잡 ${name} 이 schedule 을 스킵하지 않는다 — cron 이 매일 이 잡을 태운다: ${conditions[name]}`,
    );
  }
});

test('skipsSchedule 은 조건이 없거나 다른 조건만 있으면 false 다', () => {
  assert.equal(skipsSchedule(null), false);
  assert.equal(skipsSchedule("github.ref != 'refs/heads/production.private'"), false);
  assert.equal(
    skipsSchedule("github.ref != 'refs/heads/production.private' && github.event_name != 'schedule'"),
    true,
  );
});

test('주석·빈 줄이 섞여도 잡 이름과 if: 만 뽑는다', () => {
  const yaml = [
    'name: CI',
    'on:',
    '  push:',
    'jobs:',
    '  # 감사 잡 — cron 에서 의도적으로 돈다',
    '  dependency-audit:',
    '    name: dependency audit',
    '    runs-on: ubuntu-latest',
    '',
    '  # 무거운 잡',
    '  heavy:',
    "    if: github.event_name != 'schedule'",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo hi',
    '',
    'permissions:',
    '  contents: read',
  ].join('\n');

  const conditions = jobConditions(yaml);
  assert.deepEqual(Object.keys(conditions), ['dependency-audit', 'heavy']);
  assert.equal(conditions['dependency-audit'], null);
  assert.equal(skipsSchedule(conditions.heavy), true);
});

// scripts/audit-deploy-branch-deps.mjs 는 이 export 로 "어떤 브랜치를 추가 감사할지"
// 를 정한다. 두 가드가 같은 목록을 봐야 "배포되는 곳은 전부 감사한다" 는 불변식이
// 갈라지지 않는다 — export 가 사라지면 그 스크립트는 import 단계에서 죽는다.
test('deployBranches() 가 배포 브랜치를 돌려준다 (deploy-branch 감사의 입력)', () => {
  const branches = deployBranches();
  assert.ok(Array.isArray(branches) && branches.length > 0, '배포 브랜치 목록이 비었다');
  assert.ok(
    branches.includes('production.private'),
    `배포 브랜치에 production.private 이 없다: ${JSON.stringify(branches)}`,
  );
});

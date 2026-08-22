// Regression guard — 2026-08-22 의존성 감사.
//
// scripts/audit-published-deps.mjs 는 "호스트에 실제로 깔리는 트리" 를 감사한다.
// 그 감사에서 닫은 구멍이 원인: 이 저장소의 모든 의존성 게이트는 package-lock.json
// 을 보는데, agent-manager 는 라이브 호스트에 `npm i -g awb-agent-manager` 로 깔리고
// 그 경로는 우리 lockfile 을 읽지 않는다 — npm 이 그 시점 레지스트리에서 `^` 범위를
// 새로 해석한다. 2026-08-22 실측에서 그 차이가 10개 패키지였다(`type-is` 는 lockfile
// 1.6.18 / 실제 해석 2.1.0 으로 메이저까지 갈렸다). 즉 lockfile 이 가리키지 않는
// 버전에 advisory 가 붙으면 **CI 는 계속 초록인데 호스트는 취약하다.**
//
// 이 파일이 지키는 것은 **가드 스크립트 자신의 판정 로직**이다 — cron-coverage-guard /
// ci-branch-coverage-guard 와 같은 이유다. 실패 모드가 비대칭이기 때문이다:
//   - 네트워크 층(resolveAndAudit)이 깨지면 → throw 하고 fail-closed 로 죽는다.
//     시끄러우니 누군가 본다.
//   - **범위 판정 층(rangeProblem)이 느슨해지면 → 조용히 전부 통과한다.** `*` 를
//     상한 있음으로 잘못 읽어도 CI 는 초록이고, 그때 이 가드는 존재하지만 아무것도
//     막지 않는 상태가 된다. 그래서 여기서 양성/음성 케이스를 직접 못박는다.
//     (같은 이유로 main() 에도 "런타임 의존성 0개면 FAIL" 을 뒀다 — 파서가 매니페스트
//      구조 변경으로 아무것도 못 읽어도 검사 대상 0개는 통과로 보이기 때문이다.)
//
// 네트워크를 타지 않는다 — 순수 문자열/객체 판정만 단언하므로 매 `npm test` 에 싸다.
// 실제 레지스트리 해석·audit 은 ci.yml 의 schedule 전용 스텝이 담당한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLISHED_MANIFEST,
  clauseHasUpperBound,
  declaredRanges,
  driftRows,
  lockfileVersions,
  publishedManifest,
  rangeProblem,
  unboundedRanges,
} from '../../../scripts/audit-published-deps.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('상한이 있는 범위는 통과시킨다 (거짓 양성 없음)', () => {
  const bounded = [
    '^1.2.3',
    '~1.2.3',
    '1.2.3',
    '=1.2.3',
    '1.x',
    '1',
    '1.2',
    '>=1.0.0 <2.0.0',
    '1.0.0 - 2.0.0',
    '^1.0.0 || ^2.0.0',
  ];
  for (const r of bounded) {
    assert.equal(rangeProblem(r), null, `${r} 는 상한이 있는데 문제로 판정됐다`);
  }
});

test('상한 없는 범위를 잡는다 — 이 가드가 느슨해지면 조용히 전부 통과한다', () => {
  // `>=`/`>` 단독, 와일드카드, 빈 문자열, latest — 전부 미래의 임의 메이저를 끌어온다.
  for (const r of ['*', 'x', 'X', '', '   ', 'latest', '>=1.0.0', '>1.0.0']) {
    assert.notEqual(rangeProblem(r), null, `${JSON.stringify(r)} 는 상한이 없는데 통과했다`);
  }
});

test('`||` 로 이어진 절 중 하나만 열려 있어도 잡는다', () => {
  // 열린 절 하나면 그 절을 통해 임의 버전이 들어온다 — 다른 절이 닫혀 있어도 소용없다.
  assert.notEqual(rangeProblem('^1.0.0 || >=3'), null);
  assert.equal(rangeProblem('^1.0.0 || ^2.0.0 || ~3.1.0'), null);
});

test('비-레지스트리 스펙을 잡는다 (integrity·감사 대상 밖)', () => {
  for (const r of [
    'github:foo/bar',
    'git+https://example.test/x.git',
    'git://example.test/x.git',
    'https://example.test/x.tgz',
    'http://example.test/x.tgz',
    'file:../local',
    'link:../local',
  ]) {
    assert.notEqual(rangeProblem(r), null, `${r} 는 레지스트리 밖인데 통과했다`);
  }
});

test('clauseHasUpperBound — 하한 단독은 상한으로 세지 않는다', () => {
  assert.equal(clauseHasUpperBound('>=1.0.0'), false);
  assert.equal(clauseHasUpperBound('>1.0.0'), false);
  assert.equal(clauseHasUpperBound('*'), false);
  assert.equal(clauseHasUpperBound(''), false);
  assert.equal(clauseHasUpperBound('>=1.0.0 <2.0.0'), true);
  assert.equal(clauseHasUpperBound('^1.0.0'), true);
  assert.equal(clauseHasUpperBound('1.0.0 - 2.0.0'), true);
});

test('unboundedRanges 는 문제 있는 항목만 이유와 함께 돌려준다', () => {
  const bad = unboundedRanges({ good: '^1.0.0', open: '>=2', wild: '*' });
  assert.deepEqual(
    bad.map((b) => b.name).sort(),
    ['open', 'wild'],
    'good 이 섞여 들어왔거나 open/wild 를 놓쳤다',
  );
  for (const b of bad) assert.ok(b.reason && b.reason.length > 0, '이유 문자열이 비어 있다');
});

test('lockfileVersions 는 node_modules 경로에서 이름→버전을 뽑는다', () => {
  const versions = lockfileVersions({
    packages: {
      '': { name: 'root' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/@scope/b': { version: '2.0.0' },
      // 중첩 설치 — 마지막 node_modules/ 뒤가 패키지 이름이다.
      'node_modules/a/node_modules/c': { version: '3.0.0' },
      // 워크스페이스 심링크는 실제 설치본이 아니라 버전 축에서 제외한다.
      'node_modules/ws': { link: true, resolved: 'apps/ws' },
      'apps/ws': { name: 'ws', version: '9.9.9' },
    },
  });
  assert.equal(versions.get('a'), '1.0.0');
  assert.equal(versions.get('@scope/b'), '2.0.0');
  assert.equal(versions.get('c'), '3.0.0');
  assert.equal(versions.get('ws'), undefined);
});

test('driftRows 는 양쪽에 다 있고 버전이 갈린 것만 보고한다', () => {
  const lock = new Map([
    ['same', '1.0.0'],
    ['drifted', '1.0.0'],
    ['lock-only', '1.0.0'],
  ]);
  const resolved = new Map([
    ['same', '1.0.0'],
    ['drifted', '1.2.0'],
    ['resolved-only', '5.0.0'],
  ]);
  assert.deepEqual(driftRows(lock, resolved), [
    { name: 'drifted', lock: '1.0.0', resolved: '1.2.0' },
  ]);
});

test('실제 발행 매니페스트의 선언 범위가 전부 상한을 갖는다', () => {
  // 위 단위 케이스가 아니라 **저장소의 현재 상태** 를 단언한다. 누군가 범위를
  // 넓히면(`^1.7.0` → `*`) 여기서 즉시 red — cron 을 24시간 기다리지 않는다.
  const ranges = declaredRanges(publishedManifest(path.join(REPO_ROOT, PUBLISHED_MANIFEST)));
  const names = Object.keys(ranges);
  assert.ok(
    names.length > 0,
    `${PUBLISHED_MANIFEST} 에서 런타임 의존성을 하나도 읽지 못했다 — ` +
      '검사 대상 0개는 통과가 아니라 파서/매니페스트 구조 문제다',
  );
  assert.deepEqual(
    unboundedRanges(ranges).map((b) => `${b.name}: ${b.reason}`),
    [],
    '발행 패키지가 상한 없는 범위를 선언하고 있다 — 호스트가 임의 상위 메이저를 받게 된다',
  );
});

test('가드 스크립트가 ci.yml dependency-audit 잡에 실제로 배선돼 있다', () => {
  // 스크립트만 있고 호출부가 없으면 이 가드 전체가 장식이 된다 — 그 상태도 CI 는
  // 초록이라 아무도 모른다(2026-08-21 감사가 cron 커버리지에서 잡은 것과 같은 침묵형).
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(
    ci,
    /node scripts\/audit-published-deps\.mjs --offline/,
    'ci.yml 에 오프라인(항상 도는) 발행 범위 가드 스텝이 없다',
  );
  assert.match(
    ci,
    /node scripts\/audit-published-deps\.mjs\s*$/m,
    'ci.yml 에 전체(레지스트리 해석) 발행 트리 감사 스텝이 없다',
  );
});

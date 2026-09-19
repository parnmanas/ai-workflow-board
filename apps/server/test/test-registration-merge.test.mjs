// 테스트 등록이 병합에서 살아남는지 보는 회귀 — 티켓 5dc241d8.
//
// 원래 증상: 실행 목록이 apps/server/package.json 의 `scripts.test` **한 줄**
// (1만 자대)에 통째로 들어 있어서, 서로 아무 상관 없는 테스트 파일을 각자
// 브랜치에서 하나씩 추가해도 양쪽이 같은 줄을 고치게 됐다. git 은 줄 단위로
// 병합하므로 이건 100% 충돌이고, 그때마다 손으로 union 하고 JSON 을 다시
// 파싱해 중복·누락을 재검증해야 했다. 실제로 이 티켓의 소스 작업에서
// 프로비저닝 리베이스가 그 줄 때문에 실패했다.
//
// 그래서 등록을 test/suites/*.txt 의 줄 단위 매니페스트로 옮겼다. 이 파일은
// 그 이관이 실제로 증상을 없앴는지를 **진짜 git 저장소에서 진짜 병합을 돌려**
// 확인한다. 두 방향을 같이 본다:
//   1. 새 구조 — 독립적인 추가 둘이 손실 없이 합쳐진다.
//   2. 옛 구조 — 똑같은 추가 둘이 합쳐지지 않는다(대조군). 이게 있어야 1번이
//      "원래부터 괜찮았던 것"이 아니라 이 변경의 효과임이 드러난다.
//
// 단언은 exit code 나 git 의 오류 문구가 아니라 **결과 파일의 내용**으로 한다 —
// 그쪽이 git 버전에 흔들리지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSuiteManifest } from './helpers/suite-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_TEST_MANIFEST = path.join(__dirname, 'suites', 'test.txt');

// 실제로 추가될 법한 이름 두 개. 정렬했을 때 사이에 기존 항목이 여럿 끼는
// 위치라야 현실적인 사례가 된다 (바로 옆자리끼리면 3-way 병합이 같은 자리에
// 양쪽 삽입을 보게 되고, 그건 아래 '한계' 테스트가 따로 다룬다).
const BRANCH_A_TEST = 'test/chat-room-rename-boundary.test.mjs';
const BRANCH_B_TEST = 'test/orchestration-graph-patch-guard.test.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// 충돌은 0 이 아닌 종료 코드로 나오므로 던지는 걸 삼킨다. 코드 값 자체는
// 단언하지 않는다 — 판정은 호출한 쪽이 파일 내용으로 한다.
function gitAllowFailure(cwd, ...args) {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-5dc241d8-merge-'));
  // Windows 에서는 방금 끝난 git 이 .git 안의 핸들을 놓기 전이라 첫 rm 이 EBUSY 로
  // 튈 수 있다. 재시도를 주면 정리 실패가 테스트 실패로 둔갑하지 않는다.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  git(dir, 'init', '-q');
  // CI 러너에는 전역 git 신원이 없다. 없으면 commit 이 그대로 죽는다.
  git(dir, 'config', 'user.email', 'suite-merge-test@example.invalid');
  git(dir, 'config', 'user.name', 'AWB suite merge test');
  return dir;
}

// 매니페스트의 정렬 규약대로 한 줄을 제자리에 끼워 넣는다. 머리말 주석과
// 뒤쪽 `npm run` 위임은 건드리지 않는다.
function insertSorted(manifestText, newPath) {
  const lines = manifestText.split('\n');
  const isPath = (l) => l.trim().startsWith('test/');
  const firstPath = lines.findIndex(isPath);
  assert.ok(firstPath !== -1, '매니페스트에 경로 줄이 하나도 없다');

  let at = lines.findIndex((l, i) => i >= firstPath && isPath(l) && l.trim() > newPath);
  if (at === -1) {
    // 마지막 경로 줄 바로 뒤 (위임 줄 앞) 에 넣는다.
    let lastPath = firstPath;
    for (let i = firstPath; i < lines.length; i++) if (isPath(lines[i])) lastPath = i;
    at = lastPath + 1;
  }
  return [...lines.slice(0, at), newPath, ...lines.slice(at)].join('\n');
}

// base 커밋 하나 위에 두 브랜치를 만들고 각자 한 번씩 등록을 추가한 뒤 합친다.
// mutate 는 브랜치별로 "그 브랜치가 테스트를 추가했을 때의 파일 내용" 을 만든다.
function mergeTwoIndependentAdditions(t, { file, baseContent, mutate }) {
  const dir = makeRepo(t);
  const target = path.join(dir, file);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, baseContent);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();

  git(dir, 'checkout', '-q', '-b', 'branch-a', base);
  fs.writeFileSync(target, mutate(baseContent, BRANCH_A_TEST));
  git(dir, 'commit', '-q', '-am', 'branch-a: 테스트 추가');

  git(dir, 'checkout', '-q', '-b', 'branch-b', base);
  fs.writeFileSync(target, mutate(baseContent, BRANCH_B_TEST));
  git(dir, 'commit', '-q', '-am', 'branch-b: 테스트 추가');

  git(dir, 'checkout', '-q', 'branch-a');
  gitAllowFailure(dir, 'merge', '--no-edit', 'branch-b');

  return {
    dir,
    merged: fs.readFileSync(target, 'utf8'),
    unmerged: git(dir, 'ls-files', '-u', '--', file).trim(),
  };
}

test('새 구조: 독립 브랜치 둘이 추가한 등록이 손실 없이 합쳐진다', (t) => {
  const baseContent = fs.readFileSync(REAL_TEST_MANIFEST, 'utf8');
  const baseSteps = parseSuiteManifest(baseContent);

  const { merged, unmerged } = mergeTwoIndependentAdditions(t, {
    file: 'suites/test.txt',
    baseContent,
    mutate: insertSorted,
  });

  assert.equal(unmerged, '', `매니페스트가 충돌했다 — git ls-files -u:\n${unmerged}`);
  assert.ok(!merged.includes('<<<<<<<'), '병합 결과에 충돌 마커가 남았다');

  const mergedSteps = parseSuiteManifest(merged);
  assert.ok(mergedSteps.includes(BRANCH_A_TEST), `branch-a 의 등록이 사라졌다: ${BRANCH_A_TEST}`);
  assert.ok(mergedSteps.includes(BRANCH_B_TEST), `branch-b 의 등록이 사라졌다: ${BRANCH_B_TEST}`);

  // 손실도 중복도 없다 — 정확히 두 줄만 늘어야 한다.
  assert.equal(mergedSteps.length, baseSteps.length + 2, '합친 뒤 step 수가 base + 2 가 아니다');
  assert.equal(new Set(mergedSteps).size, mergedSteps.length, '합친 매니페스트에 중복 step 이 있다');
  for (const step of baseSteps) {
    assert.ok(mergedSteps.includes(step), `기존 등록이 병합에서 날아갔다: ${step}`);
  }
});

test('대조군 — 옛 단일 라인 구조였다면 같은 추가 둘이 합쳐지지 않는다', (t) => {
  // 이관 전 모양 그대로: 실행 목록 전체가 package.json 의 한 줄 안에 있다.
  const paths = parseSuiteManifest(fs.readFileSync(REAL_TEST_MANIFEST, 'utf8'))
    .filter((s) => s.startsWith('test/'));
  const singleLine = (list) => JSON.stringify(
    { scripts: { test: `node test/run-suite.mjs ${list.join(' ')}` } },
    null,
    2,
  ) + '\n';

  const { merged, unmerged } = mergeTwoIndependentAdditions(t, {
    file: 'package.json',
    baseContent: singleLine(paths),
    mutate: (_base, added) => singleLine([...paths, added]),
  });

  // 이게 이 티켓이 없애려던 상태다. 하나라도 성립하면 대조군이 성립한다.
  const conflicted = unmerged !== '' || merged.includes('<<<<<<<');
  assert.ok(
    conflicted,
    '옛 단일 라인 구조가 충돌 없이 합쳐졌다 — 대조군이 성립하지 않으므로 이 회귀 테스트가 '
      + '무엇을 지키는지 알 수 없다. 재현 조건을 다시 봐야 한다',
  );
});

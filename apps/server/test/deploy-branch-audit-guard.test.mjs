// Regression guard — 2026-09-17 의존성 감사.
//
// scripts/audit-deploy-branch-deps.mjs 는 **배포돼 실제로 돌고 있는 트리**의
// lockfile 을 cron 에서 따로 감사한다. 그 게이트는 fail-closed 다: 확인하지 못하면
// 통과시키지 않는다. 그 성질 자체는 옳은데, 2026-09-16 에 배포 브랜치
// production.private 이 원격에서 삭제되면서 약점이 드러났다 — 게이트가 그냥
// "fetch 실패" 로만 보고해서, **일시적 네트워크 오류**와 **배포 브랜치가 통째로
// 사라져 앞으로 영원히 감사 불가**가 완전히 같은 문장으로 나왔다. 앞의 것은
// 재시도하면 되지만 뒤의 것은 "마지막 배포 이미지가 계속 서비스되면서 감사
// 대상에서만 빠진" 상태라 대응이 전혀 다르다. 재시도로 오해하면 그대로 묻힌다.
//
// 그래서 이 파일이 지키는 것은 두 가지다:
//   1) remoteBranchExists 가 '있음/없음/모름' 세 상태를 실제로 구분한다(동작 테스트).
//   2) 원인을 구분하게 된 뒤에도 판정은 여전히 **양쪽 다 FAIL** 이다(계약 테스트).
//      여기서 '없음'을 통과로 바꾸면 배포 트리 감사 축이 조용히 사라진다.
//
// 네트워크를 타지 않는다 — 임시 로컬 bare 저장소를 origin 으로 써서 검사한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { remoteBranchExists } from '../../../scripts/audit-deploy-branch-deps.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/audit-deploy-branch-deps.mjs');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

/** origin 이 붙은 임시 작업 저장소를 만든다. 반환: { work, cleanup }. */
function makeRepoWithOrigin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-deploy-branch-guard-'));
  const bare = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  git(['init', '--bare', '--initial-branch=main', bare], tmp);
  git(['init', '--initial-branch=main', work], tmp);
  git(['config', 'user.email', 'guard@example.invalid'], work);
  git(['config', 'user.name', 'guard'], work);
  git(['remote', 'add', 'origin', bare], work);
  fs.writeFileSync(path.join(work, 'f.txt'), 'x\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['push', 'origin', 'main'], work);
  return { work, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('원격에 있는 브랜치는 true', () => {
  const { work, cleanup } = makeRepoWithOrigin();
  try {
    assert.equal(remoteBranchExists('main', work), true);
  } finally {
    cleanup();
  }
});

test('원격에서 삭제된 브랜치는 false — fetch 실패와 구분되는 신호다', () => {
  const { work, cleanup } = makeRepoWithOrigin();
  try {
    git(['push', 'origin', 'main:production.private'], work);
    assert.equal(remoteBranchExists('production.private', work), true);

    git(['push', 'origin', '--delete', 'production.private'], work);
    assert.equal(
      remoteBranchExists('production.private', work),
      false,
      '삭제된 배포 브랜치를 false 로 보고하지 못하면 "일시적 fetch 실패" 로 묻힌다',
    );
  } finally {
    cleanup();
  }
});

test('원격 조회 자체가 실패하면 null — 없음(false) 으로 단정하지 않는다', () => {
  const { work, cleanup } = makeRepoWithOrigin();
  try {
    git(['remote', 'set-url', 'origin', path.join(work, 'does-not-exist.git')], work);
    assert.equal(
      remoteBranchExists('main', work),
      null,
      '조회 실패를 null 이 아닌 값으로 돌려주면 "존재 여부 모름" 이 "삭제됨" 으로 둔갑한다',
    );
  } finally {
    cleanup();
  }
});

test('브랜치가 없어도 게이트는 여전히 FAIL 이다 (fail-closed 유지)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // '원격에 없다' 분기가 failures 에 쌓고 continue 하는지 — 즉 통과 경로가 아닌지.
  const missingBranch = src.slice(src.indexOf('exists === false'));
  assert.ok(
    missingBranch.includes('failures.push('),
    '원격에 없는 배포 브랜치를 failures 에 넣지 않는다 — 게이트가 조용히 통과한다',
  );

  // failures 가 있으면 exit 1. 이 줄이 사라지면 fail-closed 가 아니다.
  assert.match(
    src,
    /failures\.length > 0[\s\S]*process\.exit\(1\)/,
    'failures 가 있는데 exit 1 하지 않는다 — fail-closed 계약이 깨졌다',
  );
});

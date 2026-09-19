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
//   3) (2026-09-20 추가) 브랜치가 없으면 **마지막으로 배포된 sha** 를 찾아 그
//      트리를 대신 감사한다. 브랜치 상태와 배포 상태는 다른 축이고, 보안 판정에서는
//      배포 쪽이 이긴다 — 브랜치가 지워져도 마지막 배포 이미지는 계속 돌기 때문이다.
//      이 폴백은 **진단만** 채워야 하고 통과 경로를 만들면 안 된다. 조회가 실패해도
//      던지지 않고 null 로 떨어져야 판정이 흔들리지 않는다.
//
// 네트워크를 타지 않는다 — 임시 로컬 bare 저장소를 origin 으로, GitHub API 는
// 주입한 fetch 스텁으로 검사한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  remoteBranchExists,
  repoSlugFromRemote,
  lastDeployedSha,
} from '../../../scripts/audit-deploy-branch-deps.mjs';

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

// ---------------------------------------------------------------------------
// 배포 sha 폴백 (2026-09-20)
// ---------------------------------------------------------------------------

test('repoSlugFromRemote — ssh/https/.git 형태를 모두 owner/repo 로 푼다', () => {
  const { work, cleanup } = makeRepoWithOrigin();
  try {
    const cases = [
      ['git@github.com:parnmanas/ai-workflow-board.git', 'parnmanas/ai-workflow-board'],
      ['https://github.com/parnmanas/ai-workflow-board.git', 'parnmanas/ai-workflow-board'],
      ['https://github.com/parnmanas/ai-workflow-board', 'parnmanas/ai-workflow-board'],
      ['ssh://git@github.com/parnmanas/ai-workflow-board.git', 'parnmanas/ai-workflow-board'],
    ];
    for (const [url, want] of cases) {
      git(['remote', 'set-url', 'origin', url], work);
      assert.equal(repoSlugFromRemote(work), want, `${url} 를 잘못 파싱한다`);
    }

    // github 이 아니면 null — 엉뚱한 호스트로 토큰을 보내지 않는다.
    git(['remote', 'set-url', 'origin', 'https://gitlab.com/o/r.git'], work);
    assert.equal(repoSlugFromRemote(work), null, 'github.com 이 아닌 리모트를 슬러그로 만들면 안 된다');
  } finally {
    cleanup();
  }
});

test('lastDeployedSha — deploy 워크플로의 마지막 성공 실행에서 sha 를 읽는다', async () => {
  let seenUrl = null;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return {
      ok: true,
      json: async () => ({
        workflow_runs: [
          { id: 33963883830, head_sha: '0ddec72f699ebee87d8c0a4af51bcc469f17479d', created_at: '2026-09-05T11:38:38Z' },
        ],
      }),
    };
  };

  const got = await lastDeployedSha({ slug: 'o/r', token: 't', fetchImpl });
  assert.equal(got.sha, '0ddec72f699ebee87d8c0a4af51bcc469f17479d');
  assert.equal(got.createdAt, '2026-09-05T11:38:38Z');
  assert.match(seenUrl, /workflows\/deploy\.yml\/runs/, 'deploy 워크플로 이력을 조회하지 않는다');
  assert.match(seenUrl, /status=success/, '성공한 배포만 봐야 한다 — 실패한 실행은 배포되지 않았다');
});

test('lastDeployedSha — 조회가 어떤 식으로 실패하든 throw 하지 않고 null 이다', async () => {
  // 폴백이 예외를 던지면 게이트 본체가 죽어 FAIL 판정 문장 자체가 사라진다.
  const boom = async () => {
    throw new Error('network down');
  };
  assert.equal(await lastDeployedSha({ slug: 'o/r', token: 't', fetchImpl: boom }), null);

  const notOk = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await lastDeployedSha({ slug: 'o/r', token: 't', fetchImpl: notOk }), null);

  const badJson = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  assert.equal(await lastDeployedSha({ slug: 'o/r', token: 't', fetchImpl: badJson }), null);

  const empty = async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) });
  assert.equal(await lastDeployedSha({ slug: 'o/r', token: 't', fetchImpl: empty }), null);

  // 토큰이 없으면 아예 나가지 않는다.
  let called = false;
  const spy = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.equal(await lastDeployedSha({ slug: 'o/r', token: null, fetchImpl: spy }), null);
  assert.equal(called, false, '토큰 없이 API 를 때리면 안 된다');
});

test('배포 sha 폴백은 진단만 채운다 — FAIL 판정을 완화하지 않는다', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // 브랜치 없음 분기가 폴백을 부르되, 그 결과와 무관하게 failures 에 쌓아야 한다.
  const branchGone = src.slice(src.indexOf('exists === false'));
  const upToContinue = branchGone.slice(0, branchGone.indexOf('continue;'));
  assert.ok(
    upToContinue.includes('auditLastDeployedTree('),
    '브랜치가 사라졌을 때 마지막 배포 트리를 감사하지 않는다 — 배포된 트리의 취약점이 아무 데도 안 뜬다',
  );
  assert.ok(
    upToContinue.includes('failures.push('),
    '폴백 결과에 따라 failures 를 건너뛰면 배포 트리 감사 축이 통과로 둔갑한다',
  );

  // 폴백 안에서 0건이 나와도 그건 '통과' 가 아니다 — 문장만 바뀌고 판정은 호출부가 쥔다.
  assert.ok(
    !/auditLastDeployedTree[\s\S]*?process\.exit\(0\)/.test(src),
    '폴백이 스스로 성공 종료하면 안 된다',
  );
});

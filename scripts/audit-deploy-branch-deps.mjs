#!/usr/bin/env node
/**
 * audit-deploy-branch-deps.mjs
 *
 * 정기(cron) 감사에서 **배포 브랜치의 lockfile 도** 훑는다.
 *
 * 왜 필요한가(2026-08-21 의존성 감사에서 발견): GitHub 의 `schedule` 트리거는
 * **기본 브랜치에서만** 돈다. 그래서 ci.yml 에 cron 을 달아도 매일 감사되는 건
 * main 의 lockfile 뿐이다. 실제로 NAS 에 배포되는 브랜치는 `production.private`
 * 이고, 그쪽은 **push 될 때만** dependency-audit 이 돈다(2026-08-20 감사에서 push
 * 트리거를 추가해 그렇게 됐다). 즉 배포 브랜치가 몇 주 그대로 떠 있으면, 그 기간에
 * 새로 나온 advisory 는 배포된 트리에 대해 한 번도 평가되지 않는다 — 정작 돌고 있는
 * 코드가 그쪽인데.
 *
 * 이 스크립트가 그 구멍을 메운다: 배포 브랜치의 package-lock.json 만 꺼내 그대로
 * 감사한다.
 *
 * 세 가지 설계 선택:
 *   - **`npm ci` 를 하지 않는다.** lockfile 만 있으면 audit 은 돈다. 설치를 생략하면
 *     "취약점을 찾는 잡이 그 취약점의 install script 를 먼저 실행하는" 순서 문제가
 *     사라진다(ci.yml dependency-audit 과 같은 원칙).
 *   - **`npm audit` 을 쓰지 않는다** (ticket 1019e57d). CI 의 npm 은 bulk advisory
 *     엔드포인트가 흔들리면 은퇴 대상인 quick 엔드포인트로 폴백하는데, 그쪽은 이
 *     저장소의 workspaces lockfile 에 400 을 돌려준다 — 폴백이 성공할 수 있는 경우가
 *     없다. audit-lockfile-advisories.mjs 가 bulk 를 직접, 재시도와 함께 조회한다.
 *     그래서 임시 디렉터리도 더 이상 필요 없다 — lockfile 을 파싱해 넘기면 끝이다.
 *   - **lockfile 이 로컬과 동일하면 건너뛴다.** 같은 바이트면 방금 돈 감사가 이미
 *     그 트리를 판정했다 — 중복 실행이 아니라 '동일함을 증명하고 스킵' 이다.
 *
 * 실패는 fail-closed 다. fetch 가 안 되거나 lockfile 을 못 읽으면 통과시키지 않고
 * 실패시킨다 — "확인 못 했다" 를 "문제 없다" 로 바꿔 읽는 게 이 계열 가드의 가장
 * 위험한 실패 모드다.
 *
 * **배포 브랜치가 삭제된 경우의 폴백(2026-09-20).** 브랜치가 사라져도 배포는
 * 사라지지 않는다 — 배포는 **커밋 sha** 로 식별되고, sha 는 브랜치 삭제 후에도
 * 남는다. 그래서 브랜치가 없을 때 "감사할 대상이 없다" 로 끝내지 않고,
 * deploy 워크플로 실행 이력에서 **마지막으로 실제 배포된 sha** 를 찾아 그 트리의
 * lockfile 을 감사한다. 그러지 않으면 게이트는 "브랜치가 없다" 라는 참이지만 약한
 * 문장만 내놓고, 정작 **지금 돌고 있는 트리에 취약점이 몇 건인지**는 아무도
 * 자동으로 알려주지 않는다(2026-09-19/09-20 감사에서 사람이 손으로 메우던 구멍).
 * 판정은 그대로 FAIL 이다 — 폴백은 진단을 채울 뿐 통과 경로를 만들지 않는다.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { deployBranches } from './audit-ci-branch-coverage.mjs';
import { auditLockfile, formatFindings } from './audit-lockfile-advisories.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_LEVEL = 'moderate';
const DEPLOY_WORKFLOW = 'deploy.yml';

/**
 * 원격에 그 브랜치가 아직 있는지. `true`=있음, `false`=없음(삭제됨),
 * `null`=ls-remote 자체가 실패(네트워크/인증 문제라 존재 여부를 모른다).
 *
 * fetch 실패를 한 덩어리로 보고하면 "일시적 네트워크 오류" 와 "배포 브랜치가
 * 통째로 사라졌다" 가 같은 문장으로 나온다. 후자는 **배포된 트리를 앞으로 영원히
 * 감사할 수 없다**는 뜻이라 대응이 완전히 다른데, 전자로 오해하면 재시도하면
 * 되겠거니 하고 넘기게 된다(2026-09-16 production.private 삭제 때 실제로 그렇게
 * 읽혔다). 그래서 둘을 갈라서 보고한다 — 판정은 양쪽 다 그대로 FAIL 이다.
 */
export function remoteBranchExists(branch, cwd = root) {
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/** 현재 체크아웃된 브랜치명(detached 면 빈 문자열). */
function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** 후보 ref 들을 순서대로 시도해 파일 내용을 꺼낸다. 전부 실패하면 null. */
function showFromRefs(refs, file) {
  for (const ref of refs) {
    try {
      return execFileSync('git', ['show', `${ref}:${file}`], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      /* 다음 ref 시도 */
    }
  }
  return null;
}

/** origin/<branch> 의 파일 내용. 없으면 null. */
function showFromBranch(branch, file) {
  return showFromRefs([`origin/${branch}`, branch, 'FETCH_HEAD'], file);
}

/**
 * origin 리모트에서 `owner/repo` 를 뽑는다. github.com 리모트가 아니면 null.
 * ssh(`git@github.com:o/r.git`), https, 그리고 `.git` 유무를 모두 받는다.
 */
export function repoSlugFromRemote(cwd = root) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** GitHub API 토큰. Actions 에서는 env, 로컬에서는 gh CLI 에서 빌려 온다. */
function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: 'pipe' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * deploy 워크플로가 **마지막으로 성공적으로 배포한 커밋 sha**.
 * 반환 `{ sha, runId, createdAt }`, 확인 불가면 null.
 *
 * 브랜치 상태와 배포 상태는 서로 다른 축이다 — 브랜치가 지워져도 마지막 배포
 * 이미지는 계속 서비스된다. 보안 판정에서는 **배포 쪽이 이긴다**. 조회에 실패하면
 * null 을 돌려줄 뿐 호출부의 FAIL 판정을 바꾸지 않는다(폴백이 판정을 완화하면
 * 이 가드의 존재 이유가 사라진다).
 */
export async function lastDeployedSha({
  cwd = root,
  token = undefined,
  fetchImpl = globalThis.fetch,
  workflow = DEPLOY_WORKFLOW,
  slug = undefined,
} = {}) {
  const repo = slug ?? repoSlugFromRemote(cwd);
  if (!repo || typeof fetchImpl !== 'function') return null;
  const auth = token === undefined ? githubToken() : token;
  if (!auth) return null;

  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}` +
    `/runs?per_page=1&status=success`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${auth}`,
        'user-agent': 'awb-audit-deploy-branch-deps',
      },
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const run = body?.workflow_runs?.[0];
  if (!run?.head_sha) return null;
  return { sha: run.head_sha, runId: run.id ?? null, createdAt: run.created_at ?? null };
}

/**
 * 브랜치가 사라졌을 때의 폴백: 마지막으로 **배포된 sha** 의 lockfile 을 감사한다.
 * 반환은 failures 에 덧붙일 한 줄(확인 실패 시에도 '확인 못 했다' 를 문장으로 남긴다).
 */
async function auditLastDeployedTree() {
  const run = await lastDeployedSha();
  if (!run) {
    console.log(
      `     ↳ 마지막 배포 sha 를 확인하지 못했다 (deploy 워크플로 이력 조회 실패/토큰 없음)` +
        ` — 배포된 트리는 감사되지 않았다.`,
    );
    return `마지막 배포 sha 를 확인하지 못해 배포된 트리는 감사하지 못했다`;
  }

  const short = run.sha.slice(0, 8);
  const when = run.createdAt ? ` (${run.createdAt})` : '';
  console.log(`     ↳ 마지막 배포 sha ${short}${when} — 이 트리를 대신 감사한다.`);

  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', run.sha], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch {
    /* 이미 로컬에 있을 수 있다 — 아래 show 로 판정한다. */
  }

  const lock = showFromRefs([run.sha, 'FETCH_HEAD'], 'package-lock.json');
  if (!lock) {
    console.log(`     ↳ 배포 sha ${short} 의 lockfile 을 읽지 못했다.`);
    return `마지막 배포 sha ${short} 의 lockfile 을 읽지 못해 배포된 트리를 감사하지 못했다`;
  }

  let result;
  try {
    result = await auditLockfile(JSON.parse(lock), { level: AUDIT_LEVEL });
  } catch (e) {
    console.log(`     ↳ 배포 sha ${short} 감사를 완료하지 못했다: ${String(e.message).split('\n')[0]}`);
    return `마지막 배포 sha ${short} 의 취약점 감사를 완료하지 못했다`;
  }

  if (result.findings.length === 0) {
    console.log(`     ↳ 배포 sha ${short} — ${AUDIT_LEVEL} 이상 0건 (패키지 ${result.packageCount}개).`);
    return `마지막 배포 sha ${short} 의 트리는 ${AUDIT_LEVEL} 이상 0건 — 다만 브랜치가 없어 앞으로 자동 감사되지 않는다`;
  }

  console.log(`     ↳ 배포 sha ${short} — ${AUDIT_LEVEL} 이상 취약점 ${result.findings.length}건:`);
  console.log(formatFindings(result.findings));
  return (
    `지금 배포돼 돌고 있는 트리(sha ${short})에 ${AUDIT_LEVEL} 이상 취약점 ` +
    `${result.findings.length}건 — 브랜치가 없어 머지로 고칠 경로도 없다`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function main() {
  const branches = deployBranches();
  const here = currentBranch();
  const failures = [];
  let audited = 0;

  const localLockPath = join(root, 'package-lock.json');
  const localLock = existsSync(localLockPath) ? readFileSync(localLockPath, 'utf8') : null;

  for (const branch of branches) {
    if (branch === here) {
      console.log(`ok   ${branch} — 지금 체크아웃된 브랜치 (메인 취약점 감사가 이미 판정)`);
      continue;
    }

    // shallow fetch 로 그 브랜치 tip 만 가져온다. checkout 이 얕아도(fetch-depth:1)
    // 동작하며, 워킹트리는 건드리지 않는다.
    try {
      execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', branch], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch (e) {
      // fail-closed 는 유지하되 원인을 갈라서 보고한다(remoteBranchExists 주석 참조).
      const exists = remoteBranchExists(branch);
      if (exists === false) {
        console.log(`FAIL ${branch} — 원격에 이 브랜치가 없다 (삭제됐거나 이름이 바뀌었다)`);
        // 브랜치는 없어도 배포된 sha 는 남아 있다 — 거기까지 따라가 감사한다.
        // 판정은 그대로 FAIL 이고, 이 폴백은 진단만 채운다.
        const deployed = await auditLastDeployedTree();
        failures.push(
          `${branch}: 원격에 없다 — 배포 브랜치가 삭제/개명됐다. ` +
            `브랜치가 사라져도 이미 배포된 이미지는 그대로 돌아간다: ` +
            `마지막 배포분이 계속 서비스 중이면서 감사 대상에서만 빠진 상태일 수 있다. ` +
            `${deployed}.`,
        );
        continue;
      }
      const detail = String(e.message).split('\n')[0];
      console.log(`FAIL ${branch} — fetch 실패`);
      failures.push(
        exists === null
          ? `${branch}: git fetch 실패, 원격 조회도 실패해 존재 여부를 확인하지 못했다 (${detail})`
          : `${branch}: 원격에는 있는데 git fetch 실패 (${detail})`,
      );
      continue;
    }

    const lock = showFromBranch(branch, 'package-lock.json');
    // package.json 은 감사에 쓰이지 않지만(lockfile 만 보면 된다) 존재는 확인한다 —
    // 배포 브랜치에 매니페스트가 없다면 그 자체가 신호다.
    const manifest = showFromBranch(branch, 'package.json');
    if (!lock || !manifest) {
      console.log(`FAIL ${branch} — package.json/package-lock.json 을 읽지 못했다`);
      failures.push(`${branch}: lockfile 또는 manifest 를 읽지 못해 감사할 수 없었다`);
      continue;
    }

    if (localLock !== null && lock === localLock) {
      console.log(`ok   ${branch} — lockfile 이 현재 브랜치와 동일 (같은 감사 결과)`);
      continue;
    }

    let result;
    try {
      result = await auditLockfile(JSON.parse(lock), { level: AUDIT_LEVEL });
    } catch (e) {
      // 조회 자체를 못 끝냈다 — fail-closed. 통과로 바꿔 읽지 않는다.
      console.log(`FAIL ${branch} — 취약점 감사를 완료하지 못했다`);
      console.log(String(e.message));
      failures.push(`${branch}: 취약점 감사를 완료하지 못했다 (위 출력 참고)`);
      continue;
    }

    audited += 1;
    if (result.findings.length > 0) {
      console.log(`FAIL ${branch} — ${AUDIT_LEVEL} 이상 취약점 ${result.findings.length}건`);
      console.log(formatFindings(result.findings));
      failures.push(`${branch}: ${AUDIT_LEVEL} 이상 취약점 ${result.findings.length}건 (위 출력 참고)`);
      continue;
    }
    console.log(
      `ok   ${branch} — ${AUDIT_LEVEL} 이상 0건 (패키지 ${result.packageCount}개 검사)`,
    );
  }

  if (failures.length > 0) {
    console.error(
      `\n배포 브랜치 감사 문제 ${failures.length}건:\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        `\n\n이 브랜치들은 실제로 배포돼 돌고 있는 트리다. \`npm audit fix\` 는 금지 —` +
        ` 루트 overrides 를 날린다. main 에서 고친 뒤 배포 브랜치로 머지할 것.` +
        `\n브랜치가 '원격에 없다' 로 나왔다면 머지할 대상 자체가 사라진 것이다 —` +
        ` 배포 파이프라인이 은퇴한 것인지 실수로 지워진 것인지 먼저 확인할 것.` +
        ` 배포 브랜치 목록(scripts/audit-ci-branch-coverage.mjs)에서 그냥 빼면` +
        ` 이 게이트는 초록으로 바뀌지만 배포된 트리는 여전히 감사되지 않는다.`,
    );
    process.exit(1);
  }

  console.log(
    `\n배포 브랜치 ${branches.length}개 확인 — 별도 감사 ${audited}건, 나머지는 현재 트리와 동일.`,
  );
}

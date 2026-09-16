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
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { deployBranches } from './audit-ci-branch-coverage.mjs';
import { auditLockfile, formatFindings } from './audit-lockfile-advisories.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_LEVEL = 'moderate';

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

/** origin/<branch> 의 파일 내용. 없으면 null. */
function showFromBranch(branch, file) {
  for (const ref of [`origin/${branch}`, branch, 'FETCH_HEAD']) {
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
        failures.push(
          `${branch}: 원격에 없다 — 배포 브랜치가 삭제/개명됐다. ` +
            `브랜치가 사라져도 이미 배포된 이미지는 그대로 돌아간다: ` +
            `마지막 배포분이 계속 서비스 중이면서 감사 대상에서만 빠진 상태일 수 있다.`,
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

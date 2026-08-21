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
 * 이 스크립트가 그 구멍을 메운다: 배포 브랜치의 package.json / package-lock.json 만
 * 꺼내 격리된 임시 디렉터리에서 `npm audit` 을 돌린다.
 *
 * 두 가지 설계 선택:
 *   - **`npm ci` 를 하지 않는다.** lockfile 만 있으면 audit 은 돈다. 설치를 생략하면
 *     "취약점을 찾는 잡이 그 취약점의 install script 를 먼저 실행하는" 순서 문제가
 *     사라진다(ci.yml dependency-audit 과 같은 원칙).
 *   - **lockfile 이 로컬과 동일하면 건너뛴다.** 같은 바이트면 방금 돈 감사가 이미
 *     그 트리를 판정했다 — 중복 실행이 아니라 '동일함을 증명하고 스킵' 이다.
 *
 * 실패는 fail-closed 다. fetch 가 안 되거나 lockfile 을 못 읽으면 통과시키지 않고
 * 실패시킨다 — "확인 못 했다" 를 "문제 없다" 로 바꿔 읽는 게 이 계열 가드의 가장
 * 위험한 실패 모드다.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { deployBranches } from './audit-ci-branch-coverage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_LEVEL = 'moderate';

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
if (isMain) main();

function main() {
  const branches = deployBranches();
  const here = currentBranch();
  const failures = [];
  let audited = 0;

  const localLockPath = join(root, 'package-lock.json');
  const localLock = existsSync(localLockPath) ? readFileSync(localLockPath, 'utf8') : null;

  for (const branch of branches) {
    if (branch === here) {
      console.log(`ok   ${branch} — 지금 체크아웃된 브랜치 (메인 npm audit 이 이미 판정)`);
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
      console.log(`FAIL ${branch} — fetch 실패`);
      failures.push(`${branch}: git fetch 실패 (${String(e.message).split('\n')[0]})`);
      continue;
    }

    const lock = showFromBranch(branch, 'package-lock.json');
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

    const dir = mkdtempSync(join(tmpdir(), `awb-audit-${branch.replace(/[^\w.-]/g, '_')}-`));
    try {
      writeFileSync(join(dir, 'package.json'), manifest);
      writeFileSync(join(dir, 'package-lock.json'), lock);
      execFileSync('npm', ['audit', `--audit-level=${AUDIT_LEVEL}`], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      audited += 1;
      console.log(`ok   ${branch} — npm audit 통과 (${AUDIT_LEVEL} 이상 0건)`);
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      console.log(`FAIL ${branch} — npm audit 실패`);
      if (out) console.log(out);
      failures.push(`${branch}: npm audit 에서 ${AUDIT_LEVEL} 이상 취약점 (위 출력 참고)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n배포 브랜치 감사 문제 ${failures.length}건:\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        `\n\n이 브랜치들은 실제로 배포돼 돌고 있는 트리다. \`npm audit fix\` 는 금지 —` +
        ` 루트 overrides 를 날린다. main 에서 고친 뒤 production.private 로 머지할 것.`,
    );
    process.exit(1);
  }

  console.log(
    `\n배포 브랜치 ${branches.length}개 확인 — 별도 감사 ${audited}건, 나머지는 현재 트리와 동일.`,
  );
}

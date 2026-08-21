#!/usr/bin/env node
/**
 * audit-ci-branch-coverage.mjs
 *
 * 공급망 가드 — **배포되는 모든 브랜치**가 `ci.yml` 의 `push:` 트리거에 들어 있어서
 * dependency-audit 잡(취약점 advisory · install script 허용목록 · 액션 SHA 고정)이
 * 실제로 도는지 검사한다.
 *
 * 왜 필요한가(2026-08-20 의존성 감사에서 발견): 이전까지 `ci.yml` 의 push 트리거는
 * `main` 뿐이었다. 그런데 실제로 NAS 에 배포되는 브랜치는 `production.private` 이고,
 * 이 브랜치는 main 을 머지한 뒤 **직접 push** 로 갱신된다 — PR 을 거치지 않으므로
 * `pull_request` 트리거도 걸리지 않는다. 결과적으로 그 push 에 반응하는 워크플로는
 * deploy.yml(배포) 하나뿐이었고, **배포 브랜치에서는 의존성 감사가 단 한 번도 돌지
 * 않았다.** production 전용 커밋이 lockfile 이나 워크플로를 건드리면 감사 없이 그대로
 * 나가는 구조였다.
 *
 * 이 가드는 그 구멍이 되돌아오는 걸 막는다: deploy.yml 이 배포 트리거로 삼는 브랜치를
 * 읽어서, 그 브랜치가 전부 ci.yml 의 push 트리거에도 있는지 확인한다. 배포 대상이
 * 새로 늘어나면(예: staging 브랜치 추가) 감사 커버리지가 자동으로 따라오도록 강제된다.
 *
 * 주의 — 무거운 테스트 잡까지 배포 브랜치에서 돌릴 필요는 없다. 같은 커밋이 이미
 * main 에서 전체 매트릭스를 통과했고, deploy.yml 이 동일 push 에 병렬로 돌아 CI 가
 * 배포를 막지도 못한다. 그래서 ci.yml 의 무거운 잡들은
 * `if: github.ref != 'refs/heads/production.private'` 로 스킵되고, `npm ci` 조차 하지
 * 않는 dependency-audit 만 남는다. 이 가드가 보는 것은 "트리거에 있는가" 이지
 * "모든 잡이 도는가" 가 아니다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');

/**
 * `on: push: branches:` 목록을 뽑는다. 워크플로 YAML 만 다루면 되므로 의존성 없이
 * 들여쓰기 기반으로 읽는다(저장소에 YAML 파서 의존성을 새로 들이지 않기 위함).
 * 반환: 브랜치 문자열 배열. push 트리거가 없거나 branches 필터가 없으면 null
 * (= "모든 브랜치" 이므로 커버리지 관점에선 통과).
 */
export function pushBranches(yaml) {
  const lines = yaml.split('\n');
  let i = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (i < 0) return null;
  i += 1;

  // `on:` 블록 안에서 `push:` 를 찾는다(들여쓰기 2칸 키).
  let pushAt = -1;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim() !== '') break; // on: 블록 종료
    if (/^\s{2}push:\s*$/.test(l)) {
      pushAt = i;
      break;
    }
  }
  if (pushAt < 0) return null;

  // push: 아래에서 `branches:` 를 찾고 그 리스트 항목을 모은다.
  let branchesAt = -1;
  for (let j = pushAt + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const indent = l.match(/^\s*/)[0].length;
    if (indent <= 2) break; // push: 블록 종료
    if (/^\s{4}branches:\s*$/.test(l)) {
      branchesAt = j;
      break;
    }
  }
  if (branchesAt < 0) return null; // 필터 없음 = 전 브랜치

  const out = [];
  for (let j = branchesAt + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const m = l.match(/^\s{6}-\s*(\S+)/);
    if (!m) break;
    out.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

// deploy.yml 은 production.private 브랜치에만 있다(main 에는 없음). 없으면 검사할
// 배포 대상이 없다는 뜻이므로, main 기준의 알려진 배포 브랜치를 대신 확인한다.
export const KNOWN_DEPLOY_BRANCHES = ['production.private'];

/**
 * 이 저장소가 실제로 배포하는 브랜치 목록. deploy.yml 이 있으면 그 push 트리거를
 * 신뢰하고, 없으면(=main 체크아웃) 알려진 목록으로 떨어진다.
 *
 * scripts/audit-deploy-branch-deps.mjs 도 같은 목록을 써야 한다 — "배포되는 곳은
 * 전부 감사한다" 는 불변식의 출처가 하나여야 두 가드가 갈라지지 않는다.
 */
export function deployBranches() {
  const deployPath = join(dir, 'deploy.yml');
  return existsSync(deployPath)
    ? (pushBranches(readFileSync(deployPath, 'utf8')) ?? [])
    : KNOWN_DEPLOY_BRANCHES;
}

// 이 파일은 CLI 가드이면서 동시에 파서를 export 한다(테스트가 `pushBranches` 를
// 직접 단언한다 — apps/server/test/ci-branch-coverage-guard.test.mjs). import 만으로
// 아래 검사가 돌면 안 된다: 검사가 실패할 때 `process.exit(1)` 이 테스트 러너 전체를
// 죽여서 "이 가드가 FAIL 했다" 가 아니라 "스위트가 통째로 죽었다" 로 보이게 된다.
// 그래서 직접 실행됐을 때만 main() 을 돈다.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
const ciPath = join(dir, 'ci.yml');

if (!existsSync(ciPath)) {
  console.error('FAIL .github/workflows/ci.yml 이 없다 — 의존성 감사 잡의 근거가 사라졌다.');
  process.exit(1);
}

const deployBranchList = deployBranches();

const ciBranches = pushBranches(readFileSync(ciPath, 'utf8'));

if (ciBranches === null) {
  console.log('ok   ci.yml push 트리거에 branches 필터 없음 — 전 브랜치 커버.');
  process.exit(0);
}

const missing = [];
for (const b of deployBranchList) {
  if (ciBranches.includes(b)) {
    console.log(`ok   ${b} — ci.yml push 트리거에 포함 (dependency-audit 실행됨)`);
  } else {
    console.log(`FAIL ${b} — 배포 대상인데 ci.yml push 트리거에 없음`);
    missing.push(b);
  }
}

if (missing.length > 0) {
  console.error(
    `\n배포되지만 의존성 감사가 돌지 않는 브랜치 ${missing.length}개:\n` +
      missing.map((b) => `  - ${b}`).join('\n') +
      `\n\n이 브랜치들은 직접 push 로 갱신되므로 pull_request 트리거도 걸리지 않는다` +
      ` — 취약한 의존성·고정되지 않은 액션·새 install script 가 감사 없이 배포된다.` +
      ` ci.yml 의 \`on: push: branches:\` 에 추가할 것. 무거운 테스트 잡은` +
      ` \`if: github.ref != 'refs/heads/<branch>'\` 로 스킵하면 된다 —` +
      ` 자세한 이유는 scripts/audit-ci-branch-coverage.mjs 상단 참고.`,
  );
  process.exit(1);
}

console.log(`\n배포 브랜치 ${deployBranchList.length}개 — 전부 의존성 감사 커버.`);
}

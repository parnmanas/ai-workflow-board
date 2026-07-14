#!/usr/bin/env node
/**
 * check-version-bump.mjs — agent-manager 릴리스 버전 collapse 자동 차단 게이트.
 *
 * 배경 (ticket c17a8a40, board lesson #1): 동시 진행 티켓이 apps/agent-manager/
 * package.json 을 같은 다음 버전으로 범프하면, 먼저 랜딩한 쪽 기준으로 뒤 브랜치를
 * 리베이스할 때 git 이 '양쪽 동일 값' 변경을 충돌 마커 없이 그 값으로 조용히
 * auto-resolve 한다. 결과: 뒤 빌드가 앞 빌드와 version-identical → publish 워크플로가
 * "이미 npm 에 있음" 으로 no-op → 코드 변경이 npm 에 영영 안 실린다. tsc·테스트로는
 * 안 잡히는 침묵형 실패라, 지금까지는 board lesson #1 의 수동 preflight
 * (`git show origin/main:apps/agent-manager/package.json | grep version` 눈대중)
 * 하나에만 의존했다. 이 스크립트가 그 preflight 를 결정적 게이트로 승격한다.
 *
 * 규칙: 두 ref(BEFORE, AFTER) 사이 diff 가 agent-manager 의 배포 대상 소스
 * (apps/agent-manager/src/**) 를 건드렸다면, AFTER 의 package.json version 이
 * BEFORE 보다 semver 상 '엄격히 커야' 한다. 아니면 exit 1.
 * 소스를 안 건드렸으면(agent-manager 와 무관한 대부분의 커밋) 범프 불필요 → pass.
 * 이렇게 조건부로 두어 unrelated 커밋에 false-positive 를 내지 않는다.
 *
 * 사용법:
 *   node check-version-bump.mjs <BEFORE_REF> <AFTER_REF>
 *       임의의 두 ref 를 비교. CI(push→main)에서 github.event.before / github.sha 를,
 *       PR 에서 base / head sha 를 넘긴다.
 *   node check-version-bump.mjs --preflight
 *       로컬 머지 preflight. `git fetch origin main` 후 origin/main..HEAD 를 검사.
 *       board lesson #1 의 수동 확인을 대체한다 (AWB_NO_FETCH=1 이면 fetch 생략).
 *
 * 순수 Node(child_process + fs 불필요, git 만)만 사용 — 의존성/빌드 없음, 크로스플랫폼.
 * parseVersion / compareVersions 는 단위 테스트용으로 export 된다(맨 아래 CLI 가드 참조).
 */

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PKG_PATH = 'apps/agent-manager/package.json';
// 배포 대상 소스: src 만 dist 로 컴파일되어 npm tarball(package.json files:["dist"])에
// 실린다. test/·README·scripts 변경은 배포물 동작에 영향이 없으므로 범프를 강제하지 않는다.
const SOURCE_PATHSPEC = 'apps/agent-manager/src';

const ZERO_SHA = /^0{40}$/;

/** 'x.y.z' (+ 선택적 -prerelease/+build) 의 숫자 코어를 [major, minor, patch] 로. */
export function parseVersion(v) {
  const core = String(v).trim().split('-')[0].split('+')[0];
  const parts = core.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`파싱 불가한 버전 문자열: "${v}"`);
  }
  return parts;
}

/** a > b → 1, a < b → -1, a === b → 0 (숫자 비교; 문자열 비교 아님 — 1.6.9 < 1.6.10). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

/** ref 가 로컬에서 commit 으로 해석되면 true (shallow clone 등에서 missing 이면 false). */
function refResolvable(ref) {
  try {
    git(`cat-file -e ${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** 주어진 ref 의 apps/agent-manager/package.json version. 파일 없으면 null. */
function versionAtRef(ref) {
  let raw;
  try {
    raw = git(`show ${ref}:${PKG_PATH}`);
  } catch {
    return null; // 해당 ref 에 파일 없음(agent-manager 도입 이전 등) → 비교 skip 신호
  }
  try {
    return JSON.parse(raw).version;
  } catch (e) {
    throw new Error(`${ref}:${PKG_PATH} 의 version 파싱 실패: ${e.message}`);
  }
}

/**
 * 핵심 게이트. before..after 가 agent-manager 소스를 건드렸는데 version 이 엄격히
 * 커지지 않았으면 { ok:false }. 안전을 위해 ref 를 못 읽는 경우는 fail-open(skip)한다
 * — 이 게이트는 유일한 보증이 아니라 침묵형 실패용 백스톱이므로 false CI 실패가 더 해롭다.
 */
export function checkRange(beforeRef, afterRef) {
  if (!beforeRef || ZERO_SHA.test(beforeRef)) {
    return { ok: true, skipped: `BEFORE ref 없음(${beforeRef || 'empty'}) — 최초 push/브랜치 생성으로 판단, 비교 skip` };
  }
  if (!refResolvable(beforeRef) || !refResolvable(afterRef)) {
    return { ok: true, skipped: `ref 를 로컬에서 못 찾음(before=${beforeRef}, after=${afterRef}) — 비교 skip (CI 라면 checkout fetch-depth:0 필요)` };
  }

  const touched = git(`diff --name-only ${beforeRef} ${afterRef} -- ${SOURCE_PATHSPEC}`);
  if (!touched) {
    return { ok: true, message: `agent-manager 소스(${SOURCE_PATHSPEC}/**) 변경 없음 — 버전 범프 불필요` };
  }

  const beforeV = versionAtRef(beforeRef);
  const afterV = versionAtRef(afterRef);
  if (beforeV == null || afterV == null) {
    return { ok: true, skipped: `package.json 을 한쪽 ref 에서 못 읽음(before=${beforeV}, after=${afterV}) — 비교 skip` };
  }

  const cmp = compareVersions(afterV, beforeV);
  if (cmp > 0) {
    return { ok: true, message: `OK — agent-manager 소스 변경 + 버전 범프 확인 (${beforeV} → ${afterV})` };
  }
  return {
    ok: false,
    beforeV,
    afterV,
    touched: touched.split('\n'),
    message:
      cmp === 0
        ? `버전 collapse 감지: agent-manager 소스가 바뀌었는데 version 이 그대로다 (${beforeV} == ${afterV}).`
        : `버전 후퇴 감지: agent-manager 소스가 바뀌었는데 version 이 내려갔다 (${beforeV} → ${afterV}).`,
  };
}

export function main(argv) {
  let beforeRef;
  let afterRef;

  if (argv[0] === '--preflight') {
    if (process.env.AWB_NO_FETCH !== '1') {
      try {
        execSync('git fetch origin main --quiet', { stdio: 'inherit' });
      } catch {
        console.warn('⚠️  git fetch origin main 실패 — 로컬 origin/main 기준으로 계속합니다.');
      }
    }
    beforeRef = 'origin/main';
    afterRef = 'HEAD';
  } else {
    [beforeRef, afterRef] = argv;
    if (!beforeRef || !afterRef) {
      console.error('사용법: check-version-bump.mjs <BEFORE_REF> <AFTER_REF> | --preflight');
      return 2;
    }
  }

  const res = checkRange(beforeRef, afterRef);
  const label = `[agent-manager version guard] ${beforeRef}..${afterRef}`;
  if (res.ok) {
    console.log(`✅ ${label} — ${res.skipped || res.message}`);
    return 0;
  }

  console.error(`❌ ${label}`);
  console.error(`   ${res.message}`);
  console.error(`   변경된 소스: ${res.touched.join(', ')}`);
  console.error('');
  console.error('   → apps/agent-manager/package.json 의 "version" 을 origin/main 보다 큰 값으로 재범프하세요.');
  console.error('     (board lesson #1: 리베이스가 동시 티켓의 동일 범프를 조용히 collapse 시킨 것일 수 있습니다.)');
  return 1;
}

// CLI 로 직접 실행될 때만 동작. import(단위 테스트) 시에는 순수 함수만 노출하고 실행 안 함.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main(process.argv.slice(2)));
}

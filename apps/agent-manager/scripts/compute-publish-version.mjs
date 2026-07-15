#!/usr/bin/env node
/**
 * compute-publish-version.mjs — publish 시점 버전 자동 계산 + 멱등 복구 결정.
 *
 * 배경 (ticket 433f6cbd, source c17a8a40, board lesson #1/#3):
 *   예전엔 feature 브랜치가 apps/agent-manager/package.json 의 version 을 손으로
 *   범프했다. 동시 진행 티켓이 같은 다음 값으로 범프한 뒤 리베이스하면 git 이 그
 *   '양쪽 동일 값' 변경을 충돌 마커 없이 조용히 collapse 시켜(board lesson #1),
 *   뒤 빌드가 앞 빌드와 version-identical → publish 가 "이미 npm 에 있음" no-op →
 *   코드가 영영 안 실렸다. check-version-bump.mjs 는 그 collapse 를 사후 검출하는
 *   백스톱이었지만, 근본 원인은 '수동 범프' 자체다.
 *
 *   이 스크립트가 근본안이다: 버전을 소스에 안 적고, **publish 시점에 레지스트리
 *   최신값 + patch 로 계산**한다. 손으로 범프할 값이 없으니 collapse 될 것도 없다.
 *
 * 계산 규칙 (decideVersion):
 *   1. HEAD 를 가리키는 `awb-agent-manager-v*` 태그가 있으면 → 그 버전 (이 커밋의
 *      확정 버전이 이미 있다는 뜻; 재실행 멱등성의 1차 근거).
 *   2. `npm view <pkg> version` 이 E404 (패키지 미존재) → 최초 배포. seed
 *      (package.json 현재 version) 를 그대로 쓴다.
 *   3. 레지스트리 최신(latest)의 gitHead 가 HEAD 와 같으면 → 이 커밋이 이미
 *      latest 를 publish 했는데 태그 push 만 실패한 상태. 그 버전을 재사용(범프 X).
 *      npm 은 publish 시 tarball manifest 에 gitHead(=배포 당시 커밋 SHA)를
 *      박아두므로, 태그가 없어도 provenance 로 '이 커밋 산출물'임을 검증한다.
 *   4. 그 외 → latest + patch (정상 신규 릴리스).
 *
 * 실패 정책 (fail-closed): `npm view` 가 **명시적 E404 가 아닌** 오류
 *   (인증 E401 / 네트워크 / 5xx / 빈 출력 / 파싱 불가)면 절대 seed 로 폴백하지 않고
 *   throw 한다. 애매한 오류로 잘못된 버전을 밀지 않는 게 핵심이다.
 *
 * 액션 판정 (resolveAction, CLI): 계산된 V 가 npm 에 이미 있고 이 커밋 산출물이면
 *   (태그/gitHead provenance) publish 를 건너뛰고 태그만 보장한다("npm 엔 있고 tag
 *   만 없음" 복구). 있는데 소유 증명이 안 되면 무조건 성공 처리하지 않고, bump
 *   경로면 최신값을 다시 읽어 재계산(직렬화된 concurrency 하에선 사실상 도달 불가),
 *   그 외 경로면 anomaly 로 fail-closed 한다.
 *
 * 출력: GITHUB_OUTPUT 에 version / action / reason 을 적고, 사람이 읽을 로그는
 *   stdout 에 남긴다. action ∈ { publish, recover-tag, noop }.
 *
 * parseVersion / compareVersions / bumpPatch / classifyNpmView / decideVersion
 * 은 순수 함수로 export 되어 단위 테스트된다 (맨 아래 CLI 가드 참조). npm/git 을
 * 부르는 임퓨어 경로는 워크플로 dry-run + 실배포 1회로 검증한다.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'awb-agent-manager';
export const TAG_PREFIX = 'awb-agent-manager-v';
/** bump 경로에서 계산값이 이미 선점됐을 때 재계산하는 최대 횟수 (동시성 방어).
 *  concurrency group 이 run 을 직렬화하므로 정상 경로에선 0 회지만, 방어적으로 둔다. */
const MAX_BUMP_ATTEMPTS = 8;

// ─── 순수 semver ──────────────────────────────────────────────────────────

/** 'x.y.z' (+ 선택적 -prerelease/+build) 의 숫자 코어를 [major, minor, patch] 로. */
export function parseVersion(v) {
  const core = String(v).trim().split('-')[0].split('+')[0];
  const parts = core.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`파싱 불가한 버전 문자열: "${v}"`);
  }
  return parts;
}

/** a > b → 1, a < b → -1, a === b → 0 (숫자 비교 — 1.6.9 < 1.6.10). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** patch +1 (major/minor 유지). '1.6.28' → '1.6.29'. */
export function bumpPatch(v) {
  const [major, minor, patch] = parseVersion(v);
  return `${major}.${minor}.${patch + 1}`;
}

// ─── 순수 npm-view 분류 ───────────────────────────────────────────────────

/**
 * `npm view … --json` 한 번의 실행 결과를 의미 단위로 분류한다 (순수).
 *   - found     : 값이 있음 (버전 문자열 / gitHead SHA 등).
 *   - not_found : **명시적 E404** (패키지 미존재 또는 버전 미존재). 폴백 가능한
 *                 유일한 '부재' 신호.
 *   - error     : 그 외 전부 (E401/네트워크/5xx/빈 출력/파싱 불가) → fail-closed.
 *
 * npm 은 --json 실패 시 stdout 에 {"error":{"code":"E404",...}} 를 낸다. 성공 시
 * `npm view pkg[@ver] <field> --json` 은 스칼라면 JSON 문자열("1.2.3"), 다중
 * 매치면 배열을 낸다.
 */
export function classifyNpmView({ status, stdout, stderr }) {
  const out = (stdout || '').trim();
  let parsed;
  if (out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = undefined;
    }
  }
  // npm 의 구조화된 에러 (--json). E404 만 '부재', 나머지는 hard error.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
    if (parsed.error.code === 'E404') return { kind: 'not_found' };
    const detail = `${parsed.error.code || 'ERR'}: ${parsed.error.summary || parsed.error.detail || ''}`.trim();
    return { kind: 'error', detail: detail.slice(0, 240) };
  }
  if (status === 0) {
    let value;
    if (typeof parsed === 'string') value = parsed;
    else if (typeof parsed === 'number') value = String(parsed);
    else if (Array.isArray(parsed)) value = parsed.filter(Boolean).map(String).pop();
    else if (parsed === undefined) value = out.replace(/^"|"$/g, ''); // --json 아닌 bare 출력 방어
    // parsed 가 객체(비-error)면 예기치 못한 형태 → value 미설정 → 아래서 error.
    if (value && String(value).trim()) return { kind: 'found', value: String(value).trim() };
    // exit 0 인데 빈 출력: 요구한 field 가 없는 애매한 성공. 조용히 seed 로 새지
    // 않도록 error 로 처리 (fail-closed). 버전 부재는 위에서 E404 로 이미 잡힘.
    return { kind: 'error', detail: 'npm view 가 성공했지만 빈 출력' };
  }
  const tail = (stderr || out || 'unknown').split('\n').filter(Boolean).pop();
  return { kind: 'error', detail: (tail || 'npm view 실패').slice(0, 240) };
}

// ─── 순수 결정 코어 ───────────────────────────────────────────────────────

/**
 * 이미 수집한 probe 사실들로부터 버전 + 근거를 결정한다 (순수).
 *
 * @param {object}   p
 * @param {string|null} p.tagVersionOnHead HEAD 를 가리키는 TAG_PREFIX 태그의 버전(없으면 null)
 * @param {object}   p.latest           classifyNpmView 결과 (`npm view <pkg> version`)
 * @param {string|null} p.latestGitHead latest 의 gitHead (태그 없을 때만 참조)
 * @param {string}   p.headSha          HEAD 커밋 SHA
 * @param {string}   p.seed             package.json version (E404 최초배포 floor)
 * @returns {{version:string, reason:'tag'|'seed'|'provenance'|'bump'}}
 * @throws  latest 가 error(=E404 아님)거나 seed 파싱 불가 시 (fail-closed)
 */
export function decideVersion({ tagVersionOnHead, latest, latestGitHead, headSha, seed }) {
  // 1. HEAD 태그 = 이 커밋의 확정 버전 (재실행 멱등성 1차 근거).
  if (tagVersionOnHead) {
    parseVersion(tagVersionOnHead);
    return { version: tagVersionOnHead, reason: 'tag' };
  }
  // 2. 레지스트리 읽기는 found / not_found 만 허용. 그 외는 fail-closed.
  if (!latest || latest.kind === 'error') {
    throw new Error(`레지스트리 최신 버전 조회 실패 (fail-closed): ${latest?.detail || 'unknown'}`);
  }
  if (latest.kind === 'not_found') {
    parseVersion(seed); // seed 가 유효 semver 인지 검증
    return { version: seed, reason: 'seed' };
  }
  // latest.kind === 'found'
  const latestV = latest.value;
  parseVersion(latestV);
  // 3. provenance 복구: 이 커밋이 이미 latest 를 publish 했는데 태그만 실패.
  if (latestGitHead && headSha && latestGitHead === headSha) {
    return { version: latestV, reason: 'provenance' };
  }
  // 4. 정상 신규 릴리스.
  return { version: bumpPatch(latestV), reason: 'bump' };
}

// ─── 임퓨어 CLI (npm/git 호출) ────────────────────────────────────────────

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** `npm view <spec> [field] --json` 을 분류해 반환. */
function npmView(spec, field) {
  const args = ['view', spec];
  if (field) args.push(field);
  args.push('--json');
  const r = runCapture('npm', args);
  if (r.error) return { kind: 'error', detail: `npm spawn 실패: ${r.error.message}` };
  return classifyNpmView(r);
}

/** HEAD 를 가리키는 TAG_PREFIX 태그 중 가장 높은 버전 (없으면 null). */
function tagVersionOnHead() {
  const r = runCapture('git', ['tag', '--points-at', 'HEAD', `${TAG_PREFIX}*`]);
  if (r.status !== 0) return null;
  const versions = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(TAG_PREFIX))
    .map((s) => s.slice(TAG_PREFIX.length))
    .filter((v) => {
      try {
        parseVersion(v);
        return true;
      } catch {
        return false;
      }
    });
  if (!versions.length) return null;
  return versions.sort((a, b) => compareVersions(a, b)).pop();
}

/** 이 스크립트 옆 package.json 의 version (seed floor). */
function readSeed() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof pkg?.version !== 'string') throw new Error(`${pkgPath} 에 version 없음`);
  return pkg.version;
}

/**
 * 계산된 V 가 npm 에 이미 있는지 + 이 커밋 산출물인지 확인해 최종 액션을 정한다.
 * @returns {'publish'|'recover-tag'|'noop'}
 * @throws  npm view 가 E404 아닌 오류거나 (fail-closed), 소유 증명 안 되는 선점 anomaly 시
 */
function resolveAction(version, reason, headSha, tagVersionOnHeadValue) {
  const exists = npmView(`${PACKAGE_NAME}@${version}`, 'version');
  if (exists.kind === 'error') {
    throw new Error(`@${version} 존재 확인 실패 (fail-closed): ${exists.detail}`);
  }
  if (exists.kind === 'not_found') {
    return 'publish'; // 아직 npm 에 없음 → 빌드+publish
  }
  // 이미 npm 에 있음 → 이 커밋 산출물인지 증명해야 '성공(skip)' 처리.
  let owned = reason === 'tag' || reason === 'provenance';
  if (!owned) {
    const gh = npmView(`${PACKAGE_NAME}@${version}`, 'gitHead');
    if (gh.kind === 'error') {
      throw new Error(`@${version} gitHead 확인 실패 (fail-closed): ${gh.detail}`);
    }
    owned = gh.kind === 'found' && headSha && gh.value === headSha;
  }
  if (!owned) {
    // npm 에 있는데 우리 것이 아님 → 무조건 성공 처리 금지.
    return 'anomaly';
  }
  // 우리 것 → publish 는 이미 끝났고 태그만 보장하면 된다.
  return tagVersionOnHeadValue === version ? 'noop' : 'recover-tag';
}

function emitOutputs(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  for (const l of lines) console.log(`[compute-publish-version] ${l}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}

export function main() {
  const headRes = runCapture('git', ['rev-parse', 'HEAD']);
  const headSha = headRes.status === 0 ? headRes.stdout.trim() : '';
  const seed = readSeed();

  const tagOnHead = tagVersionOnHead();

  // bump 경로 선점(동시성) 방어: 최신값을 다시 읽어 재계산하는 bounded 루프.
  let attempt = 0;
  while (true) {
    attempt++;
    const latest = npmView(PACKAGE_NAME, 'version');
    let latestGitHead = null;
    if (!tagOnHead && latest.kind === 'found') {
      const gh = npmView(PACKAGE_NAME, 'gitHead');
      // gitHead 없음/에러는 provenance 복구를 못 할 뿐 치명적이지 않다 → null 로 두고
      // 정상 bump 로 진행 (태그가 없으면 어차피 새 버전을 내는 게 맞다).
      latestGitHead = gh.kind === 'found' ? gh.value : null;
    }

    const { version, reason } = decideVersion({
      tagVersionOnHead: tagOnHead,
      latest,
      latestGitHead,
      headSha,
      seed,
    });

    const action = resolveAction(version, reason, headSha, tagOnHead);

    if (action === 'anomaly') {
      if (reason === 'bump' && attempt < MAX_BUMP_ATTEMPTS) {
        // 계산한 patch 를 남이 선점 → 최신값을 다시 읽어 한 칸 더 범프. (concurrency
        // group 하에선 도달 불가지만, 가드가 꺼진 상황을 위한 방어.)
        console.log(
          `[compute-publish-version] ${version} 이(가) 이미 다른 커밋 산출물로 npm 에 있음 — 재계산 (attempt ${attempt}/${MAX_BUMP_ATTEMPTS})`,
        );
        continue;
      }
      console.error(
        `❌ [compute-publish-version] ${version} 이(가) npm 에 있으나 이 커밋(${headSha.slice(0, 12)}) 산출물임을 증명할 수 없습니다 (reason=${reason}). ` +
          '무조건 성공 처리하지 않고 fail-closed 합니다.',
      );
      return 1;
    }

    emitOutputs({ version, action, reason, head: headSha });
    console.log(
      `✅ [compute-publish-version] version=${version} action=${action} reason=${reason} ` +
        `(seed=${seed}, tagOnHead=${tagOnHead || '-'}, head=${headSha.slice(0, 12)})`,
    );
    return 0;
  }
}

// CLI 직접 실행 시에만 동작. import(단위 테스트) 시에는 순수 함수만 노출.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`❌ [compute-publish-version] ${err?.message || err}`);
    process.exit(1);
  }
}

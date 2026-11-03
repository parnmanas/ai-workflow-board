#!/usr/bin/env node
/**
 * audit-lockfile-advisories.mjs
 *
 * lockfile 의 취약점 게이트. `npm audit` 을 대신해 advisory 엔드포인트를 **직접**
 * 조회하고, 출처를 둘 둔다 — npm 의 bulk advisory 엔드포인트를 먼저 보고, 죽어 있으면
 * GitHub Advisory Database 로 넘어간다.
 *
 * ── 왜 `npm audit` 을 쓰지 않는가 (ticket 1019e57d) ──
 *
 * 2026-09-04, main 을 포함한 모든 CI 가 red 가 됐다. dependency-audit 잡의 첫 스텝
 * `npm audit --audit-level=moderate` 가 exit 1 로 죽었고, 같은 커밋(affb2266)이
 * 00:10 엔 green, 00:46 엔 red 였다 — 커밋이 아니라 시간축 외부 조건이다.
 *
 * 실패 로그(run 33821861049)가 메커니즘을 그대로 보여준다:
 *
 *     npm notice This endpoint is being retired. Use the bulk advisory endpoint instead.
 *     npm warn audit 400 Bad Request - POST .../-/npm/v1/security/audits/quick - Bad Request
 *     { statusCode: 400, error: 'Bad Request',
 *       message: 'Invalid package tree, run  npm install  to rebuild your package-lock.json' }
 *     npm error audit endpoint returned an error
 *
 * 즉 은퇴 공지가 원인이 아니다. 순서는 이렇다:
 *
 *   1. npm 이 먼저 `/-/npm/v1/security/advisories/bulk` 를 때린다.
 *   2. 레지스트리측 사정으로 그게 실패한다(첫 관측치는 Service Unavailable).
 *   3. **npm 10 은 실패하면 은퇴 대상인 `/-/npm/v1/security/audits/quick` 으로
 *      폴백한다** (@npmcli/arborist lib/audit-report.js — 10.9.4 에는 bulk 실패 시
 *      quick 으로 가는 catch 가 있고, 11.x 에는 그 폴백이 아예 없다).
 *   4. quick 엔드포인트는 이 저장소의 workspaces 모노레포 lockfile 에 대해
 *      400 Invalid package tree 를 돌려준다 — **폴백이 성공할 수 있는 경우가 없다.**
 *   5. 그래서 bulk 가 한 번 흔들리기만 하면 잡이 확정적으로 죽는다.
 *
 * CI 의 npm 은 Node 22 번들(10.9.x)에 묶여 있어 우리가 고를 수 없고, npm 을 11 로
 * 올려도 bulk 실패가 곧 exit 1 인 건 같다(폴백이 없어질 뿐이다). 어느 쪽이든
 * **npm 클라이언트의 폴백 정책이 우리 병합 경로를 좌우한다.** 그래서 폴백을 우리가
 * 소유한다: lockfile 을 직접 읽어 bulk 엔드포인트에 물어보고, 재시도도 우리가 건다.
 *
 * 부수 효과로 잡이 빨라진다. npm 10 은 bulk 재시도 + quick 폴백까지 가느라 죽는 데만
 * 약 7분을 썼다(00:47:51 → 00:54:49). 여기서는 요청 하나에 타임아웃이 걸려 있다.
 *
 * ── 판정 방식 ──
 *
 * npm 축: bulk 엔드포인트는 `{ "패키지명": ["설치된 버전", ...] }` 를 받아, **보낸 버전에
 * 실제로 걸리는** advisory 만 돌려준다. 이건 문서가 아니라 실측이다: lodash 4.17.20
 * 으로 물으면 GHSA-35jh-r3h4-6jhm(`<4.17.21`)이 오고, 4.17.21 로 물으면 그 건은 빠진
 * 채 상한이 더 높은 advisory 들만 온다. 그래서 응답에 항목이 있다는 것 자체가
 * "설치된 버전이 취약하다" 이고, 별도 semver 매칭이 필요 없다.
 *
 * ── fail-closed ──
 *
 * 네트워크·파싱 어느 단계가 실패해도 통과시키지 않는다. "확인 못 했다" 를 "문제 없다"
 * 로 바꿔 읽는 게 이 계열 가드의 가장 위험한 실패 모드다(audit-published-deps.mjs 와
 * 같은 규약). **두 출처가 모두** 실패해야 실패이므로, 폴백은 이 규약을 무르는 게
 * 아니라 한 출처의 장애를 실패로 오독하지 않게 하는 장치다.
 *
 * 여기서 "레지스트리가 정말 죽었다면 다른 잡의 `npm ci` 도 같이 죽으니 굳이 폴백이
 * 필요 없다" 고 생각하기 쉬운데, 이 사고가 그 추론을 반증했다: run 33823224505 에서
 * **dependency audit 만 실패하고 `npm ci` 를 돌리는 잡들은 전부 green 이었다.**
 * advisory 엔드포인트는 레지스트리의 나머지가 멀쩡한 채로 혼자 죽을 수 있다.
 *
 * 같은 이유로 **읽어낸 패키지가 0개면 실패**한다. 파서가 조용히 망가졌을 때 "검사할
 * 대상이 없어 통과" 하는 게 이 스크립트의 유일한 무증상 실패 모드라서다.
 *
 * ── 기준(base) 대비 판정 — push 는 "이 변경이 들인 것" 만 실패시킨다 ──
 *
 * advisory 는 우리 커밋과 무관하게 공개된다. 그런데 이 게이트가 push 마다 lockfile 전체를
 * 판정하던 동안, advisory 공개 하나가 그 뒤의 **모든 push 를 red** 로 만들었다 — 의존성을
 * 한 줄도 건드리지 않은 커밋까지. 2026-10-22 ~ 11-02 에만 네 번이다(ip-address ·
 * body-parser/multer/undici/zod · @hono/node-server · glob/minimatch). 예: run 41422645526 은
 * opencode 모델 목록 수정(872dc0b3)이었는데 glob/minimatch advisory 로 실패했다.
 *
 * 그 red 는 아무것도 막지 않았다 — main 은 직접 push 이고 배포·발행은 CI 를 기다리지 않는다.
 * 남는 것은 신호인데, 그 신호가 **커밋을 잘못 지목**했다: "이 커밋이 깨졌다" 로 읽히지만 고칠
 * 것은 그 커밋이 아니라 의존성이다. 시간축 advisory 를 잡는 자리는 따로 있다 — ci.yml 의
 * 매일 cron(정기 재감사 — 2026-08-21 감사가 바로 이 축 때문에 만들었다).
 *
 * 그래서 `--base` 가 주어지면 판정을 둘로 가른다:
 *   - 기준 lockfile 에 없던 name@version(= 이 변경이 들인 버전)에 걸린 advisory → 실패.
 *   - 기준에도 있던 버전에 걸린 advisory → 경고(GitHub annotation). run 은 통과한다.
 * 기준이 없으면(schedule · 로컬 실행 · 기준을 못 읽음) 예전 그대로 전부 실패다. 기준을 못
 * 구했을 때 약한 쪽으로 떨어지지 않는다 — fail-closed 는 여기서도 같다.
 *
 * 들인 버전의 판정도 엔드포인트에 맡긴다(semver 를 직접 풀지 않는다 — GitHub 축 주석 참조).
 * 전체 질의에서 걸린 패키지 가운데 들인 버전이 있는 것만, 그 버전으로 한 번 더 묻는다.
 * 걸린 패키지가 없거나 들인 버전이 없으면 추가 질의는 없다 — 거의 모든 push 가 그렇다.
 *
 * 라이브러리로도 쓰인다 — audit-deploy-branch-deps.mjs / audit-published-deps.mjs 가
 * 각자 확보한 lockfile 을 여기 넘긴다. 그 두 곳도 `npm audit` 을 쓰고 있었으므로 같은
 * 결함을 그대로 갖고 있었다(schedule 전용이라 병합을 막지 않았을 뿐이다).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BULK_ADVISORY_PATH = '/-/npm/v1/security/advisories/bulk';

/**
 * 이 저장소에는 `.npmrc` 가 없고 lockfile 의 `resolved` 가 전부 registry.npmjs.org 다
 * (2026-09-04 기준 604개 전부). 그래서 기본 레지스트리를 그대로 쓴다 — 인증 헤더도
 * 붙이지 않는다.
 *
 * 사설 레지스트리를 도입한다면 `fetchAdvisories({ registry })` 로 주소를 넘기고 인증을
 * 함께 붙여야 한다. 주소만 바꾸고 인증을 빠뜨리면 401 로 **조회 실패** 가 되는데,
 * 그건 fail-closed 라 조용히 통과하지는 않는다(빨갛게 죽는다).
 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** npm 과 같은 순서. 인덱스가 곧 심각도다. */
export const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

export const DEFAULT_AUDIT_LEVEL = 'moderate';

/**
 * npm 쪽 예산. 정상일 때 응답은 14.5s / 18.7s / 43.0s 였다(2026-09-04, 537개 payload
 * 실측) — 편차가 커서 30s 로 잡았더니 정상 응답을 두 번 잘라냈다. 60s 면 관측된
 * 정상 응답을 전부 덮는다.
 *
 * payload 를 쪼개면 빨라질 것 같지만 반대다: 150개씩 4조각으로 나눠 연속 호출하니
 * 20.0s / 193.9s / 104.2s 로 **뒤로 갈수록 느려졌다**. 크기가 아니라 연속 호출이
 * 스로틀을 부른다. 그래서 쪼개지 않고 한 번에 보낸다.
 *
 * 시도를 2회로 줄인 건 **폴백이 생겼기 때문**이다. 아래 GitHub 축이 약 3초에 같은
 * 답을 주므로, npm 이 죽었을 때 여기서 오래 버틸 이유가 없다. 실제로 4회*90s 예산은
 * CI 에서 415초를 통째로 태우고 실패했다(run 33826709579 step 9).
 */
export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 재시도 간격: 5s / 20s / 30s. 위 실측대로 연속 호출이 스로틀을 부르므로 촘촘한
 * 재시도는 상황을 악화시킨다 — 간격을 벌린다. 상수로 빼 둔 건 문서와 코드가 갈라지지
 * 않게 테스트가 실제 스케줄을 단언할 수 있게 하려는 것이다.
 */
export const DEFAULT_BACKOFF_MS = (attempt) => Math.min(5000 * attempt ** 2, 30_000);

export const GITHUB_API = 'https://api.github.com';

/**
 * `affects` 는 쿼리스트링이라 길이 제한이 있다. 실측한 414 경계(2026-09-04):
 *
 *     5,632자(200쌍) → HTTP 200
 *     6,523자(250쌍) → HTTP 414 Request-URL too long
 *
 * 그래서 **개수가 아니라 문자 예산**으로 쪼갠다. 개수로 자르면 scoped 이름이 많은
 * lockfile 에서 같은 개수라도 길이가 훌쩍 넘어 414 를 다시 밟는다 — 길이가 실제 한계고
 * 개수는 그 대리 변수일 뿐이다. 4,000자면 경계까지 여유가 충분하고, 지금 트리(12,688자)
 * 기준 4조각이라 비인증 rate limit(시간당 60회) 관점에서도 값싸다.
 */
export const GITHUB_AFFECTS_MAX_CHARS = 4000;
export const GITHUB_PER_PAGE = 100;
export const GITHUB_MAX_PAGES = 20;

/** GitHub 은 npm 의 'moderate' 를 'medium' 이라 부른다. 나머지 등급은 이름이 같다. */
export const GITHUB_SEVERITY = {
  low: 'low',
  medium: 'moderate',
  high: 'high',
  critical: 'critical',
};

/**
 * `severity` 가 `level` 이상인가. 모르는 심각도 문자열은 **가장 높게** 취급한다 —
 * 레지스트리가 새 등급을 도입했을 때 조용히 빠져나가지 않게 하려는 것이다.
 */
export function atOrAboveLevel(severity, level = DEFAULT_AUDIT_LEVEL) {
  const threshold = SEVERITY_ORDER.indexOf(level);
  if (threshold < 0) throw new Error(`알 수 없는 audit level: ${level}`);
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank < 0 ? true : rank >= threshold;
}

/**
 * `node_modules/a/node_modules/@scope/b` → `@scope/b`.
 * `node_modules/` 가 없는 키(워크스페이스 디렉터리)는 패키지명을 유추할 수 없으므로
 * null 을 준다 — 잘라내기 산술로 엉뚱한 이름을 만들어 물어보지 않기 위해서다.
 */
export function packageNameFromKey(key) {
  const marker = 'node_modules/';
  const at = key.lastIndexOf(marker);
  if (at < 0) return null;
  return key.slice(at + marker.length) || null;
}

/**
 * lockfile(v2/v3 `packages` 맵)에서 **레지스트리에서 받은** 패키지의 이름→버전 집합을
 * 뽑는다.
 *
 * 제외 대상:
 *   - 루트 엔트리('')와 워크스페이스 디렉터리 — `resolved` 가 없다.
 *   - `link: true` — node_modules 안의 워크스페이스 심링크.
 *   - git/file/link 프로토콜 — 레지스트리 버전 축이 아니라 물어볼 대상이 아니다.
 *
 * 이름은 `name` 필드가 있으면 그걸 쓴다. alias 설치(`string-width-cjs` →
 * `string-width`)에서 키와 실제 패키지명이 갈리기 때문이다 — 키로만 유추하면 존재하지
 * 않는 패키지를 물어보게 되고 그 패키지의 advisory 는 영영 안 걸린다.
 */
export function lockfilePackages(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error('lockfile 에 packages 맵이 없다 (lockfileVersion 2 이상이 필요하다)');
  }

  const byName = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || !entry || entry.link === true) continue;
    const resolvedUrl = entry.resolved;
    if (typeof resolvedUrl !== 'string' || !/^https?:\/\//.test(resolvedUrl)) continue;
    if (typeof entry.version !== 'string' || entry.version === '') continue;

    const name = entry.name ?? packageNameFromKey(key);
    if (!name) continue;

    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(entry.version);
  }
  return byName;
}

/** `lockfilePackages()` 결과를 bulk 엔드포인트 payload 로. */
export function bulkPayload(byName) {
  const payload = {};
  for (const [name, versions] of byName) payload[name] = [...versions].sort();
  return payload;
}

/**
 * bulk 응답을 `level` 기준으로 걸러 보고용 findings 로 만든다.
 *
 * 응답이 이미 "보낸 버전에 걸리는 것" 만 담고 있으므로 여기서는 심각도만 본다.
 * 설치된 버전 목록을 같이 실어 어느 버전을 올려야 하는지 바로 보이게 한다.
 */
export function collectFindings(report, byName, level = DEFAULT_AUDIT_LEVEL) {
  const findings = [];
  for (const [name, advisories] of Object.entries(report ?? {})) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories) {
      if (!atOrAboveLevel(advisory?.severity, level)) continue;
      findings.push({
        name,
        severity: advisory.severity,
        title: advisory.title ?? '(제목 없음)',
        url: advisory.url ?? '',
        vulnerableVersions: advisory.vulnerable_versions ?? '',
        installedVersions: [...(byName.get(name) ?? [])].sort(),
      });
    }
  }
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      a.name.localeCompare(b.name),
  );
  return findings;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTTP 로 JSON 하나를 받아온다. 비-2xx 와 JSON 아님은 전부 throw — 조용히 넘어가지 않는다. */
async function requestJson(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {},
) {
  const res = await fetchImpl(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText ?? ''}`.trim());
  return res.json();
}

/**
 * 재시도 래퍼. 전부 실패하면 시도별 사유를 담아 throw — 호출부가 fail-closed 로 처리한다.
 *
 * 재시도 간격은 오히려 **벌린다**(5s / 20s / 30s). 위 DEFAULT_TIMEOUT_MS 주석의 실측처럼
 * 연속 호출이 스로틀을 부르므로, 촘촘한 재시도는 상황을 악화시킨다.
 */
export async function withRetries(
  label,
  fn,
  { attempts = DEFAULT_ATTEMPTS, onRetry = () => {}, backoffMs = DEFAULT_BACKOFF_MS } = {},
) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      errors.push(`시도 ${attempt}/${attempts}: ${e?.message ?? e}`);
      if (attempt < attempts) {
        onRetry(attempt, e, label);
        await sleep(backoffMs(attempt));
      }
    }
  }
  const err = new Error(
    `${label}: ${attempts}회 모두 실패했다:\n` + errors.map((m) => `  - ${m}`).join('\n'),
  );
  err.attemptErrors = errors;
  throw err;
}

/** npm 의 bulk advisory 엔드포인트를 재시도와 함께 조회한다. */
export async function fetchAdvisories(payload, options = {}) {
  const { registry = DEFAULT_REGISTRY, ...rest } = options;
  const url = `${registry.replace(/\/+$/, '')}${BULK_ADVISORY_PATH}`;
  return withRetries(
    'bulk advisory 엔드포인트 조회',
    async () => {
      const body = await requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'npm-command': 'audit' },
        body: JSON.stringify(payload),
        ...rest,
      });
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error(`advisory 응답이 객체가 아니다: ${JSON.stringify(body)?.slice(0, 200)}`);
      }
      return body;
    },
    rest,
  );
}

/**
 * ── 폴백 축: GitHub Advisory Database ──
 *
 * npm 의 bulk 엔드포인트가 죽으면 여기로 넘어온다. 왜 이게 필요한지는 실측이 말한다
 * (2026-09-04): npm bulk 는 200초 동안 **0바이트**를 돌려줬고, 같은 시각 GitHub 은
 * 청크당 0.5초에 응답했다. npm 축만 있으면 npm 측 장애가 곧 저장소 전체의 병합 차단이다.
 *
 * 같은 데이터의 상류이기도 하다 — npm 의 advisory 는 GHSA 를 받아 쓴다. 실제로 우리
 * lockfile 에 대해 두 축의 판정이 일치했다(둘 다 0건). 단, **withdrawn 을 걸러야**
 * 일치한다: GitHub 은 철회된 중복 advisory(GHSA-qmq6-f8pr-cx5x, uuid, 2026-05-05 철회)
 * 도 돌려주는데 npm 은 안 준다.
 *
 * 이건 fail-open 이 아니다. 두 축이 **모두** 실패하면 그대로 실패시킨다.
 */
export function affectsChunks(byName, maxChars = GITHUB_AFFECTS_MAX_CHARS) {
  const pairs = [];
  for (const [name, versions] of byName) for (const v of versions) pairs.push(`${name}@${v}`);
  pairs.sort();

  const chunks = [];
  let current = [];
  let length = 0;
  for (const pair of pairs) {
    const added = current.length === 0 ? pair.length : pair.length + 1; // 구분자 ','
    if (current.length > 0 && length + added > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(pair);
    length += current.length === 1 ? pair.length : pair.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 응답에서 **우리 lockfile 에 있는** 패키지명만 뽑는다.
 *
 * 여기서 바로 findings 를 만들면 안 된다 — advisory 의 `vulnerabilities[]` 에는 같은
 * 취약점을 공유하는 **동반 패키지**가 함께 실린다. 예를 들어 안전한 lodash@4.17.21 과
 * 취약한 lodash-es@4.17.15 를 한 청크로 물으면, lodash-es 때문에 온 GHSA-35jh-r3h4-6jhm
 * (`<4.17.21`)의 목록에 lodash 도 들어 있다(실측). 그대로 믿으면 안전한 lodash 를
 * 취약하다고 보고하는 **위양성**이 된다. 그래서 이건 '후보' 일 뿐이고, 확정은 아래
 * 쌍 단위 재질의가 한다.
 */
export function candidateNames(advisories, byName) {
  const names = new Set();
  for (const adv of advisories ?? []) {
    if (adv?.withdrawn_at) continue;
    for (const v of adv?.vulnerabilities ?? []) {
      const name = v?.package?.name;
      if (name && byName.has(name)) names.add(name);
    }
  }
  return names;
}

/** GitHub advisory 목록을 npm bulk 와 같은 `{ 패키지명: [advisory...] }` 형태로. */
export function githubReportFor(name, advisories) {
  const rows = [];
  for (const adv of advisories ?? []) {
    if (adv?.withdrawn_at) continue;
    const hit = (adv.vulnerabilities ?? []).find((v) => v?.package?.name === name);
    if (!hit) continue;
    rows.push({
      severity: GITHUB_SEVERITY[adv.severity] ?? adv.severity,
      title: adv.summary ?? adv.ghsa_id ?? '(제목 없음)',
      url: adv.html_url ?? (adv.ghsa_id ? `https://github.com/advisories/${adv.ghsa_id}` : ''),
      vulnerable_versions: hit.vulnerable_version_range ?? '',
    });
  }
  return rows;
}

/** `/advisories` 한 질의(페이지네이션 포함). */
async function githubQuery(affects, opts) {
  const { api = GITHUB_API, token, perPage = GITHUB_PER_PAGE, maxPages = GITHUB_MAX_PAGES } = opts;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'awb-audit-lockfile-advisories',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const qs = new URLSearchParams({
      ecosystem: 'npm',
      affects,
      per_page: String(perPage),
      page: String(page),
    });
    const body = await requestJson(`${api}/advisories?${qs}`, { headers, ...opts });
    if (!Array.isArray(body)) throw new Error('advisory 목록이 배열이 아니다');
    all.push(...body);
    if (body.length < perPage) return all;
  }
  throw new Error(`advisory 페이지가 ${maxPages}쪽을 넘었다 — 질의가 너무 넓다`);
}

/**
 * GitHub 축으로 lockfile 을 감사해 npm bulk 와 같은 형태의 report 를 만든다.
 *
 * 2단계다: (1) 청크로 넓게 훑어 후보 패키지명을 얻고, (2) 후보의 **설치된 버전마다**
 * 한 쌍씩 다시 물어 정확히 귀속한다. 2단계는 GitHub 자신의 버전 매칭을 그대로 쓰므로
 * 우리가 semver 범위를 해석할 필요가 없다 — 직접 구현하면 그게 새 버그 표면이 된다.
 * 후보가 없으면 2단계는 아예 돌지 않으므로(정상 상태) 비용은 청크 수만큼이다.
 */
export async function fetchGithubAdvisories(byName, options = {}) {
  const {
    // 토큰은 **ci.yml 에서 넘기지 않는다.** `/advisories` 는 공개 엔드포인트라 없어도
    // 돌고, ci.yml 은 `pull_request` 에서 PR 이 저작한 코드를 그대로 실행하므로 거기에
    // secret 을 넣으면 supply-chain-integrity-guard 가 막는 노출 표면이 생긴다
    // (그 가드의 "ci.yml now references a secret" 단언). 비인증은 시간당 60회 제한이
    // 있지만 이 축은 npm 이 죽었을 때만, 그것도 몇 회만 부른다. 한도에 걸리면 조용히
    // 통과하지 않고 fail-closed 로 죽는다.
    //
    // 환경변수로 들어오면 쓴다 — ci.yml 밖(로컬·수동 실행)에서 한도를 늘리는 용도다.
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    chunkSize = GITHUB_AFFECTS_MAX_CHARS,
    attempts = DEFAULT_ATTEMPTS,
    ...rest
  } = options;
  const opts = { token, attempts, ...rest };

  const candidates = new Set();
  for (const chunk of affectsChunks(byName, chunkSize)) {
    const advisories = await withRetries('GitHub advisory 조회', () =>
      githubQuery(chunk.join(','), opts), opts);
    for (const name of candidateNames(advisories, byName)) candidates.add(name);
  }

  const report = {};
  for (const name of candidates) {
    for (const version of byName.get(name) ?? []) {
      const advisories = await withRetries(`GitHub advisory 재질의(${name}@${version})`, () =>
        githubQuery(`${name}@${version}`, opts), opts);
      const rows = githubReportFor(name, advisories);
      if (rows.length > 0) (report[name] ??= []).push(...rows);
    }
  }
  return report;
}

/**
 * 이름→버전 집합 하나를 감사한다. `{ source, findings }`.
 *
 * 빈 집합을 거르지 않는다 — 그 판정은 호출부 몫이다. lockfile 전체가 비면 파서 고장이지만,
 * "이 변경이 들인 버전" 이 비는 것은 정상이다.
 */
async function auditPackages(byName, { level, ...fetchOptions }) {
  // npm 을 먼저 본다 — `npm audit` 과 같은 출처라 판정이 그대로 이어진다.
  // 실패하면 GitHub 축으로 넘어간다. 둘 다 실패해야 실패다 (fail-closed).
  let report;
  let source;
  const failures = [];
  try {
    report = await fetchAdvisories(bulkPayload(byName), fetchOptions);
    source = 'npm';
  } catch (npmError) {
    failures.push(npmError);
    fetchOptions.onSourceFallback?.(npmError);
    try {
      report = await fetchGithubAdvisories(byName, fetchOptions);
      source = 'github';
    } catch (githubError) {
      failures.push(githubError);
      const err = new Error(
        'advisory 출처 두 곳이 모두 실패했다 — 통과시키지 않는다.\n' +
          failures.map((e) => `[${e === npmError ? 'npm' : 'github'}] ${e.message}`).join('\n'),
      );
      err.sourceErrors = failures;
      throw err;
    }
  }

  return { source, findings: collectFindings(report, byName, level) };
}

/**
 * head 에는 있고 base 에는 없는 name@version — "이 변경이 lockfile 에 들인 버전" 이다.
 *
 * 패키지 이름이 아니라 버전 쌍으로 센다. 이미 취약한 패키지를 아직 취약한 다른 버전으로
 * 옮기는 것(덜 된 수정)도 그 변경이 들인 취약 버전이다 — 이름 단위로 세면 그 경우가 빠진다.
 * 반대로 이미 있던 버전이 다른 경로에 한 벌 더 깔리는 것은 새 버전이 아니다.
 */
export function introducedPackages(head, base) {
  const added = new Map();
  for (const [name, versions] of head) {
    for (const version of versions) {
      if (base.get(name)?.has(version)) continue;
      if (!added.has(name)) added.set(name, new Set());
      added.get(name).add(version);
    }
  }
  return added;
}

const versionTotal = (byName) => [...byName.values()].reduce((n, s) => n + s.size, 0);

/**
 * lockfile 객체 하나를 감사한다. `{ source, findings, packageCount, versionCount, introduced }`
 * 를 돌려주고, 그중 무엇이 실패인지는 `gateFindings()` 가 정한다.
 *
 * `baseLock` 을 주면 `introduced` 에 그 기준 대비 들인 버전의 판정(`{ source, findings,
 * packageCount, versionCount }`)을 싣는다. 안 주면 `introduced` 는 null — 기준 없음이다.
 *
 * 패키지를 하나도 못 읽으면 throw 한다 — 침묵 통과 방지.
 */
export async function auditLockfile(
  lock,
  { level = DEFAULT_AUDIT_LEVEL, baseLock, ...fetchOptions } = {},
) {
  const byName = lockfilePackages(lock);
  if (byName.size === 0) {
    throw new Error(
      'lockfile 에서 레지스트리 패키지를 하나도 읽지 못했다 — 파서가 깨졌거나 lockfile 이 비었다',
    );
  }

  const { source, findings } = await auditPackages(byName, { level, ...fetchOptions });
  const result = {
    source,
    findings,
    packageCount: byName.size,
    versionCount: versionTotal(byName),
    introduced: null,
  };
  if (baseLock == null) return result;

  const added = introducedPackages(byName, lockfilePackages(baseLock));
  // 전체 질의가 어떤 패키지에 아무것도 돌려주지 않았다면 그 패키지의 어느 버전도 — 들인
  // 버전도 그 질의에 들어 있었다 — 문턱 이상 advisory 에 걸리지 않은 것이다. 그래서 걸린
  // 패키지의 들인 버전만 다시 묻는다.
  const flagged = new Set(findings.map((f) => f.name));
  const suspects = new Map([...added].filter(([name]) => flagged.has(name)));
  const recheck =
    suspects.size === 0
      ? { source: null, findings: [] }
      : await auditPackages(suspects, { level, ...fetchOptions });
  result.introduced = { ...recheck, packageCount: added.size, versionCount: versionTotal(added) };
  return result;
}

/**
 * 무엇이 이 run 을 실패시키는가 — `{ blocking, preexisting }`.
 *
 * 기준이 없으면 전부 blocking 이다(예전 동작). 기준이 있으면 이 변경이 들인 버전에 걸린
 * 것만 blocking 이고, 기존 버전에만 걸린 나머지가 preexisting(경고)이다. blocking 은 다시
 * 물은 결과 그대로다 — 첫 질의와 짝을 못 맞춰도(출처가 갈려 제목이 달라도) 들인 취약점이
 * 경고로 새지 않는다. 짝 맞추기는 경고 목록에서 중복을 빼는 데만 쓴다.
 */
export function gateFindings({ findings, introduced }) {
  if (!introduced) return { blocking: findings, preexisting: [] };
  const key = (f) => `${f.name}\u0000${f.url || f.title}`;
  const blocked = new Set(introduced.findings.map(key));
  return {
    blocking: introduced.findings,
    preexisting: findings.filter((f) => !blocked.has(key(f))),
  };
}

// ───────────────────────── 기준(base) 확보 ─────────────────────────

/** `--base=github-event` — 기준을 GitHub 이벤트에서 고른다. ci.yml 이 쓰는 형태다. */
export const BASE_FROM_GITHUB_EVENT = 'github-event';

const FULL_SHA = /^[0-9a-f]{40}$/;
const NULL_SHA = /^0{40}$/;
const BASE_FETCH_TIMEOUT_MS = 120_000;

/**
 * GitHub 이벤트에서 "이 run 이 lockfile 에 무엇을 들였나" 를 잴 기준을 고른다.
 * `{ sha }` 나 `{ branch }` 를 돌려주고, 둘 다 없으면 기준 없음 — lockfile 전체가 실패
 * 대상이다. `why` 는 로그에 그대로 찍는다.
 *
 *   push              이전 tip(`before`). 여러 커밋을 한 번에 밀어도 전부 범위에 든다 —
 *                     HEAD^1 이면 마지막 커밋만 보여 앞 커밋이 들인 것을 놓친다.
 *                     새 브랜치는 before 가 0…0 이라 기준이 없다.
 *   pull_request      `pull_request.base.sha`. 체크아웃은 base 와의 병합 커밋이다.
 *   workflow_dispatch 기본 브랜치의 지금 tip. 병합 전에 티켓 브랜치를 돌려 보는 경로라
 *                     (ci.yml workflow_dispatch 주석) 질문은 "main 에 무엇을 더하는가" 다.
 *   schedule          기준 없음 — 시간축 감사 자체다. 여기에 기준을 두면 기존 의존성에 새로
 *                     공개된 advisory 를 실패로 잡는 곳이 하나도 남지 않는다.
 *   그 밖             기준 없음.
 */
export function auditBaseFromGithubEvent(eventName, event) {
  switch (eventName) {
    case 'push': {
      const before = event?.before;
      if (typeof before === 'string' && FULL_SHA.test(before) && !NULL_SHA.test(before)) {
        return { sha: before, why: `push 이전 tip ${before.slice(0, 8)}` };
      }
      return { why: 'push 에 이전 tip 이 없다 — 새 브랜치' };
    }
    case 'pull_request': {
      const sha = event?.pull_request?.base?.sha;
      if (typeof sha === 'string' && FULL_SHA.test(sha)) {
        return { sha, why: `PR base ${sha.slice(0, 8)}` };
      }
      return { why: 'PR 이벤트에 base sha 가 없다' };
    }
    case 'workflow_dispatch': {
      const branch = event?.repository?.default_branch;
      // git 인자로 넘기므로 옵션처럼 보이는 값은 받지 않는다.
      if (typeof branch === 'string' && branch && !branch.startsWith('-')) {
        return { branch, why: `기본 브랜치 ${branch} 의 지금 tip` };
      }
      return { why: 'dispatch 이벤트에 기본 브랜치가 없다' };
    }
    case 'schedule':
      return { why: 'schedule — 시간축 감사' };
    default:
      return { why: `${eventName || 'GitHub 이벤트 없음'} — 기준을 두지 않는 실행` };
  }
}

/**
 * `git fetch` 에 붙일 depth 인자. 이미 shallow 인 저장소에서만 `--depth=1` 을 쓴다.
 *
 * CI 의 actions/checkout 은 기본이 `fetch-depth: 1` 이라 늘 shallow 다 — 거기선
 * depth 를 유지하는 게 맞다(받아올 게 커밋 하나뿐이다). 그런데 이 계열 스크립트는
 * **개발자의 완전한 클론에서도** 돈다(배포 대상이 `main` 으로 바뀐 뒤 — ticket
 * 128d62cd — audit-deploy-branch-deps 가 그렇게 됐다). 거기에 `--depth=1` 을 쓰면
 * .git/shallow 가 생기면서 로컬 이력이 커밋 하나로 잘린다 — merge-base·rebase·
 * is-ancestor 가 전부 거짓말을 시작하고, 되돌리려면 `git fetch --unshallow` 로 전부
 * 다시 받아야 한다. 감사 가드가 감사 대상 저장소를 훼손하면 안 된다.
 *
 * 판정 불가(저장소가 아님 등)면 depth 를 붙이지 않는다 — 어차피 뒤이은 fetch 가
 * 실패할 상황이고, 확신 없이 이력을 자르는 쪽보다 안전하다.
 */
export function fetchDepthArgs(cwd = root, exec = execFileSync) {
  try {
    const out = String(
      exec('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8', stdio: 'pipe' }),
    ).trim();
    return out === 'true' ? ['--depth=1'] : [];
  } catch {
    return [];
  }
}

/**
 * 기준의 package-lock.json 내용. 못 읽으면 null — 호출부는 전체 게이트로 떨어진다.
 *
 *   { sha }    가져와 본 뒤 그 sha 로 읽는다. 가져오기가 실패해도 이미 로컬에 있으면(완전한
 *              클론) 그대로 읽는다 — 정확한 커밋이라 상관없다.
 *   { branch } 가져오기가 **성공했을 때만** FETCH_HEAD 를 읽는다. 실패했는데 읽으면
 *              actions/checkout 이 남긴 FETCH_HEAD — 지금 커밋 자신 — 가 기준이 되고, 들인
 *              버전이 0개가 돼 이 변경이 들인 취약점까지 경고로 내려간다. 조용한 통과다.
 *   { ref }    가져오지 않고 로컬 ref 로 읽는다(`--base=origin/main` 같은 로컬 실행).
 */
export function readBaseLockfile(base, { exec = execFileSync, cwd = root } = {}) {
  const git = (args, extra = {}) =>
    exec('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, ...extra });
  const fetched = (target) => {
    try {
      // 멈춘 fetch 가 잡 시간 한도(6시간)까지 잡을 붙들지 않게 — 시간이 다 되면 못 가져온
      // 것으로 보고 전체 게이트로 떨어진다.
      git(['fetch', '--no-tags', ...fetchDepthArgs(cwd, exec), 'origin', target], {
        timeout: BASE_FETCH_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  };
  const show = (rev) => {
    try {
      return String(git(['show', `${rev}:package-lock.json`]));
    } catch {
      return null;
    }
  };

  if (base.ref) return show(base.ref);
  if (base.sha) {
    fetched(base.sha);
    return show(base.sha);
  }
  if (base.branch) return fetched(base.branch) ? show('FETCH_HEAD') : null;
  return null;
}

/**
 * GitHub Actions 워크플로 명령 한 줄(`::warning title=…::…`). Actions 밖에서는 null —
 * 로컬 출력에는 잡음일 뿐이다. 값은 Actions 규칙대로 이스케이프한다: 안 하면 줄바꿈에서
 * 메시지가 잘리고, 제목의 `:` `,` 가 속성 구분자로 읽힌다.
 */
export function workflowCommand(kind, title, message, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::${kind} title=${property(title)}::${data(message)}`;
}

/** findings 를 사람이 읽는 블록으로. */
export function formatFindings(findings) {
  return findings
    .map(
      (f) =>
        `  [${f.severity}] ${f.name} — ${f.title}\n` +
        `      설치됨: ${f.installedVersions.join(', ')} / 취약 범위: ${f.vulnerableVersions}\n` +
        (f.url ? `      ${f.url}\n` : ''),
    )
    .join('');
}

export function parseArgs(argv) {
  const opts = { level: DEFAULT_AUDIT_LEVEL, lockfile: join(root, 'package-lock.json'), base: null };
  for (const arg of argv) {
    const level = /^--audit-level=(.+)$/.exec(arg);
    if (level) {
      opts.level = level[1];
      continue;
    }
    const lockfile = /^--lockfile=(.+)$/.exec(arg);
    if (lockfile) {
      opts.lockfile = resolve(lockfile[1]);
      continue;
    }
    const base = /^--base=(.*)$/.exec(arg);
    if (base) {
      // git 인자로 넘기므로 옵션처럼 보이는 값은 받지 않는다.
      if (!base[1] || base[1].startsWith('-')) {
        throw new Error(`--base 값이 올바르지 않다: '${base[1]}' (${BASE_FROM_GITHUB_EVENT} 또는 git ref)`);
      }
      opts.base = base[1];
      continue;
    }
    throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!SEVERITY_ORDER.includes(opts.level)) {
    throw new Error(`알 수 없는 audit level: ${opts.level} (${SEVERITY_ORDER.join(', ')} 중 하나)`);
  }
  return opts;
}

/** GitHub Actions 이벤트 payload. 없거나 못 읽으면 null. */
function readGithubEvent(path = process.env.GITHUB_EVENT_PATH) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `--base` 를 기준 lockfile 로 푼다. 못 풀면 null — 전체 게이트다. 어느 쪽이든 왜 그렇게
 * 판정하는지 한 줄 남긴다: 조용히 전체 게이트로 떨어지면 "의존성을 안 건드렸는데 왜 red
 * 냐" 를 다시 처음부터 캐야 한다.
 */
function loadBaseLock(baseArg) {
  const base =
    baseArg === BASE_FROM_GITHUB_EVENT
      ? auditBaseFromGithubEvent(process.env.GITHUB_EVENT_NAME, readGithubEvent())
      : { ref: baseArg, why: `--base=${baseArg}` };
  const whole = 'lockfile 전체를 실패 대상으로 판정한다';
  if (!base.sha && !base.branch && !base.ref) {
    console.log(`기준 없음 (${base.why}) — ${whole}.`);
    return null;
  }
  let lock = null;
  try {
    const text = readBaseLockfile(base);
    if (text != null) {
      lock = JSON.parse(text);
      lockfilePackages(lock); // packages 맵이 없으면 비교할 수 없다 — throw
    }
  } catch {
    lock = null;
  }
  if (!lock) {
    console.log(`기준(${base.why})의 lockfile 을 읽지 못했다 — ${whole}.`);
    return null;
  }
  console.log(`기준: ${base.why} — 이 변경이 lockfile 에 들인 버전에 걸린 것만 실패시킨다.`);
  return lock;
}

/** findings 하나마다 annotation 한 줄 — 로그를 열지 않아도 run 요약에 보인다. */
function annotate(kind, title, findings) {
  for (const f of findings) {
    const line = workflowCommand(
      kind,
      title,
      `[${f.severity}] ${f.name} ${f.installedVersions.join(', ')} — ${f.title}` +
        (f.url ? ` (${f.url})` : ''),
    );
    if (line) console.log(line);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(opts.lockfile, 'utf8'));
  } catch (e) {
    console.error(`lockfile 을 읽지 못했다 (${opts.lockfile}): ${e.message}`);
    process.exit(1);
  }

  const baseLock = opts.base ? loadBaseLock(opts.base) : null;

  let result;
  try {
    result = await auditLockfile(lock, {
      level: opts.level,
      baseLock,
      onRetry: (attempt, e, label) => console.log(`재시도 ${attempt} — ${label} 실패: ${e?.message ?? e}`),
      onSourceFallback: (e) =>
        console.log(
          `npm advisory 축 실패 — GitHub Advisory Database 로 폴백한다.\n${e.message}`,
        ),
    });
  } catch (e) {
    console.error(`취약점 감사를 완료하지 못했다 — 통과시키지 않는다.\n${e.message}`);
    process.exit(1);
  }

  const { source, packageCount, versionCount, introduced } = result;
  const { blocking, preexisting } = gateFindings(result);
  const scope = `패키지 ${packageCount}개 / 버전 ${versionCount}개, 출처 ${source}`;
  const fix = `\`npm audit fix\` 는 금지 — 루트 overrides 를 날린다. 해당 의존성을 직접 올릴 것.`;

  if (preexisting.length > 0) {
    annotate('warning', '기존 의존성의 advisory — 정기 감사가 실패로 잡는다', preexisting);
    console.log(
      `경고 — 이 변경 전부터 있던 버전에 ${opts.level} 이상 advisory ${preexisting.length}건 (${scope}):\n` +
        formatFindings(preexisting) +
        `\n이 변경이 들인 버전이 아니라 이것으로는 실패시키지 않는다 — 매일 정기 감사(schedule)가 실패로 잡는다.\n${fix}`,
    );
  }

  if (blocking.length > 0) {
    annotate('error', introduced ? '이 변경이 들인 취약 버전' : '취약한 의존성', blocking);
    const head = introduced
      ? `이 변경이 들인 버전에 ${opts.level} 이상 취약점 ${blocking.length}건 ` +
        `(들인 버전 ${introduced.versionCount}개 / 전체 ${scope})`
      : `${opts.level} 이상 취약점 ${blocking.length}건 (${scope})`;
    console.error(`${head}:\n` + formatFindings(blocking) + `\n${fix}`);
    process.exit(1);
  }

  if (preexisting.length > 0) {
    console.log(
      `ok   이 변경이 들인 버전 ${introduced.versionCount}개에는 ${opts.level} 이상 취약점 0건 — ` +
        `위 ${preexisting.length}건은 기존 버전의 advisory 라 경고로만 남긴다.`,
    );
    return;
  }
  const added = introduced ? `, 이 변경이 들인 버전 ${introduced.versionCount}개` : '';
  console.log(`ok   ${opts.level} 이상 취약점 0건 — ${scope}${added}.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

#!/usr/bin/env node
/**
 * audit-lockfile-advisories.mjs
 *
 * lockfile 의 취약점 게이트. `npm audit` 을 대신해 **bulk advisory 엔드포인트를
 * 직접** 조회한다.
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
 * bulk 엔드포인트는 `{ "패키지명": ["설치된 버전", ...] }` 를 받아, **보낸 버전에
 * 실제로 걸리는** advisory 만 돌려준다. 이건 문서가 아니라 실측이다: lodash 4.17.20
 * 으로 물으면 GHSA-35jh-r3h4-6jhm(`<4.17.21`)이 오고, 4.17.21 로 물으면 그 건은 빠진
 * 채 상한이 더 높은 advisory 들만 온다. 그래서 응답에 항목이 있다는 것 자체가
 * "설치된 버전이 취약하다" 이고, 별도 semver 매칭이 필요 없다.
 *
 * ── fail-closed ──
 *
 * 네트워크·파싱 어느 단계가 실패해도 통과시키지 않는다. "확인 못 했다" 를 "문제 없다"
 * 로 바꿔 읽는 게 이 계열 가드의 가장 위험한 실패 모드다(audit-published-deps.mjs 와
 * 같은 규약). 레지스트리가 정말 죽어 있으면 다른 잡의 `npm ci` 도 같이 죽으므로,
 * 여기서만 눈감아 봐야 병합 경로가 열리지도 않는다.
 *
 * 같은 이유로 **읽어낸 패키지가 0개면 실패**한다. 파서가 조용히 망가졌을 때 "검사할
 * 대상이 없어 통과" 하는 게 이 스크립트의 유일한 무증상 실패 모드라서다.
 *
 * 라이브러리로도 쓰인다 — audit-deploy-branch-deps.mjs / audit-published-deps.mjs 가
 * 각자 확보한 lockfile 을 여기 넘긴다. 그 두 곳도 `npm audit` 을 쓰고 있었으므로 같은
 * 결함을 그대로 갖고 있었다(schedule 전용이라 병합을 막지 않았을 뿐이다).
 */

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
 * lockfile 객체 하나를 감사한다. `{ findings, packageCount, versionCount }` 를 돌려주고,
 * 취약점 유무는 호출부가 `findings.length` 로 판단한다.
 *
 * 패키지를 하나도 못 읽으면 throw 한다 — 침묵 통과 방지.
 */
export async function auditLockfile(lock, { level = DEFAULT_AUDIT_LEVEL, ...fetchOptions } = {}) {
  const byName = lockfilePackages(lock);
  if (byName.size === 0) {
    throw new Error(
      'lockfile 에서 레지스트리 패키지를 하나도 읽지 못했다 — 파서가 깨졌거나 lockfile 이 비었다',
    );
  }

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

  return {
    source,
    findings: collectFindings(report, byName, level),
    packageCount: byName.size,
    versionCount: [...byName.values()].reduce((n, s) => n + s.size, 0),
  };
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
  const opts = { level: DEFAULT_AUDIT_LEVEL, lockfile: join(root, 'package-lock.json') };
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
    throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!SEVERITY_ORDER.includes(opts.level)) {
    throw new Error(`알 수 없는 audit level: ${opts.level} (${SEVERITY_ORDER.join(', ')} 중 하나)`);
  }
  return opts;
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

  let result;
  try {
    result = await auditLockfile(lock, {
      level: opts.level,
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

  const { source, findings, packageCount, versionCount } = result;
  const scope = `패키지 ${packageCount}개 / 버전 ${versionCount}개, 출처 ${source}`;
  if (findings.length > 0) {
    console.error(
      `${opts.level} 이상 취약점 ${findings.length}건 (${scope}):\n` +
        formatFindings(findings) +
        `\n\`npm audit fix\` 는 금지 — 루트 overrides 를 날린다. 해당 의존성을 직접 올릴 것.`,
    );
    process.exit(1);
  }

  console.log(`ok   ${opts.level} 이상 취약점 0건 — ${scope}.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

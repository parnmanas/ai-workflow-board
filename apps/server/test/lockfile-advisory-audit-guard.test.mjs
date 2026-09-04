// Regression guard — ticket 1019e57d.
//
// 2026-09-04, main 을 포함한 모든 CI 가 red 가 됐다. 원인은 취약점이 아니라 npm
// 클라이언트의 폴백 정책이었다: bulk advisory 엔드포인트가 흔들리면 npm 10 이
// **은퇴 대상인 quick 엔드포인트로 폴백**하는데, 그쪽은 이 저장소의 workspaces
// lockfile 에 400 Invalid package tree 를 돌려준다 — 폴백이 성공할 수 있는 경우가
// 없어서, bulk 가 한 번 흔들리면 잡이 확정적으로 죽는다.
//
// 이 파일이 지키는 것은 두 가지다.
//
//   1) **감사 로직 자신** — scripts/audit-lockfile-advisories.mjs. 이 계열 가드의
//      가장 위험한 실패 모드는 시끄럽게 죽는 게 아니라 **조용히 통과**하는 것이다:
//      lockfile 파서가 망가져 패키지를 0개 읽으면 "검사할 대상이 없어 통과" 가 되고,
//      아무도 눈치채지 못한 채 취약점 게이트만 사라진다. 그래서 파서가 실제 lockfile
//      에서 패키지를 읽어내는지, 0개면 실제로 실패하는지, 조회 실패를 통과로 바꿔
//      읽지 않는지를 직접 단언한다.
//
//   2) **ci.yml 의 스텝 순서** — 이번 사고의 절반은 순서 결함이었다. 네트워크에
//      의존하는 `npm audit` 이 첫 스텝이라 그게 죽자 뒤따르는 공급망 가드 5종이
//      전부 skipped 됐다(run 33823224505 실측). 순서는 주석으로만 지켜지지 않으므로
//      "오프라인 가드보다 앞에 네트워크 스텝이 오면 실패" 를 여기서 강제한다.
//
// 앱 부팅도 서브프로세스도 없다 — 순수 로직 + 문자열 파싱이고, 네트워크는 전부
// 주입한 fetch 로 대체한다. 매 `npm test` 에 싸다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  SEVERITY_ORDER,
  atOrAboveLevel,
  auditLockfile,
  bulkPayload,
  collectFindings,
  fetchAdvisories,
  lockfilePackages,
  packageNameFromKey,
  parseArgs,
} from '../../../scripts/audit-lockfile-advisories.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const readCi = () => fs.readFileSync(CI_YML, 'utf8');
const readRealLock = () =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

/** 성공 응답 하나를 돌려주는 fetch 대역. */
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

// ───────────────────────── lockfile 파서 ─────────────────────────

test('실제 package-lock.json 에서 레지스트리 패키지를 다수 읽어낸다', () => {
  const byName = lockfilePackages(readRealLock());
  assert.ok(
    byName.size > 100,
    `패키지를 ${byName.size}개만 읽었다 — 파서가 깨지면 검사 대상 없이 침묵 통과한다`,
  );
  // 워크스페이스 자신은 레지스트리 패키지가 아니다.
  assert.equal(byName.has('server'), false);
  assert.equal(byName.has('awb-agent-manager'), false);
});

test('alias 엔트리는 키가 아니라 name 필드의 실제 패키지명으로 물어본다', () => {
  const byName = lockfilePackages(readRealLock());
  // node_modules/string-width-cjs 는 string-width 의 alias 설치다. 키로만 유추하면
  // 존재하지 않는 패키지를 물어보게 되고 그 패키지의 advisory 는 영영 안 걸린다.
  assert.ok(byName.has('string-width'), 'alias 대상 string-width 가 없다');
  assert.equal(byName.has('string-width-cjs'), false, 'alias 키를 패키지명으로 썼다');
});

test('루트·워크스페이스·link·비HTTP resolved 는 제외한다', () => {
  const byName = lockfilePackages({
    packages: {
      '': { name: 'root', version: '1.0.0' },
      'apps/server': { name: 'server', version: '1.0.0' },
      'node_modules/server': { link: true, resolved: 'apps/server' },
      'node_modules/from-git': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/x/y.git#abc',
      },
      'node_modules/from-file': { version: '1.0.0', resolved: 'file:../tarball.tgz' },
      'node_modules/no-version': { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' },
      'node_modules/real': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/real/-/real-2.0.0.tgz',
      },
    },
  });
  assert.deepEqual([...byName.keys()], ['real']);
  assert.deepEqual([...byName.get('real')], ['2.0.0']);
});

test('같은 패키지의 중첩 사본은 버전 집합으로 합쳐진다', () => {
  const reg = (n, v) => ({ version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` });
  const byName = lockfilePackages({
    packages: {
      'node_modules/ajv': reg('ajv', '8.0.0'),
      'node_modules/x/node_modules/ajv': reg('ajv', '6.12.6'),
    },
  });
  assert.deepEqual([...byName.get('ajv')].sort(), ['6.12.6', '8.0.0']);
  assert.deepEqual(bulkPayload(byName), { ajv: ['6.12.6', '8.0.0'] });
});

test('packageNameFromKey — 중첩·scoped·node_modules 없는 키', () => {
  assert.equal(packageNameFromKey('node_modules/lodash'), 'lodash');
  assert.equal(packageNameFromKey('node_modules/a/node_modules/@scope/b'), '@scope/b');
  // 워크스페이스 디렉터리 키. 잘라내기 산술로 엉뚱한 이름을 만들면 안 된다.
  assert.equal(packageNameFromKey('apps/server'), null);
  assert.equal(packageNameFromKey(''), null);
});

test('packages 맵이 없는 lockfile 은 통과가 아니라 예외다', () => {
  assert.throws(() => lockfilePackages({ lockfileVersion: 1 }), /packages 맵이 없다/);
});

// ───────────────────────── 심각도 판정 ─────────────────────────

test('atOrAboveLevel 은 npm 과 같은 심각도 순서를 쓴다', () => {
  assert.deepEqual(SEVERITY_ORDER, ['info', 'low', 'moderate', 'high', 'critical']);
  assert.equal(atOrAboveLevel('low', 'moderate'), false);
  assert.equal(atOrAboveLevel('moderate', 'moderate'), true);
  assert.equal(atOrAboveLevel('critical', 'moderate'), true);
  assert.equal(atOrAboveLevel('info', 'low'), false);
});

test('모르는 심각도는 통과가 아니라 최고 등급으로 취급한다 (fail-closed)', () => {
  // 레지스트리가 새 등급을 도입했을 때 조용히 빠져나가면 게이트가 사라진다.
  assert.equal(atOrAboveLevel('catastrophic', 'critical'), true);
  assert.equal(atOrAboveLevel(undefined, 'moderate'), true);
});

test('알 수 없는 audit level 은 조용히 무시하지 않는다', () => {
  assert.throws(() => atOrAboveLevel('high', 'severe'), /알 수 없는 audit level/);
  assert.throws(() => parseArgs(['--audit-level=severe']), /알 수 없는 audit level/);
  assert.throws(() => parseArgs(['--nope']), /알 수 없는 인자/);
});

// ───────────────────────── findings ─────────────────────────

const advisory = (severity, over = {}) => ({
  severity,
  title: `${severity} 문제`,
  url: `https://example.test/${severity}`,
  vulnerable_versions: '<9.9.9',
  ...over,
});

test('collectFindings 는 문턱 미만을 걸러내고 심각도 내림차순으로 정렬한다', () => {
  const byName = new Map([
    ['a', new Set(['1.0.0'])],
    ['b', new Set(['2.0.0'])],
    ['c', new Set(['3.0.0'])],
  ]);
  const findings = collectFindings(
    { a: [advisory('low')], b: [advisory('critical')], c: [advisory('moderate')] },
    byName,
    'moderate',
  );
  assert.deepEqual(
    findings.map((f) => [f.name, f.severity]),
    [
      ['b', 'critical'],
      ['c', 'moderate'],
    ],
  );
  assert.deepEqual(findings[0].installedVersions, ['2.0.0']);
  assert.equal(findings[0].vulnerableVersions, '<9.9.9');
});

test('collectFindings 는 빈 응답과 배열 아닌 값에 넘어지지 않는다', () => {
  assert.deepEqual(collectFindings({}, new Map(), 'moderate'), []);
  assert.deepEqual(collectFindings({ a: null }, new Map(), 'moderate'), []);
});

// ───────────────────────── 재시도 / fail-closed ─────────────────────────

test('일시적 실패는 재시도로 흡수한다 — 이번 사고에서 실제로 필요한 동작', async () => {
  let calls = 0;
  const retries = [];
  const body = await fetchAdvisories(
    { lodash: ['4.17.21'] },
    {
      attempts: 4,
      timeoutMs: 50,
      backoffMs: () => 0,
      onRetry: (n) => retries.push(n),
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error('The operation was aborted due to timeout');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
  );
  assert.deepEqual(body, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test('기본 재시도 예산은 주석에 적힌 그대로다 (문서-코드 드리프트 차단)', () => {
  // 이 숫자들은 실측으로 정한 값이라 주석에 근거가 붙어 있다. 코드만 바뀌고 주석이
  // 남으면 다음 사람이 잘못된 근거를 읽게 되므로 여기서 값을 고정한다.
  assert.equal(DEFAULT_ATTEMPTS, 4);
  assert.equal(DEFAULT_TIMEOUT_MS, 90_000);
  assert.deepEqual([1, 2, 3].map(DEFAULT_BACKOFF_MS), [5000, 20_000, 30_000]);
  // 최악의 경우 벽시계 상한 — 다른 잡(약 10분)보다 짧게 유지한다.
  const worstMs = DEFAULT_ATTEMPTS * DEFAULT_TIMEOUT_MS +
    [1, 2, 3].map(DEFAULT_BACKOFF_MS).reduce((a, b) => a + b, 0);
  assert.ok(worstMs < 8 * 60_000, `최악 ${Math.round(worstMs / 1000)}s — 너무 길다`);
});

test('전부 실패하면 통과시키지 않고 시도별 사유를 남긴다 (fail-closed)', async () => {
  let calls = 0;
  await assert.rejects(
    fetchAdvisories(
      { lodash: ['4.17.21'] },
      {
        attempts: 3,
        timeoutMs: 50,
        backoffMs: () => 0,
        fetchImpl: async () => {
          calls += 1;
          throw new Error('Service Unavailable');
        },
      },
    ),
    (e) => {
      assert.match(e.message, /3회 모두 실패/);
      assert.equal(e.attemptErrors.length, 3);
      assert.match(e.attemptErrors[0], /Service Unavailable/);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('HTTP 오류 응답을 빈 결과로 읽지 않는다', async () => {
  // 503 본문이 JSON 이라 json() 이 성공해도 통과시키면 안 된다 — 이번 사고의 첫
  // 관측치가 정확히 `{ error: 'Service Unavailable' }` 였다.
  await assert.rejects(
    fetchAdvisories(
      {},
      {
        attempts: 1,
        timeoutMs: 50,
        backoffMs: () => 0,
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ error: 'Service Unavailable' }),
        }),
      },
    ),
    /HTTP 503/,
  );
});

test('객체가 아닌 응답은 실패로 취급한다', async () => {
  await assert.rejects(
    fetchAdvisories(
      {},
      {
        attempts: 1,
        timeoutMs: 50,
        backoffMs: () => 0,
        fetchImpl: okFetch([{ nope: true }]),
      },
    ),
    /응답이 객체가 아니다/,
  );
});

// ───────────────────────── auditLockfile ─────────────────────────

test('패키지를 하나도 못 읽으면 침묵 통과가 아니라 실패다', async () => {
  let fetched = false;
  await assert.rejects(
    auditLockfile(
      { packages: { '': { name: 'root' }, 'apps/server': { name: 'server' } } },
      {
        fetchImpl: async () => {
          fetched = true;
          return { ok: true, status: 200, json: async () => ({}) };
        },
      },
    ),
    /레지스트리 패키지를 하나도 읽지 못했다/,
  );
  assert.equal(fetched, false, '패키지가 없는데 엔드포인트를 때렸다');
});

test('취약 패키지가 있으면 findings 로 드러난다', async () => {
  const lock = {
    packages: {
      'node_modules/lodash': {
        version: '4.17.20',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
      },
    },
  };
  let sent;
  const result = await auditLockfile(lock, {
    level: 'moderate',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ lodash: [advisory('high')] }) };
    },
  });
  assert.deepEqual(sent, { lodash: ['4.17.20'] });
  assert.equal(result.packageCount, 1);
  assert.equal(result.versionCount, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'high');
});

test('advisory 가 없으면 findings 는 비고 패키지 수는 실제로 센 값이다', async () => {
  const reg = (n, v) => ({ version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` });
  const result = await auditLockfile(
    { packages: { 'node_modules/a': reg('a', '1.0.0'), 'node_modules/b': reg('b', '2.0.0') } },
    { fetchImpl: okFetch({}) },
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.packageCount, 2);
});

// ───────────────────── ci.yml 스텝 순서 회귀 가드 ─────────────────────

const AUDIT_JOB = 'dependency-audit';

/**
 * ci.yml 의 한 잡에서 `- name:` / `run:` 쌍을 **선언 순서대로** 뽑는다.
 * 파서가 조용히 0개를 읽으면 아래 검사가 전부 공허해지므로, 호출부에서 개수를
 * 먼저 단언한다.
 */
export function jobRunSteps(yml, jobName) {
  const start = yml.indexOf(`\n  ${jobName}:\n`);
  if (start < 0) return [];
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  const block = next < 0 ? rest : rest.slice(0, next);

  const steps = [];
  const re = /^ {6}- name: (.+)$\n(?:^ {8}(?!run:).*$\n)*^ {8}run: (.+)$/gm;
  for (const m of block.matchAll(re)) steps.push({ name: m[1].trim(), run: m[2].trim() });
  return steps;
}

/**
 * 오프라인 가드 **허용목록**. 분류를 denylist(=네트워크 스크립트 열거)로 짜면 안 된다:
 * 사고 당시의 첫 스텝은 `npm audit` 이었고, 스크립트 이름 목록으로는 그게 네트워크
 * 스텝인 줄 몰라 가드가 통째로 공허하게 통과한다(실제로 이 파일 초안이 그랬다).
 *
 * 그래서 반대로 간다 — 여기 적힌 것만 오프라인이고 **나머지는 전부 네트워크로
 * 간주**한다. 새 오프라인 가드를 추가하면 이 목록에도 넣어야 하고, 그 강제가 곧
 * "새 가드를 네트워크 스텝 앞에 두라" 는 리마인더가 된다.
 */
const OFFLINE_GUARD_SCRIPTS = [
  'audit-install-scripts.mjs',
  'audit-action-pins.mjs',
  'audit-ci-branch-coverage.mjs',
  'audit-cron-coverage.mjs',
];
const isOfflineStep = (step) =>
  OFFLINE_GUARD_SCRIPTS.some((s) => step.run.includes(s)) ||
  // audit-published-deps 는 --offline 일 때만 오프라인이다.
  (step.run.includes('audit-published-deps.mjs') && step.run.includes('--offline'));

test('ci.yml 의 dependency-audit 잡 스텝을 실제로 읽어낸다 (파서 공허성 차단)', () => {
  const steps = jobRunSteps(readCi(), AUDIT_JOB);
  assert.ok(
    steps.length >= 7,
    `run 스텝을 ${steps.length}개만 읽었다 — 파서가 깨지면 아래 순서 검사가 전부 공허하게 통과한다`,
  );
  assert.ok(
    steps.some((s) => s.run.includes('audit-install-scripts.mjs')),
    `install-script 가드 스텝을 못 읽었다: ${steps.map((s) => s.run).join(' | ')}`,
  );
});

/** 첫 네트워크 스텝 뒤에 남아 있는 오프라인 가드들. 있으면 그게 곧 결함이다. */
function strandedOfflineGuards(steps) {
  const firstNetwork = steps.findIndex((s) => !isOfflineStep(s));
  if (firstNetwork < 0) return null; // 네트워크 스텝이 하나도 없다
  return steps.slice(firstNetwork + 1).filter(isOfflineStep);
}

test('네트워크 감사보다 뒤에 오프라인 가드가 남아 있으면 안 된다', () => {
  const steps = jobRunSteps(readCi(), AUDIT_JOB);
  const stranded = strandedOfflineGuards(steps);
  assert.notEqual(stranded, null, '네트워크 감사 스텝이 아예 없다 — 취약점 게이트가 사라졌다');
  assert.deepEqual(
    stranded.map((s) => s.name),
    [],
    '네트워크 스텝이 죽으면 이 오프라인 가드들이 skipped 된다 — 앞으로 옮길 것 (ticket 1019e57d)',
  );
});

test('사고 당시의 실제 ci.yml 을 넣으면 이 가드가 FAIL 한다 (가드의 공허성 차단)', () => {
  // affb2266 의 dependency-audit 잡을 그대로 재현한다 — 첫 스텝이 `npm audit` 이고
  // 오프라인 가드 5종이 그 뒤에 줄줄이 있었다. 이 형태를 못 잡으면 가드가 무의미하다.
  const broken = `
  ${AUDIT_JOB}:
    name: dependency audit
    steps:
      - name: npm audit (moderate 이상 실패)
        run: npm audit --audit-level=moderate
      - name: install-script 허용목록 가드
        run: node scripts/audit-install-scripts.mjs
      - name: 액션 SHA 고정 가드
        run: node scripts/audit-action-pins.mjs
      - name: 발행 패키지 선언 범위 가드
        run: node scripts/audit-published-deps.mjs --offline

  other-job:
`;
  const steps = jobRunSteps(broken, AUDIT_JOB);
  assert.equal(steps.length, 4, '픽스처 파싱이 안 됐다');
  assert.deepEqual(
    strandedOfflineGuards(steps).map((s) => s.name),
    ['install-script 허용목록 가드', '액션 SHA 고정 가드', '발행 패키지 선언 범위 가드'],
    '깨진 순서를 넣었는데도 가드가 아무것도 못 잡는다 — 검사가 공허하다',
  );
});

test('모르는 명령은 오프라인으로 가정하지 않는다 (분류가 fail-closed)', () => {
  // `npm audit` 처럼 목록에 없는 명령을 오프라인으로 취급하면 가드가 통째로 공허해진다.
  assert.equal(isOfflineStep({ name: 'x', run: 'npm audit --audit-level=moderate' }), false);
  assert.equal(isOfflineStep({ name: 'x', run: 'curl https://example.test' }), false);
  assert.equal(isOfflineStep({ name: 'x', run: 'node scripts/audit-published-deps.mjs' }), false);
  assert.equal(
    isOfflineStep({ name: 'x', run: 'node scripts/audit-published-deps.mjs --offline' }),
    true,
  );
  assert.equal(isOfflineStep({ name: 'x', run: 'node scripts/audit-cron-coverage.mjs' }), true);
});

test('ci.yml 은 취약점 게이트로 audit-lockfile-advisories.mjs 를 돌린다', () => {
  const steps = jobRunSteps(readCi(), AUDIT_JOB);
  const gate = steps.find((s) => s.run.includes('audit-lockfile-advisories.mjs'));
  assert.ok(gate, '취약점 감사 스텝이 없다');
  assert.match(gate.run, /--audit-level=moderate/, '문턱이 moderate 가 아니다');
});

test('ci.yml 에 `npm audit` 직접 호출이 다시 들어오지 않는다', () => {
  // 되돌아가면 죽은 quick 엔드포인트 폴백 경로로 복귀한다 (ticket 1019e57d).
  const offenders = readCi()
    .split('\n')
    .filter((l) => /^\s*run:.*\bnpm audit\b/.test(l));
  assert.deepEqual(offenders, []);
});

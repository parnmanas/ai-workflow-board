// publish 시점 버전 자동계산(scripts/compute-publish-version.mjs)의 순수 로직 커버리지.
// (ticket 433f6cbd, source c17a8a40, board lesson #1/#3)
//
// 핵심 3가지:
//   1. semver 를 '숫자'로 비교/증가 (문자열이면 1.6.10 < 1.6.9 로 뒤집힘).
//   2. npm view --json 결과를 found / not_found(E404) / error 로 정확히 분류 —
//      **명시적 E404 만** seed 폴백 허용, 나머지(E401/네트워크/5xx/빈출력)는 error
//      로 fail-closed.
//   3. decideVersion: 태그(멱등) > E404 seed > gitHead provenance 복구 > latest+patch.
//
// npm/git 을 부르는 임퓨어 경로(main/resolveAction)는 워크플로 dry-run + 실배포 1회로
// 검증하고, 여기서는 네트워크 없이 결정적인 순수 함수만 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseVersion, compareVersions, bumpPatch, classifyNpmView, classifyPublishGuard, decideVersion } =
  await import('../scripts/compute-publish-version.mjs');

// ─── semver ───────────────────────────────────────────────────────────────

test('parseVersion: x.y.z → 숫자 3튜플, prerelease/build 꼬리 제거', () => {
  assert.deepEqual(parseVersion('1.6.28'), [1, 6, 28]);
  assert.deepEqual(parseVersion(' 1.6.28 '), [1, 6, 28]);
  assert.deepEqual(parseVersion('1.6.28-rc.1'), [1, 6, 28]);
  assert.deepEqual(parseVersion('2.0.0+build.5'), [2, 0, 0]);
});

test('parseVersion: 형식 어긋나면 throw', () => {
  assert.throws(() => parseVersion('1.6'), /파싱 불가/);
  assert.throws(() => parseVersion('1.6.x'), /파싱 불가/);
  assert.throws(() => parseVersion(''), /파싱 불가/);
});

test('parseVersion: strict semver core — parseInt 느슨함 거부 (오염 태그 방어)', () => {
  // 예전 parseInt 구현은 앞 숫자만 읽어 아래 값들을 조용히 통과시켰다.
  assert.throws(() => parseVersion('1x.2.3'), /파싱 불가/, 'major 에 붙은 잡문자 거부');
  assert.throws(() => parseVersion('1.2.3foo'), /파싱 불가/, 'patch 뒤 -/+ 없는 잡문자 거부');
  assert.throws(() => parseVersion('1.2.3.4'), /파싱 불가/, '식별자 4개 거부');
  assert.throws(() => parseVersion('v1.2.3'), /파싱 불가/, '접두 v 거부');
  assert.throws(() => parseVersion('01.2.3'), /파싱 불가/, 'leading zero 거부 (semver)');
  assert.throws(() => parseVersion('1.02.3'), /파싱 불가/, 'leading zero(minor) 거부');
  // 유효한 형태는 계속 통과.
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('10.20.30'), [10, 20, 30]);
  assert.deepEqual(parseVersion('1.2.3-rc.1'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3+build.5'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.0.0'), [0, 0, 0]);
});

test('compareVersions: 두 자리 수는 숫자로 비교 (문자열 함정 방지)', () => {
  assert.equal(compareVersions('1.6.10', '1.6.9'), 1);
  assert.equal(compareVersions('1.6.9', '1.6.10'), -1);
  assert.equal(compareVersions('1.6.100', '1.6.99'), 1);
  assert.equal(compareVersions('1.6.28', '1.6.28'), 0);
});

test('bumpPatch: patch +1, major/minor 유지', () => {
  assert.equal(bumpPatch('1.6.28'), '1.6.29');
  assert.equal(bumpPatch('1.6.9'), '1.6.10', '두 자리 경계');
  assert.equal(bumpPatch('1.9.99'), '1.9.100');
  assert.equal(bumpPatch('2.0.0'), '2.0.1');
  assert.equal(bumpPatch(' 1.6.28-rc.1 '), '1.6.29', 'prerelease 꼬리는 무시하고 core 만');
});

// ─── classifyNpmView ────────────────────────────────────────────────────────

test('classifyNpmView: 성공 스칼라(JSON 문자열) → found', () => {
  assert.deepEqual(classifyNpmView({ status: 0, stdout: '"1.6.28"\n', stderr: '' }), {
    kind: 'found',
    value: '1.6.28',
  });
});

test('classifyNpmView: gitHead SHA → found', () => {
  const sha = '1529c1ee3da84e63c7521464fe386743a28d836d';
  assert.deepEqual(classifyNpmView({ status: 0, stdout: `"${sha}"\n`, stderr: '' }), {
    kind: 'found',
    value: sha,
  });
});

test('classifyNpmView: 다중 매치 배열 → 마지막 값 found', () => {
  assert.deepEqual(
    classifyNpmView({ status: 0, stdout: '["1.6.27","1.6.28"]', stderr: '' }),
    { kind: 'found', value: '1.6.28' },
  );
});

test('classifyNpmView: --json 아닌 bare 출력도 방어적으로 found', () => {
  assert.deepEqual(classifyNpmView({ status: 0, stdout: '1.6.28\n', stderr: '' }), {
    kind: 'found',
    value: '1.6.28',
  });
});

test('classifyNpmView: 패키지 미존재 E404 → not_found', () => {
  const stdout = JSON.stringify({
    error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/awb-agent-manager-xyz - Not found' },
  });
  assert.deepEqual(classifyNpmView({ status: 1, stdout, stderr: '' }), { kind: 'not_found' });
});

test('classifyNpmView: 버전 미존재 E404 (idempotency 게이트) → not_found', () => {
  const stdout = JSON.stringify({
    error: { code: 'E404', summary: 'No match found for version 99.99.99' },
  });
  assert.deepEqual(classifyNpmView({ status: 1, stdout, stderr: '' }), { kind: 'not_found' });
});

test('classifyNpmView: E404 아닌 npm 에러(E401 인증) → error (fail-closed)', () => {
  const stdout = JSON.stringify({ error: { code: 'E401', summary: 'Unauthorized' } });
  const r = classifyNpmView({ status: 1, stdout, stderr: '' });
  assert.equal(r.kind, 'error');
  assert.match(r.detail, /E401/);
});

test('classifyNpmView: JSON 없는 네트워크 실패 → error (fail-closed)', () => {
  const r = classifyNpmView({
    status: 1,
    stdout: '',
    stderr: 'npm error network request to https://registry.npmjs.org failed, reason: ETIMEDOUT',
  });
  assert.equal(r.kind, 'error');
  assert.match(r.detail, /ETIMEDOUT|network/);
});

test('classifyNpmView: exit 0 인데 빈 출력 → error (조용한 seed 폴백 금지)', () => {
  const r = classifyNpmView({ status: 0, stdout: '\n', stderr: '' });
  assert.equal(r.kind, 'error');
});

// ─── classifyPublishGuard (publish 직전 존재 재확인 게이트) ───────────────────
//
// fail-closed 계약: '미존재'는 오직 명시적 E404 로만 성립. E401/네트워크/5xx 는
// 절대 '미존재'로 오인해 publish 를 강행하지 않는다. exit 0=진행 / 2=fail-closed /
// 3=선점. (probe-exists 서브커맨드가 이 판정을 그대로 exit 코드로 쓴다.)

test('classifyPublishGuard: E404 not_found → proceed (code 0, 아직 미존재 → publish)', () => {
  const d = classifyPublishGuard({ kind: 'not_found' }, '1.6.29');
  assert.equal(d.proceed, true);
  assert.equal(d.code, 0);
});

test('classifyPublishGuard: found → 선점 실패 (code 3, 덮어쓰기 거부)', () => {
  const d = classifyPublishGuard({ kind: 'found', value: '1.6.29' }, '1.6.29');
  assert.equal(d.proceed, false);
  assert.equal(d.code, 3);
  assert.match(d.message, /덮어쓰기 거부|idempotency/);
});

test('classifyPublishGuard: E401 인증 오류 → fail-closed (code 2, publish 진행 안 함)', () => {
  // 예전 `npm view … 2>/dev/null || true` 는 이걸 '미존재'로 오인했다 — 여기서 막는다.
  const cls = classifyNpmView({
    status: 1,
    stdout: JSON.stringify({ error: { code: 'E401', summary: 'Unauthorized' } }),
    stderr: '',
  });
  const d = classifyPublishGuard(cls, '1.6.29');
  assert.equal(d.proceed, false, 'E401 은 절대 publish 진행으로 새면 안 된다');
  assert.equal(d.code, 2);
  assert.match(d.message, /fail-closed/);
});

test('classifyPublishGuard: 네트워크 실패(ETIMEDOUT) → fail-closed (code 2)', () => {
  const cls = classifyNpmView({
    status: 1,
    stdout: '',
    stderr: 'npm error network request to https://registry.npmjs.org failed, reason: ETIMEDOUT',
  });
  const d = classifyPublishGuard(cls, '1.6.29');
  assert.equal(d.proceed, false, '네트워크 오류를 미존재로 오인하면 안 된다');
  assert.equal(d.code, 2);
});

test('classifyPublishGuard: 5xx/빈출력(성공했지만 빈 출력) → fail-closed (code 2)', () => {
  const cls = classifyNpmView({ status: 0, stdout: '\n', stderr: '' });
  const d = classifyPublishGuard(cls, '1.6.29');
  assert.equal(d.proceed, false);
  assert.equal(d.code, 2);
});

test('classifyPublishGuard: classification 자체가 없으면 → fail-closed (code 2)', () => {
  const d = classifyPublishGuard(undefined, '1.6.29');
  assert.equal(d.proceed, false);
  assert.equal(d.code, 2);
});

// ─── decideVersion ──────────────────────────────────────────────────────────

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('decideVersion: HEAD 태그가 있으면 그 버전 (멱등 1차 근거)', () => {
  const r = decideVersion({
    tagVersionOnHead: '1.6.29',
    latest: { kind: 'found', value: '1.6.40' }, // 태그가 우선 — latest 무시
    latestGitHead: OTHER,
    headSha: HEAD,
    seed: '1.6.28',
  });
  assert.deepEqual(r, { version: '1.6.29', reason: 'tag' });
});

test('decideVersion: 최초 배포(E404) → seed 를 그대로', () => {
  const r = decideVersion({
    tagVersionOnHead: null,
    latest: { kind: 'not_found' },
    latestGitHead: null,
    headSha: HEAD,
    seed: '1.6.28',
  });
  assert.deepEqual(r, { version: '1.6.28', reason: 'seed' });
});

test('decideVersion: latest 조회 error → throw (fail-closed, seed 로 안 샌다)', () => {
  assert.throws(
    () =>
      decideVersion({
        tagVersionOnHead: null,
        latest: { kind: 'error', detail: 'E401: Unauthorized' },
        latestGitHead: null,
        headSha: HEAD,
        seed: '1.6.28',
      }),
    /fail-closed/,
  );
});

test('decideVersion: latest.gitHead == HEAD → provenance 복구 (범프 안 함)', () => {
  const r = decideVersion({
    tagVersionOnHead: null,
    latest: { kind: 'found', value: '1.6.29' },
    latestGitHead: HEAD, // 이 커밋이 이미 1.6.29 를 publish 했고 태그만 실패
    headSha: HEAD,
    seed: '1.6.28',
  });
  assert.deepEqual(r, { version: '1.6.29', reason: 'provenance' });
});

test('decideVersion: 정상 신규 → latest + patch', () => {
  const r = decideVersion({
    tagVersionOnHead: null,
    latest: { kind: 'found', value: '1.6.28' },
    latestGitHead: OTHER, // 다른 커밋 산출물
    headSha: HEAD,
    seed: '1.6.28',
  });
  assert.deepEqual(r, { version: '1.6.29', reason: 'bump' });
});

test('decideVersion: latest 있고 gitHead 를 못 읽으면(null) 정상 bump', () => {
  const r = decideVersion({
    tagVersionOnHead: null,
    latest: { kind: 'found', value: '1.6.28' },
    latestGitHead: null,
    headSha: HEAD,
    seed: '1.6.28',
  });
  assert.deepEqual(r, { version: '1.6.29', reason: 'bump' });
});

test('decideVersion: 두 자리 patch 경계에서 숫자 증가', () => {
  const r = decideVersion({
    tagVersionOnHead: null,
    latest: { kind: 'found', value: '1.6.9' },
    latestGitHead: OTHER,
    headSha: HEAD,
    seed: '1.6.0',
  });
  assert.equal(r.version, '1.6.10');
});

test('decideVersion: 최초 배포인데 seed 가 깨졌으면 throw', () => {
  assert.throws(
    () =>
      decideVersion({
        tagVersionOnHead: null,
        latest: { kind: 'not_found' },
        latestGitHead: null,
        headSha: HEAD,
        seed: 'not-a-version',
      }),
    /파싱 불가/,
  );
});

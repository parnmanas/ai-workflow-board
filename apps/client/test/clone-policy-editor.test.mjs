// Repo clone 정책 에디터 폼 로직 (ticket bddb63ee).
//
// 이 폼이 결정하는 것은 단 하나 — **무엇이 저장 payload 에 들어가는가** 다. 빈 칸은
// "미지정"이라 키 자체가 빠져야 하고(그래야 Repo Resource → Workspace → 시스템
// 기본값 순으로 흘러내린다), 0 은 "미지정"이 아니라 유효한 값이다(idle 비활성).
// 이 둘을 뭉개면 사용자가 idle 을 끈 저장소가 조용히 기본값 600초로 되돌아간다.
//
// 컴포넌트가 실제로 import 하는 모듈(clonePolicy.logic.ts)을 그대로 검증한다 —
// 이 저장소에는 jsdom 이 없어 React 밖으로 뺀 구현이며, 테스트용 복제본이 아니다
// (environmentConfig.logic.ts 와 같은 관례, 루트 CLAUDE.md 참고).
//
// Run: node --import tsx --test apps/client/test/clone-policy-editor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CLONE_POLICY_FORM,
  clonePolicyToForm,
  clonePolicyFormFromRaw,
  formToClonePolicy,
} from '../src/components/clonePolicy.logic.ts';

// ── LOAD: 저장된 정책 → 폼 ───────────────────────────────────────────────────

test('load: 정책 없음 / 깨진 원문은 빈 폼이 된다', () => {
  assert.deepEqual(clonePolicyToForm(null), EMPTY_CLONE_POLICY_FORM);
  assert.deepEqual(clonePolicyToForm(undefined), EMPTY_CLONE_POLICY_FORM);
  for (const raw of [null, undefined, '', '{bad json', '42', '"str"']) {
    assert.deepEqual(clonePolicyFormFromRaw(raw), EMPTY_CLONE_POLICY_FORM, `raw=${raw}`);
  }
});

test('load: 지정된 키만 칸에 채워지고 나머지는 빈 칸으로 남는다', () => {
  // 미지정 키를 기본값 문자열로 채우면, 저장 시 그 값이 "명시적 override" 로
  // 굳어져 상위 기본값 상속이 조용히 끊긴다.
  const form = clonePolicyToForm({ clone_timeout_seconds: 7200, single_branch: true });
  assert.deepEqual(form, {
    timeout: '7200',
    idleTimeout: '',
    depth: '',
    filter: '',
    singleBranch: true,
  });
});

test('load: idle 0(비활성)은 빈 칸이 아니라 "0" 으로 살아난다', () => {
  assert.equal(clonePolicyToForm({ clone_idle_timeout_seconds: 0 }).idleTimeout, '0');
});

test('load: Workspace 행처럼 원문 JSON 으로 저장된 정책도 읽는다', () => {
  const raw = JSON.stringify({ clone_depth: 1, clone_filter: 'blob:none' });
  const form = clonePolicyFormFromRaw(raw);
  assert.equal(form.depth, '1');
  assert.equal(form.filter, 'blob:none');
  assert.equal(form.timeout, '', '지정하지 않은 키는 빈 칸');
});

// ── SAVE: 폼 → 저장 payload ─────────────────────────────────────────────────

test('save: 전부 빈 폼은 null(정책 제거)이다', () => {
  const r = formToClonePolicy(EMPTY_CLONE_POLICY_FORM);
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

test('save: 빈 칸은 payload 에서 키 자체가 빠진다 (상위 기본값 상속)', () => {
  const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, timeout: '7200' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { clone_timeout_seconds: 7200 });
  assert.ok(!('clone_idle_timeout_seconds' in r.value), 'idle 은 미지정이므로 키가 없어야 한다');
  assert.ok(!('single_branch' in r.value), '체크 해제는 false 가 아니라 미지정이다');
});

test('save: idle 0 은 미지정과 구분되어 payload 에 실린다', () => {
  const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, idleTimeout: '0' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { clone_idle_timeout_seconds: 0 });
});

test('save: 다섯 설정이 모두 지정되면 그대로 실린다', () => {
  const r = formToClonePolicy({
    timeout: '7200', idleTimeout: '900', depth: '1', filter: 'blob:none', singleBranch: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    clone_timeout_seconds: 7200,
    clone_idle_timeout_seconds: 900,
    clone_depth: 1,
    clone_filter: 'blob:none',
    single_branch: true,
  });
});

test('save: 공백만 있는 칸은 미지정으로 취급한다', () => {
  const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, timeout: '   ', filter: '  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

// ── SAVE 게이트: 잘못된 입력은 저장 자체를 막는다 ────────────────────────────

test('save: 범위를 벗어나거나 정수가 아닌 값은 어느 칸인지 알려주며 거부한다', () => {
  const rejected = [
    [{ timeout: '30' }, /Clone timeout/],
    [{ timeout: '90000' }, /Clone timeout/],
    [{ timeout: '1.5' }, /정수/],
    [{ timeout: '-60' }, /정수/],
    [{ idleTimeout: '99999999' }, /Idle timeout/],
    [{ depth: '0' }, /Depth/],
    [{ depth: 'abc' }, /정수/],
  ];
  for (const [patch, pattern] of rejected) {
    const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, ...patch });
    assert.equal(r.ok, false, `허용되면 안 됨: ${JSON.stringify(patch)}`);
    assert.match(r.error, pattern);
  }
});

test('save: `-` 로 시작하는 filter 는 거부한다 (git argv 주입 차단)', () => {
  // 이 값이 그대로 저장되면 agent-manager 가 `--filter=--upload-pack=…` 을 argv 에
  // 실어 git 플래그로 해석될 수 있다. 서버·매니저에도 같은 화이트리스트가 있지만,
  // 폼에서 먼저 막아야 사용자가 원인을 알 수 있다.
  for (const filter of ['--upload-pack=evil', '-x', 'blob none', 'x'.repeat(65)]) {
    const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, filter });
    assert.equal(r.ok, false, `허용되면 안 됨: ${filter}`);
    assert.match(r.error, /Filter/);
  }
});

test('save: 유효한 partial-clone filter 형태는 통과한다', () => {
  for (const filter of ['blob:none', 'tree:0', 'blob:limit=1m', 'combine:blob:none+tree:0']) {
    const r = formToClonePolicy({ ...EMPTY_CLONE_POLICY_FORM, filter });
    assert.equal(r.ok, true, `거부되면 안 됨: ${filter}`);
    assert.equal(r.value.clone_filter, filter);
  }
});

// ── 왕복 ────────────────────────────────────────────────────────────────────

test('왕복: 저장 → 로드 → 저장이 같은 payload 를 낸다', () => {
  const original = {
    clone_timeout_seconds: 5400,
    clone_idle_timeout_seconds: 0,
    clone_depth: 25,
    clone_filter: 'tree:0',
    single_branch: true,
  };
  const again = formToClonePolicy(clonePolicyToForm(original));
  assert.equal(again.ok, true);
  assert.deepEqual(again.value, original);
});

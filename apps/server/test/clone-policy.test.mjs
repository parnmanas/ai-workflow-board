// Repo Resource별 clone 정책 — 스키마/해석/배선 (ticket bddb63ee).
//
// 대형 저장소가 고정 wall-clock timeout 때문에 clone 실패하지 않도록, clone 예산과
// 전략을 Repo Resource 에 저장하고 dispatch 에서 해석해 agent-manager 로 보낸다.
// 여기서 검증하는 것:
//   (a) 시스템 기본값은 clone timeout 60분(3600초)뿐이고 idle 은 비활성이다
//   (b) 우선순위가 Repo Resource → Workspace → 시스템 기본값이며 **키 단위**다
//   (c) 두 레이어 모두 비면 null — "override 없음"(구버전 매니저와 동일 동작)
//   (d) parse 는 읽기 경로라 깨진 행에서도 throw 하지 않고 null 로 degrade 한다
//   (e) validate 는 범위/형식 위반과 미지의 키를 거부해 쓰기 경로가 400 할 수 있다
//   (f) 해석 결과가 실제로 dispatch / run 프로비저닝에 배선돼 있다
//
// SSE 프레임 자체(agent_trigger 의 map + flatten)에 clone_policy 가 실리는지는
// event-registry-payload-parity-guard.test.mjs 의 canonical 목록에서 잠근다 —
// 여기서 중복 검사하면 두 목록이 갈라질 수 있어 그쪽 한 곳으로 모았다.
//
// dist/ 의 컴파일 산출물을 import 한다(`npm run build` 필요).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLONE_POLICY_KEYS,
  DEFAULT_CLONE_TIMEOUT_SECONDS,
  DEFAULT_CLONE_IDLE_TIMEOUT_SECONDS,
  parseClonePolicy,
  resolveClonePolicy,
  serializeClonePolicy,
  validateClonePolicyInput,
} from '../dist/common/clone-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

// ── (a) 시스템 기본값 ────────────────────────────────────────────────────────

test('시스템 기본값은 clone timeout 60분(3600초) 하나뿐이고 idle 은 비활성이다', () => {
  // 리뷰 지적 2 — 티켓이 시스템 기본값으로 명시한 것은 wall timeout 3600초뿐이다.
  // idle 을 기본으로 켜면 "설정이 없는 기존 저장소는 60분 기본값으로 clone" 이라는
  // 완료 조건을 깬다(진행률이 정상적으로 오래 멈추는 구간에서 끊길 수 있음).
  assert.equal(DEFAULT_CLONE_TIMEOUT_SECONDS, 3600);
  assert.equal(DEFAULT_CLONE_IDLE_TIMEOUT_SECONDS, 0);
});

test('설정이 없는 저장소: 한쪽만 지정해도 나머지 키는 시스템 기본값으로 채워진다', () => {
  const resolved = resolveClonePolicy(JSON.stringify({ clone_depth: 1 }), null);
  assert.equal(resolved.clone_timeout_seconds, 3600, '지정하지 않은 timeout 은 60분');
  assert.equal(resolved.clone_idle_timeout_seconds, 0, '지정하지 않은 idle 은 비활성');
  assert.equal(resolved.clone_depth, 1);
  assert.equal(resolved.clone_filter, null);
  assert.equal(resolved.single_branch, false);
});

test('idle 은 명시 지정했을 때만 켜진다 (opt-in)', () => {
  // Workspace 만 지정 / Resource 만 지정 / 둘 다 미지정 세 경우를 모두 고정한다.
  assert.equal(
    resolveClonePolicy(null, JSON.stringify({ clone_idle_timeout_seconds: 900 })).clone_idle_timeout_seconds,
    900, 'Workspace 가 켜면 켜진다',
  );
  assert.equal(
    resolveClonePolicy(JSON.stringify({ clone_idle_timeout_seconds: 300 }), JSON.stringify({ clone_idle_timeout_seconds: 900 })).clone_idle_timeout_seconds,
    300, 'Resource 값이 Workspace 를 덮는다',
  );
  assert.equal(
    resolveClonePolicy(JSON.stringify({ clone_idle_timeout_seconds: 0 }), JSON.stringify({ clone_idle_timeout_seconds: 900 })).clone_idle_timeout_seconds,
    0, 'Resource 가 명시적으로 0 을 주면 Workspace 의 idle 을 끈다',
  );
  assert.equal(
    resolveClonePolicy(JSON.stringify({ clone_timeout_seconds: 7200 }), null).clone_idle_timeout_seconds,
    0, '아무도 지정하지 않으면 비활성',
  );
});

// ── (b)(c) 우선순위 ──────────────────────────────────────────────────────────

test('우선순위: Repo Resource 가 Workspace 기본값을 키 단위로 덮는다', () => {
  const resource = JSON.stringify({ clone_timeout_seconds: 7200 });
  const workspace = JSON.stringify({ clone_timeout_seconds: 1800, clone_depth: 50, single_branch: true });
  const resolved = resolveClonePolicy(resource, workspace);
  assert.equal(resolved.clone_timeout_seconds, 7200, 'Resource 값이 이긴다');
  assert.equal(resolved.clone_depth, 50, 'Resource 가 지정하지 않은 키는 Workspace 값을 상속한다');
  assert.equal(resolved.single_branch, true);
  assert.equal(resolved.clone_idle_timeout_seconds, 0, '양쪽 다 없으면 시스템 기본값(비활성)');
});

test('우선순위: Repo Resource 만 있어도, Workspace 만 있어도 동작한다', () => {
  assert.equal(resolveClonePolicy(JSON.stringify({ clone_filter: 'blob:none' }), null).clone_filter, 'blob:none');
  assert.equal(resolveClonePolicy(null, JSON.stringify({ clone_filter: 'tree:0' })).clone_filter, 'tree:0');
});

test('하위 호환: 두 레이어 모두 비어 있으면 null(=override 없음)', () => {
  // null 은 SSE 에 그대로 실려 agent-manager 가 자신의 기본값을 쓰게 한다 —
  // 그 기본값이 같은 시스템 기본값이므로 구버전 매니저와 동작이 동일하다.
  assert.equal(resolveClonePolicy(null, null), null);
  assert.equal(resolveClonePolicy('', undefined), null);
  assert.equal(resolveClonePolicy('{}', '{}'), null, '빈 객체는 정책 없음으로 접힌다');
});

// ── (d) 읽기 경로: 절대 throw 하지 않는다 ────────────────────────────────────

test('parse: 깨진 행 / 스키마 위반은 throw 없이 null 로 degrade 한다', () => {
  for (const raw of [null, undefined, '', 'not json', '{"clone_depth":', '[]', '"str"',
    JSON.stringify({ clone_timeout_seconds: 'x' }),
    JSON.stringify({ unknown_key: 1 }),
    JSON.stringify({ clone_filter: '--upload-pack=evil' })]) {
    assert.equal(parseClonePolicy(raw), null, `${String(raw)} → null`);
  }
  // 정상 행은 그대로 살아난다.
  assert.deepEqual(parseClonePolicy(JSON.stringify({ single_branch: true })), { single_branch: true });
});

test('parse: 스키마 위반 행이 있어도 resolve 는 시스템 기본값으로 이어진다', () => {
  // 손상된 Resource 행 + 정상 Workspace 행 → Workspace 값이 살아남는다.
  const resolved = resolveClonePolicy('not json', JSON.stringify({ clone_timeout_seconds: 5400 }));
  assert.equal(resolved.clone_timeout_seconds, 5400);
});

// ── (e) 쓰기 경로 검증 ───────────────────────────────────────────────────────

test('validate: 범위를 벗어난 값과 미지의 키를 거부한다', () => {
  const rejected = [
    { clone_timeout_seconds: 30 },        // 하한 60초 미만
    { clone_timeout_seconds: 90000 },     // 상한 24시간 초과
    { clone_idle_timeout_seconds: -1 },
    { clone_depth: 0 },
    { clone_depth: 1.5 },
    { clone_filter: '--upload-pack=evil' },  // `-` 로 시작 → argv 주입 위험
    { clone_filter: 'blob none' },
    { single_branch: 'yes' },
    { setup_commands: ['rm -rf /'] },        // strict: 미지의 키
  ];
  for (const input of rejected) {
    const r = validateClonePolicyInput(input);
    assert.equal(r.ok, false, `허용되면 안 됨: ${JSON.stringify(input)}`);
    assert.match(r.error, /Invalid clone_policy/);
  }
});

test('validate: 유효한 정책은 통과하고, 0(idle 비활성)은 유효값이다', () => {
  const r = validateClonePolicyInput({
    clone_timeout_seconds: 7200,
    clone_idle_timeout_seconds: 0,
    clone_depth: 1,
    clone_filter: 'blob:none',
    single_branch: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.clone_idle_timeout_seconds, 0);
  // idle 0 은 유효값이며, 시스템 기본값도 0(비활성)이라 두 경로가 같은 결과를 낸다.
  assert.equal(resolveClonePolicy(serializeClonePolicy(r.value), null).clone_idle_timeout_seconds, 0);
});

test('serialize: 빈 정책은 null 로 접히고, 왕복이 보존된다', () => {
  assert.equal(serializeClonePolicy(null), null);
  assert.equal(serializeClonePolicy({}), null);
  const policy = { clone_timeout_seconds: 7200, clone_filter: 'blob:none' };
  assert.deepEqual(parseClonePolicy(serializeClonePolicy(policy)), policy);
});

test('CLONE_POLICY_KEYS 는 요구된 5개 설정을 전부 담는다', () => {
  assert.deepEqual([...CLONE_POLICY_KEYS].sort(), [
    'clone_depth',
    'clone_filter',
    'clone_idle_timeout_seconds',
    'clone_timeout_seconds',
    'single_branch',
  ]);
});

// ── (f) SSE 배선 정적 가드 ───────────────────────────────────────────────────

test('SSE 배선: dispatch 가 base_repo Resource 의 정책을 workspace 기본값과 합쳐 emit 한다', () => {
  const src = fs.readFileSync(path.join(SRC, 'modules/agents/trigger-loop.service.ts'), 'utf8');
  assert.match(src, /resolveClonePolicy\(baseRepoClonePolicyRaw, runtimeWorkspace\?\.clone_policy\)/,
    'Resource ⊕ Workspace 병합 지점이 사라졌다');
  assert.match(src, /clone_policy: clonePolicy/, 'emit payload 에 clone_policy 가 없다');
});

test('SSE 배선: QA/Action run 프로비저닝도 같은 정책을 실어 보낸다', () => {
  const src = fs.readFileSync(path.join(SRC, 'common/run-workspace-resolver.ts'), 'utf8');
  assert.match(src, /clone_policy/, 'buildRunProvision 이 clone_policy 를 채우지 않는다');
});

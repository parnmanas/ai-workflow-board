// Artifact 패널 순수 상태 리듀서 회귀 테스트 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
//
// 미러가 아니라 ArtifactPanelContext 가 실제로 import 하는 src/contexts/artifactPanel.ts
// 를 그대로 구동한다. 열림/접힘 전이나 "close 는 내용을 유지" 규약을 오배선하면 이
// 테스트가 실패한다(S3 에서 티켓 상세를 주입해도 프레임 동작은 이 계약을 따른다).
//
// 실행:  node --import tsx --test apps/client/test/artifact-panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  artifactPanelReducer,
  initialArtifactPanelState,
  clampArtifactPanelWidth,
  ARTIFACT_PANEL_MIN_WIDTH,
  ARTIFACT_PANEL_MAX_WIDTH,
  ARTIFACT_PANEL_DEFAULT_WIDTH,
} from '../src/contexts/artifactPanel.ts';

const TICKET = { key: 'ticket:abc', title: 'ABC 티켓' };
const OTHER = { key: 'ticket:def', title: 'DEF 티켓' };

// ─── 1. 초기 상태 ─────────────────────────────────────────────────────────────

test('초기 상태: 닫힘 + 대상 없음', () => {
  assert.deepEqual(initialArtifactPanelState, { open: false, artifact: null });
});

// ─── 2. open ──────────────────────────────────────────────────────────────────

test('open: 패널을 열고 대상을 담는다', () => {
  const next = artifactPanelReducer(initialArtifactPanelState, { type: 'open', artifact: TICKET });
  assert.equal(next.open, true);
  assert.equal(next.artifact, TICKET);
});

test('open: 이미 열린 상태에서 다른 대상으로 교체', () => {
  const opened = artifactPanelReducer(initialArtifactPanelState, { type: 'open', artifact: TICKET });
  const swapped = artifactPanelReducer(opened, { type: 'open', artifact: OTHER });
  assert.equal(swapped.open, true);
  assert.equal(swapped.artifact, OTHER);
});

// ─── 3. close ─────────────────────────────────────────────────────────────────

test('close: 숨기되 내용(artifact)은 유지 — 재오픈/애니메이션 깜빡임 방지', () => {
  const opened = artifactPanelReducer(initialArtifactPanelState, { type: 'open', artifact: TICKET });
  const closed = artifactPanelReducer(opened, { type: 'close' });
  assert.equal(closed.open, false);
  assert.equal(closed.artifact, TICKET, 'close 는 마지막 대상을 유지해야 한다');
});

test('close: 이미 닫혀 있으면 동일 참조를 반환(불필요 렌더 방지)', () => {
  const closedAgain = artifactPanelReducer(initialArtifactPanelState, { type: 'close' });
  assert.equal(closedAgain, initialArtifactPanelState);
});

// ─── 4. toggle ────────────────────────────────────────────────────────────────

test('toggle: 닫힘→열림 (대상 없으면 빈 상태로 열림)', () => {
  const next = artifactPanelReducer(initialArtifactPanelState, { type: 'toggle' });
  assert.equal(next.open, true);
  assert.equal(next.artifact, null);
});

test('toggle: 열림→닫힘 (내용 유지)', () => {
  const opened = artifactPanelReducer(initialArtifactPanelState, { type: 'open', artifact: TICKET });
  const toggled = artifactPanelReducer(opened, { type: 'toggle' });
  assert.equal(toggled.open, false);
  assert.equal(toggled.artifact, TICKET);
});

// ─── 5. 불변성 ────────────────────────────────────────────────────────────────

test('리듀서는 입력 상태를 변조하지 않는다', () => {
  const frozen = Object.freeze({ ...initialArtifactPanelState });
  assert.doesNotThrow(() => artifactPanelReducer(frozen, { type: 'open', artifact: TICKET }));
});

// ─── 6. 폭 clamp (티켓 7815a958) ───────────────────────────────────────────────

test('clamp: 범위 내 값은 반올림만 적용', () => {
  assert.equal(clampArtifactPanelWidth(400), 400);
  assert.equal(clampArtifactPanelWidth(400.4), 400);
  assert.equal(clampArtifactPanelWidth(400.6), 401);
});

test('clamp: 최소치 미만은 최소치로', () => {
  assert.equal(clampArtifactPanelWidth(0), ARTIFACT_PANEL_MIN_WIDTH);
  assert.equal(clampArtifactPanelWidth(-100), ARTIFACT_PANEL_MIN_WIDTH);
  assert.equal(clampArtifactPanelWidth(ARTIFACT_PANEL_MIN_WIDTH - 1), ARTIFACT_PANEL_MIN_WIDTH);
});

test('clamp: 최대치 초과는 최대치로', () => {
  assert.equal(clampArtifactPanelWidth(9999), ARTIFACT_PANEL_MAX_WIDTH);
  assert.equal(clampArtifactPanelWidth(ARTIFACT_PANEL_MAX_WIDTH + 1), ARTIFACT_PANEL_MAX_WIDTH);
});

test('clamp: NaN/Infinity 등 비유한값은 기본폭으로 폴백', () => {
  assert.equal(clampArtifactPanelWidth(NaN), ARTIFACT_PANEL_DEFAULT_WIDTH);
  assert.equal(clampArtifactPanelWidth(Infinity), ARTIFACT_PANEL_DEFAULT_WIDTH);
  assert.equal(clampArtifactPanelWidth(-Infinity), ARTIFACT_PANEL_DEFAULT_WIDTH);
});

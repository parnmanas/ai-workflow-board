// 워크스페이스 설정 · 어시스턴트 지정 뷰 렌더 계약 테스트 (에픽 bf65ca00 · Phase 1 · S2).
//
// 순수 <AssistantAgentSettingView> 의 옵션(지정 안 함 + 적격 에이전트)·빈 상태·무효
// 지정 경고·저장 버튼 dirty 게이팅을 react-dom/server 로 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/assistant-agent-setting-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssistantAgentSettingView } from '../src/components/chat/AssistantAgentSetting.tsx';

const noop = () => {};
const render = (props) =>
  renderToStaticMarkup(
    React.createElement(AssistantAgentSettingView, {
      agents: [],
      value: '',
      dirty: false,
      saving: false,
      onChange: noop,
      onSave: noop,
      ...props,
    }),
  );

const agents = [
  { id: 'a1', name: 'Rolf/AWB' },
  { id: 'a2', name: 'Rolf/AWB.Reviewer' },
];

test('적격 에이전트 목록 → 지정 안 함 + 각 에이전트 옵션 + 저장 버튼', () => {
  const html = render({ agents });
  assert.match(html, /지정 안 함/);
  assert.match(html, /Rolf\/AWB<\/option>|Rolf\/AWB"|Rolf\/AWB</); // 옵션 라벨 존재
  assert.match(html, /Rolf\/AWB\.Reviewer/);
  assert.match(html, /저장/);
});

test('에이전트 없음 + 지정값 없음 → 빈 상태 안내', () => {
  const html = render({ agents: [] });
  assert.match(html, /지정 가능한 활성 에이전트가 없습니다/);
});

test('무효 지정(value 가 목록에 없음) → 경고 alert', () => {
  const html = render({ agents, value: 'gone' });
  assert.match(html, /role="alert"/);
  assert.match(html, /사용할 수 없습니다/);
});

test('dirty=false → 저장 버튼 disabled', () => {
  const html = render({ agents, value: 'a1', dirty: false });
  assert.match(html, /disabled/);
});

test('dirty=true + saving → 저장 중 문구', () => {
  const html = render({ agents, value: 'a1', dirty: true, saving: true });
  assert.match(html, /저장 중/);
});

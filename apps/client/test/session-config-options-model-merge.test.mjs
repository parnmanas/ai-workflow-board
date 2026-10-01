// 세션 **안**의 설정 드롭다운은 살아 있는 어댑터가 보고한 것만 보여준다.
//
// 이 파일은 원래 그 반대를 고정하고 있었다. "새 세션 대화상자와 세션 안 목록이
// 다르다" 는 신고를 받고, 세션 안 드롭다운에도 호스트 전체 모델 합집합
// (useHostModels + withHostModelOption)을 머지해 둘을 같게 만들었다. 그건 틀린
// 수정이었고 실제로 에러를 만들었다:
//
//   이 드롭다운은 목록이 아니라 **조작기**다. 고른 값은 그대로 ACP
//   `session/set_config_option` 으로 가고(agent-session-runner.ts #setConfigOption),
//   매니저는 그 값을 검증 없이 어댑터에 넘긴다. 어댑터가 자기가 보고하지 않은
//   모델 id 를 받으면 거절한다 — 그래서 머지로 덧붙인 `claude-opus-5-5` 를 고르면
//   "Failed to change the setting" 이 떴다.
//
// 두 화면의 목록이 **다른 것은 결함이 아니다**: 새 세션 대화상자는 "무엇으로
// 띄울지" 를 고르는 자리라 호스트 전체 합집합이 맞고, 세션 안은 "지금 이 연결이
// 받아들이는 것" 만이 맞다. 원래 신고의 진짜 원인은 호스트 열거 쪽이었다 —
// Windows 에서 160바이트 npm shim 을 스캔해 매치 0개를 얻고 하드코딩 폴백으로
// 내려가던 것(커밋 cc3dd106 에서 수정). 그쪽을 고치자 두 목록이 실제로 맞았다.
//
// 그래서 여기서 고정하는 것은 "두 목록을 같게 만들지 말 것" 이다.
// 실행: node --import tsx --test apps/client/test/session-config-options-model-merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/sessions/SessionsPage.tsx', import.meta.url),
  'utf8',
);

test('세션 안 설정은 어댑터가 보고한 config_options 를 그대로 쓴다', () => {
  assert.match(source, /const configOptions = live\?\.config_options \?\? \[\];/);
});

test('세션 화면은 호스트 모델 합집합을 드롭다운에 섞지 않는다 — 고르면 어댑터가 거절한다', () => {
  // 조작기에 "띄울 때 고를 수 있는 것" 을 섞으면 누를 수 있는데 실패하는 선택지가 생긴다.
  assert.doesNotMatch(source, /withHostModelOption/);
  assert.doesNotMatch(source, /useHostModels/);
});

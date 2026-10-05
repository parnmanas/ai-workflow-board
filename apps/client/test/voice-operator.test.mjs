// Operators(이름 붙은 Agent Session) 화면 쪽 규칙 회귀 테스트 — docs/voice-operator.md "Operator".
// 실행: node --import tsx --test apps/client/test/voice-operator.test.mjs
//
// 고정하는 것:
//   1. operator 는 (Host, CLI, 세션 id) 셋이 모두 같은 세션이다 — CLI 만 달라도 다른 세션이다.
//   2. operator 지침은 그 이름으로 불린다는 것, 말로 듣는 답(요약 먼저), 음성 인식 오류 되묻기, 되돌리기
//      어려운 일의 복창 확인, 그리고 **문맥으로 대화의 끝을 알아보고 잠들기 표시를 붙이는 규칙**을 담는다.
//      지침 파일은 **없거나 예전 operator 지침 파일일 때만** 쓰게 한다(저장소 안 세션이 그 저장소의 AGENTS.md 를
//      덮어쓰지 않게, 예전 지침 파일에는 이름·잠들기 규칙이 따라오게).
import test from 'node:test';
import assert from 'node:assert/strict';

import { operatorBrief, operatorForSession, parseAliasInput } from '../src/voice/operator.ts';
import { OPERATOR_REPORT_PREFIX, SLEEP_MARKER, splitSleepMarker } from '../src/voice/wake.logic.ts';

const op = (id, managerId, cli, sessionId) => ({
  id, name: id, aliases: [], manager_id: managerId, cli, session_id: sessionId, cwd: '', title: '', created_at: '', created_by: '', updated_at: '',
});
const list = [op('jarvis', 'host-1', 'claude', 's1'), op('friday', 'host-2', 'codex', 's2')];

test('an operator is exactly one (host, cli, session) triple', () => {
  assert.equal(operatorForSession(list, 'host-1', 'claude', 's1')?.id, 'jarvis');
  assert.equal(operatorForSession(list, 'host-2', 'codex', 's2')?.id, 'friday');
  assert.equal(operatorForSession(list, 'host-1', 'codex', 's1'), null);
  assert.equal(operatorForSession(list, 'host-2', 'claude', 's1'), null);
  assert.equal(operatorForSession([], 'host-1', 'claude', 's1'), null);
});

test('the brief names the operator and carries the voice rules', () => {
  const brief = operatorBrief('자비스');
  assert.match(brief, /operator "자비스"/);
  assert.match(brief, /"헤이 자비스"/);
  assert.match(brief, /요약을 1~3문장/);
  assert.match(brief, /rolf\/ralf\/ragnar/);
  assert.match(brief, /복창하고 "네" 같은 명시적인 확인/);
  assert.match(brief, /파일이 \*\*없거나\*\*, 첫 줄에 "AWB Operator 지침" 이 들어 있는/);
  assert.match(brief, /\*\*다른 내용의 AGENTS\.md 는 건드리지 말고\*\*/);
});

test('the brief teaches the sleep marker by context — and the screen understands what it teaches', () => {
  const brief = operatorBrief('자비스');
  assert.ok(brief.includes(SLEEP_MARKER), 'the brief spells the exact marker the screen looks for');
  assert.match(brief, /문맥으로 판단한다/);
  assert.match(brief, /"고마워, 그리고 하나 더" 처럼 이어지는 말이면 붙이지 않는다/);
  assert.equal(splitSleepMarker(`알겠습니다. ${SLEEP_MARKER}`).sleep, true);
});

test('the brief tells the operator how to answer AWB work reports — and not to act on them alone', () => {
  const brief = operatorBrief('자비스');
  assert.ok(brief.includes(`"${OPERATOR_REPORT_PREFIX}" 로 시작하는 메시지`), 'the brief names the exact prefix the server sends');
  assert.match(brief, /먼저 사용자에게 알림음만 전달된다/);
  assert.match(brief, /요청하면 그때 어느 장비의 어느 세션이 어떻게 됐는지 설명한다/);
  assert.match(brief, /보고만 보고 다른 세션에 작업을 시키거나 무엇을 승인하지 않는다/);
});

test('the brief teaches spoken choices: read them numbered, pass the pick on with the AWB tools', () => {
  const brief = operatorBrief('자비스');
  assert.match(brief, /상세를 요청한 뒤.*번호 붙은 선택지를 읽어 준다/);
  assert.match(brief, /answer_session_permission \/ answer_session_question 도구로 그 세션에 전하고/);
  assert.match(brief, /list_pending_session_requests 로 확인하고/);
  assert.match(brief, /사용자의 말 없이 전하는 호출은 AWB 도 거절한다/);
  // 실측: 가짜 마이크의 "1번." 을 ragnar ASR 이 "일반." 으로 적었다 — 숫자만 들었으면 확인부터.
  assert.match(brief, /1번 → "일반"/);
  assert.match(brief, /전하기 전에 "1번, 이번만 허용으로 전할까요\?" 처럼 한 번 확인하고 "네" 를 들은 뒤 전한다/);
});

test('aliases are typed comma-separated', () => {
  assert.deepEqual(parseAliasInput(' Jarvis, 쟈비스 ,, 자 비스\n'), ['Jarvis', '쟈비스', '자 비스']);
  assert.deepEqual(parseAliasInput(''), []);
});

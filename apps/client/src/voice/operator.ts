import { useEffect, useState } from 'react';
import { api } from '../api';
import type { VoiceOperator } from '../types';

/**
 * Operator — 사이트를 관리하는 에이전트 하나(docs/voice-operator.md "Operator").
 *
 * 실체는 고정(pin)된 Agent Session 이다. 운영자가 원하는 Runtime Host · CLI 로 세션을 열고(실행은
 * agent-manager) 세션 화면에서 "Operator" 로 지정하면, 사이드바의 OPERATOR 가 어디서든 그 세션을 연다.
 * CLI 를 바꾸고 싶으면 다른 CLI 로 세션을 열어 다시 지정한다.
 */

export const OPERATOR_CHANGED_EVENT = 'awb:voice-operator-changed';

let cache: Promise<VoiceOperator | null> | null = null;

export function loadVoiceOperator(force = false): Promise<VoiceOperator | null> {
  if (!cache || force) cache = api.getVoiceOperator().then((r) => r.operator).catch(() => null);
  return cache;
}

export function useVoiceOperator(enabled = true): VoiceOperator | null {
  const [operator, setOperator] = useState<VoiceOperator | null>(null);
  useEffect(() => {
    if (!enabled) { setOperator(null); return; }
    let alive = true;
    const load = (force: boolean) => { void loadVoiceOperator(force).then((op) => { if (alive) setOperator(op); }); };
    load(false);
    const onChanged = () => load(true);
    window.addEventListener(OPERATOR_CHANGED_EVENT, onChanged);
    return () => { alive = false; window.removeEventListener(OPERATOR_CHANGED_EVENT, onChanged); };
  }, [enabled]);
  return operator;
}

export function announceOperatorChanged(): void {
  cache = null;
  window.dispatchEvent(new Event(OPERATOR_CHANGED_EVENT));
}

export function isOperatorSession(op: VoiceOperator | null, managerId: string, cli: string, sessionId: string): boolean {
  return !!op && op.manager_id === managerId && op.cli === cli && op.session_id === sessionId;
}

/**
 * operator 로 지정할 때 세션에 보내는 지침. 말로 대화하는 에이전트라는 것(답의 맨 앞에 귀로 들을 요약),
 * 음성 인식 오류(비슷한 발음의 호스트 이름)를 되묻는 것, 되돌리기 어려운 일은 복창 확인을 받는 것이 핵심이다.
 *
 * 지침을 파일로 남기라고 하되 **없을 때만** 만들게 한다 — operator 세션이 저장소 안에서 돌면 그
 * 저장소의 AGENTS.md 를 덮어쓰면 안 된다.
 */
export const OPERATOR_BRIEF = `[AWB Operator 지침]
너는 이 AWB(AI Workflow Board) 사이트 전체를 관리하는 operator 다. 사용자는 주로 말로 묻고, 너의 답은 소리로 읽힌다.

말하는 방식
- 답의 맨 앞에 귀로 들을 요약을 1~3문장으로 쓴다. 표·코드·긴 목록·ID·경로는 그 요약에 넣지 않는다.
- 표, 링크, 코드, ID 같은 상세는 요약 뒤에 화면용으로 덧붙인다.
- 사용자의 말은 음성 인식을 거친 글이다. 비슷한 발음(특히 rolf/ralf/ragnar, PR 번호, 숫자)이 잘못 들렸을 수 있으니, 애매하면 추측하지 말고 되묻는다.

일하는 방식
- AWB 를 다루는 일은 AWB MCP 도구(awb)로 한다: 보드·티켓·세션·오케스트레이션 미션·스케줄 등.
- 오래 걸리는 일은 시작한다고 짧게 말하고 진행한다. 턴이 끝나면 AWB 가 사용자에게 소리로 알린다.
- 지우기·머지·배포·재시작·권한이나 키 변경처럼 되돌리기 어려운 일은, 실행 전에 무엇을 할지 한 문장으로 복창하고 "네" 같은 명시적인 확인을 받은 뒤에만 한다.
- 확인한 사실과 추측을 구분해서 말한다.

이 지침을 잊지 않도록, 지금 작업 폴더에 AGENTS.md 가 **없을 때만** 이 지침으로 새로 만들어 두라(CLAUDE.md 도 없으면 \`@AGENTS.md\` 한 줄로 만든다). 이미 있으면 건드리지 말고 그렇다고만 말하라. 끝나면 준비됐다고 한 문장으로 답하라.`;

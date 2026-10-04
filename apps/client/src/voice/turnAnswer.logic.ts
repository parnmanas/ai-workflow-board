import type { AgentSessionEventRecord } from '../types';

/**
 * 한 턴에서 "읽어 줄 답" 을 고른다.
 *
 * 턴의 텍스트는 도구 호출 사이사이에 끼어 온다 — "확인해 볼게요" → tool → "티켓이 3개네요" →
 * tool → "정리하면 …". 귀로 들을 것은 **마지막 덩어리**다. 도구·권한 요청·질문·plan 이 덩어리를
 * 끊고, 그 사이의 텍스트가 하나의 덩어리가 된다. 답을 쓰고 나서 정리용 도구(todo 완료 표시 등)로
 * 턴을 끝내는 경우가 흔하므로, 마지막 덩어리가 비어 있으면 **비어 있지 않은 마지막 덩어리**를 쓴다.
 *
 * `tool_update` 는 덩어리를 끊지 않는다 — 진행 중인 도구의 갱신이 답 뒤에 늦게 도착할 수 있고,
 * 그걸로 답을 잃으면 안 된다.
 */

const SEGMENT_BREAKS = new Set(['tool_call', 'permission_request', 'elicitation_request', 'plan']);

function lastNonEmpty(segments: string[]): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const text = segments[i].trim();
    if (text) return text;
  }
  return '';
}

/** 기록(history + live)에서 한 턴의 읽을 답. 없으면 ''. */
export function turnAnswerText(events: AgentSessionEventRecord[], turnId: string): string {
  const segments: string[] = [''];
  for (const ev of events) {
    if (ev.turn_id !== turnId) continue;
    if (ev.type === 'text') segments[segments.length - 1] += String(ev.payload?.text ?? '');
    else if (SEGMENT_BREAKS.has(ev.type)) segments.push('');
  }
  return lastNonEmpty(segments);
}

export interface FinishedTurnAnswer {
  turnId: string;
  stopReason: string;
  answer: string;
}

/**
 * 라이브 스트림을 따라가며 턴마다 덩어리를 모으고, 턴이 끝나는 순간 답을 내놓는다.
 * 화면의 이벤트 배열(창 상한으로 앞이 잘린다)과 무관하게 동작해서, 아주 긴 턴의 답도 놓치지 않는다.
 */
export class TurnAnswerTracker {
  #turns = new Map<string, string[]>();

  /** 이벤트 하나를 먹인다. 턴 종료 이벤트면 그 턴의 답을 돌려주고 상태를 비운다. */
  push(ev: AgentSessionEventRecord | null | undefined): FinishedTurnAnswer | null {
    if (!ev || !ev.turn_id) return null;
    const turnId = ev.turn_id;
    if (ev.type === 'turn') {
      if (ev.payload?.phase !== 'finished') return null;
      const segments = this.#turns.get(turnId) ?? [];
      this.#turns.delete(turnId);
      return { turnId, stopReason: String(ev.payload?.stop_reason || 'end_turn'), answer: lastNonEmpty(segments) };
    }
    if (ev.type !== 'text' && !SEGMENT_BREAKS.has(ev.type)) return null;
    let segments = this.#turns.get(turnId);
    if (!segments) {
      segments = [''];
      this.#turns.set(turnId, segments);
    }
    if (ev.type === 'text') segments[segments.length - 1] += String(ev.payload?.text ?? '');
    else segments.push('');
    return null;
  }

  reset(): void {
    this.#turns.clear();
  }
}

/** 사용자가 멈춘 턴은 읽지 않는다 — 끊은 것은 듣지 않겠다는 뜻이다. */
export function shouldSpeakFinishedTurn(turn: FinishedTurnAnswer): boolean {
  return !!turn.answer && turn.stopReason !== 'cancelled';
}

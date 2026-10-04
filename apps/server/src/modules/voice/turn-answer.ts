/**
 * 세션 턴에서 "읽어 줄 답" 을 고르는 규칙 — 서버 쪽 사본.
 *
 * 화면은 같은 규칙(`apps/client/src/voice/turnAnswer.logic.ts`)으로 보고 있는 세션의 답을 읽고,
 * 서버는 이것으로 **보고 있지 않을 때의 음성 알림**에 답의 첫머리를 싣는다. 두 앱이 코드를 나눠
 * 쓰지 않으므로 사본이 둘이다 — 어긋나지 않게 `apps/client/test/voice-turn-answer.test.mjs` 가 두
 * 구현을 같은 입력으로 돌려 결과가 같은지 확인한다.
 *
 * 규칙: 턴의 텍스트는 도구·권한 요청·질문·plan 사이사이에 끼어 온다. 귀로 들을 것은 **마지막
 * 덩어리**이고, 답 뒤에 정리용 도구로 끝난 턴은 비어 있지 않은 마지막 덩어리다. `tool_update` 는
 * 덩어리를 끊지 않는다(늦게 온 갱신 때문에 답을 잃지 않게).
 */

export interface TurnEvent {
  turn_id: string;
  type: string;
  payload?: Record<string, any> | null;
}

export interface FinishedTurnAnswer {
  turnId: string;
  stopReason: string;
  answer: string;
}

const SEGMENT_BREAKS = new Set(['tool_call', 'permission_request', 'elicitation_request', 'plan']);

/** 끝나지 않은 채 버려진 턴(프로세스 사망 등)이 쌓이지 않게 — 오래된 것부터 버린다. */
const MAX_OPEN_TURNS = 200;

function lastNonEmpty(segments: string[]): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const text = segments[i].trim();
    if (text) return text;
  }
  return '';
}

export class TurnAnswerTracker {
  #turns = new Map<string, string[]>();

  push(ev: TurnEvent | null | undefined): FinishedTurnAnswer | null {
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
      if (this.#turns.size > MAX_OPEN_TURNS) {
        const oldest = this.#turns.keys().next().value;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
    }
    if (ev.type === 'text') segments[segments.length - 1] += String(ev.payload?.text ?? '');
    else segments.push('');
    return null;
  }
}

import type { AnnouncementLanguage } from './announcement-text';

/**
 * 재시작으로 끊긴 세션 — 순수 규칙(docs/voice-operator.md "재시작으로 끊긴 작업"). 배달·재개는
 * InterruptedSessionsService.
 *
 * agent-manager 업데이트(또는 restart_manager)는 더 이상 진행 중인 작업이 끝나길 기다리지 않는다. 매니저가
 * 재시작 직전에 끊길 작업을 저장했다가 새 프로세스가 연결되면 AWB 에 넘기고(`POST
 * /api/agent-manager/restart-resume`), AWB 는 티켓을 다시 보내고 Agent Session 은 그 호스트의 operator(없으면
 * 가장 최근에 대화한 operator)에게 보고한다. operator 는 `resume_interrupted_session` 으로 이어서 진행시킨다.
 */

/** server·client 계약 — 재개 프롬프트의 첫머리. 화면이 이 줄로 재개 턴을 알아본다(`sessionTranscript.logic.ts`). */
export const SESSION_RESUME_PREFIX = '[AWB 재개]';

/** 이보다 오래된 끊김은 재개하지 않는다 — 매니저도 같은 한도로 저장본을 버린다(restart-resume.ts). */
export const INTERRUPTED_SESSION_TTL_MS = 6 * 60 * 60_000;

/** 매니저 엔드포인트 → operator 쪽으로 넘기는 프로세스 안 이벤트(SSE 로 나가지 않는다). */
export const AGENT_MANAGER_RESTART_RESUME_EVENT = 'agent_manager_restart_resume';

export type InterruptedState = 'turn' | 'awaiting_permission' | 'awaiting_input';

export interface InterruptedSessionInput {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  state: InterruptedState;
  turn_started_at: string | null;
}

export interface RestartResumeEvent {
  /** 세션 경로의 매니저 identity(`AgentSessionExecution.manager_id`). */
  manager_id: string;
  reason: string;
  from_version: string;
  to_version: string;
  sessions: InterruptedSessionInput[];
}

const MAX_SESSIONS = 50;
const str = (v: unknown, max = 1024) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 매니저가 보낸 목록 — 모양이 틀린 행은 버리고 같은 세션은 한 번만. */
export function parseInterruptedSessions(raw: unknown): InterruptedSessionInput[] {
  const states = new Set<InterruptedState>(['turn', 'awaiting_permission', 'awaiting_input']);
  const seen = new Set<string>();
  const out: InterruptedSessionInput[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const cli = str((item as any)?.cli, 64);
    const sessionId = str((item as any)?.session_id, 256);
    if (!cli || !sessionId || seen.has(`${cli}\0${sessionId}`)) continue;
    seen.add(`${cli}\0${sessionId}`);
    const state = (item as any)?.state;
    out.push({
      cli,
      session_id: sessionId,
      cwd: str((item as any)?.cwd),
      title: str((item as any)?.title, 256),
      state: states.has(state) ? state : 'turn',
      turn_started_at: str((item as any)?.turn_started_at, 64) || null,
    });
    if (out.length >= MAX_SESSIONS) break;
  }
  return out;
}

/**
 * 끊긴 세션에 보내는 글 — 고정이다. operator 가 고를 수 있는 것은 "재개할지" 뿐이라, 다른 세션이 쓴 글(보고)이
 * 이 경로로 명령이 되지 않는다.
 */
export function composeResumePrompt(lang: AnnouncementLanguage): string {
  return lang === 'ko'
    ? `${SESSION_RESUME_PREFIX} Agent Manager 가 재시작(업데이트)되면서 이 세션의 직전 턴이 중간에 끊겼습니다. `
      + '끊기기 전에 하던 작업을 이어서 진행하세요. 이미 끝낸 단계는 다시 하지 말고, 전부 끝나 있었다면 결과만 짧게 정리하세요. '
      + '끊길 때 승인이나 답을 기다리고 있었다면 그 요청은 취소됐으니 필요하면 다시 요청하세요.'
    : `${SESSION_RESUME_PREFIX} The Agent Manager restarted (an update) and cut this session's last turn short. `
      + 'Continue the work you were doing before it stopped. Do not redo finished steps; if everything was already done, briefly sum up the result. '
      + 'If you were waiting for a permission or an answer, that request was cancelled — ask again if you still need it.';
}

const STATE_TEXT: Record<AnnouncementLanguage, Record<InterruptedState, string>> = {
  ko: { turn: '턴 실행 중', awaiting_permission: '사용자 승인 대기 중', awaiting_input: '사용자 답변 대기 중' },
  en: { turn: 'running a turn', awaiting_permission: 'waiting for the user\'s permission', awaiting_input: 'waiting for the user\'s answer' },
};

/** 보고에 싣는 "무슨 일이 있었나". */
export function interruptionDetail(
  session: InterruptedSessionInput,
  restart: Pick<RestartResumeEvent, 'reason' | 'from_version' | 'to_version'>,
  lang: AnnouncementLanguage,
  nowMs: number,
): string {
  const update = restart.reason === 'self_update_restart';
  const versions = restart.from_version && restart.to_version && restart.from_version !== restart.to_version
    ? ` (v${restart.from_version} → v${restart.to_version})` : '';
  const started = session.turn_started_at ? Date.parse(session.turn_started_at) : NaN;
  const minutes = Number.isFinite(started) ? Math.max(0, Math.round((nowMs - started) / 60_000)) : null;
  if (lang === 'ko') {
    const ran = minutes === null ? '' : `, 턴 시작 후 ${minutes}분`;
    return `Agent Manager ${update ? '업데이트' : '재시작'}${versions}로 끊겼습니다 — 끊길 때: ${STATE_TEXT.ko[session.state]}${ran}.`;
  }
  const ran = minutes === null ? '' : `, ${minutes} min into the turn`;
  return `Cut off by an Agent Manager ${update ? 'update' : 'restart'}${versions} — it was ${STATE_TEXT.en[session.state]}${ran}.`;
}

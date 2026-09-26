import { tokens } from './tokens';

/**
 * 진행 상태의 **단일 어휘**. session / chat / board / mission 은 서로 다른 데이터를
 * 갖지만 운영자가 화면에서 묻는 것은 하나다 — "이건 지금 돌고 있나, 내가 뭘 해야 하나,
 * 끝났나?" 그 답을 표면마다 다른 색·다른 단어로 말하고 있었다(같은 "진행 중"이
 * 어디선 보라색 pill, 어디선 초록 점, 어디선 아무 표시도 없었다). 여기서 상태를
 * 7개 tone 으로 접고, 각 표면은 자기 상태를 tone 으로 **번역만** 한다.
 *
 * tone 추가는 신중히. 하나 늘릴 때마다 네 표면이 같이 늘어난다.
 */
export type ActivityTone = 'idle' | 'queued' | 'live' | 'attention' | 'stalled' | 'done' | 'failed';

export interface ActivityView {
  /** 짧은 라벨. 좌측 목록 행과 우측 헤더가 **같은 단어**를 써야 한다. */
  label: string;
  tone: ActivityTone;
  /**
   * 스스로 바뀔 상태인가. 점의 숨쉬기(breathing) 애니메이션을 켠다.
   *
   * `attention`(사람이 답해야 진행) 에는 절대 켜지 않는다 — 숨쉬는 점은 "곧 알아서
   * 진행된다"로 읽혀 정확히 반대 뜻이 된다. 그쪽은 링(ring) 펄스가 맡는다.
   */
  live: boolean;
}

export interface ActivityToneStyle {
  color: string;
  background: string;
  /** 사람의 입력을 기다리는 tone — 링 펄스로 눈에 걸리게 한다. */
  attention?: boolean;
}

export const ACTIVITY_TONES: Record<ActivityTone, ActivityToneStyle> = {
  // 아무 일도 없음. 점을 찍지 않는 쪽이 목록을 읽기 쉽게 한다(ActivityDot 참고).
  idle: { color: tokens.colors.textMuted, background: `${tokens.colors.border}40` },
  // 시작을 기다리는 중 — 아직 아무것도 안 하고 있다. 정적인 점.
  queued: { color: tokens.colors.accentSubtle, background: `${tokens.colors.accent}18` },
  // 지금 돌고 있다. 네 표면이 공유하는 **핵심 tone** — 이 색 하나만 익히면 된다.
  live: { color: tokens.colors.infoLight, background: `${tokens.colors.info}22` },
  // 사람이 답해야 진행된다. 화면에서 가장 눈에 띄어야 하는 상태.
  attention: { color: tokens.colors.warningLight, background: `${tokens.colors.warningBg}55`, attention: true },
  // 멈춰 있다(차단·일시정지). 판단이 필요하지만 즉답을 요구하지는 않는다.
  stalled: { color: tokens.colors.warningLight, background: `${tokens.colors.warningBg}30` },
  done: { color: tokens.colors.successLight, background: `${tokens.colors.successBg}40` },
  failed: { color: tokens.colors.dangerLight, background: `${tokens.colors.dangerBg}40` },
};

export function toneStyle(tone: ActivityTone): ActivityToneStyle {
  return ACTIVITY_TONES[tone] ?? ACTIVITY_TONES.idle;
}

/** 목록 행에 점을 찍을 가치가 있는가. idle 은 침묵한다 — 모든 행이 점을 달면 신호가 없다. */
export function isNoteworthy(tone: ActivityTone): boolean {
  return tone !== 'idle';
}

// ── 표면별 번역기 ────────────────────────────────────────────────────────────
//
// 각 표면의 상태 이름은 그 표면의 것이다(서버 contract). 여기서는 tone 으로만 접는다.

/** Agent Session — 매니저가 보내는 라이브 상태(`AgentSessionStatus`). */
export function sessionActivity(status: string | null | undefined): ActivityView {
  switch (status) {
    case 'starting':
      return { label: 'Starting', tone: 'queued', live: true };
    // 프로세스는 살아 있고 프롬프트를 기다린다 — 돌고 있는 것이 아니다.
    case 'ready':
      return { label: 'Ready', tone: 'queued', live: false };
    case 'busy':
      return { label: 'Working', tone: 'live', live: true };
    case 'awaiting_permission':
      return { label: 'Needs your approval', tone: 'attention', live: false };
    case 'awaiting_input':
      return { label: 'Needs your input', tone: 'attention', live: false };
    case 'error':
      return { label: 'Error', tone: 'failed', live: false };
    case 'closed':
      return { label: 'Closed', tone: 'idle', live: false };
    case 'idle':
      return { label: 'Idle', tone: 'idle', live: false };
    default:
      return { label: String(status || 'Unknown'), tone: 'idle', live: false };
  }
}

/**
 * Terminal — PTY 프로세스. 살아 있는 것만 존재하므로 `live` 는 "셸이 살아 있다"이지
 * "작업이 돌고 있다"가 아니다. 그래도 숨쉬는 점을 주는 편이 맞다: 그 행은 지금
 * 붙으면 반응하는 행이고, `exited` 행과 한눈에 갈라져야 한다.
 */
export function terminalActivity(status: string | null | undefined): ActivityView {
  switch (status) {
    case 'starting':
      return { label: 'Starting', tone: 'queued', live: true };
    case 'live':
      return { label: 'Live', tone: 'live', live: true };
    case 'exited':
      return { label: 'Exited', tone: 'idle', live: false };
    case 'error':
      return { label: 'Failed', tone: 'failed', live: false };
    default:
      return { label: status ? String(status) : 'Unknown', tone: 'idle', live: false };
  }
}

/**
 * Chat room — 방 자체에는 상태 컬럼이 없다. 방이 "지금 돌고 있다"는 것은
 * (1) 그 방의 agent 가 타이핑/작업 중이거나 (2) action/QA run 진행 메시지가 흐르는 것이고,
 * 둘 다 SSE 로만 온다. 그래서 입력이 상태 문자열이 아니라 **살아 있는 사실**이다.
 */
export function roomActivity(input: {
  workingNames?: string[];
  unread?: number;
}): ActivityView {
  const names = (input.workingNames || []).filter(Boolean);
  if (names.length === 1) return { label: `${names[0]} is working`, tone: 'live', live: true };
  if (names.length > 1) return { label: `${names.length} agents working`, tone: 'live', live: true };
  if (input.unread) return { label: `${input.unread} unread`, tone: 'queued', live: false };
  return { label: 'Idle', tone: 'idle', live: false };
}

/**
 * Board ticket — 카드가 답해야 하는 질문은 미션 카드와 같다("지금 누가 이걸 하고
 * 있나 / 내가 뭘 해야 하나"). 우선순위가 있다: 사람을 기다리는 사실이 진행보다 먼저다.
 */
export function ticketActivity(ticket: {
  status?: string | null;
  pending_user_action?: boolean;
  blocked_by_count?: number;
}): ActivityView {
  if (ticket.pending_user_action) return { label: 'Needs your decision', tone: 'attention', live: false };
  if (ticket.blocked_by_count) return { label: 'Blocked', tone: 'stalled', live: false };
  switch (ticket.status) {
    case 'in_progress':
      return { label: 'Working', tone: 'live', live: true };
    case 'done':
      return { label: 'Done', tone: 'done', live: false };
    default:
      return { label: 'Waiting', tone: 'idle', live: false };
  }
}

import { toneStyle } from '../../activity';
import type { ActivityTone } from '../../activity';
import type { OrchestrationMissionStatus, OrchestrationStepStatus } from '../../types';

/**
 * Mission/step status → the shared activity vocabulary (src/activity.ts), so a
 * running step and a working CLI session read as the *same* colour across the
 * app. Kept as raw colours (not Badge variants) because the plan graph paints
 * borders and connector lines, not just pills.
 *
 * Only the tone and the label live here. Never hard-code a colour in this
 * file — the whole point is that session / chat / board / mission share one
 * palette, and a local colour here is how that promise quietly breaks.
 */

export interface StatusStyle {
  label: string;
  color: string;
  background: string;
  /** True while the state is expected to change on its own — drives the pulse. */
  live: boolean;
  tone: ActivityTone;
}

function style(label: string, tone: ActivityTone, live: boolean): StatusStyle {
  const { color, background } = toneStyle(tone);
  return { label, color, background, live, tone };
}

export const MISSION_STATUS_STYLES: Record<OrchestrationMissionStatus, StatusStyle> = {
  draft: style('Draft', 'idle', false),
  planning: style('Planning', 'live', true),
  running: style('Running', 'live', true),
  paused: style('Paused', 'stalled', false),
  completed: style('Completed', 'done', false),
  failed: style('Failed', 'failed', false),
  cancelled: style('Cancelled', 'idle', false),
};

export const STEP_STATUS_STYLES: Record<OrchestrationStepStatus, StatusStyle> = {
  pending: style('Waiting', 'idle', false),
  ready: style('Ready', 'queued', false),
  dispatched: style('Dispatched', 'live', true),
  running: style('Working', 'live', true),
  done: style('Done', 'done', false),
  failed: style('Failed', 'failed', false),
  blocked: style('Blocked', 'stalled', false),
  skipped: style('Skipped', 'idle', false),
  cancelled: style('Cancelled', 'idle', false),
  // 여기 없으면 stepStyle 의 fallback 이 걸려 가장 급한 상태가 조용히 "Waiting"
  // (muted 회색)으로 그려진다 — 운영자가 개입해야 하는 상태를 대기 중으로 오인하게
  // 만드는 조용한 오표시라, 상태 추가와 스타일 추가는 반드시 같이 가야 한다.
  needs_recovery: style('Needs recovery', 'failed', false),
  // 사람이 답해야 진행되는 상태라 가장 눈에 띄어야 한다 — 대기(muted)나 진행중(live)과
  // 같은 색이면 "누가 뭘 해야 하는가" 가 화면에서 사라진다(티켓 5dbe4aa2).
  // live:false — 스스로 바뀌지 않는다(사람의 입력이 있어야 한다). 'attention' tone 이
  // 숨쉬기 대신 링 펄스를 켜 "곧 알아서 진행될 것" 으로 읽히지 않게 한다.
  awaiting_user: style('Needs your decision', 'attention', false),
};

export function missionStyle(status: string): StatusStyle {
  return MISSION_STATUS_STYLES[status as OrchestrationMissionStatus] ?? MISSION_STATUS_STYLES.draft;
}

export function stepStyle(status: string): StatusStyle {
  return STEP_STATUS_STYLES[status as OrchestrationStepStatus] ?? STEP_STATUS_STYLES.pending;
}

/** Timeline event type → the colour of its rail dot. */
export function eventColor(type: string): string {
  if (type.endsWith('_failed') || type === 'error') return toneStyle('failed').color;
  if (type.endsWith('_blocked')) return toneStyle('stalled').color;
  if (type === 'mission_completed' || type === 'step_completed') return toneStyle('done').color;
  if (type === 'plan_submitted' || type === 'orchestrator_woken') return toneStyle('queued').color;
  if (type === 'step_dispatched' || type === 'step_assigned') return toneStyle('live').color;
  // 그래프 실행 trace(티켓 1ca9e49b) — loop 재진입/예산 소진은 운영자가 놓치면
  // 안 되는 신호라 경고색, 단순 edge 선택은 정보색.
  if (type === 'node_revisited' || type === 'loop_exhausted' || type === 'graph_budget_exhausted') {
    return toneStyle('stalled').color;
  }
  if (type === 'edge_selected') return toneStyle('live').color;
  // 사용자 확인(티켓 5dbe4aa2) — 요청은 사람이 개입해야 하는 신호라 경고색,
  // 판정 완료는 진행이 재개된 것이므로 성공색.
  if (type === 'confirm_requested') return toneStyle('attention').color;
  if (type === 'confirm_decided') return toneStyle('done').color;
  // 대기 알림 발송(티켓 a78cb566)은 사람에게 무엇을 요구하는 신호가 아니라 시스템이
  // 이미 처리한 부수 기록이라 정보색이다 — 경고색을 주면 confirm_requested 와 나란히
  // 떠서 "답해야 할 것이 두 개" 로 읽힌다.
  if (type === 'confirm_notified') return toneStyle('live').color;
  return toneStyle('idle').color;
}

/**
 * Progress percentage for a mission's bar. Counts terminal-failed steps as
 * "resolved" too — the bar answers "how much of the plan is settled", not "how
 * much succeeded", which the segment colours already convey.
 */
export function progressPercent(counts: { total: number; done: number; failed: number }): number {
  if (!counts.total) return 0;
  return Math.round(((counts.done + counts.failed) / counts.total) * 100);
}

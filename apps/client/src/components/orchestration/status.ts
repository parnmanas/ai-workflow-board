import { tokens } from '../../tokens';
import type { OrchestrationMissionStatus, OrchestrationStepStatus } from '../../types';

/**
 * Status → colour mapping shared by the mission list, the plan graph and the
 * timeline, so the same state never reads as two different colours across the
 * feature. Kept as raw colours (not Badge variants) because the plan graph
 * paints borders and connector lines, not just pills.
 */

export interface StatusStyle {
  label: string;
  color: string;
  background: string;
  /** True while the state is expected to change on its own — drives the pulse. */
  live: boolean;
}

export const MISSION_STATUS_STYLES: Record<OrchestrationMissionStatus, StatusStyle> = {
  draft: { label: 'Draft', color: tokens.colors.textMuted, background: `${tokens.colors.border}40`, live: false },
  planning: {
    label: 'Planning',
    color: tokens.colors.accentLight,
    background: `${tokens.colors.accent}20`,
    live: true,
  },
  running: {
    label: 'Running',
    color: tokens.colors.infoLight,
    background: `${tokens.colors.info}20`,
    live: true,
  },
  paused: {
    label: 'Paused',
    color: tokens.colors.warningLight,
    background: `${tokens.colors.warningBg}40`,
    live: false,
  },
  completed: {
    label: 'Completed',
    color: tokens.colors.successLight,
    background: `${tokens.colors.successBg}40`,
    live: false,
  },
  failed: { label: 'Failed', color: tokens.colors.dangerLight, background: `${tokens.colors.dangerBg}40`, live: false },
  cancelled: {
    label: 'Cancelled',
    color: tokens.colors.textMuted,
    background: `${tokens.colors.border}40`,
    live: false,
  },
};

export const STEP_STATUS_STYLES: Record<OrchestrationStepStatus, StatusStyle> = {
  pending: { label: 'Waiting', color: tokens.colors.textMuted, background: `${tokens.colors.border}40`, live: false },
  ready: {
    label: 'Ready',
    color: tokens.colors.accentSubtle,
    background: `${tokens.colors.accent}18`,
    live: false,
  },
  dispatched: {
    label: 'Dispatched',
    color: tokens.colors.accentLight,
    background: `${tokens.colors.accent}22`,
    live: true,
  },
  running: { label: 'Working', color: tokens.colors.infoLight, background: `${tokens.colors.info}22`, live: true },
  done: {
    label: 'Done',
    color: tokens.colors.successLight,
    background: `${tokens.colors.successBg}40`,
    live: false,
  },
  failed: { label: 'Failed', color: tokens.colors.dangerLight, background: `${tokens.colors.dangerBg}40`, live: false },
  blocked: {
    label: 'Blocked',
    color: tokens.colors.warningLight,
    background: `${tokens.colors.warningBg}40`,
    live: false,
  },
  skipped: { label: 'Skipped', color: tokens.colors.textMuted, background: `${tokens.colors.border}30`, live: false },
  cancelled: {
    label: 'Cancelled',
    color: tokens.colors.textMuted,
    background: `${tokens.colors.border}30`,
    live: false,
  },
  // 여기 없으면 stepStyle 의 fallback 이 걸려 가장 급한 상태가 조용히 "Waiting"
  // (muted 회색)으로 그려진다 — 운영자가 개입해야 하는 상태를 대기 중으로 오인하게
  // 만드는 조용한 오표시라, 상태 추가와 스타일 추가는 반드시 같이 가야 한다.
  needs_recovery: {
    label: 'Needs recovery',
    color: tokens.colors.dangerLight,
    background: `${tokens.colors.dangerBg}55`,
    live: false,
  },
};

export function missionStyle(status: string): StatusStyle {
  return MISSION_STATUS_STYLES[status as OrchestrationMissionStatus] ?? MISSION_STATUS_STYLES.draft;
}

export function stepStyle(status: string): StatusStyle {
  return STEP_STATUS_STYLES[status as OrchestrationStepStatus] ?? STEP_STATUS_STYLES.pending;
}

/** Timeline event type → the colour of its rail dot. */
export function eventColor(type: string): string {
  if (type.endsWith('_failed') || type === 'error') return tokens.colors.dangerLight;
  if (type.endsWith('_blocked')) return tokens.colors.warningLight;
  if (type === 'mission_completed' || type === 'step_completed') return tokens.colors.successLight;
  if (type === 'plan_submitted' || type === 'orchestrator_woken') return tokens.colors.accentLight;
  if (type === 'step_dispatched' || type === 'step_assigned') return tokens.colors.infoLight;
  // 그래프 실행 trace(티켓 1ca9e49b) — loop 재진입/예산 소진은 운영자가 놓치면
  // 안 되는 신호라 경고색, 단순 edge 선택은 정보색.
  if (type === 'node_revisited' || type === 'loop_exhausted' || type === 'graph_budget_exhausted') {
    return tokens.colors.warningLight;
  }
  if (type === 'edge_selected') return tokens.colors.infoLight;
  return tokens.colors.textMuted;
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

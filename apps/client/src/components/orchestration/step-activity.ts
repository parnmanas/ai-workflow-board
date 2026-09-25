import type { OrchestrationStep } from '../../types';
import { shortDuration } from '../../utils/time';

/**
 * step 의 "지금 실제로 하고 있는 일" 을 화면 문구로 바꾸는 순수 함수들.
 *
 * 카드(PlanGraph)와 좌측 레일이 같은 판정을 써야 한다 — 같은 step 이 두 곳에서 다른
 * 상태로 읽히면 운영자는 어느 쪽을 믿을지 알 수 없다. 렌더링은 각자 다르지만 **판정은
 * 여기 한 곳**에 둔다.
 *
 * 시간은 인자로 받는다(`nowMs`). `Date.now()` 를 내부에서 부르면 같은 프레임의 두 렌더가
 * 다른 값을 쓰고, 무엇보다 테스트가 시계를 고정할 수 없다.
 */

/** 디스패치 직후 CLI 가 뜨기까지의 유예 — 이 안의 침묵은 정상이다. */
export const SPAWN_GRACE_MS = 90_000;

export interface StepActivityView {
  /** 활동 신호가 있으면 그 본문. 없으면 null. */
  text: string | null;
  /** 'cli' = CLI 툴 하트비트, 'agent' = 에이전트의 진행 보고. text 가 null 이면 null. */
  source: 'cli' | 'agent' | null;
  /** 신호 시각(ISO). text 가 null 이면 null. */
  at: string | null;
  /** 디스패치 후 경과. 시작/디스패치 시각이 없으면 null. */
  runningFor: number | null;
  /**
   * 디스패치된 지 유예를 넘겼는데 활동 신호가 **한 번도** 없었다 — CLI 가 아예 뜨지
   * 못했다는 뜻이다(2026-09-25 EmberDelve 증상). 침묵 일반을 죽음으로 읽지 않는 이유는
   * 매니저가 하트비트 간격을 조이기 때문이다: 이미 신호가 있었던 step 의 침묵은 정상일 수
   * 있으므로 경고하지 않는다.
   */
  stalled: boolean;
}

export function describeStepActivity(step: OrchestrationStep, nowMs: number): StepActivityView {
  const startedMs = msOf(step.started_at) ?? msOf(step.dispatched_at);
  const runningFor = startedMs === null ? null : Math.max(0, nowMs - startedMs);
  const activity = step.activity ?? null;
  return {
    text: activity?.text ?? null,
    source: activity?.source ?? null,
    at: activity?.at ?? null,
    runningFor,
    stalled: !activity && runningFor !== null && runningFor > SPAWN_GRACE_MS,
  };
}

export interface StepQuietView {
  minutes: number;
  timeoutMinutes: number;
  /** 허용치를 이미 넘겼다 — 리퍼가 재연결을 요구하거나 이 시도를 실패로 처리한다. */
  overdue: boolean;
  label: string;
}

/**
 * 무신호 시계. 기준선은 **에이전트 자신의 진행 보고**이고, 서버 리퍼와 **같은 순서**로
 * 고른다(`last_heartbeat_at ?? started_at ?? dispatched_at`). CLI 활동 시각을 섞으면
 * 화면이 실제보다 안전해 보인다 — 활동이 방금 찍힌 step 도 이 시계는 계속 흐르고, 그
 * 어긋남이 열심히 일한 step 이 lease 만료로 실패하는 이유다.
 *
 * `timeoutMinutes` 가 0(모름)이거나 1분도 지나지 않았으면 null — 없는 숫자를 만들지 않는다.
 */
export function describeStepQuiet(
  step: OrchestrationStep,
  timeoutMinutes: number,
  nowMs: number,
): StepQuietView | null {
  if (!(timeoutMinutes > 0)) return null;
  const since = msOf(step.last_heartbeat_at) ?? msOf(step.started_at) ?? msOf(step.dispatched_at);
  if (since === null) return null;
  const minutes = Math.floor(Math.max(0, nowMs - since) / 60_000);
  if (minutes < 1) return null;
  return {
    minutes,
    timeoutMinutes,
    overdue: minutes >= timeoutMinutes,
    label: `quiet ${minutes}m / ${timeoutMinutes}m`,
  };
}

/** 레일처럼 좁은 자리에서 쓰는 한 줄 요약. 활동이 없으면 그 사실 자체를 문구로 만든다. */
export function compactActivityLabel(view: StepActivityView): string {
  if (view.text) return view.text;
  if (view.stalled) return '⚠ no CLI activity since dispatch';
  return 'waiting for the CLI to start…';
}

/** 실행 시간 라벨(`running 33m`). 기준 시각이 없으면 빈 문자열. */
export function runningLabel(view: StepActivityView): string {
  return view.runningFor === null ? '' : `running ${shortDuration(view.runningFor)}`;
}

/** ISO 문자열 → epoch ms. 빈 값/파싱 실패는 null(시계를 만들지 않는다). */
export function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

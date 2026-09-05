// ticket 40110b64 — `refresh_available_models` 를 보낸 뒤 **그 커맨드의 ack** 를
// 기다리는 공용 헬퍼.
//
// 왜 ack 를 직접 봐야 하나 (리뷰 지적): `sendAgentManagerCommand()` 의 202 는
// "SSE 로 실어 보냈다" 는 디스패치 수락일 뿐, 매니저가 처리했다는 뜻이 아니다.
// 처음에는 "인스턴스의 last_seen_at 이 바뀌면 완료" 로 판정했는데, 하트비트는
// 30초마다 알아서 도는 것이라 **커맨드와 무관한 정기 하트비트**가 커맨드 처리
// 전에 들어오기만 해도 조건이 충족됐다. 그러면 매니저가 재열거를 시작조차 안 한
// 시점에 성공 토스트와 예전 목록이 뜬다. 그래서 발급된 `command_id` 로 ack 를
// 명시적으로 상관시키고, 성공 ack 이후에만 인스턴스 목록을 다시 읽는다.
//
// Runtime Hosts 화면(AgentManagerPage)과 Agent 생성/편집 다이얼로그
// (ManagedAgentDialog) 두 곳이 같은 흐름을 쓴다.

import { api } from '../../api';
import type { AgentManagerCommandOutcome, AgentManagerInstance } from '../../types';

// 매니저 쪽 재열거는 어댑터별 4초 타임아웃을 병렬로 도는 best-effort 스캔이라
// 최악의 경우 몇 초가 걸린다. 그 뒤 ack POST 왕복까지 여유를 둔다.
export const REFRESH_MODELS_POLL_MS = 800;
export const REFRESH_MODELS_POLL_ATTEMPTS = 15;

/** 폴링 창 안에 ack 가 오지 않았을 때 돌려주는 상태. */
export type CommandAckWaitResult =
  | { state: 'ok' | 'error' | 'unknown'; detail: string }
  | { state: 'timeout'; detail: '' };

/**
 * 주어진 `command_id` 의 ack 가 종단 상태(ok/error/unknown)에 이를 때까지
 * 폴링한다. `pending` 인 동안에는 **절대 완료로 치지 않는다** — 그 사이 다른
 * 하트비트가 몇 번을 오든 무관하다.
 *
 * 창 안에 종단 상태를 못 보면 `timeout`. 이는 실패가 아니라 "아직" 이다:
 * 커맨드는 이미 디스패치됐고, 매니저가 늦게라도 처리하면 다음 하트비트에 새
 * 목록이 실려 온다.
 */
export async function waitForCommandAck(
  commandId: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<CommandAckWaitResult> {
  const attempts = options.attempts ?? REFRESH_MODELS_POLL_ATTEMPTS;
  const intervalMs = options.intervalMs ?? REFRESH_MODELS_POLL_MS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let outcome: AgentManagerCommandOutcome;
    try {
      outcome = await api.getAgentManagerCommandOutcome(commandId);
    } catch {
      // 일시적인 조회 실패는 창을 소모할 뿐 결과를 바꾸지 않는다.
      continue;
    }
    if (outcome.state === 'pending') continue;
    return { state: outcome.state, detail: outcome.detail || '' };
  }
  return { state: 'timeout', detail: '' };
}

/** 성공 ack 이후 인스턴스 목록을 다시 읽어 해당 행을 돌려준다. 없으면 null. */
export async function reloadInstance(instanceId: string): Promise<AgentManagerInstance | null> {
  const rows = await api.listAgentManagerInstances();
  return rows.find((row) => row.instance_id === instanceId) ?? null;
}

/** cliType → 모델 수 요약 ("claude=12, codex=8"). 보고된 CLI 가 없으면 빈 문자열. */
export function summarizeModelCounts(models: Record<string, string[]> | undefined): string {
  return Object.entries(models || {})
    .map(([cli, list]) => [cli, Array.isArray(list) ? list.length : 0] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cli, count]) => `${cli}=${count}`)
    .join(', ');
}

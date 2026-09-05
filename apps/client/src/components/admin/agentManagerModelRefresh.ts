// ticket 40110b64 — `refresh_available_models` 를 보낸 뒤 갱신된 모델 목록이
// 서버 레지스트리에 반영될 때까지 기다리는 공용 헬퍼.
//
// 매니저는 재열거 직후 즉시 하트비트 1회를 보내므로 정기 tick(30초)을 기다릴
// 필요가 없다. 다만 커맨드 ack detail 은 서버 로그로만 흐르고 UI 로 되돌아오는
// 릴레이가 없으므로, 화면은 "레지스트리가 실제로 받은 값"을 근거로 삼는다 —
// 그게 모델 드롭다운이 읽는 바로 그 값이라 ack 문자열보다 신뢰도가 높다.
//
// Runtime Hosts 화면(AgentManagerPage)과 Agent 생성/편집 다이얼로그
// (ManagedAgentDialog) 두 곳이 같은 흐름을 쓴다.

import { api } from '../../api';
import type { AgentManagerInstance } from '../../types';

// 매니저 쪽 재열거는 어댑터별 4초 타임아웃을 병렬로 도는 best-effort 스캔이라
// 최악의 경우 몇 초가 걸린다.
export const REFRESH_MODELS_POLL_MS = 800;
export const REFRESH_MODELS_POLL_ATTEMPTS = 15;

/**
 * 갱신된 하트비트가 서버 레지스트리에 반영될 때까지 짧게 재조회한다.
 *
 * `last_seen_at` 이 직전에 본 값과 달라지면 그 인스턴스의 하트비트가 새로
 * 도착한 것이다 — 클라이언트/서버 시계 차이에 기대지 않으려고 절대 시각 비교
 * 대신 "값이 바뀌었는가"로 판정한다.
 *
 * 창 안에 못 받으면 null 을 돌려주며, 이는 실패가 아니라 "아직"이다: 정기
 * 하트비트가 최대 30초 안에 같은 값을 싣고 온다.
 */
export async function waitForFreshHeartbeat(
  instanceId: string,
  seenBefore: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<AgentManagerInstance | null> {
  const attempts = options.attempts ?? REFRESH_MODELS_POLL_ATTEMPTS;
  const intervalMs = options.intervalMs ?? REFRESH_MODELS_POLL_MS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let rows: AgentManagerInstance[];
    try {
      rows = await api.listAgentManagerInstances();
    } catch {
      // 일시적인 조회 실패는 창을 소모할 뿐 결과를 바꾸지 않는다.
      continue;
    }
    const row = rows.find((r) => r.instance_id === instanceId);
    if (row && row.last_seen_at !== seenBefore) return row;
  }
  return null;
}

/** cliType → 모델 수 요약 ("claude=12, codex=8"). 보고된 CLI 가 없으면 빈 문자열. */
export function summarizeModelCounts(models: Record<string, string[]> | undefined): string {
  return Object.entries(models || {})
    .map(([cli, list]) => [cli, Array.isArray(list) ? list.length : 0] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cli, count]) => `${cli}=${count}`)
    .join(', ');
}

// Action fan-out 대상 해석 (티켓 fc3906c5).
//
// 하나의 Action은 이제 N개의 에이전트를 대상으로 가질 수 있고, 한 번의 트리거가
// 대상마다 독립적인 ActionRun을 만든다(fan-out). 대상은 여전히 Action 정의에
// **선언적으로 고정**된다 — 과거에 기각된 "실행 시점 에이전트 선택"이 아니라,
// 고정된 대상이 1개가 아니라 N개일 뿐이다.
//
// 저장 형태가 두 개인 이유(하위 호환):
//   - `Action.target_agent_id`  — 레거시 단일 컬럼. 삭제하지 않고 배열의 첫
//     원소를 계속 미러링한다. 이 컬럼만 읽는 오래된 코드/쿼리가 여전히
//     "이 Action의 대표 대상"을 얻는다.
//   - `Action.target_agent_ids` — JSON 문자열 배열. `Ticket.on_done_action_ids`
//     와 같은 SQLite/Postgres 패리티 관례(varchar + '[]' 기본값)를 따른다.
//
// 읽기는 **항상** `actionTargetAgentIds()` 한 곳을 통과한다. 배열이 비어 있으면
// 레거시 단일 컬럼으로 폴백하므로, 마이그레이션 백필이 돌지 않은 DB에서도
// 기존 단일 대상 Action이 그대로 동작한다(백필은 데이터 정합성용일 뿐 동작의
// 전제가 아니다).

import { normalizeWorkspaceFolder } from './workspace-folder-options';

/** 파싱 실패를 조용히 빈 배열로 흘리는 JSON 배열 파서. */
function parseIdArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 입력(배열 또는 JSON 문자열)을 정규화한다: 공백 제거, 빈 값 제거, **순서를
 * 보존한 중복 제거**. 순서를 보존하는 이유는 첫 원소가 레거시
 * `target_agent_id` 로 미러링되는 "대표 대상"이기 때문이다 — 정렬해 버리면
 * 사용자가 UI에서 고른 순서와 무관하게 대표가 바뀐다.
 */
export function normalizeTargetAgentIds(input: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of parseIdArray(input)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 정규화된 배열을 컬럼 저장 형태(JSON 문자열)로 직렬화한다. */
export function serializeTargetAgentIds(ids: unknown): string {
  return JSON.stringify(normalizeTargetAgentIds(ids));
}

/**
 * 이 Action이 실제로 디스패치할 대상 에이전트 id 목록 — fan-out의 단일 진실
 * 공급원(single source of truth).
 *
 * 배열이 비어 있으면 레거시 단일 컬럼으로 폴백한다. 둘 다 비면 빈 배열이고,
 * 호출부는 이를 "대상 없음"(디스패치 거부) 으로 처리한다.
 */
export function actionTargetAgentIds(
  action: { target_agent_id?: string | null; target_agent_ids?: unknown } | null | undefined,
): string[] {
  if (!action) return [];
  const many = normalizeTargetAgentIds(action.target_agent_ids);
  if (many.length > 0) return many;
  const single = (action.target_agent_id || '').trim();
  return single ? [single] : [];
}

/**
 * 레거시 단일 컬럼에 미러링할 대표 대상. 항상 `actionTargetAgentIds()` 의 첫
 * 원소다 — 두 컬럼이 어긋나지 않도록 쓰기 경로도 이 함수 하나만 쓴다.
 */
export function primaryTargetAgentId(
  action: { target_agent_id?: string | null; target_agent_ids?: unknown } | null | undefined,
): string {
  return actionTargetAgentIds(action)[0] || '';
}

/** 대상이 2개 이상이면 fan-out이다(작업폴더 분리 등 분기 판단에 쓴다). */
export function isFanOutAction(
  action: { target_agent_id?: string | null; target_agent_ids?: unknown } | null | undefined,
): boolean {
  return actionTargetAgentIds(action).length > 1;
}

/**
 * Action 행을 클라이언트로 내보내기 위한 정규화 (티켓 fc3906c5).
 *
 * `target_agent_ids` 는 DB 에 JSON **문자열**로 저장된다(SQLite/Postgres 패리티
 * 관례). 엔티티를 그대로 `res.json()` 하면 클라이언트는 배열이 아니라
 * `'["a","b"]'` 문자열을 받는다 — `.filter` 를 부르는 순간 화면이 터지거나,
 * 운이 좋아야 리터럴 문자열이 그대로 렌더된다(awb-field-wiring 스킬이 말하는
 * 바로 그 실패 모드). 모든 REST 읽기 경로가 이 함수를 통과해야 한다.
 *
 * 레거시 단일 컬럼도 함께 정규화해서, 두 필드가 어긋난 행(백필 전)이라도
 * 클라이언트는 항상 일관된 값을 본다.
 */
export function actionToWireJson<T extends { target_agent_id?: string | null; target_agent_ids?: unknown }>(
  action: T,
): Omit<T, 'target_agent_ids'> & { target_agent_id: string; target_agent_ids: string[] } {
  const ids = actionTargetAgentIds(action);
  return { ...action, target_agent_id: ids[0] || '', target_agent_ids: ids };
}

/**
 * fan-out 시 **에이전트별** 작업폴더 leaf (티켓 fc3906c5).
 *
 * Action의 기본 작업폴더는 `.awb/act/<action8>` 로 **action 단위**다 — 한
 * Action의 모든 run이 같은 폴더를 재사용해 warm checkout이 run 사이에 유지되는,
 * 의도된 설계다. 그런데 대상이 여럿이 되면 같은 매니저 아래 두 에이전트가 같은
 * 체크아웃을 동시에 밟는다(서로의 작업 트리를 덮어쓰고, `checkout_mode='fresh'`
 * 면 한쪽이 다른 쪽 폴더를 `rm -rf` 한다).
 *
 * 그래서 마지막 경로 세그먼트에 에이전트 id 앞 8자를 붙여 가른다. 세그먼트
 * **끝**에 붙이는 이유는 사용자가 지정한 `foo/bar` 같은 다단 경로에서 경로
 * 모양을 보존하기 위해서다(`foo/bar-<agent8>`).
 *
 * 에이전트별로 폴더가 고정되므로 같은 에이전트의 반복 run은 여전히 같은 폴더를
 * 재사용한다 — warm checkout 이점은 에이전트 단위로 그대로 남는다.
 *
 * 호출부는 **대상이 2개 이상일 때만** 이 함수를 쓴다. 단일 대상 Action의 폴더는
 * 글자 하나 바뀌지 않아야 기존 체크아웃이 그대로 유지되기 때문이다.
 */
export function agentScopedWorkspaceFolder(
  workspaceFolder: string | null | undefined,
  actionId: string,
  agentId: string,
): string {
  const base = normalizeWorkspaceFolder(workspaceFolder) || String(actionId || '').slice(0, 8);
  const suffix = String(agentId || '').slice(0, 8);
  if (!suffix) return base;
  if (!base) return suffix;
  const segments = base.split('/');
  segments[segments.length - 1] = `${segments[segments.length - 1]}-${suffix}`;
  return segments.join('/');
}

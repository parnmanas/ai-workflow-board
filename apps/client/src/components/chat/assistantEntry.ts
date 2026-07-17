// AWB 어시스턴트 진입점 순수 로직 (에픽 bf65ca00 · Phase 1 · S2).
//
// Chat-first 랜딩이 workspace 의 `assistant_agent_id` 를 해석하고, 기존 chat-rooms
// DM 프리셋(에이전트와의 DM 룸)을 find-or-create 하기 위한 결정 로직을 컴포넌트에서
// 분리했다. fetch·라우팅 같은 부수효과는 컨테이너가, 판정은 여기서 — node:test 로
// 직접 검증한다(composerSend·viewMode DI-추출 선례).
//
// 핵심 규칙(planner 결정 a):
//   - 미지정(null)일 때 임의 에이전트를 자동 선택하지 않는다 → 'unset'.
//   - 지정된 id 가 활성·비-매니저·(선택적으로) 같은 workspace 에이전트가 아니면
//     안전 fallback → 'invalid'. 삭제/비활성/타 workspace 이동 모두 여기로 수렴한다.
//   - 서버 검증(workspaces.controller `assistant_agent_id`)과 동일 기준을 클라에서도
//     써서 read/write 가 어긋나지 않게 한다.

/** 셀렉터/카드에서 쓰는 어시스턴트 에이전트 최소 표현. */
export interface AssistantAgentInfo {
  id: string;
  name: string;
  avatar_url?: string;
}

/** api.getAgents() 로우의 부분 구조 — 판정에 필요한 필드만. */
export interface AgentLike {
  id: string;
  name?: string;
  avatar_url?: string;
  is_active?: number;
  type?: string;
  workspace_id?: string | null;
}

export type AssistantResolution =
  | { status: 'unset' }
  | { status: 'invalid'; agentId: string }
  | { status: 'ready'; agent: AssistantAgentInfo };

/**
 * 서버 workspace PATCH 와 동일한 어시스턴트 적격성:
 * 활성(is_active===1) · 매니저 아님(type!=='manager') · (wsId 주면) 해당 workspace 소속.
 * 매니저는 DM auto-route 대상이 아니므로(_handleDmAgentRequest) 어시스턴트가 될 수 없다.
 */
export function isEligibleAssistant(agent: AgentLike | null | undefined, wsId?: string): boolean {
  if (!agent) return false;
  if (agent.is_active !== 1) return false;
  if (agent.type === 'manager') return false;
  if (wsId && agent.workspace_id !== wsId) return false;
  return true;
}

/** 설정 셀렉터에 노출할 적격 에이전트 목록(이름 정렬). */
export function eligibleAssistantAgents(agents: AgentLike[] | null | undefined, wsId?: string): AssistantAgentInfo[] {
  return (agents || [])
    .filter((a) => isEligibleAssistant(a, wsId))
    .map((a) => ({ id: a.id, name: a.name || a.id, avatar_url: a.avatar_url }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * workspace.assistant_agent_id 를 agents 목록에 대조해 랜딩 상태를 결정한다.
 * agents 는 이미 workspace-scoped(api.getAgents)라 타 workspace 지정은 match 불가 →
 * invalid 로 수렴한다. wsId 를 주면 서버 검증과 완전히 동일해진다.
 */
export function resolveAssistant(
  workspace: { assistant_agent_id?: string | null } | null | undefined,
  agents: AgentLike[] | null | undefined,
  wsId?: string,
): AssistantResolution {
  const id = workspace?.assistant_agent_id;
  if (!id) return { status: 'unset' };
  const match = (agents || []).find((a) => a.id === id);
  if (!isEligibleAssistant(match, wsId)) return { status: 'invalid', agentId: id };
  return { status: 'ready', agent: { id: match!.id, name: match!.name || match!.id, avatar_url: match!.avatar_url } };
}

/** DM 룸 목록 항목의 부분 구조 — find-or-create 판정용. */
export interface RoomLike {
  id: string;
  type?: 'dm' | 'group' | string;
  participants?: Array<{ participant_type: string; participant_id: string }>;
}

/**
 * 어시스턴트 에이전트와의 기존 DM 룸 id 를 찾는다(없으면 null → 컨테이너가 새로 생성).
 * 서버가 동일-멤버 DM 을 dedup 하지 않으므로(api.ts 주석) 반복 진입 시 룸이 쌓이지
 * 않도록 클라에서 기존 DM 을 먼저 재사용한다. participants 투영이 없는 구버전 응답은
 * 매칭 불가(→ 새로 생성)로 안전하게 처리한다.
 */
export function findAssistantDmRoomId(rooms: RoomLike[] | null | undefined, assistantId: string | null | undefined): string | null {
  if (!assistantId) return null;
  const room = (rooms || []).find(
    (r) =>
      r.type === 'dm' &&
      Array.isArray(r.participants) &&
      r.participants.some((p) => p.participant_type === 'agent' && p.participant_id === assistantId),
  );
  return room ? room.id : null;
}

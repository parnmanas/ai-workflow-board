// New Chat / Add People 의 Agent 목록 규칙 (React 없음 — test/chat-invite-participants.test.mjs).
//
// 채팅의 Agent 참여자는 Agent 행이 아니라 RuntimeSpec 이고, 서버는 그 실행 신원
// `runtimeIdentityKey(spec)` = cli + working_dir + credential 로 참여자를 매긴 뒤 같은 키를
// **조용히 하나로 합친다**(room-crud.service createRoom 의 dedupe). 모델·label 은 신원이
// 아니다. 그래서 모델만 다른 두 Agent 를 같은 폴더에 넣으면 방에는 하나만 들어간다 —
// 피커가 그 조합을 미리 막아야 사용자가 "둘을 넣었는데 하나만 있다"를 겪지 않는다.

export interface ChatAgentSpec {
  manager_agent_id?: string | null;
  cli?: string | null;
  model?: string | null;
  working_dir?: string | null;
  credential_id?: string | null;
  label?: string | null;
}

/** 서버 runtimeIdentityKey 와 같은 입력(정규화 포함) — 해시 대신 튜플로 비교한다. */
export function chatAgentIdentity(spec: ChatAgentSpec): string {
  const norm = (v: string | null | undefined) => (v || '').trim();
  return `${norm(spec.cli).toLowerCase()}\0${norm(spec.working_dir)}\0${norm(spec.credential_id)}`;
}

/**
 * `spec` 과 실행 신원이 같은 Agent — 없으면 null. 편집 중인 항목 자신(`exceptKey`)은 뺀다.
 */
export function findSameRuntimeAgent<T extends { key: string; spec: ChatAgentSpec }>(
  agents: T[],
  spec: ChatAgentSpec,
  exceptKey?: string | null,
): T | null {
  const identity = chatAgentIdentity(spec);
  return agents.find((a) => a.key !== exceptKey && chatAgentIdentity(a.spec) === identity) ?? null;
}

/**
 * 만들어질 방의 모양 — 제출 버튼 라벨과 안내 문구가 같은 판정을 쓴다. 서버도 참여자
 * 수로 정한다(나 포함 2명 = dm, 3명 이상 = group). DM 의 Agent 는 모든 메시지에 답하고,
 * group 의 Agent 는 @멘션을 받았을 때만 답한다(room-messaging.service).
 */
export function newChatShape(counts: { agents: number; people: number }): 'empty' | 'dm' | 'group' {
  const total = counts.agents + counts.people;
  if (total === 0) return 'empty';
  return total === 1 ? 'dm' : 'group';
}

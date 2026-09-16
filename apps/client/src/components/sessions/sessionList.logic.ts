/**
 * Agent Session 목록 순수 로직 — 사이드바/목록 페이지가 공유. React 없이
 * node:test 로 구동한다(hooks/useAgentSessionsNav.ts 가 재수출).
 */
import type { AgentSessionSnapshot, AgentSessionUpdateEvent } from '../../types';

function activityOf(s: AgentSessionSnapshot): number {
  const raw = s.last_activity_at || s.updated_at || s.created_at;
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

export function sortSessionsByActivity(list: AgentSessionSnapshot[]): AgentSessionSnapshot[] {
  return [...list].sort((a, b) => activityOf(b) - activityOf(a));
}

/** SSE 한 건을 목록에 반영한 새 배열 — 삭제는 제거, 나머지는 upsert. */
export function applySessionUpdate(
  list: AgentSessionSnapshot[],
  update: AgentSessionUpdateEvent,
): AgentSessionSnapshot[] {
  const session = update?.session;
  if (!session?.id) return list;
  if (update.reason === 'deleted') return list.filter((s) => s.id !== session.id);
  const idx = list.findIndex((s) => s.id === session.id);
  const next = idx === -1 ? [session, ...list] : list.map((s, i) => (i === idx ? session : s));
  return sortSessionsByActivity(next);
}


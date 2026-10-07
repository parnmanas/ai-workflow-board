import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '../../api';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import type { SessionProposal, SessionProposalEvent } from '../../types';

/**
 * operator 의 작업 제안(docs/voice-operator.md "작업 제안") — 화면 쪽 상태. 서버는 내가 정할 것만 보내 준다
 * (`GET /api/voice/proposals` + SSE `agent_session_proposal`). 여러 화면(세션 · operator 세션 · 알림)이 같은 목록을
 * 보므로 모듈 하나에 둔다.
 */

/** 화면이 들고 있는 제안 — 아직 정할 것(pending · queued)과 다시 보낼 수 있는 실패. */
export const VISIBLE_PROPOSAL_STATUSES: ReadonlySet<string> = new Set(['pending', 'queued', 'failed']);

const byCreated = (a: SessionProposal, b: SessionProposal) => a.created_at.localeCompare(b.created_at);

/** 제안 하나가 생기거나 바뀌었다 — 아직 보일 것이면 넣거나 바꾸고, 정해졌으면 뺀다. */
export function applyProposal(list: readonly SessionProposal[], next: SessionProposal): SessionProposal[] {
  const rest = list.filter((p) => p.id !== next.id);
  return VISIBLE_PROPOSAL_STATUSES.has(next.status) ? [...rest, next].sort(byCreated) : rest;
}

/**
 * 이 세션 화면에 보일 제안 — 이 세션에 시키자는 것, 그리고 이 세션이 operator 면 그 operator 가 낸 것
 * (operator 와 대화하다가 그 자리에서 보낼 수 있게).
 */
export function proposalsForSession(
  list: readonly SessionProposal[],
  ref: { manager_id: string; cli: string; session_id: string },
  operatorId: string | null,
): SessionProposal[] {
  return list.filter((p) => (p.target.manager_id === ref.manager_id && p.target.cli === ref.cli && p.target.session_id === ref.session_id)
    || (!!operatorId && p.operator.id === operatorId));
}

let state: SessionProposal[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function setState(next: SessionProposal[]): void {
  state = next;
  for (const fn of listeners) fn();
}

export const sessionProposalStore = {
  get: (): SessionProposal[] => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  apply(next: SessionProposal): void {
    setState(applyProposal(state, next));
  },
  /** 서버의 목록으로 맞춘다 — SSE 가 끊겼던 동안 놓친 변화도 여기서 따라잡는다. */
  load(): Promise<void> {
    loading ??= api.listSessionProposals()
      .then(({ proposals }) => setState([...proposals].sort(byCreated)))
      .catch(() => undefined)
      .finally(() => { loading = null; });
    return loading;
  },
  /** 테스트용. */
  reset(): void {
    loading = null;
    setState([]);
  },
};

/** 내가 정할 제안 목록 — 처음 쓸 때 서버에서 읽고, 이후는 SSE 로 따라간다. */
export function useSessionProposals(): SessionProposal[] {
  const list = useSyncExternalStore(sessionProposalStore.subscribe, sessionProposalStore.get, sessionProposalStore.get);
  useEffect(() => { void sessionProposalStore.load(); }, []);
  useBoardStreamEvent('agent_session_proposal', useCallback((data: SessionProposalEvent) => {
    if (data?.proposal) sessionProposalStore.apply(data.proposal);
  }, []));
  return list;
}

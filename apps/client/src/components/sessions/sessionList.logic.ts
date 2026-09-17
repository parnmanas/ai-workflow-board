/**
 * Agent Session 목록 순수 로직 — 사이드바/목록 페이지 공유. React 없이 node:test 로 구동.
 */
import type { AgentSessionSummary } from '../../types';

export function sortSessionsByActivity(list: AgentSessionSummary[]): AgentSessionSummary[] {
  return [...list].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export function sessionPath(workspaceBase: string, managerId: string, cli: string, sessionId: string): string {
  return `${workspaceBase}/sessions/${managerId}/${cli}/${encodeURIComponent(sessionId)}`;
}

/** 새 세션 cwd 기억 — 호스트×CLI 별 localStorage 키. */
export function lastCwdStorageKey(managerId: string, cli: string): string {
  return `awb.sessions.lastCwd.${managerId}.${cli}`;
}

/** cwd 의 마지막 경로 요소 (표시용). 절대경로·상대경로 모두 처리. */
export function cwdBaseName(cwd: string): string {
  if (!cwd) return '(unknown)';
  const normalized = cwd.replace(/[\\/]+$/, '');
  const sep = normalized.includes('/') ? '/' : '\\';
  return normalized.split(sep).filter(Boolean).pop() ?? cwd;
}

export interface CwdGroup {
  /** 전체 working directory 경로 */
  cwd: string;
  /** 표시용 짧은 이름 */
  cwdLabel: string;
  /** 해당 cwd 의 모든 세션 (최신 순) */
  sessions: (AgentSessionSummary & { cli: string })[];
}

/**
 * 여러 CLI 에서 가져온 세션을 cwd 별로 묶는다.
 * 그룹 순서는 각 그룹 내 가장 최근 세션 기준(최신 그룹 먼저).
 */
export function groupSessionsByCwd(sessionsByCli: Record<string, AgentSessionSummary[]>): CwdGroup[] {
  const flat = Object.entries(sessionsByCli).flatMap(([cli, sessions]) =>
    sessions.map((s) => ({ ...s, cli })),
  );
  flat.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  const groups = new Map<string, CwdGroup>();
  for (const s of flat) {
    const key = s.cwd || '';
    if (!groups.has(key)) {
      groups.set(key, { cwd: key, cwdLabel: cwdBaseName(key), sessions: [] });
    }
    groups.get(key)!.sessions.push(s);
  }
  return Array.from(groups.values());
}

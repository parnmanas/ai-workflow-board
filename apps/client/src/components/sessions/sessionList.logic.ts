/**
 * Agent Session 목록 순수 로직 — 사이드바/목록 페이지 공유. React 없이 node:test 로 구동.
 */
import type { AgentSessionHost, AgentSessionSummary } from '../../types';

export function sortSessionsByActivity(list: AgentSessionSummary[]): AgentSessionSummary[] {
  return [...list].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export interface HostCliEntry {
  key: string;
  manager_id: string;
  cli: string;
  host_name: string;
  label: string;
  path: string;
}

/** 사이드바 행: 호스트 × CLI. 경로는 `/ws/:wsId/sessions/:managerId/:cli`. */
export function hostCliEntries(hosts: AgentSessionHost[], workspaceBase: string, cliLabel: (cli: string) => string): HostCliEntry[] {
  const out: HostCliEntry[] = [];
  for (const host of hosts) {
    for (const cli of host.clis) {
      out.push({
        key: `${host.manager_id}:${cli}`,
        manager_id: host.manager_id,
        cli,
        host_name: host.name,
        label: `${host.name} · ${cliLabel(cli)}`,
        path: `${workspaceBase}/sessions/${host.manager_id}/${cli}`,
      });
    }
  }
  return out;
}

export function sessionPath(workspaceBase: string, managerId: string, cli: string, sessionId: string): string {
  return `${workspaceBase}/sessions/${managerId}/${cli}/${encodeURIComponent(sessionId)}`;
}

/** 새 세션 cwd 기억 — 호스트×CLI 별 localStorage 키. */
export function lastCwdStorageKey(managerId: string, cli: string): string {
  return `awb.sessions.lastCwd.${managerId}.${cli}`;
}

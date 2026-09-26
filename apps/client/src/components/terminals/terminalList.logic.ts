// Terminal 화면의 순수 로직 — 렌더링 없이 테스트할 수 있는 만큼을 여기 둔다.
//
// 터미널은 **살아 있는 것만** 존재한다(장비에 기록이 없다). 그래서 목록 갱신 규칙이
// 세션과 다르다: `exited` 는 보여 줄 과거가 아니라 곧 사라질 행이다.

import type { TerminalSummary } from '../../types';

export const LIVE_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['starting', 'live']);

export function isLiveTerminal(terminal: Pick<TerminalSummary, 'status'>): boolean {
  return LIVE_TERMINAL_STATUSES.has(terminal.status);
}

export function describeTerminalStatus(status: string | null | undefined): { label: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger' } {
  switch (status) {
    case 'starting': return { label: 'Starting', tone: 'accent' };
    case 'live': return { label: 'Live', tone: 'success' };
    case 'exited': return { label: 'Exited', tone: 'muted' };
    case 'error': return { label: 'Failed', tone: 'danger' };
    default: return { label: status ? String(status) : 'Unknown', tone: 'muted' };
  }
}

/** 경로의 마지막 조각 — Windows 경로(`C:\a\b`)도 같이 다룬다. */
export function basename(path: string): string {
  const trimmed = String(path || '').replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function terminalDisplayTitle(terminal: Pick<TerminalSummary, 'title' | 'shell_label' | 'shell' | 'cwd'>): string {
  const title = (terminal.title || '').trim();
  if (title) return title;
  const shell = terminal.shell_label || terminal.shell || 'shell';
  const dir = basename(terminal.cwd);
  return dir ? `${shell} — ${dir}` : shell;
}

/**
 * 목록에 한 행을 반영한다. 죽은 터미널은 **지운다** — 화면에 남겨 둘 과거가 없고,
 * 서버도 곧 잊는다. 정렬은 만들어진 순서(오래된 것이 위)를 지킨다.
 */
export function upsertTerminal(list: TerminalSummary[], next: TerminalSummary): TerminalSummary[] {
  const rest = list.filter((t) => t.terminal_id !== next.terminal_id);
  if (!isLiveTerminal(next)) return rest;
  return [...rest, next].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function terminalPath(wsId: string, managerId: string, terminalId: string): string {
  return `/ws/${wsId}/terminals/${managerId}/${terminalId}`;
}

/** base64 → 원문 바이트. xterm 은 Uint8Array 를 그대로 받아 UTF-8 경계를 스스로 맞춘다. */
export function decodeBase64(data: string): Uint8Array {
  if (!data) return new Uint8Array(0);
  const g = globalThis as any;
  if (typeof g.atob === 'function') {
    const binary = g.atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  // 테스트(node) 경로.
  return new Uint8Array(g.Buffer.from(data, 'base64'));
}

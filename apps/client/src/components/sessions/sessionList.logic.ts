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

/**
 * "최근" 의 기준. 목록은 오래된 것을 접어 두는데, 세션 행과 작업 폴더 그룹이 **같은 창**을 써야
 * 사이드바와 목록 화면이 어긋나지 않는다(예전엔 사이드바가 폴더는 전부 펼쳐 놓고 세션만 접었다).
 */
export const SESSION_RECENCY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function sessionTime(session: { updated_at?: string }): number {
  const t = session.updated_at ? new Date(session.updated_at).getTime() : Number.NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

export interface RecencySplit<T> {
  /** 바로 보여 줄 것. */
  visible: T[];
  /** "더 보기" 뒤로 접을 것. */
  hidden: T[];
}

/**
 * 세션을 최근/오래된 것으로 나눈다. 전부 오래됐으면 가장 최신 하나는 남긴다 — 폴더를 펼쳤는데
 * 아무것도 없는 화면이 되면 안 된다. 입력은 최신 순으로 정렬돼 있다고 본다(groupSessionsByCwd).
 */
export function splitRecentSessions<T extends { updated_at?: string }>(
  sessions: T[],
  now: number = Date.now(),
  windowMs: number = SESSION_RECENCY_WINDOW_MS,
): RecencySplit<T> {
  const cutoff = now - windowMs;
  const recent = sessions.filter((s) => sessionTime(s) >= cutoff);
  if (recent.length) return { visible: recent, hidden: sessions.filter((s) => sessionTime(s) < cutoff) };
  return { visible: sessions.slice(0, 1), hidden: sessions.slice(1) };
}

/**
 * 작업 폴더 그룹을 같은 창으로 나눈다 — 그 폴더에 최근 세션이 하나라도 있으면 최근 그룹이다.
 * 전부 오래됐으면 가장 최신 폴더 하나는 남긴다.
 */
export function splitRecentCwdGroups(
  groups: CwdGroup[],
  now: number = Date.now(),
  windowMs: number = SESSION_RECENCY_WINDOW_MS,
): RecencySplit<CwdGroup> {
  const cutoff = now - windowMs;
  const isRecent = (g: CwdGroup) => g.sessions.some((s) => sessionTime(s) >= cutoff);
  const recent = groups.filter(isRecent);
  if (recent.length) return { visible: recent, hidden: groups.filter((g) => !isRecent(g)) };
  return { visible: groups.slice(0, 1), hidden: groups.slice(1) };
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

/**
 * 라이브 SSE 로 들어온 세션 한 건을 그룹 목록에 반영한다 — 있으면 고치고, **없으면 넣는다**.
 *
 * 예전에는 이미 목록에 있는 행만 고쳤다. 그래서 방금 만든 세션은 `agent_session_update`
 * ('opened') 가 와도 조용히 버려졌고, 사이드바는 새로고침하거나 그 호스트 목록을 다시 불러올
 * 때까지 새 세션을 보여주지 않았다.
 *
 * **기존 행은 통째로 갈아끼우지 않는다.** 라이브 스냅샷은 목록 행이 가진 모든 것을 알지
 * 못한다(`created_at` / `source` / `size_bytes` 는 저장소를 읽어야 나온다) — 덮어쓰면 그
 * 정보가 사라지고 배지가 바뀐다. 아는 필드만 고친다.
 *
 * 재그룹핑은 최초 적재와 **같은 함수**(groupSessionsByCwd)로 한다 — 정렬·그룹 순서 규칙을
 * 두 벌로 만들면 "새로고침 전후로 순서가 다른" 문제가 생긴다. cwd 가 바뀐 경우도 같은 이유로
 * 자연히 처리된다(옛 그룹에서 빠지고 새 그룹에 들어간다).
 */
export function upsertSessionInGroups(
  groups: CwdGroup[],
  patch: {
    cli: string;
    session_id: string;
    cwd: string;
    title: string;
    updated_at: string;
    live_status?: string;
  },
): CwdGroup[] {
  const byCli: Record<string, AgentSessionSummary[]> = {};
  let existing: (AgentSessionSummary & { cli: string }) | null = null;
  for (const group of groups) {
    for (const session of group.sessions) {
      if (session.cli === patch.cli && session.session_id === patch.session_id) {
        existing = session;
        continue;
      }
      (byCli[session.cli] ??= []).push(session);
    }
  }
  // 빈 문자열은 "모른다" 로 읽는다 — 어댑터가 제목을 아직 못 정한 시점에 목록의 제목을
  // 지워 버리면 안 된다(예전 핸들러도 `live.title || row.title` 로 같은 규칙이었다).
  const merged: AgentSessionSummary = existing
    ? {
        ...existing,
        cwd: patch.cwd || existing.cwd,
        title: patch.title || existing.title,
        updated_at: patch.updated_at || existing.updated_at,
        live_status: patch.live_status,
      }
    : {
        cli: patch.cli,
        session_id: patch.session_id,
        cwd: patch.cwd,
        title: patch.title,
        // 목록 적재가 아니라 라이브 이벤트로 알게 된 세션이라 저장소 메타는 아직 모른다.
        created_at: null,
        updated_at: patch.updated_at,
        source: 'awb',
        live_status: patch.live_status,
      };
  (byCli[patch.cli] ??= []).push(merged);
  return groupSessionsByCwd(byCli);
}

// 사이드바의 접기/펼치기 상태 — 저장과 복원.
//
// **왜 별도 모듈인가**: 예전에는 이 로직이 Sidebar.tsx(1000줄 넘는 컴포넌트) 안에
// 인라인으로 있었고 테스트가 하나도 없었다. 그래서 "모든 메뉴와 서브메뉴의 폴드를
// 저장한다" 는 요구가 절반만 구현된 채로 지나갔다 — 섹션·세션·채팅·호스트는 저장되고
// WORK 의 Teams/Orchestrations/Boards 와 호스트 아래 작업 폴더는 매 새로고침마다
// 펼쳐진 상태로 돌아왔다. 순수 함수로 떼어 내면 "무엇을 저장하는가" 를 목록으로
// 고정할 수 있다.
//
// **왜 localStorage 인가**: 예전 구현은 쿠키에 넣었다(주석은 localStorage 라고
// 적혀 있었는데 코드는 `document.cookie` 였다). 쿠키는 **모든 HTTP 요청에 실려
// 나간다** — 사이드바를 어떻게 접었는지는 서버가 알 필요가 없고, 호스트·작업 폴더
// 키까지 담기 시작하면 매 API 호출에 수백 바이트가 붙는다. 저장 위치를 옮기되,
// 기존 쿠키가 있으면 한 번 읽어 옮기고 지운다(아래 `readLegacyCookie`).

const STORAGE_KEY = 'awb_sidebar_fold';
/** 쿠키에 남아 있던 예전 값 — 한 번 읽어 옮기고 지운다. */
const LEGACY_COOKIE_KEY = 'awb_sidebar_fold';

/**
 * 저장하는 폴드 상태 전부. 새 접기 지점을 만들면 **여기에 키를 더하고**
 * `sidebar-fold-persistence.test.mjs` 의 목록도 함께 늘린다 — 그 테스트가 이
 * 타입과 Sidebar 의 실제 state 를 맞춰 본다.
 *
 * 불리언/레코드는 "접혔다(true)" 이고, 문자열 배열은 "이 키들이 접혔다" 또는
 * "이 키들이 펼쳐졌다"(older*) 이다. 어느 쪽이든 **기본값은 저장하지 않아도 되는
 * 쪽**이라, 아무것도 저장된 적 없는 새 사용자는 전부 펼친 기본 화면을 본다.
 */
export interface SidebarFoldSnapshot {
  /** SESSIONS 섹션 */
  sessions: boolean;
  /** CHAT 섹션 */
  chats: boolean;
  /** 섹션 헤더(WORK / AUTOMATION / KNOWLEDGE / QUALITY / SETTINGS …) */
  sections: Record<string, boolean>;
  /** WORK 의 최상위 메뉴 — teams / orchestrations / boards */
  groups: Record<string, boolean>;
  /** 세션 트리의 Runtime Host */
  hosts: string[];
  /** 호스트 아래 작업 폴더(cwd) */
  hostCwds: string[];
  /** "+N개 더 보기" 로 펼쳐 둔 작업 폴더 */
  olderCwds: string[];
  /** "+N개 더 보기" 로 펼쳐 둔 호스트의 오래된 폴더 묶음 */
  olderHosts: string[];
}

export const EMPTY_SIDEBAR_FOLD: SidebarFoldSnapshot = {
  sessions: false,
  chats: false,
  sections: {},
  groups: {},
  hosts: [],
  hostCwds: [],
  olderCwds: [],
  olderHosts: [],
};

/** 저장된 모양이 무엇이든 온전한 스냅샷으로 만든다. 예전 스냅샷(키가 적던 시절)도
 *  그대로 읽힌다 — 없는 키는 기본값이 된다. */
export function normalizeSidebarFold(raw: unknown): SidebarFoldSnapshot {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<SidebarFoldSnapshot>;
  const bool = (v: unknown) => v === true;
  const rec = (v: unknown): Record<string, boolean> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    // 접힌 것만 남긴다 — `false` 를 들고 있어 봐야 기본값과 같고 저장만 커진다.
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val === true) out[k] = true;
    return out;
  };
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  return {
    sessions: bool(p.sessions),
    chats: bool(p.chats),
    sections: rec(p.sections),
    groups: rec(p.groups),
    hosts: list(p.hosts),
    hostCwds: list(p.hostCwds),
    olderCwds: list(p.olderCwds),
    olderHosts: list(p.olderHosts),
  };
}

function readLegacyCookie(): unknown | null {
  try {
    const match = document.cookie
      .split(';')
      .find((c) => c.trim().startsWith(`${LEGACY_COOKIE_KEY}=`));
    if (!match) return null;
    const raw = decodeURIComponent(match.trim().slice(LEGACY_COOKIE_KEY.length + 1));
    // 옮겨 담았으므로 지운다 — 남겨 두면 계속 모든 요청에 실려 나간다.
    document.cookie = `${LEGACY_COOKIE_KEY}=; path=/; max-age=0; SameSite=Lax`;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 저장된 폴드 상태. 읽기 실패·손상은 전부 "저장된 적 없음" 으로 떨어진다 —
 *  사이드바가 못 그려지는 것보다 기본 모양으로 뜨는 편이 낫다. */
export function loadSidebarFold(): SidebarFoldSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeSidebarFold(JSON.parse(raw));
  } catch {
    /* 읽기 실패 → 아래 쿠키 폴백 */
  }
  const legacy = readLegacyCookie();
  if (legacy) {
    const migrated = normalizeSidebarFold(legacy);
    saveSidebarFold(migrated);
    return migrated;
  }
  return EMPTY_SIDEBAR_FOLD;
}

export function saveSidebarFold(snap: SidebarFoldSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch { /* best-effort — 저장 실패가 사이드바를 막으면 안 된다 */ }
}

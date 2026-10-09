/**
 * PWA/하이브리드 앱의 서버 주소 설정 — docs/tickets.md·ownership 계약과 무관한 순수 클라이언트 설정.
 *
 * AWB 서버가 UI까지 서빙하는 단일 오리진(`same-origin`)이 기본이다. PWA를 설치한 폰에서
 * 집/사무실의 다른 AWB 서버를 바라봐야 할 때만 주소를 입력한다 — 빈 값이면 기존처럼
 * 상대경로(`/api`, `/api/events/stream`)를 써서 CORS 문제 자체가 없다.
 *
 * 저장 키: localStorage `awb.serverUrl` (정규화된 origin[+subpath], 빈 문자열은 미저장).
 * 서버를 바꾸면 그 서버가 발급한 토큰이 무효이므로 인증 상태도 함께 지우고 reload 한다.
 */

export const SERVER_URL_KEY = 'awb.serverUrl';
export const SERVER_URL_CHANGED_EVENT = 'awb:server-url-changed';

/** 입력값을 `https://host:port[/subpath]` 형태로 정규화. 빈 입력은 ''(same-origin). 형식 오류는 throw. */
export function normalizeServerUrl(raw: string): string {
  const v = (raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('주소가 올바르지 않습니다. 예: https://awb.example.com 또는 http://192.168.1.10:7701');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('http:// 또는 https:// 주소만 입력할 수 있습니다');
  }
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

/** 현재 설정된 서버 베이스. ''이면 same-origin(상대경로 사용). */
export function getServerBaseUrl(): string {
  try {
    const raw = localStorage.getItem(SERVER_URL_KEY);
    if (!raw) return '';
    return normalizeServerUrl(raw);
  } catch {
    return '';
  }
}

/** REST/SSE가 붙는 API 베이스 — same-origin이면 '/api', 커스텀이면 '<base>/api'. */
export function getApiBase(): string {
  const base = getServerBaseUrl();
  return base ? `${base}/api` : '/api';
}

/** 전체 페이지 이동(OAuth 시작 등)에 쓰는 절대 URL. */
export function getServerUrl(path: string): string {
  const base = getServerBaseUrl();
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/**
 * HTTPS 페이지에서 http 서버를 가리키면 브라우저가 차단한다(mixed content).
 * PWA는 보통 HTTPS(또는 localhost)라서 이 조합은 미리 경고한다.
 */
export function isMixedContentRisk(serverBase: string, pageProtocol?: string): boolean {
  const proto = pageProtocol
    || (typeof window !== 'undefined' ? window.location.protocol : 'https:');
  return proto === 'https:' && serverBase.startsWith('http://');
}

/** 서버 헬스 확인 — 저장하지 않고 입력값이 살아있는지만 본다. */
export async function checkServerHealth(raw: string, timeoutMs = 8000): Promise<{ ok: boolean; status?: string; error?: string }> {
  let base: string;
  try {
    base = normalizeServerUrl(raw);
  } catch (err: any) {
    return { ok: false, error: err?.message || '주소가 올바르지 않습니다' };
  }
  const url = `${base}/api/health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `서버 응답 오류 (HTTP ${res.status})` };
    const data = await res.json().catch(() => null);
    return { ok: true, status: data?.status || 'ok' };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: '시간 초과 — 주소·방화벽을 확인해 주세요' };
    return { ok: false, error: '연결 실패 — 주소·HTTPS·CORS를 확인해 주세요' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 서버 주소를 저장한다. 바뀌면 이 서버용 토큰·계정 선택을 지우고
 * `SERVER_URL_CHANGED_EVENT`를 쏜다 — 호출한 쪽에서 reload 한다.
 */
export function setServerBaseUrl(raw: string): string {
  const next = normalizeServerUrl(raw);
  let prev = '';
  try {
    prev = localStorage.getItem(SERVER_URL_KEY) || '';
  } catch { /* storage unavailable */ }
  if (prev === next) return next;
  try {
    if (next) localStorage.setItem(SERVER_URL_KEY, next);
    else localStorage.removeItem(SERVER_URL_KEY);
    // 이 서버가 발급한 세션은 다른 서버에서 무효다 — 남기면 401 루프만 돈다.
    localStorage.removeItem('auth_token');
    localStorage.removeItem('currentAccountId');
    try { sessionStorage.removeItem('awb.activeAccountId'); } catch { /* ignore */ }
  } catch { /* quota / private mode */ }
  try {
    window.dispatchEvent(new CustomEvent(SERVER_URL_CHANGED_EVENT, { detail: { baseUrl: next } }));
  } catch { /* ignore */ }
  return next;
}

export function subscribeServerBaseUrl(fn: (baseUrl: string) => void): () => void {
  const onCustom = (e: Event) => fn((e as CustomEvent<{ baseUrl: string }>).detail?.baseUrl ?? '');
  const onStorage = (e: StorageEvent) => {
    if (e.key === SERVER_URL_KEY) fn(e.newValue || '');
  };
  window.addEventListener(SERVER_URL_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SERVER_URL_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

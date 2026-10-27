/**
 * Android 앱(`apps/android`) 안에서 도는 웹 화면 ↔ 앱.
 *
 * 앱은 서버가 서빙하는 이 웹 화면을 WebView 로 그대로 띄우고, `window.AwbAndroid` 를 서버 오리진의
 * 최상위 문서에만 넣는다(androidx.webkit WebMessageListener). 웹은 `{id, type, …}` 를 보내고 앱은
 * `{id, ok, result | error}` 로 답한다. 앱이 먼저 알리는 것은 `{event, …}` — 음성 상태 변화와
 * 알림을 눌러 세션으로 가기. 앱 쪽 짝: `apps/android/.../WebBridge.java`.
 *
 * 웹(브라우저 · PWA)에서는 객체가 없으므로 `isAndroidApp()` 이 false 이고 아무것도 하지 않는다.
 */

interface NativePort {
  postMessage(message: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener?(type: 'message', listener: (event: MessageEvent) => void): void;
}

declare global {
  interface Window {
    AwbAndroid?: NativePort;
  }
}

export interface NativeVoiceStatus {
  /** 이 단말에서 상시 음성을 켜 두었는가(앱 설정). */
  enabled: boolean;
  /** 서비스가 돌고 있는가. */
  running: boolean;
  /** off · sleeping(부르기를 기다림) · awake(대화 중) · paused(앱 화면이 맡음) · error */
  state: 'off' | 'sleeping' | 'awake' | 'paused' | 'error';
  detail: string;
  operator: string;
  mic: boolean;
  notifications: boolean;
  battery_optimized: boolean;
}

export const NATIVE_VOICE_OFF: NativeVoiceStatus = {
  enabled: false, running: false, state: 'off', detail: '', operator: '',
  mic: false, notifications: false, battery_optimized: false,
};

function port(): NativePort | null {
  if (typeof window === 'undefined') return null;
  return window.AwbAndroid ?? null;
}

export function isAndroidApp(): boolean {
  return !!port();
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const listeners = new Map<string, Set<(msg: any) => void>>();
let attached = false;
let seq = 0;

function onMessage(event: MessageEvent): void {
  let msg: any;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (msg?.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result ?? {});
    else p.reject(new Error(String(msg.error || 'native_error')));
    return;
  }
  if (typeof msg?.event === 'string') {
    for (const fn of listeners.get(msg.event) ?? []) fn(msg);
  }
}

function attach(p: NativePort): void {
  if (attached) return;
  attached = true;
  if (p.addEventListener) p.addEventListener('message', onMessage);
  else p.onmessage = onMessage;
}

export function callNative<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const p = port();
  if (!p) return Promise.reject(new Error('not_android_app'));
  attach(p);
  const id = `w${Date.now().toString(36)}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('native_timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      p.postMessage(JSON.stringify({ ...payload, id, type }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

/** 앱이 먼저 보내는 알림(`voice-status`, `navigate`). 해제 함수를 돌려준다. */
export function onNativeEvent(event: string, fn: (msg: any) => void): () => void {
  const p = port();
  if (!p) return () => undefined;
  attach(p);
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => { set!.delete(fn); };
}

// ─── 로그인 ────────────────────────────────────────────────────────────────

/**
 * 앱이 들고 있는 세션 토큰 — 앱은 단말 자격으로 세션이 끊길 때마다 새로 받으므로, 배포로 서버가
 * 다시 떠도 다시 로그인하지 않는다. 앱이 로그인 전이면 ''.
 */
export async function nativeSessionToken(): Promise<string> {
  if (!isAndroidApp()) return '';
  try {
    const r = await callNative<{ token?: string }>('session.get');
    return r.token || '';
  } catch {
    return '';
  }
}

/** 401 을 받았다 — 앱에 새 세션을 달라고 한다. 앱도 못 주면 ''(진짜 로그아웃). */
export async function nativeRefreshToken(rejected: string): Promise<string> {
  if (!isAndroidApp()) return '';
  try {
    const r = await callNative<{ token?: string }>('session.refresh', { rejected });
    const token = r.token || '';
    return token && token !== rejected ? token : '';
  } catch {
    return '';
  }
}

/** 화면에서 로그인이 끝났다 — 앱이 단말 자격을 받고(처음이면) 상시 음성을 켠다. */
export function notifyNativeLoggedIn(token: string): void {
  if (!isAndroidApp() || !token) return;
  callNative('session.loggedIn', { token }).catch(() => undefined);
}

export async function notifyNativeLoggedOut(): Promise<void> {
  if (!isAndroidApp()) return;
  await callNative('session.loggedOut').catch(() => undefined);
}

/** Google 은 WebView 안 로그인을 막는다 — 앱이 시스템 브라우저로 로그인하고 돌아온다. */
export function startNativeGoogleLogin(): void {
  callNative('oauth.google').catch(() => undefined);
}

/** 앱의 서버 목록(전환 · 추가 · 관리)을 연다. 2.1 이하 앱은 서버 주소 화면을 연다. */
export function changeNativeServer(): void {
  callNative('server.change').catch(() => undefined);
}

export interface NativeAppInfo {
  app: 'android';
  version: string;
  version_code: number;
  /** 지금 서버 주소. */
  server: string;
  /** 앱에서 붙인 서버 이름, 없으면 host — 2.2 부터. */
  server_name?: string;
  /** 앱에 등록된 서버 수 — 2.2 부터. */
  servers?: number;
}

/** 앱 정보(`hello`). 앱이 아니거나 답이 없으면 null. */
export async function nativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!isAndroidApp()) return null;
  try {
    return await callNative<NativeAppInfo>('hello');
  } catch {
    return null;
  }
}

// ─── 상시 음성 ─────────────────────────────────────────────────────────────

export async function nativeVoiceStatus(): Promise<NativeVoiceStatus> {
  if (!isAndroidApp()) return NATIVE_VOICE_OFF;
  try {
    return { ...NATIVE_VOICE_OFF, ...(await callNative<Partial<NativeVoiceStatus>>('voice.status')) };
  } catch {
    return NATIVE_VOICE_OFF;
  }
}

/** 켜면 앱이 마이크 · 알림 권한을 묻고 서비스를 띄운다(사용자가 고르는 동안 기다린다). */
export async function setNativeVoice(enabled: boolean): Promise<NativeVoiceStatus> {
  const r = await callNative<Partial<NativeVoiceStatus>>('voice.setEnabled', { enabled }, 120_000);
  return { ...NATIVE_VOICE_OFF, ...r };
}

export function openNativeBatterySettings(): void {
  callNative('voice.batterySettings').catch(() => undefined);
}

/** 앱 안에서 이 화면이 숨었는가 — 숨은 동안 마이크와 소리는 앱의 상시 음성이 맡는다. */
export function hiddenInAndroidApp(): boolean {
  return isAndroidApp() && typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * 알림을 눌러 들어온 앱 링크(`awb://sessions/…`, 공유된 https 링크)를 화면 경로로. 세션이 아니면 null.
 * 앱은 경로로 바꿔 보내지만, 옛 앱 · 공유 링크도 같은 규칙으로 받는다.
 */
export function parseAwbDeepLink(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let path: string;
  if (u.protocol === 'awb:') {
    const segs = [u.hostname, ...u.pathname.split('/').filter(Boolean)].filter(Boolean);
    path = `/${segs.join('/')}`;
  } else if (u.protocol === 'http:' || u.protocol === 'https:') {
    path = u.pathname;
  } else {
    return null;
  }
  if (!path.startsWith('/sessions/')) return null;
  return `${path}${u.search}${u.hash}`;
}

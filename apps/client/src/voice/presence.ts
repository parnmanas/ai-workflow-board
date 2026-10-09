import { api } from '../api';

/**
 * 지금 어느 세션 화면을 보고 있는가를 서버에 알린다(docs/voice-operator.md "작업 보고"). 서버는 보고 있는
 * 세션의 완료·대기를 operator 에게 보고하지 않는다 — 이미 보고 있다.
 *
 * 세션 화면이 열리고 닫힐 때, 탭이 숨거나 다시 보일 때, 그리고 보는 동안 30초마다 보낸다. 서버는 소식이
 * 끊긴 탭을 75초 뒤에 잊는다(탭을 닫았거나 서버가 다시 떴다). 실패는 조용히 넘긴다 — 놓치면 한 번 더
 * 듣는 것뿐이다.
 */

export interface PresenceSession {
  manager_id: string;
  cli: string;
  session_id: string;
}

const HEARTBEAT_MS = 30_000;
const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let viewing: PresenceSession | null = null;
let handling = false;
let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;

function send(): void {
  // 숨은 탭은 보고 있지 않다 — 단, 이름을 불러 깨운 대화를 맡은 화면은 숨어 있어도 답을 스스로 읽으므로
  // 보고 있는 것으로 친다(서버가 같은 답을 알림으로 한 번 더 읽지 않게).
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible' || handling;
  api.reportVoicePresence({ tab_id: TAB_ID, session: viewing, visible }).catch(() => undefined);
}

function onVisibility(): void {
  if (viewing) send();
}

/**
 * 세션 화면이 열리면 그 세션, 닫히면 null. 음성을 쓸 수 있는 사용자에게서만 부른다.
 * `handlesWhileHidden` — 이 화면이 깨어 있는 대화를 맡고 있다(숨어 있어도 답을 읽는다).
 */
export function reportViewingSession(session: PresenceSession | null, handlesWhileHidden = false): void {
  const changed = viewing?.manager_id !== session?.manager_id || viewing?.cli !== session?.cli
    || viewing?.session_id !== session?.session_id || handling !== (handlesWhileHidden && !!session);
  viewing = session;
  handling = handlesWhileHidden && !!session;
  if (changed) send();
  if (session && !timer) timer = setInterval(() => { if (viewing) send(); }, HEARTBEAT_MS);
  if (!session && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    document.addEventListener('visibilitychange', onVisibility);
  }
}

// ─── 음성 지원 스위치 ───────────────────────────────────────────────────────

const DEVICE_ID_KEY = 'awb.voice.device-id';

/** 이 단말(브라우저 저장소)의 고정 id — 스위치는 단말마다 따로라 서버가 단말을 구분해야 한다. */
export function voiceDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    localStorage.setItem(DEVICE_ID_KEY, TAB_ID);
    return TAB_ID;
  } catch {
    return TAB_ID;
  }
}

/**
 * 이 단말의 음성 지원 스위치를 서버에 알린다(켤 때 · 끌 때 · 앱이 열릴 때). 사용자의 단말이 모두 꺼져 있으면
 * 서버가 세션 완료를 operator 에게 보고하지 않는다(docs/voice-operator.md "음성 지원 · 잠들기"). 실패는 조용히
 * 넘긴다 — 다음에 열릴 때 다시 알린다.
 */
export function reportVoiceSupport(enabled: boolean): void {
  api.reportVoiceSupport({ device_id: voiceDeviceId(), enabled }).catch(() => undefined);
}

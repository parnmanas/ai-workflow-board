import { useEffect, useState } from 'react';

/**
 * 이름 부르기의 탭 상태(docs/voice-operator.md "이름 부르기 · 잠들기").
 *
 *   off       — 이 단말에서 이름 부르기를 켜지 않았다.
 *   sleeping  — 켜져 있고 아무도 깨어 있지 않다. 상시 청취(WakeListener)가 이름을 기다린다.
 *   awake     — operator 하나가 불려 깨어 있다. 그 세션 화면의 대화 모드가 마이크를 쓰고, 상시 청취는 쉰다.
 *
 * 켜기는 단말의 선택이라 localStorage 에 두고 탭 사이에 맞춘다. 깨어 있음은 그 탭의 것이다 — 마이크를
 * 쥔 탭(Web Lock, WakeListener)에서만 깨어난다.
 */

export type WakeMode = 'off' | 'sleeping' | 'awake';

/** 상시 청취가 지금 무엇을 하는가 — 사이드바가 그대로 보여 준다. */
export type WakeListenerStatus =
  | 'idle'
  /** 브라우저가 소리 처리를 사용자 동작 뒤에만 허락한다 — 화면을 한 번 누르면 시작한다. */
  | 'waiting-gesture'
  /** 다른 탭이 듣고 있다(한 단말에서 한 탭만 듣는다). */
  | 'other-tab'
  | 'starting'
  | 'listening'
  /** 들린 말이 이름인지 확인하는 중. */
  | 'checking'
  | 'error';

export interface WakeSnapshot {
  enabled: boolean;
  mode: WakeMode;
  /** 깨어 있는 operator. */
  operatorId: string | null;
  /** 깨어난 시각(ms) — 깨어날 때마다 바뀐다. 한 번 깨어 있는 동안을 가리키는 키로 쓴다. */
  wokeAt: number;
  listener: WakeListenerStatus;
  error: string | null;
  /** 마이크를 쓰는 대화 모드 수 — 0 일 때만 상시 청취가 마이크를 연다. */
  micClaims: number;
  /**
   * 알림음 뒤의 보고 요청 또는 선택지 설명 뒤의 답변을 이름 없이 듣는 짧은 창.
   * 상시 이름 부르기를 꺼 두어도 알림음 뒤에는 잠깐 마이크를 연다.
   */
  followUp: { operatorId: string; until: number; source: 'decision' | 'notification' } | null;
}

/** 결정이 필요한 보고를 읽은 뒤 이름 없이 답을 기다리는 시간. */
export const FOLLOW_UP_MS = 8_000;
export const NOTIFICATION_FOLLOW_UP_MS = 15_000;
export const NOTIFICATION_FOLLOW_UP_KEY = 'awb.voice.notification-listen';

const ENABLED_KEY = 'awb.voice.wake';
/** 깨어났는데 그 operator 의 화면이 이만큼 안에 열리지 않으면(이동 실패) 다시 잠든다. */
const ATTACH_GRACE_MS = 10_000;

type Listener = (state: WakeSnapshot) => void;

function readEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

class WakeStore {
  #state: WakeSnapshot = {
    enabled: false, mode: 'off', operatorId: null, wokeAt: 0, listener: 'idle', error: null, micClaims: 0, followUp: null,
  };
  #followUpTimer: ReturnType<typeof setTimeout> | null = null;
  #followUpRevision = 0;
  #followUpHolds = 0;
  #listeners = new Set<Listener>();
  #firstPrompt: { operatorId: string; text: string } | null = null;
  #attached = new Map<string, number>();
  #attachTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    const enabled = readEnabled();
    this.#state = { ...this.#state, enabled, mode: enabled ? 'sleeping' : 'off' };
    window.addEventListener('storage', (e) => {
      if (e.key === ENABLED_KEY) this.#applyEnabled(e.newValue === '1');
    });
  }

  get state(): WakeSnapshot {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #set(patch: Partial<WakeSnapshot>): void {
    const next = { ...this.#state, ...patch };
    if (Object.keys(patch).every((k) => (this.#state as any)[k] === (next as any)[k])) return;
    this.#state = next;
    for (const l of this.#listeners) l(next);
  }

  #applyEnabled(enabled: boolean): void {
    if (enabled) this.#set({ enabled, mode: this.#state.mode === 'awake' ? 'awake' : 'sleeping', error: null });
    else {
      this.#firstPrompt = null;
      this.#clearFollowUp();
      this.#set({ enabled, mode: 'off', operatorId: null, listener: 'idle', error: null });
    }
  }

  setEnabled(enabled: boolean): void {
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch { /* private mode */ }
    this.#applyEnabled(enabled);
  }

  /** `operatorId` 가 불렸다. `firstPrompt` 는 이름 뒤에 이어 한 말(없으면 null). */
  wake(operatorId: string, firstPrompt: string | null): void {
    this.#clearFollowUp();
    this.#firstPrompt = firstPrompt ? { operatorId, text: firstPrompt } : null;
    this.#set({ mode: 'awake', operatorId, wokeAt: Date.now(), error: null });
    if (this.#attachTimer) clearTimeout(this.#attachTimer);
    this.#attachTimer = setTimeout(() => {
      this.#attachTimer = null;
      if (!this.#attached.get(operatorId)) this.sleep(operatorId);
    }, ATTACH_GRACE_MS);
  }

  /** 깨운 말에 이어 한 말을 한 번만 내준다. */
  takeFirstPrompt(operatorId: string): string | null {
    if (this.#firstPrompt?.operatorId !== operatorId) return null;
    const { text } = this.#firstPrompt;
    this.#firstPrompt = null;
    return text;
  }

  /** 다시 잠든다. `operatorId` 를 주면 그 operator 가 깨어 있을 때만 — 다른 operator 로 넘어간 뒤의 늦은 신호를 무시한다. */
  sleep(operatorId?: string): void {
    if (this.#state.mode !== 'awake') return;
    if (operatorId && this.#state.operatorId !== operatorId) return;
    this.#firstPrompt = null;
    this.#set({ mode: this.#state.enabled ? 'sleeping' : 'off', operatorId: null });
  }

  /**
   * operator 세션 화면이 열려 있는 동안 등록한다. 마지막 화면이 닫히면(다른 곳으로 이동) 그 operator 는
   * 잠든다 — 판정은 한 틱 뒤에 한다. React 개발 모드는 화면을 붙였다 떼었다 다시 붙이므로, 곧바로 판정하면
   * 막 깨어난 operator 를 재운다.
   */
  attach(operatorId: string): () => void {
    this.#attached.set(operatorId, (this.#attached.get(operatorId) ?? 0) + 1);
    return () => {
      this.#attached.set(operatorId, Math.max(0, (this.#attached.get(operatorId) ?? 1) - 1));
      setTimeout(() => { if (!this.#attached.get(operatorId)) this.sleep(operatorId); }, 0);
    };
  }

  /**
   * operator 가 결정이 필요한 보고를 막 읽어 줬다 — 잠깐 이름 없이 답을 듣는다. 이름 부르기가 켜져 있고 잠든
   * 동안에만 연다(깨어 있으면 이미 이름 없이 듣고 있다).
   */
  openFollowUp(operatorId: string, ms = FOLLOW_UP_MS): boolean {
    if (!this.#state.enabled || this.#state.mode !== 'sleeping') return false;
    return this.#openFollowUp(operatorId, ms, 'decision');
  }

  /** A cue opens a temporary input window without enabling persistent name calling. */
  openNotificationFollowUp(operatorId: string, ms = NOTIFICATION_FOLLOW_UP_MS, broadcast = true): boolean {
    if (this.#state.mode === 'awake' || this.#state.micClaims > 0) return false;
    if (!this.#openFollowUp(operatorId, ms, 'notification')) return false;
    if (broadcast) {
      // The tab playing the cue can differ from the tab that owns the microphone lock.
      try {
        localStorage.setItem(NOTIFICATION_FOLLOW_UP_KEY, JSON.stringify({ operatorId, until: this.#state.followUp!.until }));
        localStorage.removeItem(NOTIFICATION_FOLLOW_UP_KEY);
      } catch { /* this tab still listens if storage is unavailable */ }
    }
    return true;
  }

  #openFollowUp(operatorId: string, ms: number, source: 'decision' | 'notification'): boolean {
    if (this.#followUpHolds > 0) return false; // Keep an utterance with the operator it started addressing.
    if (this.#followUpTimer) clearTimeout(this.#followUpTimer);
    this.#followUpRevision += 1;
    this.#followUpTimer = setTimeout(() => {
      this.#followUpTimer = null;
      if (!this.#followUpHolds) this.#clearFollowUp();
      else this.#followUpTimer = setTimeout(() => this.#clearFollowUp(), 60_000);
    }, ms);
    this.#set({ mode: 'sleeping', followUp: { operatorId, until: Date.now() + ms, source } });
    return true;
  }

  /** Keep a started utterance alive through the deadline and its STT request. */
  holdFollowUp(): { operatorId: string; isValid: () => boolean; release: () => void } | null {
    const operatorId = this.activeFollowUp();
    if (!operatorId) return null;
    const revision = this.#followUpRevision;
    this.#followUpHolds += 1;
    let released = false;
    return { operatorId, isValid: () => revision === this.#followUpRevision, release: () => {
      if (released || revision !== this.#followUpRevision) return;
      released = true;
      this.#followUpHolds -= 1;
      if (!this.#followUpHolds && this.#state.followUp && Date.now() >= this.#state.followUp.until) this.#clearFollowUp();
    } };
  }

  closeNotificationFollowUp(): void {
    if (this.#state.followUp?.source === 'notification') this.#clearFollowUp();
  }

  /** 지금 답을 기다리는 창이 열려 있으면 그 operator. */
  activeFollowUp(now = Date.now()): string | null {
    const f = this.#state.followUp;
    return f && now < f.until ? f.operatorId : null;
  }

  #clearFollowUp(): void {
    if (this.#followUpTimer) clearTimeout(this.#followUpTimer);
    this.#followUpTimer = null;
    this.#followUpRevision += 1;
    this.#followUpHolds = 0;
    if (this.#state.followUp) this.#set({ followUp: null,
      ...(!this.#state.enabled && this.#state.mode === 'sleeping' ? { mode: 'off' as const } : {}) });
  }

  setListener(listener: WakeListenerStatus, error: string | null = null): void {
    this.#set({ listener, error });
  }

  /** 대화 모드가 마이크를 쓰는 동안 잡아 둔다 — 상시 청취가 같은 마이크를 따로 열지 않게. */
  claimMic(): () => void {
    this.#set({ micClaims: this.#state.micClaims + 1 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#set({ micClaims: Math.max(0, this.#state.micClaims - 1) });
    };
  }
}

export const wakeStore = new WakeStore();

export function useWakeState(): WakeSnapshot {
  const [state, setState] = useState<WakeSnapshot>(wakeStore.state);
  useEffect(() => {
    setState(wakeStore.state);
    return wakeStore.subscribe(setState);
  }, []);
  return state;
}

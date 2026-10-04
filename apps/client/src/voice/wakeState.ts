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
}

const ENABLED_KEY = 'awb.voice.wake';
/** 깨어났는데 그 operator 의 화면이 이만큼 안에 열리지 않으면(이동 실패) 다시 잠든다. */
const ATTACH_GRACE_MS = 10_000;

type Listener = (state: WakeSnapshot) => void;

function readEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

class WakeStore {
  #state: WakeSnapshot = {
    enabled: false, mode: 'off', operatorId: null, wokeAt: 0, listener: 'idle', error: null, micClaims: 0,
  };
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
      this.#set({ enabled, mode: 'off', operatorId: null, listener: 'idle', error: null });
    }
  }

  setEnabled(enabled: boolean): void {
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch { /* private mode */ }
    this.#applyEnabled(enabled);
  }

  /** `operatorId` 가 불렸다. `firstPrompt` 는 이름 뒤에 이어 한 말(없으면 null). */
  wake(operatorId: string, firstPrompt: string | null): void {
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

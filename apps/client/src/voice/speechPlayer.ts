import { api } from '../api';

/**
 * 낭독기. 탭 안에서 **한 번에 한 목소리**만 낸다 — 새 낭독이 오면 이전 것을 끊는다(최신 답이 우선).
 * 음성 알림(`enqueueClip`)은 끊지 않고 **줄을 선다** — 대화 답을 듣는 중에 알림이 끼어들지 않고,
 * 답이 끝나면 차례로 나온다. 사용자가 말하기 시작하면(`stop`) 줄까지 비운다 — 조용히 하라는 뜻이다.
 *
 * 텍스트는 서버가 읽을 조각으로 나누고(`/voice/speakable` — 마크다운·코드·식별자 정리는 서버의
 * toSpeakable 한 곳에서), 조각마다 합성해(`/voice/speech`) 차례로 튼다. 한 조각을 트는 동안 다음
 * 조각을 미리 받아 두므로 첫 소리는 첫 조각의 합성 시간만큼만 늦다.
 *
 * 재생은 `<audio>` 하나를 계속 쓴다. iOS Safari 는 사용자 제스처 안에서 한 번 재생된 요소만
 * 나중에(제스처 없이) 소리를 낼 수 있으므로, 마이크·읽기 버튼을 누를 때 `unlock()` 으로 그 요소를
 * 깨워 둔다. 같은 요소를 계속 쓰는 이유가 그것이다.
 */

export interface SpeechState {
  speaking: boolean;
  /** 지금(또는 마지막으로) 읽은 것의 키 — 어느 답을 읽는지 화면이 알 수 있게. */
  key: string | null;
  error: string | null;
}

type Listener = (state: SpeechState) => void;

// 아주 짧은 무음 WAV — unlock 때 재생해 요소를 깨운다.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

class SpeechPlayer {
  #audio: HTMLAudioElement | null = null;
  #generation = 0;
  #objectUrl: string | null = null;
  #endCurrent: (() => void) | null = null;
  #state: SpeechState = { speaking: false, key: null, error: null };
  #listeners = new Set<Listener>();
  #queue: Array<{ key: string; fetch: () => Promise<Blob>; onEnded?: () => void }> = [];

  get state(): SpeechState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #set(next: SpeechState): void {
    this.#state = next;
    for (const l of this.#listeners) l(next);
  }

  #element(): HTMLAudioElement {
    if (!this.#audio) {
      this.#audio = new Audio();
      this.#audio.preload = 'auto';
    }
    return this.#audio;
  }

  /** 사용자 제스처 안에서 부른다 — 이후 제스처 없는 재생(턴이 끝났을 때)이 막히지 않게. */
  unlock(): void {
    const el = this.#element();
    if (this.#state.speaking) return;
    el.src = SILENT_WAV;
    el.play().then(() => el.pause()).catch(() => undefined);
  }

  /** 읽기를 멈추고 기다리던 알림도 버린다. 사용자가 말하기 시작하면(barge-in) 곧바로 부른다. */
  stop(): void {
    this.#queue = [];
    this.#interrupt();
  }

  /** 지금 나오는 소리만 끊는다(줄 선 알림은 남는다). */
  #interrupt(): void {
    this.#generation += 1;
    const el = this.#audio;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.#releaseUrl();
    this.#endCurrent?.();
    this.#endCurrent = null;
    if (this.#state.speaking) this.#set({ speaking: false, key: this.#state.key, error: null });
  }

  #releaseUrl(): void {
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
  }

  #play(blob: Blob, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (generation !== this.#generation) { resolve(); return; }
      const el = this.#element();
      this.#releaseUrl();
      this.#objectUrl = URL.createObjectURL(blob);
      const done = () => {
        el.onended = null;
        el.onerror = null;
        this.#endCurrent = null;
        resolve();
      };
      this.#endCurrent = done;
      el.onended = done;
      el.onerror = () => {
        el.onended = null;
        el.onerror = null;
        this.#endCurrent = null;
        reject(new Error('audio playback failed'));
      };
      el.src = this.#objectUrl;
      el.play().catch((err) => {
        el.onended = null;
        el.onerror = null;
        this.#endCurrent = null;
        reject(err);
      });
    });
  }

  /**
   * `text`(화면용 답 그대로)를 읽는다. 앞의 낭독은 끊는다. 읽을 것이 없으면 조용히 끝난다.
   * 실패는 상태(error)로 남기고 던지지 않는다 — 낭독 실패가 대화를 막으면 안 된다.
   */
  async speak(text: string, key: string): Promise<void> {
    this.#interrupt();
    const generation = this.#generation;
    this.#set({ speaking: true, key, error: null });
    const stale = () => generation !== this.#generation;
    try {
      const { chunks } = await api.voiceSpeakable(text);
      if (stale()) return;
      const fetchChunk = (i: number): Promise<Blob> | null => {
        if (i >= chunks.length) return null;
        const p = api.synthesizeVoice(chunks[i]);
        p.catch(() => undefined); // 미리 받은 조각의 실패는 그 차례에 await 할 때 다룬다
        return p;
      };
      let next = fetchChunk(0);
      for (let i = 0; next; i++) {
        const blob = await next;
        if (stale()) return;
        next = fetchChunk(i + 1);
        await this.#play(blob, generation);
        if (stale()) return;
      }
      this.#releaseUrl();
      this.#set({ speaking: false, key, error: null });
    } catch (err: any) {
      if (stale()) return;
      this.#releaseUrl();
      this.#set({ speaking: false, key, error: playbackError(err) });
    }
    void this.#drain();
  }

  /** 미리 합성된 소리 하나(음성 알림)를 줄 세운다. 지금 아무것도 안 나오면 바로 튼다. */
  enqueueClip(fetchClip: () => Promise<Blob>, key: string, onEnded?: () => void): void {
    this.#queue.push({ key, fetch: fetchClip, onEnded });
    if (!this.#state.speaking) void this.#drain();
  }

  async #drain(): Promise<void> {
    while (!this.#state.speaking && this.#queue.length) {
      const item = this.#queue.shift()!;
      this.#interrupt();
      const generation = this.#generation;
      this.#set({ speaking: true, key: item.key, error: null });
      try {
        const blob = await item.fetch();
        if (generation !== this.#generation) return;
        await this.#play(blob, generation);
        if (generation !== this.#generation) return;
        this.#releaseUrl();
        this.#set({ speaking: false, key: item.key, error: null });
        item.onEnded?.();
      } catch (err: any) {
        if (generation !== this.#generation) return;
        this.#releaseUrl();
        this.#set({ speaking: false, key: item.key, error: playbackError(err) });
      }
    }
  }
}

function playbackError(err: any): string {
  return err?.name === 'NotAllowedError'
    ? '브라우저가 자동 재생을 막았습니다 — 화면을 한 번 누른 뒤 다시 시도하세요.'
    : (err?.message || '읽기에 실패했습니다');
}

export const speechPlayer = new SpeechPlayer();

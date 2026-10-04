/**
 * 짧은 신호음 — 깨어났다(올라가는 두 음) · 잠든다(내려가는 두 음). 말보다 빠르고 엔진을 부르지 않는다.
 * 소리 파일 없이 WebAudio 로 만든다. 소리를 낼 수 없는 환경이면 조용히 넘어간다(신호음은 덤이다).
 */

let context: AudioContext | null = null;

const TONES: Record<'wake' | 'sleep', number[]> = {
  wake: [660, 880],
  sleep: [784, 523],
};

export function playEarcon(kind: 'wake' | 'sleep'): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    TONES[kind].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = t0 + i * 0.13;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    });
  } catch {
    /* 소리 장치 없음 */
  }
}

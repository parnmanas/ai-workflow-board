/**
 * 대화 모드(docs/voice-operator.md "대화 모드") — 마이크를 켜 두면 말이 시작되고 끝나는 것을
 * 브라우저가 스스로 알아챈다. 버튼으로 녹음을 끊지 않아도, 말을 멈추면(약 1초) 그 발화가 통째로
 * 넘어간다.
 *
 * 판정은 Silero VAD(@ricky0123/vad-web)가 브라우저 안에서 한다 — 오디오를 서버로 흘려보내지
 * 않고, 발화가 끝났을 때 그 구간만 보낸다. 모델·런타임 파일은 AWB 가 직접 내려준다(`/vad/`,
 * scripts/copy-vad-assets.mjs) — 실행 중에 외부 CDN 을 부르지 않는다. 처음 켤 때 한 번 받는다
 * (약 16MB, 이후 캐시).
 */

export const VAD_ASSET_PATH = '/vad/';
const SAMPLE_RATE = 16_000;

/** 말이 끝났다고 보기까지 기다리는 정적. 짧으면 말하다 숨 쉴 때 끊기고, 길면 답이 늦다. */
export const END_OF_SPEECH_SILENCE_MS = 1100;

export interface HandsFreeCallbacks {
  /** 말이 시작됐다(아직 오인일 수 있다). */
  onSpeechStart?(): void;
  /** 말하는 동안의 입력 크기(0..1) — 듣고 있다는 표시용. */
  onLevel?(level: number): void;
  /** 지금까지 말한 구간(16 kHz WAV) — 실시간 자막용. 호출자가 얼마나 자주 쓸지 정한다. */
  onSpeechSoFar?(wav: Blob, durationMs: number): void;
  /** 너무 짧아 발화가 아니었다(기침·잡음). */
  onMisfire?(): void;
  /** 발화 하나가 끝났다. */
  onUtterance(wav: Blob, durationMs: number): void;
}

export interface HandsFreeSession {
  /** 듣기를 잠시 멈춘다(답을 읽는 동안 자기 목소리를 듣지 않게). */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** 마이크를 닫고 끝낸다. */
  destroy(): Promise<void>;
}

/** float32 [-1, 1] mono → 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number = SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function concatFrames(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function rmsLevel(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)) * 6);
}

/** 실시간 자막을 너무 자주 만들지 않는다 — 발화가 이만큼 자랄 때마다 한 번. */
const SPEECH_SO_FAR_EVERY_MS = 1500;

export async function startHandsFree(cb: HandsFreeCallbacks): Promise<HandsFreeSession> {
  const { MicVAD } = await import('@ricky0123/vad-web');
  let speaking = false;
  let frames: Float32Array[] = [];
  let lastSoFarAt = 0;

  const vad = await MicVAD.new({
    model: 'v6',
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: VAD_ASSET_PATH,
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    redemptionMs: END_OF_SPEECH_SILENCE_MS,
    preSpeechPadMs: 300,
    minSpeechMs: 400,
    submitUserSpeechOnPause: false,
    getStream: () => navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
    onSpeechStart: () => {
      speaking = true;
      frames = [];
      lastSoFarAt = 0;
      cb.onSpeechStart?.();
    },
    onFrameProcessed: (_probabilities, frame) => {
      cb.onLevel?.(rmsLevel(frame));
      if (!speaking) return;
      frames.push(frame.slice());
      const heardMs = (frames.reduce((n, f) => n + f.length, 0) / SAMPLE_RATE) * 1000;
      if (cb.onSpeechSoFar && heardMs - lastSoFarAt >= SPEECH_SO_FAR_EVERY_MS) {
        lastSoFarAt = heardMs;
        cb.onSpeechSoFar(encodeWav(concatFrames(frames)), heardMs);
      }
    },
    onVADMisfire: () => {
      speaking = false;
      frames = [];
      cb.onMisfire?.();
    },
    onSpeechEnd: (audio: Float32Array) => {
      speaking = false;
      frames = [];
      cb.onUtterance(encodeWav(audio), (audio.length / SAMPLE_RATE) * 1000);
    },
  });
  await vad.start();

  return {
    pause: async () => {
      speaking = false;
      frames = [];
      await vad.pause();
    },
    resume: async () => {
      await vad.start();
    },
    destroy: async () => {
      speaking = false;
      frames = [];
      await vad.destroy();
    },
  };
}

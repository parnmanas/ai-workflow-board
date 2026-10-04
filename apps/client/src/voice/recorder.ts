/**
 * 발화 하나를 녹음한다(push-to-talk / tap). 결과는 공급자에 그대로 넘길 수 있는 압축 오디오다 —
 * Chrome·Android WebView 는 webm/opus, Safari 는 mp4/aac 를 낸다. 서버가 형식을 그대로 넘기고
 * 공급자들이 둘 다 받으므로 여기서 변환하지 않는다.
 *
 * 마이크는 녹음하는 동안에만 연다. 계속 열어 두면 브라우저·OS 의 녹음 표시가 켜진 채로 남는다.
 */

export interface VoiceRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface ActiveRecording {
  /** 녹음을 끝내고 결과를 돌려준다. */
  stop(): Promise<VoiceRecording>;
  /** 녹음을 버린다(전사하지 않는다). */
  cancel(): void;
  /** 0..1 입력 크기 — 듣고 있다는 표시용. 측정할 수 없으면 0. */
  level(): number;
}

/** 한 발화의 상한. 넘으면 저절로 멈춘다 — 켜 둔 채 잊어도 무한히 쌓이지 않게. */
export const MAX_RECORDING_MS = 2 * 60 * 1000;

const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function voiceRecordingSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as any).MediaRecorder !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;
}

function pickMimeType(): string {
  const MR = (window as any).MediaRecorder as typeof MediaRecorder;
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MR.isTypeSupported?.(type)) return type;
  }
  return '';
}

/**
 * 마이크를 열고 녹음을 시작한다. 권한 거부·장치 없음은 그대로 던진다 — 호출자가 사유를 보여 준다.
 * `onAutoStop` 은 상한에 걸려 저절로 멈췄을 때 불린다(호출자가 stop() 과 같은 처리를 하게).
 */
export async function startVoiceRecording(onAutoStop?: () => void): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  // 입력 크기 — AudioContext 가 없거나 막히면 표시만 포기한다(녹음은 계속된다).
  let analyser: AnalyserNode | null = null;
  let audioContext: AudioContext | null = null;
  try {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (Ctx) {
      audioContext = new Ctx();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
    }
  } catch {
    analyser = null;
  }
  const samples = analyser ? new Uint8Array(analyser.fftSize) : null;

  let finished = false;
  const release = () => {
    finished = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    void audioContext?.close().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    if (!finished) onAutoStop?.();
  }, MAX_RECORDING_MS);

  recorder.start(250);

  return {
    stop: () => new Promise<VoiceRecording>((resolve, reject) => {
      if (finished) {
        reject(new Error('recording already finished'));
        return;
      }
      recorder.onstop = () => {
        release();
        const type = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm';
        resolve({ blob: new Blob(chunks, { type }), mimeType: type, durationMs: Date.now() - startedAt });
      };
      recorder.onerror = (e: any) => {
        release();
        reject(e?.error || new Error('recording failed'));
      };
      recorder.stop();
    }),
    cancel: () => {
      if (finished) return;
      recorder.onstop = null;
      try { recorder.stop(); } catch { /* already inactive */ }
      release();
    },
    level: () => {
      if (!analyser || !samples || finished) return 0;
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 64);
    },
  };
}

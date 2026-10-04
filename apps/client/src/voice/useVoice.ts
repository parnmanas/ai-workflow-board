import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VoiceConfigView } from '../types';
import { speechPlayer, type SpeechState } from './speechPlayer';
import { startVoiceRecording, voiceRecordingSupported, type ActiveRecording } from './recorder';

/**
 * 음성 설정은 서버가 정한다(엔진·키). 화면은 "쓸 수 있는가" 만 알면 된다 — 한 번 받아 두고 1분 동안
 * 같은 답을 쓴다. 권한(voice.use)이 없거나 꺼져 있으면 null 이고, 마이크·읽기 버튼이 아예 나오지 않는다.
 */
const CONFIG_TTL_MS = 60_000;
let configCache: { at: number; promise: Promise<VoiceConfigView | null> } | null = null;

export function loadVoiceConfig(force = false): Promise<VoiceConfigView | null> {
  const now = Date.now();
  if (!force && configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.promise;
  const promise = api.getVoiceConfig().catch(() => null);
  configCache = { at: now, promise };
  return promise;
}

export function useVoiceConfig(): VoiceConfigView | null {
  const [config, setConfig] = useState<VoiceConfigView | null>(null);
  useEffect(() => {
    let alive = true;
    void loadVoiceConfig().then((c) => { if (alive) setConfig(c); });
    return () => { alive = false; };
  }, []);
  return config;
}

export function useSpeechState(): SpeechState {
  const [state, setState] = useState<SpeechState>(speechPlayer.state);
  useEffect(() => speechPlayer.subscribe(setState), []);
  return state;
}

/** "답을 소리로 읽기" 개인 설정 — 단말(브라우저)마다 다르게 두는 게 자연스러워 localStorage 에 둔다. */
const READ_REPLIES_KEY = 'awb.voice.readReplies';

export function useReadRepliesSetting(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try { return localStorage.getItem(READ_REPLIES_KEY) === '1'; } catch { return false; }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(READ_REPLIES_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  }, []);
  return [on, set];
}

export type DictationPhase = 'idle' | 'recording' | 'transcribing';

/**
 * 탭해서 말하고, 다시 탭하면 전사한다. 녹음을 시작하면 읽던 것을 멈춘다(barge-in — 내가 말하는데
 * 기계가 계속 말하면 안 된다). 전사된 글자는 `onText` 로 넘긴다; 비어 있으면 넘기지 않고 사유를 남긴다.
 */
export function useVoiceDictation(onText: (text: string) => void) {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  // 녹음 중 입력 크기 표시.
  useEffect(() => {
    if (phase !== 'recording') { setLevel(0); return; }
    let raf = 0;
    const tick = () => {
      setLevel(recordingRef.current?.level() ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // 화면을 떠나면 마이크를 닫는다.
  useEffect(() => () => { recordingRef.current?.cancel(); recordingRef.current = null; }, []);

  const finish = useCallback(async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return;
    setPhase('transcribing');
    try {
      const result = await recording.stop();
      if (result.durationMs < 300 || result.blob.size === 0) {
        setError('너무 짧아서 듣지 못했습니다');
        return;
      }
      const transcript = await api.transcribeVoice(result.blob);
      const text = (transcript.text || '').trim();
      if (!text) {
        setError('말소리를 알아듣지 못했습니다');
        return;
      }
      onTextRef.current(text);
    } catch (err: any) {
      setError(err?.message || '전사에 실패했습니다');
    } finally {
      setPhase('idle');
    }
  }, []);

  const start = useCallback(async () => {
    if (recordingRef.current) return;
    setError(null);
    speechPlayer.stop();
    speechPlayer.unlock();
    try {
      recordingRef.current = await startVoiceRecording(() => { void finish(); });
      setPhase('recording');
    } catch (err: any) {
      recordingRef.current = null;
      setPhase('idle');
      setError(err?.name === 'NotAllowedError'
        ? '마이크 권한이 없습니다 — 브라우저 설정에서 허용해 주세요.'
        : (err?.message || '마이크를 열지 못했습니다'));
    }
  }, [finish]);

  const toggle = useCallback(() => {
    if (phase === 'recording') void finish();
    else if (phase === 'idle') void start();
  }, [phase, finish, start]);

  const cancel = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase('idle');
  }, []);

  return { phase, error, level, toggle, cancel, supported: voiceRecordingSupported(), clearError: () => setError(null) };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VoiceConfigView } from '../types';
import { speechPlayer, type SpeechState } from './speechPlayer';
import { voiceRecordingSupported } from './recorder';
import { startHandsFree, type HandsFreeSession } from './handsFree';
import { wakeStore } from './wakeState';

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

export type ConversationPhase =
  | 'off'
  | 'starting'
  /** 마이크가 켜져 있고 말을 기다린다. */
  | 'listening'
  /** 말하는 중이다(실시간 자막이 쌓인다). */
  | 'hearing'
  /** 말이 끝나 글자로 바꾸는 중이다. */
  | 'transcribing'
  /** 답(또는 알림)을 읽는 중이라 듣기를 잠시 멈췄다. */
  | 'paused-for-reply';

/**
 * 대화 모드 — 마이크를 한 번 켜 두면, 말을 멈출 때마다(약 1초 정적) 그 발화를 글자로 바꿔 `onText`
 * 로 넘긴다. 버튼으로 녹음을 끊지 않는다(docs/voice-operator.md "대화 모드").
 *
 * - 답을 읽는 동안에는 듣기를 멈춘다 — 스피커 소리를 다시 듣고 자기 답을 프롬프트로 보내지 않게.
 *   읽기가 끝나면 저절로 다시 듣는다.
 * - `liveCaptions` 면 말하는 동안 지금까지의 구간을 1.5초마다 받아써 자막으로 보여 준다(엔진을 그만큼
 *   더 부르므로 무료인 셀프호스팅 엔진에서만 켠다).
 * - 화면을 떠나면 마이크를 닫는다. 탭이 숨으면 멈췄다가 돌아오면 다시 듣는다 — 단, 이름을 불러 깨운
 *   대화(`keepListeningWhenHidden`)는 숨어 있어도 듣는다. 켜 둔 단말을 스피커처럼 쓰는 경우다.
 * - 켜져 있는 동안 마이크를 잡아 둔다(`wakeStore.claimMic`) — 이름 부르기의 상시 청취가 같은 마이크를
 *   따로 열지 않게.
 */
export function useHandsFreeConversation(
  onText: (text: string) => void,
  options: { liveCaptions: boolean; keepListeningWhenHidden?: boolean },
) {
  const [phase, setPhaseState] = useState<ConversationPhase>('off');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const sessionRef = useRef<HandsFreeSession | null>(null);
  const phaseRef = useRef<ConversationPhase>('off');
  const pendingRef = useRef(0);
  const captionBusyRef = useRef(false);
  const levelAtRef = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const liveRef = useRef(options.liveCaptions);
  liveRef.current = options.liveCaptions;
  const keepHiddenRef = useRef(!!options.keepListeningWhenHidden);
  keepHiddenRef.current = !!options.keepListeningWhenHidden;
  const releaseMicRef = useRef<(() => void) | null>(null);
  const speech = useSpeechState();

  const setPhase = useCallback((next: ConversationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const releaseMic = useCallback(() => {
    releaseMicRef.current?.();
    releaseMicRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    void session?.destroy();
    releaseMic();
    setCaption('');
    setLevel(0);
    setPhase('off');
  }, [setPhase, releaseMic]);

  /** `fromGesture` — 사용자가 눌러서 켠다(그 제스처로 낭독기를 깨운다). 이름 부르기로 켜질 때는 아니다. */
  const start = useCallback(async (fromGesture = true) => {
    if (sessionRef.current || phaseRef.current !== 'off') return;
    setError(null);
    if (fromGesture) {
      speechPlayer.stop();
      speechPlayer.unlock(); // 이 탭이 사용자 제스처다 — 답을 나중에 소리 낼 수 있게
    }
    releaseMicRef.current ??= wakeStore.claimMic();
    setPhase('starting');
    try {
      const session = await startHandsFree({
        onSpeechStart: () => {
          if (phaseRef.current === 'off') return;
          setCaption('');
          setPhase('hearing');
        },
        onLevel: (value) => {
          const now = performance.now();
          if (now - levelAtRef.current < 100) return;
          levelAtRef.current = now;
          setLevel(value);
        },
        onSpeechSoFar: (wav) => {
          if (!liveRef.current || captionBusyRef.current) return;
          captionBusyRef.current = true;
          api.transcribeVoice(wav)
            .then((t) => { if (phaseRef.current === 'hearing') setCaption(t.text.trim()); })
            .catch(() => undefined) // 자막은 덤이다 — 실패해도 발화 끝의 전사가 결과를 낸다
            .finally(() => { captionBusyRef.current = false; });
        },
        onMisfire: () => {
          if (phaseRef.current === 'hearing') setPhase('listening');
          setCaption('');
        },
        onUtterance: (wav) => {
          pendingRef.current += 1;
          setPhase('transcribing');
          api.transcribeVoice(wav)
            .then((t) => {
              const text = (t.text || '').trim();
              if (text) onTextRef.current(text);
            })
            .catch((err: any) => setError(err?.message || '전사에 실패했습니다'))
            .finally(() => {
              pendingRef.current -= 1;
              setCaption('');
              if (pendingRef.current === 0 && phaseRef.current === 'transcribing') setPhase('listening');
            });
        },
      });
      if (phaseRef.current === 'off') {
        void session.destroy(); // 켜는 동안 꺼졌다(마이크 잡기는 stop 이 이미 풀었다)
        return;
      }
      sessionRef.current = session;
      setPhase(speechPlayer.state.speaking ? 'paused-for-reply' : 'listening');
      if (speechPlayer.state.speaking) void session.pause();
    } catch (err: any) {
      sessionRef.current = null;
      releaseMic();
      setPhase('off');
      setError(err?.name === 'NotAllowedError'
        ? '마이크 권한이 없습니다 — 브라우저 설정에서 허용해 주세요.'
        : (err?.message || '대화 모드를 시작하지 못했습니다'));
    }
  }, [setPhase]);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'off') void start();
    else stop();
  }, [start, stop]);

  // 답을 읽는 동안 듣지 않는다 — 끝나면 다시 듣는다.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (speech.speaking && phaseRef.current !== 'off' && phaseRef.current !== 'starting') {
      void session.pause();
      setCaption('');
      setPhase('paused-for-reply');
    } else if (!speech.speaking && phaseRef.current === 'paused-for-reply') {
      void session.resume();
      setPhase('listening');
    }
  }, [speech.speaking, setPhase]);

  // 탭이 숨으면 멈췄다가 돌아오면 다시 듣는다(모바일은 백그라운드에서 마이크를 어차피 끊는다).
  useEffect(() => {
    const onVisibility = () => {
      const session = sessionRef.current;
      if (!session || keepHiddenRef.current) return;
      if (document.visibilityState === 'hidden') void session.pause();
      else if (!speechPlayer.state.speaking) void session.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // 화면을 떠나면 마이크를 닫는다.
  useEffect(() => () => {
    void sessionRef.current?.destroy();
    sessionRef.current = null;
    phaseRef.current = 'off';
    releaseMicRef.current?.();
    releaseMicRef.current = null;
  }, []);

  return { phase, caption, error, level, toggle, start, stop, clearError: () => setError(null), supported: voiceRecordingSupported() };
}

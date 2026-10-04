import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { sessionPath } from '../components/sessions/sessionList.logic';
import { playEarcon } from './earcon';
import { startHandsFree, type HandsFreeSession } from './handsFree';
import { useVoiceOperators } from './operator';
import { voiceRecordingSupported } from './recorder';
import { speechPlayer } from './speechPlayer';
import { useSpeechState, useVoiceConfig } from './useVoice';
import { matchWake } from './wake.logic';
import { useWakeState, wakeStore } from './wakeState';

/** 한 단말에서 한 탭만 이름을 듣는다 — 탭마다 마이크를 열면 같은 부름에 여러 탭이 깨어난다. */
const WAKE_LOCK = 'awb-voice-wake-listener';

function hasUserActivation(): boolean {
  const activation = (navigator as any).userActivation;
  return !activation || activation.hasBeenActive;
}

/**
 * 이름 부르기의 상시 청취(docs/voice-operator.md "이름 부르기"). 화면을 그리지 않는다 — AppLayout 에 한 번
 * 붙어 모든 화면에서 산다. 상태는 사이드바의 OPERATORS 가 보여 준다.
 *
 * 잠든 동안 들린 발화마다(브라우저 안의 VAD 가 말의 시작과 끝을 가른다) 자체 호스팅 STT 로 받아 적고,
 * 그 글이 operator 를 부르는 말이면 신호음을 내고 그 operator 의 세션 화면으로 간다 — 거기서 대화 모드가
 * 스스로 켜지고, 이름 뒤에 이어 한 말이 첫 요청으로 간다.
 *
 * 탭이 숨어 있어도 듣는다(켜 둔 단말을 스피커처럼 쓰는 것이 이 기능의 쓰임새다). 다른 소리를 읽는 동안은
 * 쉰다 — 스피커 소리에서 이름을 듣지 않게.
 */
export default function WakeListener() {
  const config = useVoiceConfig();
  const wake = useWakeState();
  const operators = useVoiceOperators(!!config);
  const navigate = useNavigate();
  const { currentWorkspaceId } = useAuth();
  const speech = useSpeechState();
  const latest = useRef({ operators, workspaceId: currentWorkspaceId, navigate });
  latest.current = { operators, workspaceId: currentWorkspaceId, navigate };
  const sessionRef = useRef<HandsFreeSession | null>(null);
  const [hasLock, setHasLock] = useState(false);

  const wanted = !!config?.wake.ready && operators.length > 0 && voiceRecordingSupported() && wake.enabled;

  // 1. 이 단말의 듣는 탭이 된다.
  useEffect(() => {
    if (!wanted) return;
    const locks = (navigator as any).locks as
      | { request(name: string, options: { signal: AbortSignal }, cb: () => Promise<void>): Promise<void> }
      | undefined;
    if (!locks?.request) {
      setHasLock(true);
      return () => setHasLock(false);
    }
    const abort = new AbortController();
    let release: (() => void) | null = null;
    wakeStore.setListener('other-tab');
    locks.request(WAKE_LOCK, { signal: abort.signal }, () => new Promise<void>((resolve) => {
      release = resolve;
      setHasLock(true);
    })).catch(() => undefined);
    return () => {
      abort.abort();
      release?.();
      setHasLock(false);
      wakeStore.setListener('idle');
    };
  }, [wanted]);

  // 2. 잠든 동안, 마이크를 대화 모드가 쓰지 않을 때만 듣는다.
  const listen = hasLock && wake.mode === 'sleeping' && wake.micClaims === 0;
  useEffect(() => {
    if (!listen) return;
    const run = { cancelled: false };
    const gesture = new AbortController();
    let checking = 0;

    const onUtterance = (wav: Blob) => {
      if (run.cancelled) return;
      checking += 1;
      wakeStore.setListener('checking');
      let failure: string | null = null;
      api.transcribeVoice(wav, 'wake')
        .then((t) => {
          if (run.cancelled || wakeStore.state.mode !== 'sleeping') return;
          const { operators: list, workspaceId, navigate: go } = latest.current;
          const match = matchWake(t.text || '', list);
          if (!match) return;
          if (!workspaceId) {
            failure = `"${match.operator.name}" 을(를) 들었지만 열 워크스페이스가 없습니다 — 워크스페이스를 한 번 연 뒤에 다시 불러 주세요.`;
            return;
          }
          playEarcon('wake');
          wakeStore.wake(match.operator.id, match.rest || null);
          go(sessionPath(`/ws/${workspaceId}`, match.operator.manager_id, match.operator.cli, match.operator.session_id));
        })
        .catch((err: any) => { failure = err?.message || '이름을 확인하지 못했습니다'; })
        .finally(() => {
          checking -= 1;
          if (run.cancelled || wakeStore.state.mode !== 'sleeping') return;
          if (failure) wakeStore.setListener('error', failure);
          else if (checking === 0) wakeStore.setListener('listening');
        });
    };

    void (async () => {
      // 브라우저는 사용자 동작 전에는 소리 처리를 막는다(새로고침 직후). 화면을 한 번 누르면 시작한다.
      if (!hasUserActivation()) {
        wakeStore.setListener('waiting-gesture');
        await new Promise<void>((resolve) => {
          document.addEventListener('pointerdown', () => resolve(), { once: true, capture: true, signal: gesture.signal });
          document.addEventListener('keydown', () => resolve(), { once: true, capture: true, signal: gesture.signal });
        });
        if (run.cancelled) return;
      }
      wakeStore.setListener('starting');
      try {
        const session = await startHandsFree({ onUtterance });
        if (run.cancelled) {
          void session.destroy();
          return;
        }
        sessionRef.current = session;
        if (speechPlayer.state.speaking) void session.pause();
        wakeStore.setListener('listening');
      } catch (err: any) {
        if (run.cancelled) return;
        wakeStore.setListener('error', err?.name === 'NotAllowedError'
          ? '마이크 권한이 없습니다 — 브라우저 설정에서 허용해 주세요.'
          : (err?.message || '마이크를 열지 못했습니다'));
      }
    })();

    return () => {
      run.cancelled = true;
      gesture.abort();
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.destroy();
    };
  }, [listen]);

  // 3. 무엇을 읽는 동안은 쉰다.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (speech.speaking) void session.pause();
    else void session.resume();
  }, [speech.speaking]);

  return null;
}

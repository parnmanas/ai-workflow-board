import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationPrefs } from '../contexts/notificationPrefs';
import { sessionPath } from '../components/sessions/sessionList.logic';
import { playEarcon } from './earcon';
import { startHandsFree, type HandsFreeSession } from './handsFree';
import { useVoiceOperators } from './operator';
import { voiceRecordingSupported } from './recorder';
import { speechPlayer } from './speechPlayer';
import { useSpeechState, useVoiceConfig } from './useVoice';
import { isFillerUtterance, isReportRequest, matchWake } from './wake.logic';
import { transcriptionFeedback } from './transcriptionFeedback';
import { NOTIFICATION_FOLLOW_UP_KEY, NOTIFICATION_FOLLOW_UP_MS, useWakeState, wakeStore } from './wakeState';

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
  const cancelFollowUpSpeech = useRef<() => void>(() => {});

  const wanted = !!config?.wake.ready && operators.length > 0 && voiceRecordingSupported() && (wake.enabled || !!wake.followUp);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== NOTIFICATION_FOLLOW_UP_KEY || !event.newValue || !config?.wake.ready) return;
      const prefs = getNotificationPrefs();
      if (!prefs.voice || !prefs.audio || !prefs.listenAfterWorkSound) return;
      try {
        const notice = JSON.parse(event.newValue);
        const remaining = Number(notice.until) - Date.now();
        if (remaining > 0 && remaining <= NOTIFICATION_FOLLOW_UP_MS && operators.some((op) => op.id === notice.operatorId)) {
          wakeStore.openNotificationFollowUp(notice.operatorId, remaining, false);
        }
      } catch { /* ignore invalid or expired input windows */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [config?.wake.ready, operators]);

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

    // 말을 시작한 순간 답을 기다리는 창이 열려 있었나 — 말하는 동안·받아 적는 동안 창이 닫혀도 그 말은 답이다.
    let followUpAtSpeechStart: ReturnType<typeof wakeStore.holdFollowUp> = null;
    const cancelFollowUp = () => { followUpAtSpeechStart?.release(); followUpAtSpeechStart = null; };
    cancelFollowUpSpeech.current = cancelFollowUp;
    let reportOperatorAtSpeechStart: string | null = null;
    const onSpeechStart = () => {
      cancelFollowUp();
      followUpAtSpeechStart = wakeStore.holdFollowUp();
      reportOperatorAtSpeechStart = wakeStore.reportOperator();
    };
    const onUtterance = (wav: Blob) => {
      if (run.cancelled) return;
      const followUp = followUpAtSpeechStart ?? wakeStore.holdFollowUp();
      const followUpOperatorId = followUp?.operatorId;
      const reportOperatorId = reportOperatorAtSpeechStart;
      reportOperatorAtSpeechStart = null;
      followUpAtSpeechStart = null;
      checking += 1;
      wakeStore.setListener('checking');
      let failure: string | null = null;
      api.transcribeVoice(wav, 'wake')
        .then((t) => {
          if (run.cancelled || wakeStore.state.mode !== 'sleeping') return;
          const { operators: list, workspaceId, navigate: go } = latest.current;
          const text = (t.text || '').trim();
          if (!text) { failure = transcriptionFeedback(t); return; }
          const match = matchWake(text, list);
          // Name calling wins; otherwise send the report request to the operator whose cue just played.
          const answering = !match && followUpOperatorId && followUp?.isValid() && !isFillerUtterance(text)
            ? list.find((op) => op.id === followUpOperatorId) ?? null
            : null;
          const reporting = !match && !followUp && !answering && isReportRequest(text) && reportOperatorId === wakeStore.reportOperator()
            ? list.find((op) => op.id === reportOperatorId) ?? null : null;
          const operator = match?.operator ?? answering ?? reporting;
          if (!operator) return;
          if (!workspaceId) {
            failure = `"${operator.name}" 을(를) 들었지만 열 워크스페이스가 없습니다 — 워크스페이스를 한 번 연 뒤에 다시 불러 주세요.`;
            return;
          }
          playEarcon('wake');
          wakeStore.wake(operator.id, match ? (match.rest || null) : text);
          go(sessionPath(`/ws/${workspaceId}`, operator.manager_id, operator.cli, operator.session_id));
        })
        .catch((err: any) => { failure = err?.message || '이름을 확인하지 못했습니다'; })
        .finally(() => {
          followUp?.release();
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
        const session = await startHandsFree({ onSpeechStart, onUtterance, onMisfire: cancelFollowUp,
          onWaitingForGesture: () => { if (!run.cancelled) wakeStore.setListener('waiting-gesture'); },
          onAudioRunning: () => { if (!run.cancelled) wakeStore.setListener('starting'); },
        }, { signal: gesture.signal });
        if (run.cancelled) {
          void session.destroy().catch(() => undefined);
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
      cancelFollowUp();
      gesture.abort();
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.destroy().catch(() => undefined);
    };
  }, [listen]);

  // 3. 무엇을 읽는 동안은 쉰다.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (speech.speaking) { cancelFollowUpSpeech.current(); void session.pause(); }
    else void session.resume().then(() => {
      if (sessionRef.current === session && wakeStore.state.mode === 'sleeping') wakeStore.setListener('listening');
    }).catch((err) => {
      if (sessionRef.current === session) wakeStore.setListener('error', err?.message || '마이크를 다시 열지 못했습니다');
    });
  }, [speech.speaking]);

  return null;
}

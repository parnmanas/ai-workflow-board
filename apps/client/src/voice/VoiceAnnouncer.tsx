import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import type { VoiceAnnouncementEvent } from '../types';
import { announcementPath, claimAnnouncement, isViewingTarget, shouldSpeakAnnouncement } from './announcements';
import { speechPlayer } from './speechPlayer';
import { useSpeechState, useVoiceConfig } from './useVoice';
import { playEarcon } from './earcon';
import { wakeStore } from './wakeState';

const KEY_PREFIX = 'announcement:';

/**
 * 음성 알림을 받아 읽는다(docs/voice-operator.md "음성 알림"). 화면을 그리지 않는다 — AppLayout 에
 * 한 번 붙어 모든 화면에서 산다.
 *
 * 말하는 조건: 서버에 TTS 가 준비돼 있고, 이 단말에서 "Speak work updates" 가 켜져 있고, 지금 그
 * 세션을 보고 있지 않고, 이 탭이 알림을 먼저 집었을 때. 글자는 토스트로도 보여 주고(누르면 그 화면으로),
 * 소리는 대화 낭독을 끊지 않고 줄을 선다.
 *
 * 세션의 작업 소식은 operator 가 요약해서 전한다(`operator_report` — 서버가 operator 에게 보고하고 그 답을
 * 보낸다). 누르면 소식의 주인공인 세션으로 간다. operator 화면에서 그 보고 턴을 다시 읽지 않는 것은 세션
 * 화면의 몫이다(자기가 보낸 턴만 읽는다).
 */
export default function VoiceAnnouncer() {
  const config = useVoiceConfig();
  const { prefs } = useNotifications();
  const { showToast } = useToast();
  const { currentWorkspaceId } = useAuth();
  const navigate = useNavigate();
  const speech = useSpeechState();

  // 결정이 필요한 operator 보고 — 다 읽고 나면 잠깐 이름 없이 답을 듣는다(이름 부르기가 켜져 있으면).
  const followUpRef = useRef<{ key: string; operatorId: string } | null>(null);
  const latest = useRef({ ready: false, enabled: true, workspaceId: currentWorkspaceId });
  latest.current = { ready: !!config?.tts.ready, enabled: prefs.voice, workspaceId: currentWorkspaceId };

  // 알림은 사용자 제스처 없이 나온다 — 앱에서 처음 누르는 순간 재생 요소를 깨워 둔다
  // (iOS 는 제스처 안에서 한 번 재생된 요소만 나중에 소리를 낸다).
  useEffect(() => {
    const unlock = () => speechPlayer.unlock();
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  useBoardStreamEvent('voice_announcement', useCallback((data: VoiceAnnouncementEvent) => {
    const { ready, enabled, workspaceId } = latest.current;
    if (!data?.id || !data.text || !ready || !enabled) return;
    const visible = document.visibilityState === 'visible';
    void (async () => {
      // 보고 있는 세션이면 이 탭이 집어서(=처리됨) 다른 탭도 말하지 않게 하고, 자신도 말하지 않는다.
      const viewing = isViewingTarget(data.target, visible);
      if (!(await claimAnnouncement(data.id, visible)) || !shouldSpeakAnnouncement(viewing, !!data.needs_decision)) return;
      const path = announcementPath(data.target, workspaceId);
      // operator 가 쓴 글이면(작업 보고 요약 · operator 의 답) 누가 말하는지 붙인다.
      const text = data.operator ? `🎙 ${data.operator.name}: ${data.text}` : data.text;
      showToast(text, 'info', {
        durationMs: data.needs_decision ? 20000 : data.operator ? 12000 : 8000,
        ...(path ? { onClick: () => navigate(path) } : {}),
      });
      const key = `${KEY_PREFIX}${data.id}`;
      if (data.needs_decision && data.operator) followUpRef.current = { key, operatorId: data.operator.id };
      speechPlayer.enqueueClip(() => api.getVoiceAnnouncementAudio(data.id), key);
    })();
  }, [navigate, showToast]));

  // 선택지를 다 읽었다 — 신호음과 함께 이름 없이 답을 듣는 창을 연다(사용자는 "1번" 처럼 바로 답한다).
  useEffect(() => {
    const pending = followUpRef.current;
    if (!pending || speech.speaking || speech.key !== pending.key) return;
    followUpRef.current = null;
    if (wakeStore.openFollowUp(pending.operatorId)) playEarcon('wake');
  }, [speech.speaking, speech.key]);

  // 알림 소리를 못 냈으면(자동 재생 차단 · 엔진 오류) 한 번 알려 준다 — 조용히 삼키지 않는다.
  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const err = speech.key?.startsWith(KEY_PREFIX) ? speech.error : null;
    if (err && err !== shownErrorRef.current) showToast(`음성 알림을 재생하지 못했습니다: ${err}`, 'error');
    shownErrorRef.current = err;
  }, [speech.error, speech.key, showToast]);

  return null;
}

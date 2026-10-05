import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import type { VoiceAnnouncementEvent } from '../types';
import { announcementPath, announcementPlayback, claimAnnouncement, isViewingTarget, shouldSpeakAnnouncement } from './announcements';
import { speechPlayer } from './speechPlayer';
import { useSpeechState, useVoiceConfig } from './useVoice';
import { notificationSoundClip } from './notificationSound';
import { wakeStore } from './wakeState';

const KEY_PREFIX = 'announcement:';

/**
 * Work updates play a selected cue; only operator conversation replies use TTS.
 * Reports remain in the operator's context for a later request for details.
 * Mounted once in AppLayout, with cross-tab claims, viewing suppression and a shared audio queue.
 */
export default function VoiceAnnouncer() {
  const config = useVoiceConfig();
  const { prefs } = useNotifications();
  const { showToast } = useToast();
  const { currentWorkspaceId } = useAuth();
  const navigate = useNavigate();
  const speech = useSpeechState();

  const latest = useRef({ ready: false, wakeReady: false, enabled: true, audio: true, listen: prefs.listenAfterWorkSound, sound: prefs.workSound, workspaceId: currentWorkspaceId });
  latest.current = { ready: !!config?.tts.ready, wakeReady: !!config?.wake.ready, enabled: prefs.voice, audio: prefs.audio, listen: prefs.listenAfterWorkSound, sound: prefs.workSound, workspaceId: currentWorkspaceId };

  useEffect(() => {
    if (!prefs.voice || !prefs.audio || !prefs.listenAfterWorkSound) wakeStore.closeNotificationFollowUp();
  }, [prefs.voice, prefs.audio, prefs.listenAfterWorkSound]);

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
    const { ready, enabled, audio, sound, workspaceId } = latest.current;
    const playback = announcementPlayback(data?.kind || '');
    if (!data?.id || !data.text || !enabled || (playback === 'speech' && !ready)) return;
    const visible = document.visibilityState === 'visible';
    void (async () => {
      // Claim viewed updates too, so another tab cannot announce them.
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
      if (playback === 'speech') {
        speechPlayer.enqueueClip(() => api.getVoiceAnnouncementAudio(data.id), key);
      } else if (audio) {
        speechPlayer.enqueueClip(async () => notificationSoundClip(sound), key, () => {
          const now = latest.current;
          if (data.operator && now.wakeReady && now.enabled && now.audio && now.listen) {
            wakeStore.openNotificationFollowUp(data.operator.id);
          }
        });
      }
    })();
  }, [navigate, showToast]));

  // 알림 소리를 못 냈으면(자동 재생 차단 · 엔진 오류) 한 번 알려 준다 — 조용히 삼키지 않는다.
  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const err = speech.key?.startsWith(KEY_PREFIX) ? speech.error : null;
    if (err && err !== shownErrorRef.current) showToast(`음성 알림을 재생하지 못했습니다: ${err}`, 'error');
    shownErrorRef.current = err;
  }, [speech.error, speech.key, showToast]);

  return null;
}

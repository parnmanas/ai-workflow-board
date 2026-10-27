import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { wakeStore } from '../voice/wakeState';
import {
  NATIVE_VOICE_OFF,
  hiddenInAndroidApp,
  isAndroidApp,
  nativeAppInfo,
  nativeVoiceStatus,
  onNativeEvent,
  parseAwbDeepLink,
  type NativeVoiceStatus,
} from './androidBridge';

/**
 * Android 앱 안에서만 하는 일 — 화면을 그리지 않는다(AppLayout 에 한 번 붙는다).
 *   - 앱 알림을 누르면 앱이 `navigate` 를 보낸다 → 그 세션 화면으로.
 *   - 앱의 상시 음성 스위치와 화면의 음성 지원 스위치를 맞춘다(단말의 스위치는 하나).
 *   - 화면이 숨으면 깨어 있던 대화를 내려놓는다 — 숨은 동안은 앱의 상시 음성이 듣는다.
 */
export default function AndroidAppBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAndroidApp()) return;
    const offNav = onNativeEvent('navigate', (msg) => {
      const path = typeof msg?.path === 'string' ? parseAwbDeepLink(`https://app${msg.path}`) : null;
      if (path) navigate(path);
    });
    const sync = (status: NativeVoiceStatus) => wakeStore.syncDeviceEnabled(!!status.enabled);
    void nativeVoiceStatus().then(sync);
    const offVoice = onNativeEvent('voice-status', (msg) => sync({ ...NATIVE_VOICE_OFF, ...(msg?.status || {}) }));
    const onVisibility = () => {
      if (hiddenInAndroidApp() && wakeStore.state.mode === 'awake') wakeStore.sleep();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      offNav();
      offVoice();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [navigate]);

  return null;
}

/**
 * Android 앱 안에서 이 화면의 서버 이름(앱에서 붙인 것, 없으면 host). 앱이 아니면 null.
 * 앱은 서버를 여러 개 둘 수 있어 화면이 어느 서버인지 보여야 한다 — 화면은 서버마다 같은 모양이다.
 */
export function useNativeServerLabel(): string | null {
  const [label, setLabel] = useState<string | null>(() => (isAndroidApp() ? window.location.host : null));
  useEffect(() => {
    if (!isAndroidApp()) return;
    let alive = true;
    void nativeAppInfo().then((info) => {
      if (alive && info?.server_name) setLabel(info.server_name);
    });
    return () => { alive = false; };
  }, []);
  return label;
}

/** 앱 안에서 이 화면이 숨었는가 — 숨은 동안 마이크 · 소리는 앱이 맡으므로 웹은 손을 뗀다. */
export function useHiddenInAndroidApp(): boolean {
  const [hidden, setHidden] = useState(hiddenInAndroidApp);
  useEffect(() => {
    if (!isAndroidApp()) return;
    const update = () => setHidden(hiddenInAndroidApp());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

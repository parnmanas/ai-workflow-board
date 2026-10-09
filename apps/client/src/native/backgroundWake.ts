import { Capacitor, registerPlugin } from '@capacitor/core';
import { getServerBaseUrl } from '../serverConfig';

/**
 * Android 백그라운드 wake 브릿지 — 네이티브 `AwbBackgroundWake` 플러그인.
 *
 * 웹(PWA·브라우저)에서는 전부 폴백: 백그라운드 리스닝은 OS가 허락하지 않으므로
 * `supported=false` 를 내고, 탭 상시청취(WakeListener)가 그대로 전제다.
 * 네이티브에서만 포그라운드 서비스 + 마이크가 돈다. 화면·세션은 양쪽 다 WebView다.
 */

export interface BackgroundWakeStatus {
  running: boolean;
  /** 켜 둔 상태(재부팅 후 복원 포함). 토큰 만료時は 서비스가 조용히 멈춰 있을 수 있다. */
  enabled: boolean;
  mic: boolean;
  notifications: boolean;
  /** true면 절전 예외를 켜야 오래 산다. */
  batteryOptimized: boolean;
}

interface AwbBackgroundWakePlugin {
  isSupported(): Promise<{ supported: boolean; reliable: boolean }>;
  getStatus(): Promise<BackgroundWakeStatus>;
  requestPermissions(): Promise<{ mic: boolean; notifications: boolean }>;
  startListening(options: { serverUrl: string; token: string }): Promise<{ running: boolean }>;
  stopListening(): Promise<{ running: boolean }>;
  openBatterySettings(): Promise<void>;
}

const Native = registerPlugin<AwbBackgroundWakePlugin>('AwbBackgroundWake');

/** 네이티브 앱(WebView 껍데기)에서 돌 때만 true — PWA·브라우저는 false. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

const WEB_STATUS: BackgroundWakeStatus = {
  running: false, enabled: false, mic: false, notifications: false, batteryOptimized: false,
};

export async function backgroundWakeSupported(): Promise<{ supported: boolean; reliable: boolean }> {
  if (!isNativeApp()) return { supported: false, reliable: false };
  try {
    return await Native.isSupported();
  } catch {
    return { supported: false, reliable: false };
  }
}

export async function getBackgroundWakeStatus(): Promise<BackgroundWakeStatus> {
  if (!isNativeApp()) return WEB_STATUS;
  try {
    return await Native.getStatus();
  } catch {
    return WEB_STATUS;
  }
}

export async function requestBackgroundWakePermissions(): Promise<{ mic: boolean; notifications: boolean }> {
  const res = await Native.requestPermissions();
  return { mic: !!res.mic, notifications: !!res.notifications };
}

export async function startBackgroundWake(): Promise<void> {
  const token = (() => {
    try {
      return localStorage.getItem('auth_token') || '';
    } catch {
      return '';
    }
  })();
  await Native.startListening({ serverUrl: getServerBaseUrl(), token });
}

export async function stopBackgroundWake(): Promise<void> {
  try {
    await Native.stopListening();
  } catch {
    /* 이미 멈춰 있으면 무시 */
  }
}

export async function openBatterySettings(): Promise<void> {
  await Native.openBatterySettings();
}

/**
 * 네이티브 딥링크 → 앱 경로. `awb://sessions/m/cli/s?say=…` (알림 탭)와
 * `https://…/sessions/…` (공유 링크) 둘 다 받는다. 세션 경로가 아니면 null.
 */
export function parseAwbDeepLink(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let path: string;
  if (u.protocol === 'awb:') {
    // awb://sessions/… — hostname이 첫 세그먼트다. pathname은 대소문자를 보존한다.
    const segs = [u.hostname, ...u.pathname.split('/').filter(Boolean)].filter(Boolean);
    path = `/${segs.join('/')}`;
  } else if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'capacitor:') {
    path = u.pathname;
  } else {
    return null;
  }
  if (!path.startsWith('/sessions/')) return null;
  return `${path}${u.search}${u.hash}`;
}

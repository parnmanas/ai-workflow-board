import type { CapacitorConfig } from '@capacitor/cli';

/**
 * AWB Android 앱(Capacitor) 설정.
 *
 * 웹 콘텐츠는 이 Vite 빌드(`webDir: dist`) 그대로 — 플러터처럼 다시 만들지 않는다.
 * 백그라운드 wake는 네이티브 포그라운드 서비스(`AwbBackgroundWake` 플러그인)가 맡고,
 * 화면·API·SSE는 WebView의 React 앱이 그대로 그린다.
 *
 * 네이티브 앱 전제 두 가지:
 *   1. WebView 오리진은 `https://localhost` 라서 API 호출이 항상 크로스오리진이다 —
 *      AWB 서버의 `CORS_ORIGIN`에 `https://localhost` 를 등록해야 한다.
 *      (백그라운드 서비스의 네이티브 HTTP는 CORS와 무관하다.)
 *   2. `http://` 서버는 WebView mixed-content 정책에 막힌다 — 서버도 https로 열 것.
 *
 * 빌드: Android Studio에서 `apps/client/android` 열기, 또는
 * `npx cap sync android && cd android && ./gradlew assembleDebug`.
 */
const config: CapacitorConfig = {
  appId: 'com.parnmanas.awb',
  appName: 'AWB',
  webDir: 'dist',
  backgroundColor: '#0f172a',
  server: {
    // https 스킴 = secure context — WebView에서도 마이크·알림·SW가 동작한다.
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

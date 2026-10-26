import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import React, { useCallback, useEffect, useState } from 'react';
import { tokens } from '../tokens';
import { wakeStore } from '../voice/wakeState';
import {
  isAndroidApp,
  nativeVoiceStatus,
  onNativeEvent,
  openNativeBatterySettings,
  NATIVE_VOICE_OFF,
  type NativeVoiceStatus,
} from '../native/androidBridge';

const STATE_LABEL: Record<NativeVoiceStatus['state'], string> = {
  get off() { return translate('꺼짐'); },
  get sleeping() { return translate('듣는 중 — “헤이 <이름>” 을 기다립니다'); },
  get awake() { return translate('대화 중'); },
  get paused() { return translate('앱 화면이 듣는 중 — 화면을 끄거나 다른 앱으로 가면 앱이 이어서 듣습니다'); },
  get error() { return translate('멈춤'); },
};

/**
 * 상시 음성 (Android 앱 전용) — 설정 → Device.
 *
 * 앱 화면이 보이지 않을 때(다른 앱 · 화면 꺼짐 · 잠금)도 “헤이 <이름>” 을 듣고, 그 자리에서 operator 와
 * 말로 대화하고 답을 읽는다. 사이드바 OPERATORS 의 음성 지원 스위치와 같은 스위치다(단말의 스위치는 하나).
 * 웹(PWA · 브라우저)에서는 그리지 않는다 — 백그라운드 마이크는 OS 가 네이티브 앱에만 허락한다.
 */
export default function AndroidVoiceCard() {
  useLocale();
  const [status, setStatus] = useState<NativeVoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setStatus(await nativeVoiceStatus()), []);

  useEffect(() => {
    if (!isAndroidApp()) return;
    void refresh();
    return onNativeEvent('voice-status', (msg) => setStatus({ ...NATIVE_VOICE_OFF, ...(msg?.status || {}) }));
  }, [refresh]);

  if (!isAndroidApp()) return null;

  const enabled = !!status?.enabled;
  const onToggle = async () => {
    setBusy(true);
    try {
      wakeStore.setEnabled(!enabled);
      // 켤 때는 앱이 권한을 묻는다 — 고르는 동안 상태는 voice-status 로 따라온다.
      await new Promise((r) => setTimeout(r, 400));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const stateText = status
    ? `${STATE_LABEL[status.state] || status.state}${status.operator ? ` (${status.operator})` : ''}${status.detail ? ` · ${status.detail}` : ''}`
    : translate('확인 중…');

  return (
    <div style={{
      background: tokens.colors.surfaceCard,
      border: `1px solid ${tokens.colors.border}`,
      borderRadius: tokens.radii.lg,
      padding: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
      maxWidth: 560,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>
            {translate('상시 음성')}</div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
            {translate('화면이 꺼져 있어도 “헤이 <이름>” 으로 부르고, 말로 묻고, 답을 듣습니다')}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          disabled={busy}
          style={{
            padding: '8px 14px', borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 700,
            background: enabled ? tokens.colors.successDark : tokens.colors.accent,
            color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1, flexShrink: 0,
          }}
        >
          {busy ? '…' : enabled ? translate('끄기') : translate('켜기')}
        </button>
      </div>
      <div style={{ fontSize: 11, color: status?.state === 'error' ? tokens.colors.dangerLight : tokens.colors.textMuted, lineHeight: 1.6 }}>
        {translate('상태:')} {stateText}
        {status && (
          <>
            {' · '}{translate('마이크')} {status.mic ? translate('허용') : translate('거부')}
            {' · '}{translate('알림')} {status.notifications ? translate('허용') : translate('거부')}
          </>
        )}
      </div>
      {status?.battery_optimized && (
        <button
          type="button"
          onClick={() => openNativeBatterySettings()}
          style={{
            padding: '8px 12px', background: 'transparent',
            color: tokens.colors.warningLight, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md, fontSize: 11, fontWeight: 600,
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          {translate('절전 예외 켜기 — 배터리 최적화가 켜져 있으면 몇 시간 뒤 OS 가 듣기를 멈춥니다')}</button>
      )}
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
        {translate('켜져 있는 동안 상태바에 알림이 있고 초록 마이크 표시가 뜹니다. 알림의 “끄기” 로도 끌 수 있습니다.')}</div>
    </div>
  );
}

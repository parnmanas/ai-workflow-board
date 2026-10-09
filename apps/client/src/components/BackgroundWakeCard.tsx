import React, { useCallback, useEffect, useState } from 'react';
import { tokens } from '../tokens';
import {
  backgroundWakeSupported,
  getBackgroundWakeStatus,
  isNativeApp,
  openBatterySettings,
  requestBackgroundWakePermissions,
  startBackgroundWake,
  stopBackgroundWake,
  type BackgroundWakeStatus,
} from '../native/backgroundWake';

/**
 * 백그라운드에서 듣기 (Android 앱 전용) — 설정 → Device.
 *
 * 웹(PWA)에서는 렌더하지 않는다: 백그라운드 마이크는 OS가 네이티브에만 허락한다.
 * 켜면 포그라운드 서비스가 상시 알림 + 초록 마이크 표시와 함께 돌고,
 * “헤이 <이름>” 을 알아들으면 알림을 울려 세션으로 데려간다.
 * 판정은 서버라 이 화면은 스위치 + 상태만 맡는다.
 */
export default function BackgroundWakeCard() {
  const [supported, setSupported] = useState<{ supported: boolean; reliable: boolean } | null>(null);
  const [status, setStatus] = useState<BackgroundWakeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSupported(await backgroundWakeSupported());
    setStatus(await getBackgroundWakeStatus());
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    void refresh();
  }, [refresh]);

  if (!isNativeApp()) return null;

  const onToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (status?.running) {
        await stopBackgroundWake();
      } else {
        const perm = await requestBackgroundWakePermissions();
        if (!perm.mic) {
          setError('마이크 권한이 필요합니다 — 허용 후 다시 켜주세요');
          return;
        }
        await startBackgroundWake();
      }
    } catch (err: any) {
      setError(err?.message || '백그라운드 듣기를 켜지 못했습니다');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const running = !!status?.running;

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
            백그라운드에서 듣기
          </div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
            {supported && !supported.reliable
              ? '이 기기에서는 동작하지만 OS가 언제든 멈출 수 있습니다'
              : '다른 앱 앞·화면 꺼짐에서도 “헤이 <이름>” 을 듣습니다'}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={running}
          onClick={onToggle}
          disabled={busy}
          style={{
            padding: '8px 14px', borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 700,
            background: running ? tokens.colors.successDark : tokens.colors.accent,
            color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1, flexShrink: 0,
          }}
        >
          {busy ? '…' : running ? '끄기' : '켜기'}
        </button>
      </div>
      {status && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
          상태: {running ? '듣는 중 (상태바 알림 + 초록 마이크 표시)' : status.enabled ? '켜져 있으나 멈춰 있음 — 다시 켜주세요' : '꺼짐'}
          {' · '}마이크 {status.mic ? '허용' : '거부'}
          {' · '}알림 {status.notifications ? '허용' : '거부'}
        </div>
      )}
      {status?.batteryOptimized && (
        <button
          type="button"
          onClick={() => { void openBatterySettings().catch(() => undefined); }}
          style={{
            padding: '8px 12px', background: 'transparent',
            color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md, fontSize: 11, fontWeight: 600,
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          절전 예외 켜기 — 오래 들으려면 “제한 없음”으로 바꿔주세요 (선택)
        </button>
      )}
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
        배터리를 씁니다 — 거치·충전 중 단말 권장. 끄면 마이크·알림·서비스를 전부 거둡니다.
      </div>
      {error && (
        <div style={{
          fontSize: 11, color: tokens.colors.dangerLight, background: '#7f1d1d20',
          border: '1px solid #7f1d1d50', borderRadius: tokens.radii.sm, padding: '6px 8px',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

import React, { useState } from 'react';
import { tokens } from '../tokens';
import {
  checkServerHealth,
  getServerBaseUrl,
  isMixedContentRisk,
  setServerBaseUrl,
} from '../serverConfig';

/**
 * PWA 서버 주소 입력 — LoginPage(로그인 전)와 Settings(로그인 후)에서 공유.
 *
 * 비우면 same-origin(지금 여는 서버). 다른 AWB 서버를 쓰면 저장 즉시
 * 세션을 지우고 reload 한다 — 토큰은 발급 서버에서만 유효해서다.
 * 크로스오리진이면 그 서버의 CORS_ORIGIN에 이 앱 주소를 등록해야 하고,
 * https 페이지에서 http 서버는 브라우저가 차단한다(경고 표시).
 */
export default function ServerConfigField({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState(() => getServerBaseUrl());
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const effective = getServerBaseUrl();
  const mixedRisk = !!value.trim() && (() => {
    try {
      const norm = value.trim().replace(/\/+$/, '');
      return isMixedContentRisk(norm.startsWith('http') ? norm : `https://${norm}`);
    } catch {
      return false;
    }
  })();

  const onCheck = async () => {
    setChecking(true);
    setResult(null);
    const r = await checkServerHealth(value);
    setChecking(false);
    setResult(r.ok
      ? { ok: true, message: `연결됨 (db: ${r.status || 'ok'}) — 저장하면 이 서버로 전환됩니다` }
      : { ok: false, message: r.error || '연결 실패' });
  };

  const onSave = () => {
    try {
      setServerBaseUrl(value);
    } catch (err: any) {
      setResult({ ok: false, message: err?.message || '주소가 올바르지 않습니다' });
      return;
    }
    window.location.reload();
  };

  const dirty = value.trim().replace(/\/+$/, '') !== effective;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 8 }}>
      <label style={{
        fontSize: 11, color: tokens.colors.textMuted, fontWeight: 600,
        textTransform: 'uppercase', display: 'block',
      }}>
        Server
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          value={value}
          onChange={(e) => { setValue(e.target.value); setResult(null); }}
          placeholder="비우면 이 서버 (예: https://awb.example.com)"
          aria-label="AWB 서버 주소"
          style={{
            flex: 1, minWidth: 0, padding: '10px 14px', background: tokens.colors.surface,
            border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
            color: tokens.colors.textStrong, fontSize: '14px', outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>
      {!compact && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
          현재: {effective || '이 서버 (same-origin)'}
          {' · '}다른 서버로 바꾸면 다시 로그인합니다.
          크로스오리진은 그 서버의 CORS_ORIGIN에 이 앱 주소를 등록해야 합니다.
        </div>
      )}
      {mixedRisk && (
        <div style={{
          fontSize: 11, color: tokens.colors.warningLight, lineHeight: 1.5,
          background: `${tokens.colors.warning}15`, border: `1px solid ${tokens.colors.warning}40`,
          borderRadius: tokens.radii.sm, padding: '6px 8px',
        }}>
          https 페이지에서 http 서버는 브라우저가 차단합니다 — 서버도 https로 열어주세요.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || !value.trim()}
          style={{
            flex: 1, padding: '8px 12px', background: 'transparent',
            color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 600,
            cursor: checking || !value.trim() ? 'not-allowed' : 'pointer',
            opacity: checking || !value.trim() ? 0.6 : 1,
          }}
        >
          {checking ? '확인 중…' : '연결 테스트'}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty}
          style={{
            flex: 1, padding: '8px 12px', background: tokens.colors.accent,
            color: '#fff', border: 'none',
            borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 600,
            cursor: !dirty ? 'not-allowed' : 'pointer',
            opacity: !dirty ? 0.6 : 1,
          }}
        >
          서버 전환
        </button>
      </div>
      {result && (
        <div style={{
          fontSize: 11, lineHeight: 1.5, padding: '6px 8px',
          borderRadius: tokens.radii.sm,
          color: result.ok ? tokens.colors.successLight : tokens.colors.dangerLight,
          background: result.ok ? '#065f4620' : '#7f1d1d20',
          border: `1px solid ${result.ok ? '#065f4650' : '#7f1d1d50'}`,
        }}>
          {result.message}
        </div>
      )}
    </div>
  );
}

/** PWA 설치 버튼 — 브라우저가 beforeinstallprompt를 쏠 때만 보인다. */
export function PwaInstallButton() {
  const [deferred, setDeferred] = useState<any>(null);
  const [installed, setInstalled] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches,
  );

  React.useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) {
    return (
      <div style={{ fontSize: 11, color: tokens.colors.successLight }}>
        앱으로 설치되어 실행 중입니다.
      </div>
    );
  }
  if (!deferred) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          deferred.prompt();
          await deferred.userChoice;
        } catch { /* ignore */ }
        setDeferred(null);
      }}
      style={{
        padding: '8px 12px', background: tokens.colors.accent, color: '#fff',
        border: 'none', borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      앱으로 설치
    </button>
  );
}

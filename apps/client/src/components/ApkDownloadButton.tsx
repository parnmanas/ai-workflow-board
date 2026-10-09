import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { tokens } from '../tokens';
import {
  GITHUB_ANDROID_APK_URL,
  checkLatestApk,
  formatApkSize,
} from '../githubRelease';

/**
 * Android 앱 다운로드 — 설정 → Device. 항상 GitHub 최신 APK를 낸다.
 *
 * 버전 표시는 API로, href는 고정 latest 링크로(githubRelease.ts) — API가 막혀도
 * 다운로드는 된다. 상태가 셋이라 거짓말을 안 한다: yes(버전 표시 + 받기) /
 * unknown(API 실패 — 받기는 그대로) / no(릴리즈가 정말 없음 — 자료실 안내).
 */
export default function ApkDownloadButton() {
  const [label, setLabel] = useState<string | null>(null);
  const [ready, setReady] = useState<'loading' | 'yes' | 'unknown' | 'no'>('loading');

  useEffect(() => {
    const ctrl = new AbortController();
    void checkLatestApk(ctrl.signal).then((checked) => {
      if (ctrl.signal.aborted) return;
      if (checked.status === 'ready') {
        const size = formatApkSize(checked.app.size);
        setLabel(`Android 앱 받기${checked.app.tag ? ` (${checked.app.tag})` : ''}${size ? ` · ${size}` : ''}`);
        setReady('yes');
      } else if (checked.status === 'unreachable') {
        setLabel('Android 앱 받기');
        setReady('unknown');
      } else {
        setReady('no');
      }
    });
    return () => ctrl.abort();
  }, []);

  if (ready === 'loading') {
    return <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>앱 확인 중…</span>;
  }
  if (ready === 'no') {
    return (
      <span style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
        게시된 Android 릴리즈가 아직 없습니다.{' '}
        <Link to="/library" style={{ color: tokens.colors.accentMid }}>자료실</Link>에서 소식을 확인하세요.
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <a
        href={GITHUB_ANDROID_APK_URL}
        style={{
          display: 'inline-block', padding: '8px 14px', background: tokens.colors.successDark,
          color: '#fff', borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        {label || 'Android 앱 받기'}
      </a>
      <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
        {ready === 'unknown' && '버전 확인 실패 — 고정 링크로 받습니다. '}
        처음 한 번은 폰에서 “출처 미확인 앱 설치”를 허용해야 합니다.
        {' '}<Link to="/library" style={{ color: tokens.colors.accentMid }}>옛 버전은 자료실</Link>
      </span>
    </span>
  );
}

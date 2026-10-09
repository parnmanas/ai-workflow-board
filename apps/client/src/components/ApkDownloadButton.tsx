import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { tokens } from '../tokens';
import {
  GITHUB_ANDROID_APK_URL,
  fetchLatestApk,
  formatApkSize,
} from '../githubRelease';

/**
 * Android 앱 다운로드 — 설정 → Device. 항상 GitHub 최신 APK를 낸다.
 *
 * 버전 표시는 API로, href는 고정 latest 링크로(githubRelease.ts) — API가 막혀도
 * 다운로드는 된다. 릴리즈 미게시 때는 고정 링크가 GitHub 404를 내므로, 그 경우엔
 * 자료실로 안내한다.
 */
export default function ApkDownloadButton() {
  const [label, setLabel] = useState<string | null>(null);
  const [ready, setReady] = useState<'loading' | 'yes' | 'no'>('loading');

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchLatestApk(ctrl.signal).then((app) => {
      if (ctrl.signal.aborted) return;
      if (app) {
        const size = formatApkSize(app.size);
        setLabel(`Android 앱 받기${app.tag ? ` (${app.tag})` : ''}${size ? ` · ${size}` : ''}`);
        setReady('yes');
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
        처음 한 번은 폰에서 “출처 미확인 앱 설치”를 허용해야 합니다.
        {' '}<Link to="/library" style={{ color: tokens.colors.accentMid }}>옛 버전은 자료실</Link>
      </span>
    </span>
  );
}

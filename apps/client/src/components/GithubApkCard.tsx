import React, { useEffect, useState } from 'react';
import { tokens } from '../tokens';
import {
  GITHUB_ANDROID_APK_URL,
  GITHUB_RELEASES_URL,
  checkLatestApk,
  formatApkSize,
  type ApkAsset,
} from '../githubRelease';

/**
 * 자료실 최상단의 Android 앱 카드 — 항상 GitHub 최신 APK를 낸다.
 *
 * 버전·용량·날짜는 API로 보여주고, 다운로드 href는 고정 latest 링크를 쓴다
 * (API가 막힌 환경에서도 다운로드는 되게). 상태는 셋이다:
 * ready(버전 표시 + 받기) / unreachable(API 실패 — 받기는 그대로 둔다) /
 * none(릴리즈가 정말 없음 — 버튼 없이 안내만).
 */
export default function GithubApkCard() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'none' | 'unreachable'; app?: ApkAsset }>({ status: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    void checkLatestApk(ctrl.signal).then((checked) => {
      if (!ctrl.signal.aborted) setState(checked);
    });
    return () => ctrl.abort();
  }, []);

  const app = state.app;

  return (
    <section style={{
      background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
      borderRadius: tokens.radii.lg, padding: 16,
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, background: '#0f172a',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 24, fontWeight: 700, color: '#fff', flexShrink: 0,
      }}>
        W
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>
          Android 앱
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 3, lineHeight: 1.5 }}>
          {state.status === 'loading' && '최신 버전 확인 중…'}
          {state.status === 'ready' && app && (
            <>최신 {app.tag}{formatApkSize(app.size) ? ` · ${formatApkSize(app.size)}` : ''} — GitHub 릴리즈에서 받습니다</>
          )}
          {state.status === 'none' && '아직 게시된 릴리즈가 없습니다 — 첫 릴리즈가 올라오면 여기 버튼이 생깁니다'}
          {state.status === 'unreachable' && '버전 확인이 안 됩니다(차단·접속 제한) — 아래 버튼은 고정 링크라 그대로 받습니다'}
        </div>
      </div>
      {(state.status === 'ready' || state.status === 'unreachable') && (
        <a
          href={GITHUB_ANDROID_APK_URL}
          style={{
            padding: '9px 16px', background: tokens.colors.successDark, color: '#fff',
            borderRadius: tokens.radii.md, fontSize: 13, fontWeight: 700,
            textDecoration: 'none', flexShrink: 0,
          }}
        >
          APK 받기
        </a>
      )}
      <a
        href={GITHUB_RELEASES_URL}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 11, color: tokens.colors.accentMid, flexShrink: 0 }}
      >
        모든 버전
      </a>
    </section>
  );
}

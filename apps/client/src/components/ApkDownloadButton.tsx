import React from 'react';
import { Link } from 'react-router-dom';
import { tokens } from '../tokens';

/**
 * Android 앱 다운로드 — 설정 → Device.
 *
 * APK는 GitHub 릴리즈에 올리고 이 버튼은 latest 다운로드로 건다:
 *   https://github.com/parnmanas/ai-workflow-board/releases/latest/download/awb-android.apk
 * 릴리즈 에셋 이름은 `awb-android.apk` 로 고정 — 바꿀 때 여기도 함께 바꾼다.
 * 새 릴리즈를 올리면 버튼이 곧바로 최신본을 낸다(클라이언트 수정·재배포 불필요).
 * 옛 버전·기타 파일은 자료실(/library)에 있다.
 */
export const GITHUB_ANDROID_APK_URL =
  'https://github.com/parnmanas/ai-workflow-board/releases/latest/download/awb-android.apk';

export const GITHUB_ANDROID_ASSET_NAME = 'awb-android.apk';

export default function ApkDownloadButton() {
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
        Android 앱 받기
      </a>
      <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
        처음 한 번은 폰에서 “출처 미확인 앱 설치”를 허용해야 합니다.
        {' '}<Link to="/library" style={{ color: tokens.colors.accentMid }}>옛 버전은 자료실</Link>
      </span>
    </span>
  );
}

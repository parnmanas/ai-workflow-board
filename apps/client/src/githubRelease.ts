/**
 * GitHub 릴리즈의 최신 APK — 자료실·설정의 앱 다운로드 공용.
 *
 * 원칙: 버전 표시는 API로, 다운로드는 고정 링크로. `.../releases/latest/download/<에셋>`
 * 은 릴리즈가 있기만 하면 항상 최신본을 내주므로, 새 릴리즈를 올리면 클라이언트
 * 수정·재배포 없이 버튼이 최신본을 낸다. API(api.github.com)가 막힌 환경에서도
 * 다운로드는 된다 — 버전 표기만 못 할 뿐이다.
 */

export const GITHUB_OWNER = 'parnmanas';
export const GITHUB_REPO = 'ai-workflow-board';
export const GITHUB_ANDROID_ASSET_NAME = 'awb-android.apk';
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
/** 릴리즈 있기만 하면 항상 최신 APK. 에셋 이름을 바꾸면 서버·버튼이 아니라 릴리즈가 깨진다. */
export const GITHUB_ANDROID_APK_URL = `${GITHUB_RELEASES_URL}/latest/download/${GITHUB_ANDROID_ASSET_NAME}`;

export interface ApkAsset {
  tag: string;
  name: string;
  size: number;
  publishedAt: string;
  downloadUrl: string;
}

/** latest 릴리즈 JSON에서 APK 에셋을 고른다. 없으면 null — 호출 쪽이 고정 링크로 떨어진다. */
export function pickApkAsset(release: any): ApkAsset | null {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const hit = assets.find((a: any) => a?.name === GITHUB_ANDROID_ASSET_NAME && typeof a?.browser_download_url === 'string');
  if (!hit) return null;
  return {
    tag: String(release?.tag_name || ''),
    name: String(hit.name),
    size: Number(hit.size) || 0,
    publishedAt: String(hit.updated_at || release?.published_at || ''),
    downloadUrl: String(hit.browser_download_url),
  };
}

/** 최신 릴리즈를 묻는다. 릴리즈 미게시(none)와 API 실패(unreachable)를 구분한다 —
 * 뭉뚱그리면 "릴리즈가 없다"는 거짓말이 된다. 다운로드는 고정 링크가 있어
 * unreachable에서도 된다. */
export async function checkLatestApk(signal?: AbortSignal): Promise<
  { status: 'ready'; app: ApkAsset } | { status: 'none' } | { status: 'unreachable' }
> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { signal, headers: { Accept: 'application/vnd.github+json' } },
    );
  } catch {
    return { status: 'unreachable' };
  }
  if (!res.ok) {
    // 404 = 릴리즈가 정말 없다. 403/429(레이트리밋) 등은 못 닿음으로 친다.
    return res.status === 404 ? { status: 'none' } : { status: 'unreachable' };
  }
  try {
    const app = pickApkAsset(await res.json());
    return app ? { status: 'ready', app } : { status: 'none' };
  } catch {
    return { status: 'unreachable' };
  }
}

export async function fetchLatestApk(signal?: AbortSignal): Promise<ApkAsset | null> {
  const checked = await checkLatestApk(signal);
  return checked.status === 'ready' ? checked.app : null;
}

export function formatApkSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

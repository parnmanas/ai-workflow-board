import { t as translate } from '../../i18n/core';
import {
  copyImageToNativeClipboard,
  isAndroidApp,
  nativeDownloadUrl,
  saveBlobToNativeDownloads,
} from '../../native/androidBridge';

/**
 * 화면의 미디어 내려받기와 이미지 복사 — 브라우저와 Android 앱이 같은 함수를 탄다.
 *
 * 브라우저는 `<a download>` 와 async Clipboard API 로 된다. 앱(WebView)은 둘 다 안 된다: 내려받기는 앱의
 * DownloadManager 가 `blob:` 을 읽지 못하고(세션 이미지 · 영상과 첨부는 인증 헤더로 받아 blob: 으로 그린다),
 * WebView 의 Clipboard API 는 이미지를 쓰지 못한다. 그래서 앱 안에서는 바이트를 앱에 넘겨 다운로드 폴더 ·
 * 클립보드에 둔다(`native/androidBridge.ts`). 바이트를 다시 읽는 `fetch(blob:)` 는 CSP connect-src 가 연다.
 */

const PAGE_BYTES = /^(blob|data):/i;

function sameOrigin(src: string): boolean {
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function bytesOf(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.blob();
}

/**
 * 앱 안의 내려받기 — 화면이 들고 있는 바이트(blob: · data:)는 앱의 다운로드 폴더에 쓰고, http(s) 주소는 앱의
 * DownloadManager 에 맡긴다(지금 서버의 주소에만 앱이 세션을 붙인다).
 *
 * http(s) 를 모르는 옛 앱이면 예전처럼 WebView 에 맡긴다 — 같은 서버는 WebView 의 내려받기, 다른 사이트는 바깥
 * 열기. 그 재시도는 `data-awb-native="skip"` 표시로 이 가로채기를 다시 타지 않는다.
 */
export async function downloadInAndroidApp(href: string, name: string): Promise<void> {
  if (PAGE_BYTES.test(href)) {
    await saveBlobToNativeDownloads(await bytesOf(href), name);
    return;
  }
  try {
    await nativeDownloadUrl(new URL(href, window.location.href).href, name);
  } catch (err) {
    if ((err as Error)?.message !== 'unknown_type') throw err;
    const fallback = document.createElement('a');
    fallback.href = href;
    fallback.download = name;
    fallback.dataset.awbNative = 'skip';
    document.body.appendChild(fallback);
    fallback.click();
    fallback.remove();
  }
}

/**
 * 앱 안에서 `<a download>` 를 누르면 앱의 내려받기로 돌린다 — 화면의 모든 내려받기 링크(세션 미디어 · 라이트박스 ·
 * 첨부 · CSV 내보내기)가 각자 고치지 않고 같이 된다. 캡처 단계에서 받아 WebView 의 기본 동작보다 먼저 막는다.
 * 실패는 `onError` 로 알린다(성공은 앱이 알림으로 알린다).
 */
export function interceptDownloadsInAndroidApp(onError: (message: string) => void): () => void {
  if (!isAndroidApp()) return () => undefined;
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
    if (!a || !a.href || a.dataset.awbNative === 'skip') return;
    e.preventDefault();
    void downloadInAndroidApp(a.href, a.getAttribute('download') || '').catch((err) => onError(mediaActionError(err, 'download')));
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

/** 복사할 수 있는 이미지 주소인가 — 화면이 바이트를 읽을 수 있어야 한다(다른 사이트 그림은 CORS 로 못 읽는다). */
export function canCopyImage(src: string): boolean {
  return PAGE_BYTES.test(src) || sameOrigin(src);
}

/** 클립보드의 그림은 PNG 만 받는 브라우저가 있다 — 다른 형식은 그려서 바꾼다. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('png_failed'))), 'image/png');
  });
}

/**
 * 이미지 한 장을 클립보드로. 앱이면 앱의 클립보드(다른 앱에 붙여 넣을 수 있다), 브라우저면 async Clipboard API.
 * 브라우저는 ClipboardItem 에 바이트의 약속을 바로 넣는다 — 누른 그 순간에 만들어진 항목만 받는 브라우저(Safari)가 있다.
 */
export async function copyImage(src: string): Promise<void> {
  if (isAndroidApp()) {
    await copyImageToNativeClipboard(await bytesOf(src));
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard_unsupported');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': bytesOf(src).then(toPng) })]);
}

/** 실패 사유 → 화면에 보일 말. */
export function mediaActionError(err: unknown, action: 'download' | 'copy'): string {
  const code = (err as Error)?.message || '';
  if (code === 'unknown_type') return translate('Update the Android app to use this.');
  if (code === 'storage_permission') return translate('Allow storage access, then try again.');
  if (code === 'clipboard_unsupported') return translate('This browser cannot copy images.');
  return action === 'copy' ? translate('Copy failed') : translate('Download failed');
}

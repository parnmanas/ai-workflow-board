import React, { useCallback, useEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import { base64ToBlob, formatBytes, isImageMime, isVideoMime, triggerBlobDownload } from '../chat/utils/attachments';

/**
 * 검증 증거(스크린샷·녹화)를 그리는 공용 조각 — step 세션의 첨부와 Evidence 갤러리가
 * 같은 썸네일·플레이어·라이트박스를 쓴다.
 *
 * 바이트는 **필요할 때만** 받는다. 세션 전사와 갤러리 목록은 메타만 싣고, 썸네일이
 * 화면에 놓이는 순간 `load(id)` 로 base64 를 받아 Blob URL 로 바꾼다. base64 를 `<img src>`
 * 에 직접 넣지 않는 이유는 채팅 MessageList 와 같다 — 렌더마다 수 MB 문자열이 diff 되고,
 * 브라우저가 디코드 결과를 캐시하지 못한다. URL 은 언마운트 때 revoke 한다.
 *
 * 동영상은 `<video controls>` 로 인라인 재생한다. 채팅의 파일 카드처럼 "다운로드" 만
 * 주면 운영자가 검증 녹화를 보려고 파일을 내려받아 다른 앱을 열어야 한다 — 증거는
 * 그 자리에서 재생돼야 증거다.
 */

export interface EvidenceMediaMeta {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

/** id → base64 payload. 호출자가 어느 경로(step 첨부 / 채팅 첨부)로 읽을지 정한다. */
export type EvidenceLoader = (meta: EvidenceMediaMeta) => Promise<{ file_data: string; mime_type?: string } | null>;

/**
 * Blob URL 캐시. 같은 첨부를 두 번 받지 않고, 컴포넌트가 사라지면 전부 revoke 한다.
 * 실패한 id 는 `failed` 에 남겨 무한 재시도를 막는다(썸네일이 "…" 로 남는다).
 */
export function useEvidenceUrls(load: EvidenceLoader) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef<Record<string, string>>({});
  const inflight = useRef<Set<string>>(new Set());
  const failed = useRef<Set<string>>(new Set());

  useEffect(() => {
    urlsRef.current = urls;
  }, [urls]);
  useEffect(
    () => () => {
      for (const u of Object.values(urlsRef.current)) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  const ensure = useCallback(
    (meta: EvidenceMediaMeta) => {
      const id = meta.id;
      if (!id || urlsRef.current[id] || inflight.current.has(id) || failed.current.has(id)) return;
      inflight.current.add(id);
      load(meta)
        .then((full) => {
          if (!full?.file_data) {
            failed.current.add(id);
            return;
          }
          const blob = base64ToBlob(full.file_data, full.mime_type || meta.mime_type || '');
          const url = URL.createObjectURL(blob);
          setUrls((prev) => {
            if (prev[id]) {
              try {
                URL.revokeObjectURL(url);
              } catch {
                /* ignore */
              }
              return prev;
            }
            return { ...prev, [id]: url };
          });
        })
        .catch(() => {
          failed.current.add(id);
        })
        .finally(() => {
          inflight.current.delete(id);
        });
    },
    [load],
  );

  return { urls, ensure };
}

/** 썸네일 한 장. 이미지는 잘라서, 동영상은 첫 프레임 + ▶ 표시. 클릭하면 라이트박스. */
export function EvidenceThumb({
  meta,
  url,
  onEnsure,
  onOpen,
  size = 112,
}: {
  meta: EvidenceMediaMeta;
  url: string | undefined;
  onEnsure: (meta: EvidenceMediaMeta) => void;
  onOpen: (meta: EvidenceMediaMeta, url: string) => void;
  size?: number;
}) {
  useEffect(() => {
    onEnsure(meta);
  }, [meta, onEnsure]);
  const video = isVideoMime(meta.mime_type);
  return (
    <button
      type="button"
      data-testid="evidence-thumb"
      title={`${meta.file_name} · ${formatBytes(meta.size_bytes)}`}
      onClick={() => {
        if (url) onOpen(meta, url);
      }}
      style={{
        position: 'relative',
        width: size,
        height: size,
        padding: 0,
        borderRadius: 7,
        border: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.border,
        overflow: 'hidden',
        cursor: url ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {url ? (
        video ? (
          <video src={url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <img src={url} alt={meta.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )
      ) : (
        <span style={{ fontSize: 11, color: tokens.colors.textSecondary }}>…</span>
      )}
      {video && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 6,
            bottom: 6,
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.65)',
            color: '#fff',
          }}
        >
          ▶ video
        </span>
      )}
    </button>
  );
}

/** 전체 화면 미리보기 — 이미지는 원본 크기, 동영상은 컨트롤 달린 플레이어. */
export function EvidenceLightbox({
  meta,
  url,
  caption,
  onClose,
}: {
  meta: EvidenceMediaMeta;
  url: string;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const video = isVideoMime(meta.mime_type);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={video ? 'Video preview' : 'Image preview'}
      data-testid="evidence-lightbox"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: tokens.overlays.scrimStrong,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
    >
      {video ? (
        <video
          src={url}
          controls
          autoPlay
          style={{ maxWidth: '92vw', maxHeight: '82vh', borderRadius: 6, background: '#000' }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={url}
          alt={meta.file_name}
          style={{ maxWidth: '92vw', maxHeight: '82vh', borderRadius: 6 }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', gap: 12, alignItems: 'center', color: '#ddd', fontSize: 12 }}
      >
        <span>{caption || meta.file_name}</span>
        <span style={{ color: '#999' }}>{formatBytes(meta.size_bytes)}</span>
        <button
          type="button"
          onClick={async () => {
            const res = await fetch(url);
            triggerBlobDownload(await res.blob(), meta.file_name || 'evidence');
          }}
          style={{
            border: '1px solid #666',
            background: 'transparent',
            color: '#eee',
            borderRadius: 5,
            padding: '3px 10px',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Download
        </button>
      </div>
    </div>
  );
}

/** 이 첨부를 인라인 미디어로 그릴 수 있는가. 서버의 `is_media` 와 같은 판정(mime 기준). */
export function isEvidenceMedia(meta: { mime_type: string; file_name?: string }): boolean {
  return isImageMime(meta.mime_type) || isVideoMime(meta.mime_type);
}

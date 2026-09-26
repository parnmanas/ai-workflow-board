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

/**
 * id → base64 payload. 호출자가 어느 경로(step 첨부 / 채팅 첨부)로 읽을지 정한다.
 * `truncated` 는 서버가 "이 파일은 끝까지 오지 않았다"고 알려 주는 값이다(읽기 시점에
 * 스트림만 닫아 준 것) — 화면은 남은 부분을 그리되 **일부라는 사실을 함께** 말해야 한다.
 */
export type EvidenceLoader = (
  meta: EvidenceMediaMeta,
) => Promise<{ file_data: string; mime_type?: string; truncated?: boolean } | null>;

/**
 * Blob URL 캐시. 같은 첨부를 두 번 받지 않고, 컴포넌트가 사라지면 전부 revoke 한다.
 * 실패한 id 는 `failed` 에 남겨 무한 재시도를 막는다(썸네일이 "…" 로 남는다).
 */
export function useEvidenceUrls(load: EvidenceLoader) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [partial, setPartial] = useState<Record<string, boolean>>({});
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
          if (full.truncated) setPartial((prev) => ({ ...prev, [id]: true }));
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

  return { urls, ensure, partial };
}

/** 썸네일 한 장. 이미지는 잘라서, 동영상은 첫 프레임 + ▶ 표시. 클릭하면 라이트박스. */
export function EvidenceThumb({
  meta,
  url,
  partial,
  onEnsure,
  onOpen,
  size = 112,
}: {
  meta: EvidenceMediaMeta;
  url: string | undefined;
  /** 서버가 잘린 파일이라고 알려 준 경우 — 남은 부분만 그려진다. */
  partial?: boolean;
  onEnsure: (meta: EvidenceMediaMeta) => void;
  onOpen: (meta: EvidenceMediaMeta, url: string) => void;
  size?: number;
}) {
  useEffect(() => {
    onEnsure(meta);
  }, [meta, onEnsure]);
  /**
   * 바이트는 받았는데 **브라우저가 디코드하지 못하는** 경우. 2026-09-26 에 실제로 일어났다:
   * 에이전트가 아직 쓰이는 중인 캡처 파일을 읽어 올려서 JPEG 가 중간에 끊긴 채 저장됐다.
   * 그때 화면은 영원히 "…" 자리표시자였고, 운영자에게는 "AWB 가 이미지를 못 보여준다"로
   * 보였다 — 실제로는 파일이 깨진 것이다. 둘은 서로 **다른 문제**이므로 화면이 구분해서
   * 말해야 한다. 업로드 시점 검사가 지금은 이런 파일을 막지만, 이미 저장된 것들과
   * 검사하지 않는 형식(동영상 컨테이너)이 남아 있다.
   */
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [url]);
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
        // contain 레터박스의 여백. 어두운 스크린샷과 이어지도록 검은 바탕을 쓴다.
        background: '#111',
        overflow: 'hidden',
        cursor: url ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {broken ? (
        <span
          data-testid="evidence-thumb-broken"
          style={{
            fontSize: 10,
            lineHeight: 1.35,
            padding: 6,
            textAlign: 'center',
            color: tokens.colors.warningLight,
          }}
        >
          ⚠ 깨진 파일
          <br />
          <span style={{ color: tokens.colors.textMuted }}>열 수 없습니다</span>
        </span>
      ) : url ? (
        /*
          `contain` 이다 — 예전 `cover` 는 정사각 썸네일에 맞추려고 **가운데를 잘랐고**,
          그래서 넓은 대조표(900x180)는 아이콘 한두 개만, 잘린 스크린샷은 미디코드 영역인
          회색 한가운데만 보였다. 운영자 눈에는 빈 칸이다(2026-09-26 실측: 잘린 3장의
          중앙 크롭이 회색 85~99%). 증거 썸네일에서 중요한 것은 격자의 균일함이 아니라
          **무엇이 찍혔는지**이므로 프레임 전체를 레터박스로 보여준다.
        */
        video ? (
          <video
            src={url}
            muted
            preload="metadata"
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <img
            src={url}
            alt={meta.file_name}
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        )
      ) : (
        <span style={{ fontSize: 11, color: tokens.colors.textSecondary }}>…</span>
      )}
      {partial && !broken && (
        <span
          data-testid="evidence-thumb-partial"
          title={
            '이 파일은 끝까지 도착하지 않아 아래쪽이 비어 있습니다. 보이는 부분은 실제로 찍힌 내용이지만, ' +
            '나머지는 존재하지 않습니다 — 온전한 증거가 필요하면 담당 agent 에게 다시 올려 달라고 하세요.'
          }
          style={{
            position: 'absolute',
            left: 4,
            top: 4,
            fontSize: 9,
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.7)',
            color: tokens.colors.warningLight,
          }}
        >
          일부만
        </span>
      )}
      {video && !broken && (
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
  partial,
  onClose,
}: {
  meta: EvidenceMediaMeta;
  url: string;
  caption?: string;
  partial?: boolean;
  onClose: () => void;
}) {
  const [broken, setBroken] = useState(false);
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
      {broken ? (
        <div
          data-testid="evidence-lightbox-broken"
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: 520,
            padding: 20,
            borderRadius: 8,
            background: tokens.colors.surfaceCard,
            color: tokens.colors.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          <div style={{ color: tokens.colors.warningLight, fontWeight: 700, marginBottom: 6 }}>
            ⚠ 이 파일은 열 수 없습니다
          </div>
          바이트는 서버에 저장돼 있지만 이미지로 해석되지 않습니다. 파일이 끝까지 오지 않았거나
          형식이 맞지 않는 경우이고, 어느 쪽이든 화면에서 복구할 방법은 없습니다 — 담당 agent 에게
          다시 올려 달라고 하세요. 아래 Download 로 원본 바이트는 그대로 받을 수 있습니다.
        </div>
      ) : video ? (
        <video
          src={url}
          controls
          autoPlay
          onError={() => setBroken(true)}
          style={{ maxWidth: '92vw', maxHeight: '82vh', borderRadius: 6, background: '#000' }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={url}
          alt={meta.file_name}
          onError={() => setBroken(true)}
          style={{ maxWidth: '92vw', maxHeight: '82vh', borderRadius: 6 }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          color: '#ddd',
          fontSize: 12,
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: '80vw',
          lineHeight: 1.6,
          textAlign: 'center',
        }}
      >
        <span>{caption || meta.file_name}</span>
        {partial && (
          <span data-testid="evidence-lightbox-partial" style={{ color: tokens.colors.warningLight }}>
            ⚠ 끝까지 도착하지 않은 파일입니다 — 아래쪽 빈 부분은 처음부터 오지 않았습니다.
            대개 캡처가 저장을 마치기 전에 읽혀서 생깁니다. 온전한 증거가 필요하면 담당 agent 에게
            다시 올려 달라고 하세요(지금은 이런 파일이 업로드 단계에서 걸러집니다).
          </span>
        )}
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

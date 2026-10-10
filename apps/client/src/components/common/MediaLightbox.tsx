import React, { useCallback, useEffect, useState } from 'react';
import { tokens } from '../../tokens';

/**
 * 이미지/영상 공용 라이트박스.
 *
 * 클릭이 곧 다운로드였던 화면들(Chat·세션·티켓·증거)을 "팝업으로 보고 prev/next 로
 * 넘기는" UX 로 통일하기 위한 단일 구현이다. 각 화면은 갤러리 목록(items)과 현재
 * 위치(index)만 넘기면 된다 — 키보드(Esc/←→), 배경 클릭 닫기, 깨진 파일 표시,
 * 영상 인라인 재생, 다운로드(팝업 안의 부차 버튼)는 여기서 한 번만 다룬다.
 */

export interface MediaLightboxItem {
  src: string;
  kind: 'image' | 'video';
  /** 파일명·캡션 — 하단 바에 보인다. */
  caption?: string;
  filename?: string;
}

interface MediaLightboxProps {
  items: MediaLightboxItem[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}

export default function MediaLightbox({ items, index, onIndexChange, onClose }: MediaLightboxProps) {
  const [broken, setBroken] = useState(false);
  const total = items.length;
  const safeIndex = total === 0 ? 0 : ((index % total) + total) % total;
  const current = items[safeIndex];

  useEffect(() => {
    setBroken(false);
  }, [safeIndex, current?.src]);

  const goPrev = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((safeIndex + total - 1) % total);
  }, [safeIndex, total, onIndexChange]);

  const goNext = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((safeIndex + 1) % total);
  }, [safeIndex, total, onIndexChange]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, goPrev, goNext]);

  if (total === 0 || !current) return null;
  const isVideo = current.kind === 'video';
  const label = current.caption || current.filename || (isVideo ? 'Video' : 'Image');
  const loading = !current.src;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="media-lightbox"
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
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          maxWidth: '94vw',
          maxHeight: '82vh',
          width: '100%',
        }}
      >
        {total > 1 && (
          <button
            type="button"
            aria-label="Previous"
            data-testid="media-lightbox-prev"
            onClick={goPrev}
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              width: 40,
              height: 56,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 22,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ‹
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 120 }}>
          {loading ? (
            <div style={{ color: '#bbb', fontSize: 13 }}>불러오는 중…</div>
          ) : broken ? (
            <div
              data-testid="media-lightbox-broken"
              style={{
                maxWidth: 520,
                padding: 20,
                borderRadius: 8,
                background: tokens.colors.surfaceCard,
                color: tokens.colors.textSecondary,
                fontSize: 12.5,
                lineHeight: 1.7,
                textAlign: 'center',
              }}
            >
              <div style={{ color: tokens.colors.warningLight, fontWeight: 700, marginBottom: 6 }}>
                ⚠ 이 파일은 열 수 없습니다
              </div>
              바이트는 저장돼 있지만 이미지/영상으로 해석되지 않습니다.
            </div>
          ) : isVideo ? (
            <video
              key={current.src}
              src={current.src}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onError={() => setBroken(true)}
              style={{ maxWidth: '88vw', maxHeight: '78vh', borderRadius: 6, background: '#000' }}
            />
          ) : (
            <img
              key={current.src}
              src={current.src}
              alt={label}
              onError={() => setBroken(true)}
              style={{ maxWidth: '88vw', maxHeight: '78vh', borderRadius: 6, objectFit: 'contain' }}
            />
          )}
        </div>
        {total > 1 && (
          <button
            type="button"
            aria-label="Next"
            data-testid="media-lightbox-next"
            onClick={goNext}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              width: 40,
              height: 56,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 22,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ›
          </button>
        )}
      </div>
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
          maxWidth: '88vw',
          lineHeight: 1.6,
          textAlign: 'center',
        }}
      >
        {total > 1 && (
          <span data-testid="media-lightbox-counter" style={{ color: '#aaa', fontVariantNumeric: 'tabular-nums' }}>
            {safeIndex + 1} / {total}
          </span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50vw' }} title={label}>
          {label}
        </span>
        <a
          href={current.src}
          download={current.filename || (isVideo ? 'video' : 'image')}
          onClick={(e) => e.stopPropagation()}
          style={{ color: '#bbb', fontSize: 11, border: '1px solid #666', borderRadius: 5, padding: '3px 10px', textDecoration: 'none' }}
        >
          Download
        </a>
        <button
          type="button"
          onClick={onClose}
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
          Close (Esc)
        </button>
      </div>
    </div>
  );
}

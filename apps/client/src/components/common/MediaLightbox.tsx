import React, { useCallback, useEffect, useState } from 'react';
import { tokens } from '../../tokens';
import ZoomStage from './ZoomStage';
import { useCloseOnBack } from './useCloseOnBack';

/**
 * 이미지/영상 공용 라이트박스.
 *
 * 클릭이 곧 다운로드였던 화면들(Chat·세션·티켓·증거)을 "팝업으로 보고 prev/next 로
 * 넘기는" UX 로 통일하기 위한 단일 구현이다. 각 화면은 갤러리 목록(items)과 현재
 * 위치(index)만 넘기면 된다 — 키보드(Esc/←→), 배경 클릭 닫기, 깨진 파일 표시,
 * 영상 인라인 재생, 다운로드(팝업 안의 부차 버튼)는 여기서 한 번만 다룬다.
 *
 * 확대 · 이동(핀치, 드래그, 더블탭, 휠)과 스와이프 넘기기/닫기는 `ZoomStage` 가, 뒤로 가기로
 * 닫기(안드로이드 앱의 뒤로 버튼)는 `useCloseOnBack` 이 맡는다.
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

  useCloseOnBack(onClose);

  // Esc 는 라이트박스 몫이다 — capture 단계에서 받아 멈춘다. 티켓 패널처럼 document 에서 Esc 로
  // 닫히는 화면 위에 떠 있을 때, 사진만 닫으려던 Esc 가 그 화면까지 닫지 않게.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
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
        // 오버레이 위의 손가락이 뒤 화면을 스크롤하지 않게.
        touchAction: 'none',
        overscrollBehavior: 'contain',
      }}
    >
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={centered}>
            <div style={{ color: '#bbb', fontSize: 13 }}>불러오는 중…</div>
          </div>
        ) : broken ? (
          <div style={centered}>
            <div
              data-testid="media-lightbox-broken"
              onClick={(e) => e.stopPropagation()}
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
          </div>
        ) : (
          <ZoomStage
            key={current.src}
            kind={current.kind}
            src={current.src}
            alt={label}
            onError={() => setBroken(true)}
            onPrev={total > 1 ? goPrev : undefined}
            onNext={total > 1 ? goNext : undefined}
            onDismiss={onClose}
          />
        )}
        {total > 1 && (
          <button
            type="button"
            aria-label="Previous"
            data-testid="media-lightbox-prev"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            style={{ ...navButton, left: 8 }}
          >
            ‹
          </button>
        )}
        {total > 1 && (
          <button
            type="button"
            aria-label="Next"
            data-testid="media-lightbox-next"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            style={{ ...navButton, right: 8 }}
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
          margin: '0 auto',
          padding: '6px 0 calc(10px + env(safe-area-inset-bottom, 0px))',
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

const centered: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const navButton: React.CSSProperties = {
  position: 'absolute',
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
};

import React from 'react';
import { rawResourceUrl } from '../../api';
import { tokens } from '../../tokens';
import type { Resource } from '../../types';

// Modal that lists file-backed workspace Resources so a comment can
// reference one instead of re-uploading bytes (ticket ff3e7337 — the
// design-recommended "reference existing Resource" path).
export default function ResourceReferencePicker({
  loading, error, items, onPick, onClose,
}: {
  loading: boolean;
  error: string | null;
  items: Resource[];
  onPick: (r: Resource) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)', maxHeight: '70vh', overflow: 'auto',
          background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.lg, padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong style={{ color: tokens.colors.textStrong, fontSize: 14 }}>기존 리소스 첨부</strong>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 16,
          }}>{'✕'}</button>
        </div>
        {loading && <div style={{ color: tokens.colors.textMuted, fontSize: 12, padding: '12px 0' }}>불러오는 중…</div>}
        {error && <div style={{ color: tokens.colors.danger, fontSize: 12, padding: '12px 0' }}>{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div style={{ color: tokens.colors.textMuted, fontSize: 12, padding: '12px 0' }}>첨부할 수 있는 파일 리소스가 없습니다.</div>
        )}
        {!loading && !error && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {items.map((r) => {
              const mt = r.file_mimetype || '';
              const isImage = mt.startsWith('image/');
              const isVideo = mt.startsWith('video/');
              return (
                <button
                  key={r.id}
                  onClick={() => onPick(r)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                    background: 'transparent', border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md, cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  <span style={{
                    width: 40, height: 40, flexShrink: 0, borderRadius: tokens.radii.sm,
                    border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
                    background: isVideo ? '#000' : tokens.colors.surfaceCard,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                  }}>
                    {isImage
                      ? <img src={rawResourceUrl(r.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : isVideo ? <span>🎬</span> : <span>📎</span>}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', color: tokens.colors.textStrong, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.file_name || r.name}</span>
                    <span style={{ display: 'block', color: tokens.colors.textMuted, fontSize: 10 }}>{mt || r.type}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, rawResourceUrl } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { LibraryItem } from '../types';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * 자료실 — 설치물(APK)·공유 파일을 올리고 받는 곳. 바이트는 Resource에 있고
 * 이 화면은 겉장만 다룬다. 다운로드는 /raw?download=1 직링크(세션 토큰 쿼리)라
 * 앱 설치도 브라우저가 받아서 연다.
 */
export default function LibraryPage() {
  const { currentAccountId } = useAuth();
  const { showToast } = useToast();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('');
  const [description, setDescription] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!currentAccountId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.listLibraryItems(currentAccountId);
      setItems(res.items || []);
    } catch (err: any) {
      showToast(err?.message || '자료를 불러오지 못했습니다', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!currentAccountId) return;
    if (!file) {
      showToast('파일을 먼저 고르세요', 'error');
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.uploadResourceFile(file, { account_id: currentAccountId, type: 'library_file' });
      await api.createLibraryItem({
        account_id: currentAccountId,
        resource_id: uploaded.id,
        title: title.trim() || file.name,
        description: description.trim(),
        version: version.trim(),
        kind: file.name.toLowerCase().endsWith('.apk') ? 'app' : 'file',
      });
      setTitle('');
      setVersion('');
      setDescription('');
      if (fileRef.current) fileRef.current.value = '';
      showToast('자료실에 올렸습니다', 'success');
      await refresh();
    } catch (err: any) {
      showToast(err?.message || '올리지 못했습니다', 'error');
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (item: LibraryItem) => {
    if (!currentAccountId) return;
    if (!window.confirm(`'${item.title}' 을(를) 자료실에서 지울까요?`)) return;
    try {
      await api.deleteLibraryItem(item.id, currentAccountId);
      showToast('지웠습니다', 'success');
      await refresh();
    } catch (err: any) {
      showToast(err?.message || '지우지 못했습니다', 'error');
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
    color: tokens.colors.textStrong, fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Library" description="Installable apps and shared files for this account" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        <div style={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section style={{
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.lg, padding: 16,
          }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>
              올리기
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input ref={fileRef} type="file" aria-label="올릴 파일" style={{ color: tokens.colors.textSecondary, fontSize: 13 }} />
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목 (비우면 파일 이름)" aria-label="제목" style={inputStyle} />
              <div style={{ display: 'flex', gap: 10 }}>
                <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="버전 (예: 1.0)" aria-label="버전" style={{ ...inputStyle, flex: 1 }} />
              </div>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명 (선택)" aria-label="설명" rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
              <button
                type="button" onClick={onUpload} disabled={uploading}
                style={{
                  padding: '10px 14px', background: tokens.colors.accent, color: '#fff',
                  border: 'none', borderRadius: tokens.radii.md, fontSize: 13, fontWeight: 700,
                  cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.6 : 1,
                }}
              >
                {uploading ? '올리는 중…' : '자료실에 올리기'}
              </button>
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
                .apk는 설치물로 분류되어 최신본이 “앱 다운로드”에 뜹니다. 받는 쪽은 로그인한 멤버만 가능합니다.
              </div>
            </div>
          </section>

          <section>
            <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>
              자료 {items.length > 0 && `(${items.length})`}
            </h2>
            {loading ? (
              <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>Loading...</div>
            ) : items.length === 0 ? (
              <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>
                아직 자료가 없습니다. APK나 공유 파일을 올려보세요.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((item) => (
                  <div key={item.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md, padding: '12px 14px',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.title}
                        </span>
                        {item.kind === 'app' && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, color: tokens.colors.successLight,
                            border: `1px solid ${tokens.colors.successDark}`, borderRadius: 999, padding: '1px 7px',
                            flexShrink: 0,
                          }}>
                            APP{item.version ? ` ${item.version}` : ''}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 3 }}>
                        {item.file_name} · {formatSize(item.size)} · {formatDate(item.created_at)}
                        {item.description ? ` · ${item.description}` : ''}
                      </div>
                    </div>
                    <a
                      href={rawResourceUrl(item.resource_id, { download: true })}
                      style={{
                        padding: '7px 12px', background: tokens.colors.accent, color: '#fff',
                        borderRadius: tokens.radii.md, fontSize: 12, fontWeight: 700,
                        textDecoration: 'none', flexShrink: 0,
                      }}
                    >
                      받기
                    </a>
                    <button
                      type="button" onClick={() => onDelete(item)} aria-label={`${item.title} 지우기`}
                      style={{
                        padding: '7px 10px', background: 'transparent',
                        color: tokens.colors.textMuted, border: `1px solid ${tokens.colors.border}`,
                        borderRadius: tokens.radii.md, fontSize: 12, cursor: 'pointer', flexShrink: 0,
                      }}
                    >
                      지우기
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import type { RepoTreeEntry, RepoFileContent } from '../../types';
import { tokens } from '../../tokens';
import { Button } from '../common';
import { MONO, ErrorBox } from './repoTabCommon';

// Files 탭 — 선택 ref 기준 디렉토리 트리 브라우즈 + 파일 클릭 시 내용 미리보기.
// 데이터는 서버 캐시 클론의 git ls-tree / git cat-file 에서 온다. 텍스트는 표시,
// 바이너리/대용량은 안내만 노출한다. ref 변경 시 부모가 refKey 를 갈아끼운다.

interface RepoFilesTabProps {
  resourceId: string;
  workspaceId: string;
  refKey: string;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export default function RepoFilesTab({ resourceId, workspaceId, refKey }: RepoFilesTabProps) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<RepoTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 파일 미리보기(열려 있으면 트리 위에 패널로 표시).
  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<RepoFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // ref 가 바뀌면 루트로 리셋.
  useEffect(() => { setPath(''); setFilePath(null); setFile(null); }, [refKey]);

  const loadTree = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getRepoTree(resourceId, workspaceId, { ref: refKey, path: p });
      setEntries(res.entries);
    } catch (err: any) {
      setError(err?.message || '파일 트리를 불러오지 못했습니다.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [resourceId, workspaceId, refKey]);

  useEffect(() => { loadTree(path); }, [loadTree, path]);

  const openFile = useCallback(async (entry: RepoTreeEntry) => {
    setFilePath(entry.path);
    setFile(null);
    setFileError(null);
    setFileLoading(true);
    try {
      const res = await api.getRepoFile(resourceId, workspaceId, entry.path, refKey);
      setFile(res);
    } catch (err: any) {
      setFileError(err?.message || '파일을 불러오지 못했습니다.');
    } finally {
      setFileLoading(false);
    }
  }, [resourceId, workspaceId, refKey]);

  // breadcrumb 세그먼트 — 클릭 시 해당 깊이로 이동.
  const segments = path ? path.split('/') : [];

  // ── 파일 미리보기 뷰 ─────────────────────────────────────
  if (filePath) {
    return (
      <div data-testid="repo-file-preview">
        <Button variant="secondary" size="sm" onClick={() => { setFilePath(null); setFile(null); }}>
          ← 파일 트리
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontFamily: MONO,
              color: tokens.colors.textStrong,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filePath}
          >
            {filePath}
          </span>
          {file && <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}>{formatBytes(file.size)}</span>}
        </div>
        {fileLoading && (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
            파일 불러오는 중…
          </div>
        )}
        {!fileLoading && fileError && <ErrorBox message={fileError} />}
        {!fileLoading && file && <FilePreview file={file} />}
      </div>
    );
  }

  // ── 트리 브라우즈 뷰 ─────────────────────────────────────
  return (
    <div data-testid="repo-files-tree">
      {/* breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        <BreadcrumbButton label="/" onClick={() => setPath('')} active={segments.length === 0} />
        {segments.map((seg, i) => {
          const target = segments.slice(0, i + 1).join('/');
          return (
            <React.Fragment key={target}>
              <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>/</span>
              <BreadcrumbButton label={seg} onClick={() => setPath(target)} active={i === segments.length - 1} />
            </React.Fragment>
          );
        })}
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
          파일 트리 불러오는 중…
        </div>
      )}
      {!loading && error && <ErrorBox message={error} />}
      {!loading && !error && entries.length === 0 && (
        <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '16px 4px' }}>
          빈 디렉토리입니다.
        </div>
      )}
      {!loading && !error && entries.length > 0 && (
        <div
          style={{
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            overflow: 'hidden',
          }}
        >
          {path && (
            <button
              type="button"
              onClick={() => setPath(segments.slice(0, -1).join('/'))}
              style={rowButtonStyle(true)}
            >
              <span style={{ fontSize: 13, color: tokens.colors.textSecondary, fontFamily: MONO }}>../</span>
            </button>
          )}
          {entries.map((entry, idx) => {
            const isDir = entry.type === 'tree';
            const isSub = entry.type === 'commit';
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => { if (isDir) setPath(entry.path); else if (!isSub) openFile(entry); }}
                disabled={isSub}
                style={rowButtonStyle(idx === 0 && !path)}
              >
                <span aria-hidden style={{ flexShrink: 0, fontSize: 13 }}>
                  {isDir ? '📁' : isSub ? '🔗' : '📄'}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontFamily: MONO,
                    color: isSub ? tokens.colors.textMuted : tokens.colors.textStrong,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.name}{isDir ? '/' : ''}
                </span>
                {entry.type === 'blob' && entry.size != null && (
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}>
                    {formatBytes(entry.size)}
                  </span>
                )}
                {isSub && <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}>submodule</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilePreview({ file }: { file: RepoFileContent }) {
  if (file.too_large) {
    return (
      <div style={noteStyle}>
        파일이 너무 커서 미리보기를 제공하지 않습니다 ({formatBytes(file.size)}).
      </div>
    );
  }
  if (file.binary) {
    return (
      <div style={noteStyle}>
        바이너리 파일이라 미리보기를 표시할 수 없습니다 ({formatBytes(file.size)}).
      </div>
    );
  }
  return (
    <div>
      <pre
        data-testid="repo-file-content"
        style={{
          margin: 0,
          fontSize: 12,
          fontFamily: MONO,
          color: tokens.colors.textStrong,
          background: tokens.colors.surface,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          padding: 12,
          maxHeight: 480,
          overflow: 'auto',
          whiteSpace: 'pre',
          lineHeight: 1.5,
        }}
      >
        {file.content || '(빈 파일)'}
      </pre>
      {file.truncated && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
          파일이 커서 일부만 표시했습니다.
        </div>
      )}
    </div>
  );
}

const noteStyle: React.CSSProperties = {
  fontSize: 13,
  color: tokens.colors.textMuted,
  padding: '24px 12px',
  textAlign: 'center',
  border: `1px dashed ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
};

function rowButtonStyle(first: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    padding: '8px 12px',
    border: 'none',
    borderTop: first ? 'none' : `1px solid ${tokens.colors.border}`,
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function BreadcrumbButton({ label, onClick, active }: { label: string; onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={active}
      style={{
        background: 'none',
        border: 'none',
        padding: '2px 4px',
        fontSize: 12,
        fontFamily: MONO,
        color: active ? tokens.colors.textPrimary : tokens.colors.accentSubtle,
        fontWeight: active ? 700 : 500,
        cursor: active ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

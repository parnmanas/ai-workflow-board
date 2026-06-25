import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import type { RepoCommitSummary, RepoCommitDetail } from '../../types';
import { tokens } from '../../tokens';
import { Button, Badge } from '../common';
import { relativeTime } from '../../utils/time';
import { MONO, ErrorBox } from './repoTabCommon';

// History 탭 — 선택 ref 기준 커밋 리스트(load-older 페이지네이션) + 커밋 클릭 시
// 변경 파일/diff 상세. 데이터는 서버의 per-resource 캐시 클론(git log/git show)에서
// 온다. ref 가 바뀌면 부모(ResourceDetailPanel)가 refKey 를 갈아끼워 재조회시킨다.

const PAGE = 30;

interface RepoHistoryTabProps {
  resourceId: string;
  workspaceId: string;
  // 선택된 ref(브랜치/태그). 빈 문자열이면 서버가 HEAD 로 해석한다.
  refKey: string;
}

export default function RepoHistoryTab({ resourceId, workspaceId, refKey }: RepoHistoryTabProps) {
  const [commits, setCommits] = useState<RepoCommitSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // 선택 커밋 상세(있으면 리스트 대신 상세 뷰).
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<RepoCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedSha(null);
    setDetail(null);
    try {
      const res = await api.listRepoCommits(resourceId, workspaceId, { ref: refKey, limit: PAGE });
      setCommits(res.commits);
      setHasMore(res.commits.length === PAGE);
    } catch (err: any) {
      setError(err?.message || '커밋 히스토리를 불러오지 못했습니다.');
      setCommits([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [resourceId, workspaceId, refKey]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadOlder = useCallback(async () => {
    if (loadingMore || commits.length === 0) return;
    setLoadingMore(true);
    try {
      const before = commits[commits.length - 1].sha;
      const res = await api.listRepoCommits(resourceId, workspaceId, { ref: refKey, limit: PAGE, before });
      setCommits((prev) => [...prev, ...res.commits]);
      setHasMore(res.commits.length === PAGE);
    } catch (err: any) {
      setError(err?.message || '더 불러오지 못했습니다.');
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, commits, resourceId, workspaceId, refKey]);

  const openCommit = useCallback(async (sha: string) => {
    setSelectedSha(sha);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await api.getRepoCommit(resourceId, workspaceId, sha);
      setDetail(d);
    } catch (err: any) {
      setDetailError(err?.message || '커밋 상세를 불러오지 못했습니다.');
    } finally {
      setDetailLoading(false);
    }
  }, [resourceId, workspaceId]);

  // ── 커밋 상세 뷰 ─────────────────────────────────────────
  if (selectedSha) {
    return (
      <div data-testid="repo-commit-detail">
        <Button variant="secondary" size="sm" onClick={() => { setSelectedSha(null); setDetail(null); }}>
          ← 커밋 목록
        </Button>
        {detailLoading && (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
            커밋 상세 불러오는 중…
          </div>
        )}
        {!detailLoading && detailError && <ErrorBox message={detailError} />}
        {!detailLoading && detail && <CommitDetailView detail={detail} />}
      </div>
    );
  }

  // ── 커밋 리스트 뷰 ───────────────────────────────────────
  return (
    <div data-testid="repo-history-list">
      {loading && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
          커밋 히스토리 불러오는 중…
        </div>
      )}
      {!loading && error && <ErrorBox message={error} />}
      {!loading && !error && commits.length === 0 && (
        <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '16px 4px', lineHeight: 1.5 }}>
          이 ref 에서 커밋을 찾지 못했습니다.
        </div>
      )}
      {!loading && !error && commits.length > 0 && (
        <>
          <div
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              overflow: 'hidden',
            }}
          >
            {commits.map((c, idx) => (
              <button
                key={c.sha}
                type="button"
                onClick={() => openCommit(c.sha)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '9px 12px',
                  border: 'none',
                  borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: MONO,
                    color: tokens.colors.accentSubtle,
                    flexShrink: 0,
                  }}
                  title={c.sha}
                >
                  {c.short_sha}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    color: tokens.colors.textStrong,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={c.subject}
                >
                  {c.subject || '(빈 커밋 메시지)'}
                </span>
                <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }} title={c.author_email}>
                  {c.author_name}
                </span>
                <span
                  style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}
                  title={c.committed_at}
                >
                  {relativeTime(c.committed_at || c.authored_at)}
                </span>
              </button>
            ))}
          </div>
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <Button variant="secondary" size="sm" onClick={loadOlder} disabled={loadingMore} loading={loadingMore}>
                이전 커밋 더 보기
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 커밋 상세 본문 ─────────────────────────────────────────
function CommitDetailView({ detail }: { detail: RepoCommitDetail }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: tokens.colors.textPrimary,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {detail.subject || '(빈 커밋 메시지)'}
        </div>
        {detail.body && detail.body.trim() && (
          <pre
            style={{
              margin: '8px 0 0',
              fontSize: 12,
              fontFamily: MONO,
              color: tokens.colors.textSecondary,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
            }}
          >
            {detail.body.trim()}
          </pre>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, fontFamily: MONO, color: tokens.colors.accentSubtle }} title={detail.sha}>
            {detail.short_sha}
          </span>
          <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
            {detail.author_name} · {relativeTime(detail.committed_at || detail.authored_at)}
          </span>
          {detail.parents.length > 1 && <Badge variant="neutral">merge</Badge>}
        </div>
      </div>

      {detail.files.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
            {detail.files.length} files changed
          </div>
          <div
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              overflow: 'hidden',
            }}
          >
            {detail.files.map((f, idx) => (
              <div
                key={f.path + idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontFamily: MONO,
                    color: tokens.colors.textStrong,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                >
                  {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                </span>
                {f.binary ? (
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted, flexShrink: 0 }}>binary</span>
                ) : (
                  <span style={{ fontSize: 11, flexShrink: 0, fontFamily: MONO }}>
                    <span style={{ color: tokens.colors.success }}>+{f.additions}</span>{' '}
                    <span style={{ color: tokens.colors.danger }}>−{f.deletions}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <DiffView diff={detail.diff} truncated={detail.diff_truncated} />
    </div>
  );
}

// 라인 단위 색칠 unified diff 뷰. 대용량 패치는 서버에서 잘려오고 truncated 표시.
function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  if (!diff || !diff.trim()) {
    return (
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: '8px 0' }}>
        표시할 diff 가 없습니다 (바이너리 변경이거나 변경 내용이 없습니다).
      </div>
    );
  }
  const lines = diff.split('\n');
  return (
    <div>
      <pre
        data-testid="repo-commit-diff"
        style={{
          margin: 0,
          fontSize: 12,
          fontFamily: MONO,
          background: tokens.colors.surface,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          padding: 0,
          maxHeight: 480,
          overflow: 'auto',
          lineHeight: 1.5,
        }}
      >
        {lines.map((line, i) => {
          let color: string = tokens.colors.textStrong;
          let bg: string = 'transparent';
          if (line.startsWith('+') && !line.startsWith('+++')) { color = tokens.colors.success; bg = `${tokens.colors.success}12`; }
          else if (line.startsWith('-') && !line.startsWith('---')) { color = tokens.colors.danger; bg = `${tokens.colors.danger}12`; }
          else if (line.startsWith('@@')) { color = tokens.colors.accentSubtle; }
          else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) { color = tokens.colors.textMuted; }
          return (
            <div
              key={i}
              style={{ color, background: bg, padding: '0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {line || ' '}
            </div>
          );
        })}
      </pre>
      {truncated && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
          diff 가 너무 커서 일부만 표시했습니다.
        </div>
      )}
    </div>
  );
}

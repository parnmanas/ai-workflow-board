import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../api';
import type { Resource, Credential, RepoBranch } from '../../types';
import { tokens } from '../../tokens';
import { Button, Badge, Input } from '../common';
import { relativeTime } from '../../utils/time';

// 우측 detail 패널. master/detail 레이아웃에서 리스트의 선택 항목을 받아
// repository(브랜치 탭 포함)와 그 외 타입(미리보기/메타)을 통일된 UI 로 보여준다.
// branches 외의 무거운 git 읽기(history/diff/file tree)는 서버에 로컬 클론이
// 없어 불가 → #2 로 분리. 여기서는 placeholder("준비중")만 잡아둔다.

interface ResourceDetailPanelProps {
  resource: Resource;
  credentials: Credential[];
  workspaceId: string;
  onEdit: (r: Resource) => void;
  onDelete: (r: Resource) => void;
  // 이미지/비디오는 라이트박스, 파일은 새 탭/다운로드 — ResourceManager 의
  // openResourceFile 을 그대로 위임받아 카드 시절 동작을 유지한다.
  onPreview: (r: Resource) => void;
  // 좁은 폭 오버레이일 때만 노출되는 닫기 버튼 핸들러.
  onClose?: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type RepoTab = 'branches' | 'history' | 'files';

const LABEL_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: tokens.typography.fontWeightSemibold,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

function typeBadgeLabel(type: string): string {
  const map: Record<string, string> = {
    repository: 'Repository',
    document: 'Document',
    image: 'Image',
    link: 'Link',
    comment_attachment: 'Comment Attachment',
  };
  return map[type] || type;
}

// base64 페이로드의 대략적인 바이트 크기(패딩 무시한 근사치).
function approxBytes(base64: string): number {
  if (!base64) return 0;
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export default function ResourceDetailPanel({
  resource,
  credentials,
  workspaceId,
  onEdit,
  onDelete,
  onPreview,
  onClose,
  showToast,
}: ResourceDetailPanelProps) {
  const isRepo = resource.type === 'repository';
  const [repoTab, setRepoTab] = useState<RepoTab>('branches');

  // Branches 탭 상태 — resource.id 가 바뀔 때마다 재조회.
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [branchQuery, setBranchQuery] = useState('');

  const linkedCredential = useMemo(
    () => credentials.find((c) => c.id === resource.credential_id) || null,
    [credentials, resource.credential_id],
  );

  const loadBranches = useCallback(async () => {
    if (!isRepo) return;
    setBranchLoading(true);
    setBranchError(null);
    try {
      const result = await api.listRepoBranches(resource.id, workspaceId);
      setBranches(result.branches);
    } catch (err: any) {
      setBranchError(err?.message || 'Failed to list branches');
      setBranches(null);
    } finally {
      setBranchLoading(false);
    }
  }, [isRepo, resource.id, workspaceId]);

  // 패널은 호출 측에서 resource.id 를 key 로 받아 선택 변경 시 remount 된다
  // (ResourceManager). 따라서 탭/검색/브랜치 상태 초기화는 useState 초깃값으로
  // 충분하고, 이전 리소스의 늦은 브랜치 조회가 새 리소스 위에 stale 데이터를
  // 덮어쓰는 경쟁도 구조적으로 사라진다 — 여기선 마운트 시 1회만 조회한다.
  useEffect(() => {
    if (isRepo) loadBranches();
  }, [isRepo, loadBranches]);

  const copyUrl = async () => {
    if (!resource.url) return;
    try {
      await navigator.clipboard.writeText(resource.url);
      showToast('URL을 복사했습니다.', 'success');
    } catch {
      showToast('복사에 실패했습니다.', 'error');
    }
  };

  const defaultBranch = (resource.default_branch || '').trim();
  const filteredBranches = useMemo(() => {
    if (!branches) return [];
    const q = branchQuery.trim().toLowerCase();
    const list = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
    // 기본 브랜치를 항상 맨 위로 핀 고정.
    return [...list].sort((a, b) => {
      const ad = a.name === defaultBranch ? 0 : 1;
      const bd = b.name === defaultBranch ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  }, [branches, branchQuery, defaultBranch]);

  // ── 공통 헤더 ────────────────────────────────────────────
  const header = (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {resource.name}
            </h2>
            <Badge variant="neutral">{typeBadgeLabel(resource.type)}</Badge>
            {isRepo && defaultBranch && (
              <Badge variant="info">default: {defaultBranch}</Badge>
            )}
          </div>
          {resource.description && (
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginTop: 4, lineHeight: 1.4 }}>
              {resource.description}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {onClose && (
            <Button variant="secondary" size="sm" onClick={onClose}>← 목록</Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => onEdit(resource)}>Edit</Button>
          <Button variant="danger" size="sm" onClick={() => onDelete(resource)}>Delete</Button>
        </div>
      </div>

      {/* git URL — 복사 버튼 포함 */}
      {resource.url && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            background: tokens.colors.surface,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            padding: '6px 10px',
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              color: tokens.colors.accentSubtle,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={resource.url}
          >
            {resource.url}
          </span>
          <Button variant="secondary" size="sm" onClick={copyUrl}>복사</Button>
          {!isRepo && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(resource.url, '_blank', 'noopener,noreferrer')}
            >
              열기
            </Button>
          )}
        </div>
      )}

      {/* 메타 행 */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 12 }}>
        {isRepo && (
          <div>
            <div style={LABEL_STYLE}>Credential</div>
            <div style={{ fontSize: 13, color: tokens.colors.textStrong, marginTop: 2 }}>
              {linkedCredential ? (
                <Badge variant="success" dot>{linkedCredential.name}</Badge>
              ) : (
                <span style={{ color: tokens.colors.textMuted }}>연결 안 됨</span>
              )}
            </div>
          </div>
        )}
        <div>
          <div style={LABEL_STYLE}>Created</div>
          <div style={{ fontSize: 13, color: tokens.colors.textStrong, marginTop: 2 }}>
            {relativeTime(resource.created_at)}
          </div>
        </div>
        <div>
          <div style={LABEL_STYLE}>Updated</div>
          <div style={{ fontSize: 13, color: tokens.colors.textStrong, marginTop: 2 }}>
            {relativeTime(resource.updated_at || resource.created_at)}
          </div>
        </div>
      </div>

      {resource.tags && resource.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 12 }}>
          {resource.tags.map((tag, i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: tokens.radii.sm,
                background: `${tokens.colors.border}80`,
                color: tokens.colors.textSecondary,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  // ── repository: 탭 ───────────────────────────────────────
  const tabBar = (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${tokens.colors.border}`, marginBottom: 14 }}>
      {([
        { key: 'branches', label: 'Branches' },
        { key: 'history', label: 'History' },
        { key: 'files', label: 'Files' },
      ] as { key: RepoTab; label: string }[]).map((t) => {
        const active = repoTab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setRepoTab(t.key)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${active ? tokens.colors.accent : 'transparent'}`,
              color: active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
              fontSize: 13,
              fontWeight: active ? 700 : 500,
              padding: '8px 12px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );

  const branchesTab = (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <Input
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
            placeholder="브랜치 검색…"
          />
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={loadBranches}
          disabled={branchLoading}
          loading={branchLoading}
        >
          새로고침
        </Button>
      </div>

      {branchLoading && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
          브랜치 불러오는 중…
        </div>
      )}

      {!branchLoading && branchError && (
        <div
          data-testid="resource-detail-branch-error"
          style={{
            fontSize: 12,
            color: tokens.colors.danger,
            background: `${tokens.colors.danger}14`,
            border: `1px solid ${tokens.colors.danger}40`,
            borderRadius: tokens.radii.md,
            padding: '10px 12px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          브랜치를 불러오지 못했습니다: {branchError}
          {'\n'}SSH 전용 URL 은 인증 키(credential)가 필요해 조회가 안 될 수 있습니다.
        </div>
      )}

      {!branchLoading && !branchError && branches && branches.length === 0 && (
        <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '16px 4px', lineHeight: 1.5 }}>
          원격에서 브랜치를 찾지 못했습니다. 빈 저장소이거나, SSH 전용 URL 이라 인증 키가
          필요할 수 있습니다.
        </div>
      )}

      {!branchLoading && !branchError && branches && branches.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
            {filteredBranches.length} / {branches.length} branches
          </div>
          <div
            data-testid="resource-detail-branch-list"
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              overflow: 'hidden',
            }}
          >
            {filteredBranches.length === 0 ? (
              <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '12px' }}>
                "{branchQuery}" 과 일치하는 브랜치가 없습니다.
              </div>
            ) : (
              filteredBranches.map((b, idx) => {
                const isDefault = b.name === defaultBranch;
                return (
                  <div
                    key={b.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
                      background: isDefault ? tokens.colors.surfaceCard : 'transparent',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        flexShrink: 0,
                        background: isDefault ? tokens.colors.success : tokens.colors.border,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        color: tokens.colors.textStrong,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {b.name}
                    </span>
                    {isDefault && <Badge variant="info">default</Badge>}
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        color: tokens.colors.textMuted,
                        flexShrink: 0,
                      }}
                      title={b.sha}
                    >
                      {b.sha.slice(0, 8)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );

  const placeholderTab = (label: string, hint: string) => (
    <div
      style={{
        textAlign: 'center',
        padding: '40px 24px',
        border: `1px dashed ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textSecondary, marginBottom: 6 }}>
        {label} — 준비중
      </div>
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.5 }}>{hint}</div>
    </div>
  );

  // ── non-repository: 미리보기/다운로드 ─────────────────────
  const nonRepoBody = (() => {
    const mime = resource.file_mimetype || '';
    const isImage = mime.startsWith('image/') || (resource.type === 'image' && !!resource.file_data);
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {resource.file_data && isImage && (
          <img
            src={`data:${mime || 'image/png'};base64,${resource.file_data}`}
            alt={resource.name}
            onClick={() => onPreview(resource)}
            title="클릭하여 원본 보기"
            style={{
              maxWidth: '100%',
              maxHeight: 360,
              borderRadius: tokens.radii.md,
              objectFit: 'contain',
              cursor: 'zoom-in',
              alignSelf: 'flex-start',
            }}
          />
        )}
        {resource.file_data && isVideo && (
          <video
            src={`data:${mime};base64,${resource.file_data}`}
            controls
            preload="metadata"
            playsInline
            title={resource.file_name || resource.name}
            style={{ width: '100%', maxHeight: 420, borderRadius: tokens.radii.md, background: '#000' }}
          />
        )}
        {resource.file_data && isAudio && (
          <audio
            src={`data:${mime};base64,${resource.file_data}`}
            controls
            preload="metadata"
            title={resource.file_name || resource.name}
            style={{ width: '100%' }}
          />
        )}

        {/* 문서/링크 텍스트 컨텐츠 */}
        {resource.content && (
          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>Content</div>
            <pre
              style={{
                margin: 0,
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                color: tokens.colors.textStrong,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: 12,
                maxHeight: 320,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.5,
              }}
            >
              {resource.content}
            </pre>
          </div>
        )}

        {/* 첨부 파일 메타 + 다운로드 */}
        {resource.file_name && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '10px 12px',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  color: tokens.colors.textStrong,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {resource.file_name}
              </div>
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
                {mime || 'application/octet-stream'}
                {resource.file_data ? ` · ${formatBytes(approxBytes(resource.file_data))}` : ''}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onPreview(resource)}>
              {isImage || isVideo ? '보기' : '열기 / 다운로드'}
            </Button>
          </div>
        )}

        {!resource.url && !resource.content && !resource.file_data && (
          <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '12px 0' }}>
            표시할 추가 정보가 없습니다.
          </div>
        )}
      </div>
    );
  })();

  return (
    <div data-testid="resource-detail-panel">
      {header}
      {isRepo ? (
        <>
          {tabBar}
          {repoTab === 'branches' && branchesTab}
          {repoTab === 'history' && placeholderTab(
            'History',
            '커밋 히스토리/diff 는 서버에 git 읽기 능력이 추가되는 후속 작업에서 제공됩니다.',
          )}
          {repoTab === 'files' && placeholderTab(
            'Files',
            '파일 트리 탐색은 서버 git 읽기 능력이 추가되는 후속 작업에서 제공됩니다.',
          )}
        </>
      ) : (
        nonRepoBody
      )}
    </div>
  );
}

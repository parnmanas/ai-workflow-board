import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../api';
import type { Resource, Credential, RepoBranch, RepoRefs } from '../../types';
import { tokens } from '../../tokens';
import { Button, Badge, Input } from '../common';
import { relativeTime } from '../../utils/time';
import RepoHistoryTab from './RepoHistoryTab';
import RepoFilesTab from './RepoFilesTab';
import { ErrorBox } from './repoTabCommon';

// 우측 detail 패널. master/detail 레이아웃에서 리스트의 선택 항목을 받아
// repository(브랜치/히스토리/파일 탭 포함)와 그 외 타입(미리보기/메타)을 통일된
// UI 로 보여준다. History/Files 탭의 무거운 git 읽기(log/diff/tree)는 서버의
// per-resource 캐시 클론(git-repo-cache)에서 온다. ref 선택기는 History·Files 가
// 같은 ref 를 따라가도록 두 탭이 공유한다.

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

  // History/Files 공유 ref 선택기 상태. 캐시 클론을 처음 만드는 비용이 있어
  // (clone) 마운트가 아니라 History/Files 탭을 처음 열 때 lazy 로 조회한다.
  const [refs, setRefs] = useState<RepoRefs | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  // ref 조회 실패가 'SSH 전용 URL 미지원'(code 'ssh_unsupported') 때문인지 구분.
  // 그래야 그 안내 문구를 실제 SSH-only 에러일 때만 띄우고, 그 외(예: 시놀로지
  // getrandom/ENOSYS) 는 git stderr 원문만 보여줘 진짜 원인을 가리지 않는다.
  const [refsErrorSshOnly, setRefsErrorSshOnly] = useState(false);
  const [selectedRef, setSelectedRef] = useState('');

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

  const loadRefs = useCallback(async (refresh = false) => {
    if (!isRepo) return;
    setRefsLoading(true);
    setRefsError(null);
    setRefsErrorSshOnly(false);
    try {
      const result = await api.getRepoRefs(resource.id, workspaceId, refresh);
      setRefs(result);
      // 기본 선택 = 원격 HEAD, 없으면 첫 브랜치, 그것도 없으면 빈 값(서버가 HEAD).
      setSelectedRef((prev) => prev || result.head || result.branches[0] || '');
    } catch (err: any) {
      setRefsError(err?.message || 'ref 목록을 불러오지 못했습니다.');
      setRefsErrorSshOnly(err?.code === 'ssh_unsupported');
      setRefs(null);
    } finally {
      setRefsLoading(false);
    }
  }, [isRepo, resource.id, workspaceId]);

  // History/Files 탭을 처음 열 때만 캐시 클론을 만들고 ref 를 조회한다.
  useEffect(() => {
    if (!isRepo) return;
    if ((repoTab === 'history' || repoTab === 'files') && !refs && !refsLoading && !refsError) {
      loadRefs();
    }
  }, [isRepo, repoTab, refs, refsLoading, refsError, loadRefs]);

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
          {/^(ssh:\/\/|git@)/i.test(resource.url || '') && (
            <>{'\n'}SSH 전용 URL은 서버 측 SSH 키가 필요합니다. HTTPS URL + credential을 사용해 주세요.</>
          )}
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

  // History/Files 가 공유하는 ref 선택기 + 새로고침. 선택이 바뀌면 두 탭이 같은
  // ref 를 따라가도록 selectedRef 한 곳만 갱신한다. (이전의 placeholderTab 은
  // 실제 탭 구현으로 대체되어 제거됨.)
  const refSelectorBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <select
        data-testid="repo-ref-select"
        value={selectedRef}
        onChange={(e) => setSelectedRef(e.target.value)}
        disabled={refsLoading || !refs}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontFamily: 'inherit',
          padding: '7px 10px',
          borderRadius: tokens.radii.md,
          border: `1px solid ${tokens.colors.border}`,
          background: tokens.colors.surface,
          color: tokens.colors.textStrong,
        }}
      >
        {refs && refs.branches.length > 0 && (
          <optgroup label="Branches">
            {refs.branches.map((b) => (
              <option key={`b/${b}`} value={b}>{b}</option>
            ))}
          </optgroup>
        )}
        {refs && refs.tags.length > 0 && (
          <optgroup label="Tags">
            {refs.tags.map((t) => (
              <option key={`t/${t}`} value={t}>{t}</option>
            ))}
          </optgroup>
        )}
        {(!refs || (refs.branches.length === 0 && refs.tags.length === 0)) && (
          <option value="">{refsLoading ? '불러오는 중…' : 'HEAD'}</option>
        )}
      </select>
      <Button
        variant="secondary"
        size="md"
        onClick={() => loadRefs(true)}
        disabled={refsLoading}
        loading={refsLoading}
      >
        새로고침
      </Button>
    </div>
  );

  // History/Files 탭 공통 래퍼 — ref 로딩/에러를 먼저 처리하고, 준비되면 본문 탭을
  // 렌더한다. ref 조회는 캐시 클론 생성을 트리거하므로 에러(예: SSH-only)도 여기서
  // 한 번에 노출된다.
  const gitReadTab = (body: React.ReactNode) => {
    if (refsLoading && !refs) {
      return (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
          저장소 캐시 준비 중… (최초 1회 클론이 필요해 시간이 걸릴 수 있습니다)
        </div>
      );
    }
    if (refsError) {
      return (
        <div>
          <ErrorBox message={refsError} />
          {/* SSH-only 안내는 실제 code 가 'ssh_unsupported' 일 때만. 그 외(타임아웃,
              ENOSYS 등 git stderr)는 ErrorBox 의 원문만으로 진짜 원인을 보여준다. */}
          {refsErrorSshOnly && (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8, lineHeight: 1.5 }}>
              SSH 전용 URL 은 서버에 인증 키가 없어 지원되지 않습니다. HTTPS URL + credential 로
              연결된 저장소만 히스토리/파일 조회가 가능합니다.
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <Button variant="secondary" size="sm" onClick={() => loadRefs(true)} loading={refsLoading}>
              다시 시도
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div>
        {refSelectorBar}
        {body}
      </div>
    );
  };

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
          {repoTab === 'history' && gitReadTab(
            <RepoHistoryTab resourceId={resource.id} workspaceId={workspaceId} refKey={selectedRef} />,
          )}
          {repoTab === 'files' && gitReadTab(
            <RepoFilesTab resourceId={resource.id} workspaceId={workspaceId} refKey={selectedRef} />,
          )}
        </>
      ) : (
        nonRepoBody
      )}
    </div>
  );
}

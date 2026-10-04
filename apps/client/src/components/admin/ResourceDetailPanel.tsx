import React, { useMemo } from 'react';
import type { Resource, Credential } from '../../types';
import { tokens } from '../../tokens';
import { Button, Badge } from '../common';
import { relativeTime } from '../../utils/time';

// 우측 detail 패널. master/detail 레이아웃에서 리스트의 선택 항목(문서/이미지/
// 링크)을 미리보기·메타와 함께 보여준다. Git 저장소의 브랜치/히스토리/파일 탭은
// Projects 화면(components/projects/ProjectRepoTabs)으로 옮겨갔다.

interface ResourceDetailPanelProps {
  resource: Resource;
  credentials: Credential[];
  onEdit: (r: Resource) => void;
  onDelete: (r: Resource) => void;
  canManage?: boolean;
  // 이미지/비디오는 라이트박스, 파일은 새 탭/다운로드 — ResourceManager 의
  // openResourceFile 을 그대로 위임받아 카드 시절 동작을 유지한다.
  onPreview: (r: Resource) => void;
  // 좁은 폭 오버레이일 때만 노출되는 닫기 버튼 핸들러.
  onClose?: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: tokens.typography.fontWeightSemibold,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

function typeBadgeLabel(type: string): string {
  const map: Record<string, string> = {
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
  onEdit,
  onDelete,
  canManage = true,
  onPreview,
  onClose,
  showToast,
}: ResourceDetailPanelProps) {
  const linkedCredential = useMemo(
    () => credentials.find((c) => c.id === resource.credential_id) || null,
    [credentials, resource.credential_id],
  );

  const copyUrl = async () => {
    if (!resource.url) return;
    try {
      await navigator.clipboard.writeText(resource.url);
      showToast('URL을 복사했습니다.', 'success');
    } catch {
      showToast('복사에 실패했습니다.', 'error');
    }
  };

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
          {canManage ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => onEdit(resource)}>Edit</Button>
              <Button variant="danger" size="sm" onClick={() => onDelete(resource)}>Delete</Button>
            </>
          ) : (
            <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Inherited (read-only)</span>
          )}
        </div>
      </div>

      {/* URL — 복사/열기 버튼 포함 */}
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(resource.url, '_blank', 'noopener,noreferrer')}
          >
            열기
          </Button>
        </div>
      )}

      {/* 메타 행 */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 12 }}>
        {linkedCredential && (
          <div>
            <div style={LABEL_STYLE}>Credential</div>
            <div style={{ fontSize: 13, color: tokens.colors.textStrong, marginTop: 2 }}>
              <Badge variant="success" dot>{linkedCredential.name}</Badge>
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

  // ── 미리보기/다운로드 ─────────────────────
  const body = (() => {
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
      {body}
    </div>
  );
}

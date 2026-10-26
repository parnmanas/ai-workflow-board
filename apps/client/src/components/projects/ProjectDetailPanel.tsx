import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import type { Credential, Project } from '../../types';
import { tokens } from '../../tokens';
import { Badge, Button } from '../common';
import { relativeTime } from '../../utils/time';
import ProjectForm from './ProjectForm';
import ProjectHostFolders from './ProjectHostFolders';
import ProjectRepoTabs, { type ProjectRepoTab } from './ProjectRepoTabs';

// 우측 detail 패널 — 선택된 프로젝트(또는 새 프로젝트 초안)를 탭으로 보여준다.
// 호출 측(ProjectsPage)이 project id 를 key 로 넘겨 선택이 바뀌면 remount 되므로
// 폼 초안·브랜치 조회 같은 in-flight 상태가 다른 프로젝트로 새지 않는다.

type DetailTab = 'settings' | 'folders' | ProjectRepoTab;

const TABS: Array<{ key: DetailTab; label: string; needsSaved: boolean }> = [
  { key: 'settings', get label() { return translate('설정'); }, needsSaved: false },
  { key: 'folders', get label() { return translate('Host 폴더'); }, needsSaved: true },
  { key: 'branches', get label() { return translate('Branches'); }, needsSaved: true },
  { key: 'history', get label() { return translate('History'); }, needsSaved: true },
  { key: 'files', get label() { return translate('Files'); }, needsSaved: true },
];

interface ProjectDetailPanelProps {
  /** null = new project draft. */
  project: Project | null;
  accountId: string;
  credentials: Credential[];
  hosts: Array<{ id: string; name: string }>;
  hostsLoading: boolean;
  onSaved(project: Project, created: boolean): void;
  onDelete(project: Project): void;
  onCancelNew(): void;
  /** Narrow-layout overlay only. */
  onClose?: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export default function ProjectDetailPanel({
  project,
  accountId,
  credentials,
  hosts,
  hostsLoading,
  onSaved,
  onDelete,
  onCancelNew,
  onClose,
  showToast,
}: ProjectDetailPanelProps) {
  useLocale();
  const [tab, setTab] = useState<DetailTab>('settings');
  const folderCount = (project?.host_folders || []).filter((f) => (f.path || '').trim()).length;

  return (
    <div data-testid="project-detail-panel">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {project ? project.name : translate('새 프로젝트')}
            </h2>
            {project?.default_branch && <Badge variant="info">{translate('default:')} {project.default_branch}</Badge>}
            {project?.use_pr && <Badge variant="neutral">{translate('PR')}</Badge>}
            {project && <Badge variant={folderCount ? 'success' : 'neutral'}>{translate('Host 폴더')} {folderCount}</Badge>}
          </div>
          {project?.repo_url && (
            <div
              title={project.repo_url}
              style={{
                fontSize: 12, marginTop: 4, color: tokens.colors.accentSubtle,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {project.repo_url}
            </div>
          )}
          {project && (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4 }}>
              {translate('수정')} {relativeTime(project.updated_at || project.created_at)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {onClose && <Button variant="secondary" size="sm" onClick={onClose}>{translate('← 목록')}</Button>}
          {project && <Button variant="danger" size="sm" onClick={() => onDelete(project)}>{translate('삭제')}</Button>}
        </div>
      </div>

      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${tokens.colors.border}`, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.filter((t) => project || !t.needsSaved).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
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

      {/* 폼은 다른 탭으로 가도 언마운트하지 않는다 — 저장 안 한 편집이 탭 전환에 날아가지 않게. */}
      <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
        <ProjectForm
          project={project}
          accountId={accountId}
          credentials={credentials}
          hosts={hosts}
          onSaved={onSaved}
          onCancel={project ? undefined : onCancelNew}
          showToast={showToast}
        />
      </div>
      {!project && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 12 }}>
          {translate('Host 폴더와 브랜치/히스토리/파일 탭은 프로젝트를 만든 뒤 쓸 수 있습니다.')}</div>
      )}
      {project && tab === 'folders' && (
        <ProjectHostFolders
          project={project}
          hosts={hosts}
          hostsLoading={hostsLoading}
          onSaved={(p) => onSaved(p, false)}
          showToast={showToast}
        />
      )}
      {project && (tab === 'branches' || tab === 'history' || tab === 'files') && (
        <ProjectRepoTabs project={project} accountId={accountId} tab={tab} />
      )}
    </div>
  );
}

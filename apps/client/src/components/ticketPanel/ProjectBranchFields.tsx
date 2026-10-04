import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { Project, RepoBranch, TicketProjectSummary } from '../../types';

interface ProjectBranchFieldsProps {
  projects: Project[];
  projectsLoading: boolean;
  /** '' = no project. */
  projectId: string;
  /** '' = the project's default branch. */
  baseBranch: string;
  /** Server-hydrated summary of the SAVED project — names it while the list loads or when it is gone. */
  savedProject?: TicketProjectSummary | null;
  onProjectChange(id: string): void;
  onBranchChange(branch: string): void;
  labelStyle: React.CSSProperties;
  disabled?: boolean;
}

const fieldStyle: React.CSSProperties = {
  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
  padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%', boxSizing: 'border-box',
};

/**
 * Project + base branch pickers (docs/tickets.md → project_id / base_branch).
 * Branches come from `GET /projects/:id/branches` (git ls-remote, can take a
 * few seconds). When that fails or returns nothing the branch becomes a free
 * text field so a branch name can still be pinned — the error stays visible.
 */
export default function ProjectBranchFields({
  projects, projectsLoading, projectId, baseBranch, savedProject,
  onProjectChange, onBranchChange, labelStyle, disabled,
}: ProjectBranchFieldsProps) {
  const [branches, setBranches] = useState<RepoBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBranches([]);
    setDefaultBranch('');
    setError(null);
    if (!projectId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.listProjectBranches(projectId)
      .then(res => {
        if (cancelled) return;
        setBranches(res?.branches || []);
        setDefaultBranch(res?.default_branch || '');
      })
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to list branches'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const selected = projects.find(p => p.id === projectId) || null;
  const knownDefault = defaultBranch || selected?.default_branch
    || (savedProject?.id === projectId ? savedProject?.default_branch : '') || 'origin/HEAD';
  const defaultLabel = `project default (${knownDefault})`;
  const freeText = !!projectId && !loading && (!!error || branches.length === 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
      <div>
        <label style={labelStyle}>Project{projectsLoading ? ' · loading…' : ''}</label>
        <select
          value={projectId}
          disabled={disabled}
          onChange={e => onProjectChange(e.target.value)}
          style={{ ...fieldStyle, cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          <option value="">— 없음 —</option>
          {/* The saved project may be missing from the list (still loading,
              deleted, or not visible) — keep it selectable by name. */}
          {projectId && !selected && (
            <option value={projectId}>
              {savedProject?.id === projectId ? savedProject.name : (projectsLoading ? '…' : '(알 수 없는 프로젝트)')}
            </option>
          )}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Base Branch{projectId && loading ? ' · loading…' : ''}</label>
        {freeText ? (
          <input
            value={baseBranch}
            disabled={disabled}
            onChange={e => onBranchChange(e.target.value.trim())}
            placeholder={defaultLabel}
            style={fieldStyle}
          />
        ) : (
          <select
            value={baseBranch}
            disabled={disabled || !projectId || loading}
            onChange={e => onBranchChange(e.target.value)}
            style={{ ...fieldStyle, cursor: disabled || !projectId || loading ? 'not-allowed' : 'pointer' }}
          >
            <option value="">{projectId ? defaultLabel : '— Select project first —'}</option>
            {/* A pinned branch may be gone upstream or the list still loading —
                show it anyway so the picker reflects the persisted value. */}
            {baseBranch && !branches.some(b => b.name === baseBranch) && (
              <option value={baseBranch}>{baseBranch}</option>
            )}
            {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        )}
        {error && (
          <div style={{ fontSize: '10px', color: tokens.colors.dangerLight, marginTop: 4 }}>
            {error} — 브랜치 이름을 직접 입력할 수 있습니다
          </div>
        )}
      </div>
    </div>
  );
}

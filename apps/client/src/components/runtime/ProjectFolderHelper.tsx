import React, { useMemo } from 'react';
import { getActiveAccountId } from '../../api';
import type { Project } from '../../types';
import { tokens } from '../../tokens';
import { Select } from '../common';
import { useProjects } from '../../projects/useProjects';
import { projectFolderHelperView } from '../../projects/projectFolderHelper.logic';

interface ProjectFolderHelperProps {
  /** Account whose projects are offered. Falls back to the active workspace. */
  accountId?: string;
  /**
   * The currently selected Runtime Host — one id, or the ids that name the same
   * host (Host id + legacy manager Agent uuid). Empty → the control is disabled.
   */
  hostIds: string | null | undefined | ReadonlyArray<string | null | undefined>;
  /** The spec's current working_dir (marks the project already in use). */
  currentDir?: string;
  /** Called with the project's main clone folder on that host. */
  onPick(path: string, project: Project): void;
  disabled?: boolean;
}

/**
 * "Use project folder" — fills a runtime's working_dir with a project's main
 * clone folder on the selected host (docs/tickets.md → "Main clone folder per
 * host"). Shared by RuntimeSpecEditor (tickets, a project's default assignee,
 * every DeclareRuntimeSection) and the orchestration team-slot editor, so the
 * rule lives once. Renders nothing while the workspace has no projects.
 */
export default function ProjectFolderHelper({
  accountId,
  hostIds,
  currentDir = '',
  onPick,
  disabled = false,
}: ProjectFolderHelperProps) {
  const wsId = accountId || getActiveAccountId() || '';
  const { projects } = useProjects(wsId);
  const view = useMemo(
    () => projectFolderHelperView(projects, hostIds, currentDir),
    [projects, hostIds, currentDir],
  );

  if (!projects.length) return null;

  return (
    <div data-testid="project-folder-helper" style={{ marginTop: 6 }}>
      <Select
        aria-label="프로젝트 폴더 사용"
        value=""
        disabled={disabled || view.disabled}
        options={view.options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled }))}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const id = e.target.value;
          const option = view.options.find((o) => o.value === id);
          const project = projects.find((p) => p.id === id);
          if (option?.path && project) onPick(option.path, project);
        }}
      />
      {view.hint && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4 }}>{view.hint}</div>
      )}
    </div>
  );
}

// Project ↔ Runtime Host folder helpers (docs/tickets.md → "Main clone folder
// per host"). A project has at most one main clone folder per Runtime Host; the
// ticket form, the project's default assignee and orchestration team slots all
// offer "use the project's folder on this host" as the spec's working_dir, so
// agents on different hosts never guess where the project lives.
// React-free — `test/project-host-folder-prefill.test.mjs` imports it directly.

import { emptyRuntimeSpec, type RuntimeSpecDraft } from '../runtime/runtimeSpec';

export interface ProjectFolderSource {
  id: string;
  name?: string;
  host_folders?: Array<{ host_id: string; path: string }> | null;
  default_assignee?: Partial<RuntimeSpecDraft> | null;
}

/**
 * The project's main clone folder on a host, or null when it has none there.
 * `hostId` may be a list of ids for the same host (Host id + its legacy manager
 * Agent uuid alias — see OrchestrationRuntimeHost.legacy_agent_id).
 */
export function projectFolderForHost(
  project: ProjectFolderSource | null | undefined,
  hostId: string | null | undefined | ReadonlyArray<string | null | undefined>,
): string | null {
  if (!project) return null;
  const ids = (Array.isArray(hostId) ? hostId : [hostId]).filter((v): v is string => !!v);
  if (!ids.length) return null;
  const row = (project.host_folders || []).find((f) => ids.includes(f.host_id));
  const path = (row?.path || '').trim();
  return path || null;
}

/**
 * Fill `spec.working_dir` with the project's folder on the spec's host.
 *
 * Only fills an EMPTY working_dir unless `force` — a folder the operator typed
 * is never overwritten behind their back. Returns the same object when nothing
 * changes so callers can skip a state update.
 */
export function applyProjectFolder<T extends Pick<RuntimeSpecDraft, 'manager_agent_id' | 'working_dir'>>(
  spec: T,
  project: ProjectFolderSource | null | undefined,
  opts: { force?: boolean } = {},
): T {
  const folder = projectFolderForHost(project, spec.manager_agent_id);
  if (!folder) return spec;
  if (!opts.force && (spec.working_dir || '').trim()) return spec;
  if (spec.working_dir === folder) return spec;
  return { ...spec, working_dir: folder };
}

/**
 * Assignee to prefill when a project is picked on a NEW ticket.
 *
 * - The user already chose an assignee (`assigneeTouched`) → keep it, only
 *   fill an empty working_dir from the project folder on its host.
 * - Otherwise the project's `default_assignee` (if any) replaces the draft,
 *   and its working_dir is filled from the project folder when it has none.
 * - No default assignee and nothing chosen → the current draft (folder-filled).
 */
export function prefillAssigneeForProject(
  current: RuntimeSpecDraft | null,
  project: ProjectFolderSource | null | undefined,
  opts: { assigneeTouched: boolean },
): RuntimeSpecDraft | null {
  if (!project) return current;
  if (!opts.assigneeTouched && project.default_assignee) {
    const empty = emptyRuntimeSpec();
    const base: RuntimeSpecDraft = {
      ...empty,
      ...(project.default_assignee as Partial<RuntimeSpecDraft>),
      runtime_config: { ...(project.default_assignee.runtime_config || empty.runtime_config) },
    };
    return applyProjectFolder(base, project);
  }
  return current ? applyProjectFolder(current, project) : current;
}

/** One row per project for the "use project folder" picker on a given host. */
export function projectFolderChoices(
  projects: ProjectFolderSource[],
  hostId: string | null | undefined,
): Array<{ id: string; name: string; path: string | null }> {
  return projects.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    path: projectFolderForHost(p, hostId),
  }));
}

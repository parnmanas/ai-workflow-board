/**
 * A mission's Projects — where its work happens (docs/tickets.md → "Main clone
 * folder per host").
 *
 * A team is reused across missions, so the folder a member works in cannot
 * belong to the team; it comes from the mission. A mission names one or more
 * Projects (`OrchestrationMission.projects`, primary first). Every Runtime Host
 * keeps its own main clone of a project (ProjectHostFolder), at a path that
 * differs from machine to machine — so a slot's working folder for a project is
 * "that project's folder on the slot's host", and a host with no folder
 * registered cannot work on that project at all (the mission says so instead
 * of guessing a path).
 *
 * Lookups happen here, in the services; the renderers in orchestration-prompt.ts
 * stay pure and receive the folder strings as data.
 */

import type { OrchestrationMission } from '../../entities/OrchestrationMission';
import type { ProjectsService } from '../projects/projects.service';
import { normalizeRepoRef } from '../../common/workspace-folder-options';
import { orchestrationError } from './orchestration-errors';

/** One project as a mission stores it. `branch` '' = the project's default branch. */
export interface MissionProjectRef {
  project_id: string;
  branch: string;
}

/** Cap on projects per mission — a brief listing more cannot be planned from. */
export const MAX_MISSION_PROJECTS = 10;

export interface MissionProject {
  id: string;
  name: string;
  repo_url: string;
  /** Branch the mission works from: the mission's pick → the project's default_branch → '' (remote HEAD). */
  branch: string;
  instructions: string;
  /** Runtime Host id → that host's main clone folder (absolute path on the host). */
  host_folders: Map<string, string>;
}

/**
 * Normalize loose REST/MCP input into the stored list: `[{ project_id, branch? }]`
 * or a bare id string per entry. Order is kept (the first entry is the primary
 * project); duplicates are rejected rather than merged, because two entries for
 * one project with different branches would leave it ambiguous which branch
 * the mission works from.
 */
export function normalizeMissionProjects(input: unknown): MissionProjectRef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw orchestrationError(400, 'projects must be an array of { project_id, branch? }');
  if (input.length > MAX_MISSION_PROJECTS) {
    throw orchestrationError(400, `a mission can name at most ${MAX_MISSION_PROJECTS} projects`);
  }
  const out: MissionProjectRef[] = [];
  const seen = new Set<string>();
  input.forEach((entry, i) => {
    const raw = typeof entry === 'string' ? { project_id: entry } : entry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw orchestrationError(400, `projects[${i}]: { project_id, branch? } is required`);
    }
    const projectId = str((raw as any).project_id ?? (raw as any).id);
    if (!projectId) throw orchestrationError(400, `projects[${i}]: project_id is required`);
    if (seen.has(projectId)) throw orchestrationError(400, `projects[${i}]: project ${projectId} is listed twice`);
    seen.add(projectId);
    out.push({ project_id: projectId, branch: str((raw as any).branch) });
  });
  return out;
}

/**
 * The mission's projects as stored. A mission written before missions held a
 * list names its one project through `repo_ref.project_id` — read that as a
 * one-entry list so legacy rows keep working without a data migration.
 */
export function readMissionProjects(mission: Pick<OrchestrationMission, 'projects' | 'repo_ref'>): MissionProjectRef[] {
  let stored: unknown = (mission as any)?.projects;
  if (typeof stored === 'string') {
    try {
      stored = JSON.parse(stored);
    } catch {
      stored = null;
    }
  }
  if (Array.isArray(stored) && stored.length > 0) {
    return stored
      .map((p) => ({ project_id: str((p as any)?.project_id), branch: str((p as any)?.branch) }))
      .filter((p) => p.project_id);
  }
  const ref = normalizeRepoRef((mission as any)?.repo_ref);
  return ref?.project_id ? [{ project_id: ref.project_id, branch: ref.branch || '' }] : [];
}

/**
 * Load every project the mission names, in order. A project id that does not
 * resolve inside the mission's account is reported in `missing` — the caller
 * decides whether that blocks (starting a mission) or only drops a prompt line
 * (re-reading a work order).
 */
export async function loadMissionProjects(
  projects: ProjectsService,
  mission: Pick<OrchestrationMission, 'account_id' | 'projects' | 'repo_ref'>,
): Promise<{ loaded: MissionProject[]; missing: string[] }> {
  const loaded: MissionProject[] = [];
  const missing: string[] = [];
  for (const ref of readMissionProjects(mission)) {
    const project = await projects.getInAccount(ref.project_id, mission.account_id);
    if (!project) {
      missing.push(ref.project_id);
      continue;
    }
    loaded.push({
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      branch: ref.branch || project.default_branch || '',
      instructions: project.instructions || '',
      host_folders: await projects.hostFolders(project.id),
    });
  }
  return { loaded, missing };
}

/**
 * The project's main clone folder on a slot's host, or null when that host has
 * none registered. `hostId` is the slot spec's `manager_agent_id`.
 */
export function projectFolderForHost(project: MissionProject, hostId: string | null | undefined): string | null {
  if (!hostId) return null;
  return project.host_folders.get(hostId) ?? null;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

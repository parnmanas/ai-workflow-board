/**
 * The mission's Project, as the orchestration prompts need it
 * (docs/tickets.md → "Main clone folder per host").
 *
 * A mission names its project through `repo_ref.project_id`. Every Runtime Host
 * keeps its own main clone of that project (ProjectHostFolder), at a path that
 * differs from machine to machine — so the planning brief and each step work
 * order state the folder for the host the reader actually runs on, or say
 * plainly that the host has none. A member left to guess picks a path that is
 * right on one machine and wrong (or absent) on the next.
 *
 * Lookups happen here, in the services; the renderers in orchestration-prompt.ts
 * stay pure and receive the folder strings as data.
 */

import type { OrchestrationMission } from '../../entities/OrchestrationMission';
import type { ProjectsService } from '../projects/projects.service';
import { normalizeRepoRef } from '../../common/workspace-folder-options';

export interface MissionProject {
  id: string;
  name: string;
  repo_url: string;
  /** Branch the mission works from: repo_ref.branch → the project's default_branch → '' (remote HEAD). */
  branch: string;
  instructions: string;
  /** Runtime Host id → that host's main clone folder (absolute path on the host). */
  host_folders: Map<string, string>;
}

/**
 * The mission's project, or null when it names none. A project id that does not
 * resolve inside the mission's workspace is treated as "no project" — the same
 * stance `buildRunProvision` takes, so the prompt never describes a repo the
 * provisioner will not check out.
 */
export async function loadMissionProject(
  projects: ProjectsService,
  mission: Pick<OrchestrationMission, 'workspace_id' | 'repo_ref'>,
): Promise<MissionProject | null> {
  const ref = normalizeRepoRef(mission.repo_ref);
  if (!ref?.project_id) return null;
  const project = await projects.getInWorkspace(ref.project_id, mission.workspace_id);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    repo_url: project.repo_url,
    branch: ref.branch || project.default_branch || '',
    instructions: project.instructions || '',
    host_folders: await projects.hostFolders(project.id),
  };
}

/**
 * The project's main clone folder on a slot's host, or null when that host has
 * none registered. `hostId` is the slot spec's `manager_agent_id`, normally a
 * RuntimeHost id; a legacy slot still carrying its manager Agent uuid there
 * finds no folder and is told "none registered" — the safe direction, since the
 * prompt then tells the member not to guess.
 */
export function projectFolderForHost(project: MissionProject, hostId: string | null | undefined): string | null {
  if (!hostId) return null;
  return project.host_folders.get(hostId) ?? null;
}

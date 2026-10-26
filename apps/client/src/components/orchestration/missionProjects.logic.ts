import { t as translate } from '../../i18n/core';
// Mission projects ↔ roster slots (docs/orchestration.md → "미션 프로젝트").
//
// A team names no folders; a mission names Projects, and each slot works in a
// project's folder on its OWN host (ProjectHostFolder). The mission form shows,
// before anything starts, which slot can work on which selected project — and
// refuses to start when one cannot work on any, the same rule the server's
// `resolveMissionRoster` applies (so the operator fixes it in the form instead
// of reading a 409). React-free so `test/mission-projects-logic.test.mjs` can
// import it directly.

import { projectFolderForHost, type ProjectFolderSource } from '../../projects/projectFolders';

/** One selected project as the form edits it. `branch` '' = the project's default branch. */
export interface MissionProjectDraft {
  project_id: string;
  branch: string;
}

/** A slot as the coverage check needs it: a label and the host it runs on. */
export interface CoverageSlot {
  key: string;
  label: string;
  /** The slot's Runtime Host id (plus any alias ids for the same host). */
  host_ids: string[];
}

export interface SlotCoverage {
  slot: CoverageSlot;
  /** One entry per selected project, in selection order: its folder on the slot's host, or null. */
  folders: Array<{ project_id: string; folder: string | null }>;
  /** The slot can work on at least one selected project. */
  workable: boolean;
}

/** Which selected projects each slot can work on (its host has the project's folder). */
export function slotCoverage(
  projects: ProjectFolderSource[],
  selected: MissionProjectDraft[],
  slot: CoverageSlot,
): SlotCoverage {
  const folders = selected.map((p) => ({
    project_id: p.project_id,
    folder: projectFolderForHost(projects.find((x) => x.id === p.project_id) ?? null, slot.host_ids),
  }));
  return { slot, folders, workable: folders.some((f) => !!f.folder) };
}

/**
 * Why the mission cannot start yet, as sentences — empty when it can. Mirrors
 * the server: at least one project; the orchestrator's host needs a folder for
 * one of them (it runs in the first such project); every participating member's
 * host needs a folder for at least one.
 */
export function missionStartProblems(args: {
  projects: ProjectFolderSource[];
  selected: MissionProjectDraft[];
  orchestrator: CoverageSlot | null;
  members: CoverageSlot[];
}): string[] {
  const { projects, selected, orchestrator, members } = args;
  if (selected.length === 0) {
    return [translate('Pick at least one project — members work in its folder on their own host.')];
  }
  const problems: string[] = [];
  if (orchestrator && !slotCoverage(projects, selected, orchestrator).workable) {
    problems.push(translate('The orchestrator ({0}) has no folder for any selected project on its host.', { 0: orchestrator.label }));
  }
  for (const member of members) {
    if (!slotCoverage(projects, selected, member).workable) {
      problems.push(translate('{0} has no folder for any selected project on its host — set one, or leave it out.', { 0: member.label }));
    }
  }
  return problems;
}

/** Add a project at the end (the first one stays primary). No-op when already selected. */
export function addMissionProject(selected: MissionProjectDraft[], projectId: string): MissionProjectDraft[] {
  if (!projectId || selected.some((p) => p.project_id === projectId)) return selected;
  return [...selected, { project_id: projectId, branch: '' }];
}

/** Move a project to the front — the primary project is where the orchestrator runs when its host has it. */
export function makePrimaryProject(selected: MissionProjectDraft[], projectId: string): MissionProjectDraft[] {
  const hit = selected.find((p) => p.project_id === projectId);
  if (!hit || selected[0]?.project_id === projectId) return selected;
  return [hit, ...selected.filter((p) => p.project_id !== projectId)];
}

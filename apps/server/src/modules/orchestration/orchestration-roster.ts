/**
 * A mission's runtime roster — which slot runs where (pure logic, no DB).
 *
 * A team slot says WHO runs (host, CLI, model, credential); a mission's
 * projects say WHERE (each project's main clone folder on each host). Starting
 * a mission resolves the two into concrete runtimes — one per (slot, project)
 * pair whose host has a folder for that project — and freezes the result on
 * the mission (`OrchestrationMission.runtime_roster`). Everything downstream
 * reads that snapshot: the brief's roster, plan and reassignment validation,
 * per-slot concurrency, runtime preparation (credentials), the credential
 * fetch, and dispatch. The orchestrator was briefed with exactly this roster,
 * so editing the team mid-mission must not change what it may assign; a
 * reopen re-resolves it from the current team.
 *
 * Steps address a SLOT (`slot_id`) plus a project, not an execution identity.
 * Identities are derived (`runtimeIdentityKey`: CLI + folder + credential) and
 * two slots that differ only by model share one identity in one folder — as
 * identities they are the same CLI login in the same tree, but as roster
 * entries they are different workers the orchestrator must be able to pick
 * between. Addressing slots is what keeps "Opus reviewer + Sonnet implementer
 * on one machine" assignable.
 */

import {
  MemberFolderScope,
  TeamAgentSpec,
  TeamSlotSpec,
  parseTeamAgentSpec,
  parseTeamSlotSpec,
  slotExecutionSpec,
} from '../../common/orchestration-member-spec';
import { runtimeIdentityKey } from '../../common/runtime-spec';
import { MissionProject, projectFolderForHost } from './orchestration-project';

/** The orchestrator's slot id inside a roster. Never a step assignee. */
export const ORCHESTRATOR_SLOT_ID = 'orchestrator';

export type RosterSlotKind = 'member' | 'extra' | 'orchestrator';

/** One slot of a mission's effective roster (team members − exclusions + ad-hoc members). */
export interface RosterSlot {
  /** Roster address: the team member row id, an ad-hoc member's slot id, or ORCHESTRATOR_SLOT_ID. */
  slot_id: string;
  kind: RosterSlotKind;
  /** `<Host>/<role|cli>` — the name the brief, the work orders and the UI all use. */
  name: string;
  role_label: string;
  capabilities: string;
  max_concurrent: number;
  spec: TeamSlotSpec;
}

/** One (slot, project) pair the mission can execute: the slot's CLI in that project's folder on its host. */
export interface MissionRuntime {
  slot_id: string;
  project_id: string;
  /** `runtimeIdentityKey(spec)` — the execution identity steps of this pair run as. */
  agent_id: string;
  /** Execution spec (slot + working folder + folder scope) the manager spawns from. */
  spec: TeamAgentSpec;
}

/** What `OrchestrationMission.runtime_roster` stores — the roster frozen when the mission started. */
export interface MissionRuntimeRoster {
  version: 1;
  folder_scope: MemberFolderScope;
  orchestrator: RosterSlot;
  /** Assignable slots, in roster order. */
  members: RosterSlot[];
  /** The orchestrator's runtime first, then every member × project pair. */
  runtimes: MissionRuntime[];
}

/**
 * Resolve a mission's roster against its projects. Every problem is collected
 * into one message so the operator fixes them in one pass instead of
 * discovering them one start attempt at a time.
 */
export function resolveMissionRoster(args: {
  orchestrator: RosterSlot;
  members: RosterSlot[];
  projects: MissionProject[];
  folderScope: MemberFolderScope;
  hostName(id: string): string;
  /**
   * An identity the orchestrator should keep if it can: the agent that created
   * the mission for its team (`create_orchestration_mission` pre-stamps it). When
   * that identity is the orchestrator slot in one of the mission's project
   * folders, the orchestrator runs there — so the creating agent goes on
   * orchestrating instead of a separate session being briefed.
   */
  preferOrchestratorIdentity?: string | null;
}): { roster: MissionRuntimeRoster } | { error: string } {
  const { orchestrator, members, projects, folderScope, hostName } = args;
  if (projects.length === 0) {
    return {
      error:
        'This mission names no project. Add at least one project — each member works in that project\'s ' +
        'folder on its own host (Projects → host folders).',
    };
  }
  const projectNames = projects.map((p) => p.name).join(', ');
  const problems: string[] = [];
  const runtimes: MissionRuntime[] = [];

  // The orchestrator works in the first listed project its host has a folder
  // for (or the one its preferred identity runs in). It only plans and reviews,
  // so it needs one folder, not one per project.
  const orchestratorHost = orchestrator.spec.manager_agent_id;
  const workableForOrchestrator = projects.filter((p) => projectFolderForHost(p, orchestratorHost));
  const orchestratorProject =
    workableForOrchestrator.find(
      (p) => !!args.preferOrchestratorIdentity
        && runtimeFor(orchestrator, p, 'shared').agent_id === args.preferOrchestratorIdentity,
    ) ?? workableForOrchestrator[0];
  if (!orchestratorProject) {
    problems.push(
      `The orchestrator runs on ${hostName(orchestratorHost)}, which has no folder registered for any of this ` +
        `mission's projects (${projectNames}).`,
    );
  } else {
    runtimes.push(runtimeFor(orchestrator, orchestratorProject, 'shared'));
  }

  for (const slot of members) {
    const host = slot.spec.manager_agent_id;
    const workable = projects.filter((p) => projectFolderForHost(p, host));
    if (workable.length === 0) {
      problems.push(
        `${slot.name} runs on ${hostName(host)}, which has no folder registered for any of this mission's ` +
          `projects (${projectNames}) — register one, or leave this member out of the mission.`,
      );
      continue;
    }
    for (const project of workable) runtimes.push(runtimeFor(slot, project, folderScope));
  }

  if (problems.length > 0) {
    return {
      error:
        `${problems.join(' ')} A project's folder on a host is set in Projects → the project → host folders ` +
        `(its main clone on that machine).`,
    };
  }
  return { roster: { version: 1, folder_scope: folderScope, orchestrator, members, runtimes } };
}

function runtimeFor(slot: RosterSlot, project: MissionProject, folderScope: MemberFolderScope): MissionRuntime {
  const spec = slotExecutionSpec(slot.spec, projectFolderForHost(project, slot.spec.manager_agent_id)!, folderScope);
  return { slot_id: slot.slot_id, project_id: project.id, agent_id: runtimeIdentityKey(spec), spec };
}

/** The orchestrator's runtime (always the first runtime of a resolved roster). */
export function orchestratorRuntime(roster: MissionRuntimeRoster): MissionRuntime | null {
  return roster.runtimes.find((r) => r.slot_id === ORCHESTRATOR_SLOT_ID) ?? null;
}

/** Runtimes a member slot can run, one per project it has a folder for. */
export function runtimesForSlot(roster: MissionRuntimeRoster, slotId: string): MissionRuntime[] {
  return roster.runtimes.filter((r) => r.slot_id === slotId && slotId !== ORCHESTRATOR_SLOT_ID);
}

/**
 * Resolve a step assignment — `{ slot, project? }` from the orchestrator — to
 * the runtime it executes on.
 *
 * `project` may be omitted when the slot can only work on one of the mission's
 * projects (always true for a one-project mission). A project can be named by
 * id or, as long as it is unambiguous, by name — the orchestrator reads both
 * in its brief and LLMs reach for the name.
 *
 * Legacy: a roster used to be addressed by execution identity. An identity
 * that maps to exactly one slot of this roster is accepted as that slot, so an
 * orchestrator briefed before the change keeps working.
 */
export function resolveStepAssignment(
  roster: MissionRuntimeRoster,
  projects: Array<{ id: string; name: string }>,
  input: { slot: string; project?: string | null },
): { slot: RosterSlot; runtime: MissionRuntime } | { error: string } {
  const wanted = (input.slot || '').trim();
  let slot = roster.members.find((m) => m.slot_id === wanted) ?? null;
  let impliedProject: string | null = null;
  if (!slot && wanted) {
    const byIdentity = roster.runtimes.filter((r) => r.agent_id === wanted && r.slot_id !== ORCHESTRATOR_SLOT_ID);
    const slotIds = Array.from(new Set(byIdentity.map((r) => r.slot_id)));
    if (slotIds.length === 1) {
      slot = roster.members.find((m) => m.slot_id === slotIds[0]) ?? null;
      impliedProject = byIdentity.length === 1 ? byIdentity[0].project_id : null;
    } else if (slotIds.length > 1) {
      // The identity IS on the roster — several slots run as it (same CLI, folder
      // and credential, e.g. differing only by model), so it cannot say which.
      const names = roster.members.filter((m) => slotIds.includes(m.slot_id)).map((m) => `${m.name} (${m.slot_id})`);
      return {
        error:
          `"${wanted}" is the execution identity of ${slotIds.length} slots on this roster (${names.join(', ')}) — ` +
          `assign the step by slot id instead.`,
      };
    }
  }
  if (!slot) {
    return {
      error:
        `"${wanted}" is not a member of this mission's roster. Assign a step with a slot id from your brief: ` +
        roster.members.map((m) => `${m.name} (${m.slot_id})`).join(', '),
    };
  }

  const options = runtimesForSlot(roster, slot.slot_id);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const optionList = options.map((r) => `${projectName(r.project_id)} (${r.project_id})`).join(', ');

  const named = (input.project || '').trim();
  let projectId: string | null = null;
  if (named) {
    const byId = projects.find((p) => p.id === named);
    const byName = projects.filter((p) => p.name.toLowerCase() === named.toLowerCase());
    projectId = byId?.id ?? (byName.length === 1 ? byName[0].id : null);
    if (!projectId) {
      return {
        error:
          `"${named}" is not one of this mission's projects: ` +
          projects.map((p) => `${p.name} (${p.id})`).join(', '),
      };
    }
  } else if (impliedProject) {
    projectId = impliedProject;
  } else if (options.length === 1) {
    projectId = options[0].project_id;
  } else {
    return {
      error:
        `${slot.name} can work on more than one of this mission's projects — name the step's project: ${optionList}`,
    };
  }

  const runtime = options.find((r) => r.project_id === projectId);
  if (!runtime) {
    return {
      error:
        `${slot.name} cannot work on ${projectName(projectId)}: its host has no folder registered for that ` +
        `project. ${slot.name} can work on: ${optionList}. Assign this step to a member whose host has the ` +
        `project, or ask the operator to register the folder.`,
    };
  }
  return { slot, runtime };
}

/**
 * Other member slots working in the same folder on the same host as `runtime`
 * — who the assignee shares a tree with. Only meaningful for `shared` missions.
 */
export function folderMatesOf(roster: MissionRuntimeRoster, runtime: MissionRuntime): RosterSlot[] {
  const mateIds = new Set(
    roster.runtimes
      .filter(
        (r) =>
          r.slot_id !== runtime.slot_id
          && r.slot_id !== ORCHESTRATOR_SLOT_ID
          && r.spec.manager_agent_id === runtime.spec.manager_agent_id
          && sameFolder(r.spec.working_dir, runtime.spec.working_dir),
      )
      .map((r) => r.slot_id),
  );
  return roster.members.filter((m) => mateIds.has(m.slot_id));
}

/**
 * The (host, folder) pairs this mission's MEMBERS write to. The orchestrator
 * is left out on purpose: it plans and reviews, so sharing its folder with
 * another mission is a reader next to a writer, not two writers.
 */
export function memberFolders(roster: MissionRuntimeRoster): Array<{ host: string; folder: string }> {
  const seen = new Map<string, { host: string; folder: string }>();
  for (const r of roster.runtimes) {
    if (r.slot_id === ORCHESTRATOR_SLOT_ID) continue;
    const folder = trimFolder(r.spec.working_dir);
    seen.set(`${r.spec.manager_agent_id}\u0000${folder}`, { host: r.spec.manager_agent_id, folder });
  }
  return Array.from(seen.values());
}

/**
 * The first (host, folder) a shared mission would write to that another
 * running shared mission is already writing to, or null. Two shared missions
 * in one checkout overwrite each other's files and fight over the branch —
 * the very thing `isolated` exists to avoid.
 */
export function sharedFolderConflict(
  roster: MissionRuntimeRoster,
  others: Array<{ id: string; title: string; status: string; roster: MissionRuntimeRoster | null }>,
): { mission: { id: string; title: string; status: string }; host: string; folder: string } | null {
  if (roster.folder_scope !== 'shared') return null;
  const mine = memberFolders(roster);
  for (const other of others) {
    if (!other.roster || other.roster.folder_scope !== 'shared') continue;
    const theirs = new Set(memberFolders(other.roster).map((f) => `${f.host}\u0000${f.folder}`));
    const hit = mine.find((f) => theirs.has(`${f.host}\u0000${f.folder}`));
    if (hit) return { mission: { id: other.id, title: other.title, status: other.status }, ...hit };
  }
  return null;
}

/**
 * Read a stored roster back. NEVER throws: a missing, legacy or damaged value
 * reads as null, and callers treat that as "this mission predates runtime
 * rosters" (its steps still carry their own execution snapshots).
 */
export function readRuntimeRoster(value: unknown): MissionRuntimeRoster | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  if (r.version !== 1 || !Array.isArray(r.members) || !Array.isArray(r.runtimes)) return null;
  const orchestrator = readSlot(r.orchestrator);
  if (!orchestrator) return null;
  const members = (r.members as unknown[]).map(readSlot).filter((s): s is RosterSlot => !!s);
  const runtimes = (r.runtimes as unknown[])
    .map((x) => {
      const o = x as Record<string, any>;
      const spec = parseTeamAgentSpec(o?.spec);
      if (!spec || typeof o?.slot_id !== 'string' || typeof o?.project_id !== 'string') return null;
      return { slot_id: o.slot_id, project_id: o.project_id, agent_id: runtimeIdentityKey(spec), spec };
    })
    .filter((x): x is MissionRuntime => !!x);
  return {
    version: 1,
    folder_scope: r.folder_scope === 'isolated' ? 'isolated' : 'shared',
    orchestrator,
    members,
    runtimes,
  };
}

function readSlot(value: unknown): RosterSlot | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, any>;
  const spec = parseTeamSlotSpec(o.spec);
  if (!spec || typeof o.slot_id !== 'string' || !o.slot_id) return null;
  const kind: RosterSlotKind = o.kind === 'extra' || o.kind === 'orchestrator' ? o.kind : 'member';
  const cap = Number(o.max_concurrent);
  return {
    slot_id: o.slot_id,
    kind,
    name: typeof o.name === 'string' && o.name ? o.name : spec.cli,
    role_label: typeof o.role_label === 'string' ? o.role_label : '',
    capabilities: typeof o.capabilities === 'string' ? o.capabilities : '',
    max_concurrent: Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1,
    spec,
  };
}

/**
 * `<Host>/<role|cli>` — the one display rule for a slot (runbook
 * agent-display-name): the same role label legitimately exists on several
 * hosts, so the host is part of the name wherever it is known.
 */
export function slotDisplayName(hostName: string | null | undefined, roleLabel: string, cli: string): string {
  const leaf = (roleLabel || '').trim() || cli;
  return hostName ? `${hostName}/${leaf}` : leaf;
}

/** Same folder, ignoring a trailing separator (`/srv/awb/` vs `/srv/awb`). */
export function sameFolder(a: string, b: string): boolean {
  return trimFolder(a) === trimFolder(b);
}

function trimFolder(path: string): string {
  return String(path || '').replace(/[\\/]+$/, '');
}

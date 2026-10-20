/**
 * "Which teams is this agent on?" for MCP callers.
 *
 * An MCP caller is a runtime identity (`rt-…`: CLI + folder + credential). A
 * team slot has no folder, so it is not one identity — it is every identity it
 * would run as in a project folder on its host. Membership is therefore
 * computed: hash the slot's CLI + credential with each project folder
 * registered on the slot's host and compare. The tables involved (teams,
 * slots, project host folders) are small, and this runs only on the discovery
 * / self-service MCP tools, never per dispatch.
 *
 * Identities recorded before slots lost their folder (`orchestrator_agent_id`
 * on the team, `agent_id` on a member row) still count, so an agent from an
 * old mission keeps finding its team.
 */

import { DataSource } from 'typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { TeamSlotSpec, parseTeamSlotSpec } from '../../common/orchestration-member-spec';
import { runtimeIdentityKey } from '../../common/runtime-spec';

export interface TeamMembership {
  orchestrator: boolean;
  member: boolean;
}

/** Team id → how `ids` (the caller's identities) sit on that team. Teams it is not on are absent. */
export async function teamsForIdentities(ds: DataSource, ids: string[]): Promise<Map<string, TeamMembership>> {
  const wanted = new Set(ids.map((v) => (v || '').trim()).filter(Boolean));
  const out = new Map<string, TeamMembership>();
  if (wanted.size === 0) return out;

  const [teams, members, folders] = await Promise.all([
    ds.getRepository(OrchestrationTeam).find({
      select: { id: true, orchestrator_spec: true, orchestrator_agent_id: true } as any,
    }),
    ds.getRepository(OrchestrationTeamMember).find({
      select: { id: true, team_id: true, spec: true, agent_id: true } as any,
    }),
    ds.getRepository(ProjectHostFolder).find({ select: { host_id: true, path: true } as any }),
  ]);
  const foldersByHost = new Map<string, Set<string>>();
  for (const f of folders) {
    const set = foldersByHost.get(f.host_id) ?? new Set<string>();
    set.add(f.path);
    foldersByHost.set(f.host_id, set);
  }
  const runsAs = (spec: TeamSlotSpec | null): boolean => {
    if (!spec) return false;
    for (const folder of foldersByHost.get(spec.manager_agent_id) ?? []) {
      const key = runtimeIdentityKey({ cli: spec.cli, working_dir: folder, credential_id: spec.credential_id });
      if (wanted.has(key)) return true;
    }
    return false;
  };
  const mark = (teamId: string, role: keyof TeamMembership) => {
    const entry = out.get(teamId) ?? { orchestrator: false, member: false };
    entry[role] = true;
    out.set(teamId, entry);
  };

  for (const t of teams) {
    if ((t.orchestrator_agent_id && wanted.has(t.orchestrator_agent_id)) || runsAs(parseTeamSlotSpec(t.orchestrator_spec))) {
      mark(t.id, 'orchestrator');
    }
  }
  for (const m of members) {
    if ((m.agent_id && wanted.has(m.agent_id)) || runsAs(parseTeamSlotSpec(m.spec))) mark(m.team_id, 'member');
  }
  return out;
}

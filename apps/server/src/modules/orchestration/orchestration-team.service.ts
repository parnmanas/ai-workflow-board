/**
 * Team + membership CRUD for Orchestration mode.
 *
 * Kept separate from the runner so the "who is on the team" surface (a plain
 * REST-driven admin concern) never drags the dispatch engine's dependencies
 * into a request that only wants to rename a team.
 *
 * Invariants enforced here rather than at the DB level (SQLite + Postgres dual
 * support means we avoid partial/functional constraints):
 *   - orchestrator_agent_id must be a real, workspace-visible agent
 *   - a member's agent must be a real, workspace-visible agent
 *   - (team_id, agent_id) is unique
 *   - a team the operator is trying to disable/delete must not have a live mission
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { Agent } from '../../entities/Agent';
import { LogService } from '../../services/log.service';
import { MAX_PARALLEL_CEILING, TERMINAL_MISSION_STATUSES } from './orchestration.constants';
import { orchestrationError } from './orchestration-errors';

export interface TeamMemberView {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_type: string;
  is_online: boolean;
  role_label: string;
  capabilities: string;
  max_concurrent: number;
  position: number;
}

export interface TeamView {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  orchestrator_agent_id: string | null;
  orchestrator_name: string;
  orchestrator_online: boolean;
  orchestrator_prompt: string;
  max_parallel_steps: number;
  enabled: boolean;
  members: TeamMemberView[];
  active_mission_count: number;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OrchestrationTeamService {
  constructor(
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    @InjectRepository(OrchestrationTeamMember) private readonly memberRepo: Repository<OrchestrationTeamMember>,
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly logService: LogService,
  ) {}

  // ── Agent resolution ──────────────────────────────────────────────────────

  /**
   * Resolve an agent that is legitimately usable inside `workspaceId`.
   *
   * Workspace-less agents (manager identities) are visible everywhere by
   * design — see the Agent.workspace_id docstring — but a Runtime Host manager
   * is not an executable worker, so it is rejected as an orchestrator or member
   * outright. Anything else must belong to this workspace.
   */
  private async requireWorkspaceAgent(agentId: string, workspaceId: string, label: string): Promise<Agent> {
    const id = (agentId || '').trim();
    if (!id) throw orchestrationError(400, `${label} is required`);
    const agent = await this.agentRepo.findOne({ where: { id } });
    if (!agent) throw orchestrationError(404, `${label}: agent ${id} not found`);
    if (agent.type === 'manager') {
      throw orchestrationError(
        400,
        `${label}: ${agent.name} is a Runtime Host manager identity, not an executable agent. ` +
          `Pick one of the agents it manages instead.`,
      );
    }
    if (agent.workspace_id && agent.workspace_id !== workspaceId) {
      throw orchestrationError(400, `${label}: agent ${agent.name} belongs to a different workspace`);
    }
    return agent;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listTeams(workspaceId: string): Promise<TeamView[]> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    const teams = await this.teamRepo.find({
      where: { workspace_id: workspaceId },
      order: { created_at: 'DESC' },
    });
    if (teams.length === 0) return [];
    return this.projectTeams(teams);
  }

  /**
   * Teams an agent belongs to, as orchestrator or member — the agent-scoped
   * counterpart to `listTeams` (workspace-scoped, human/REST use). No
   * workspace filter: orchestrator/member agents are frequently workspace-less
   * manager identities (visible everywhere by design, see
   * `requireWorkspaceAgent`), so scoping by the caller's own workspace would
   * hide teams they legitimately belong to.
   */
  async listTeamsForAgent(agentId: string): Promise<TeamView[]> {
    if (!agentId) return [];
    const [orchTeams, memberRows] = await Promise.all([
      this.teamRepo.find({ where: { orchestrator_agent_id: agentId }, select: ['id'] }),
      this.memberRepo.find({ where: { agent_id: agentId }, select: ['team_id'] }),
    ]);
    const teamIds = Array.from(new Set<string>([...orchTeams.map((t) => t.id), ...memberRows.map((m) => m.team_id)]));
    if (teamIds.length === 0) return [];
    const teams = await this.teamRepo.find({ where: { id: In(teamIds) }, order: { created_at: 'DESC' } });
    return this.projectTeams(teams);
  }

  async getTeam(teamId: string, workspaceId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    const [view] = await this.projectTeams([team]);
    return view;
  }

  async requireTeam(teamId: string, workspaceId: string): Promise<OrchestrationTeam> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    const team = await this.teamRepo.findOne({ where: { id: teamId, workspace_id: workspaceId } });
    if (!team) throw orchestrationError(404, 'orchestration team not found in workspace');
    return team;
  }

  /**
   * Workspace-unscoped team lookup for the agent-created mission path
   * (`create_orchestration_mission`), which — like the other 9 orchestration
   * MCP tools — never takes a workspace_id input. The ownership check the
   * caller must still pass (team.orchestrator_agent_id === callerAgentId) is
   * a strictly stronger scope than a workspace match would add.
   */
  async requireTeamById(teamId: string): Promise<OrchestrationTeam> {
    const id = (teamId || '').trim();
    if (!id) throw orchestrationError(400, 'team_id is required');
    const team = await this.teamRepo.findOne({ where: { id } });
    if (!team) throw orchestrationError(404, 'orchestration team not found');
    return team;
  }

  /** Members of a team, ordered, with the agent row joined in. */
  async listMembers(teamId: string): Promise<Array<OrchestrationTeamMember & { agent: Agent | null }>> {
    const members = await this.memberRepo.find({
      where: { team_id: teamId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
    if (members.length === 0) return [];
    const agents = await this.agentRepo.find({ where: { id: In(members.map((m) => m.agent_id)) } });
    const byId = new Map(agents.map((a) => [a.id, a]));
    return members.map((m) => Object.assign(m, { agent: byId.get(m.agent_id) ?? null }));
  }

  private async projectTeams(teams: OrchestrationTeam[]): Promise<TeamView[]> {
    const teamIds = teams.map((t) => t.id);
    const members = await this.memberRepo.find({
      where: { team_id: In(teamIds) },
      order: { position: 'ASC', created_at: 'ASC' },
    });
    const agentIds = new Set<string>();
    for (const m of members) agentIds.add(m.agent_id);
    for (const t of teams) if (t.orchestrator_agent_id) agentIds.add(t.orchestrator_agent_id);
    const agents = agentIds.size
      ? await this.agentRepo.find({ where: { id: In(Array.from(agentIds)) } })
      : [];
    const byId = new Map(agents.map((a) => [a.id, a]));

    // One grouped count instead of a per-team query.
    const liveMissions = await this.missionRepo.find({
      where: { team_id: In(teamIds), status: Not(In(TERMINAL_MISSION_STATUSES as unknown as string[])) },
      select: ['id', 'team_id'],
    });
    const liveByTeam = new Map<string, number>();
    for (const m of liveMissions) liveByTeam.set(m.team_id, (liveByTeam.get(m.team_id) ?? 0) + 1);

    return teams.map((t) => {
      const orch = t.orchestrator_agent_id ? byId.get(t.orchestrator_agent_id) ?? null : null;
      return {
        id: t.id,
        workspace_id: t.workspace_id,
        name: t.name,
        description: t.description,
        orchestrator_agent_id: t.orchestrator_agent_id,
        orchestrator_name: orch?.name ?? '',
        orchestrator_online: !!orch?.is_online,
        orchestrator_prompt: t.orchestrator_prompt,
        max_parallel_steps: t.max_parallel_steps,
        enabled: t.enabled !== 0,
        members: members
          .filter((m) => m.team_id === t.id)
          .map((m) => {
            const a = byId.get(m.agent_id) ?? null;
            return {
              id: m.id,
              agent_id: m.agent_id,
              agent_name: a?.name ?? '(deleted agent)',
              agent_type: a?.type ?? '',
              is_online: !!a?.is_online,
              role_label: m.role_label,
              capabilities: m.capabilities,
              max_concurrent: m.max_concurrent,
              position: m.position,
            };
          }),
        active_mission_count: liveByTeam.get(t.id) ?? 0,
        created_at: t.created_at,
        updated_at: t.updated_at,
      };
    });
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async createTeam(input: {
    workspace_id: string;
    name: string;
    description?: string;
    orchestrator_agent_id: string;
    orchestrator_prompt?: string;
    max_parallel_steps?: number;
    created_by?: string;
  }): Promise<TeamView> {
    const workspaceId = (input.workspace_id || '').trim();
    const name = (input.name || '').trim();
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    if (!name) throw orchestrationError(400, 'name is required');

    const orchestrator = await this.requireWorkspaceAgent(
      input.orchestrator_agent_id,
      workspaceId,
      'orchestrator_agent_id',
    );

    const team = await this.teamRepo.save(
      this.teamRepo.create({
        workspace_id: workspaceId,
        name,
        description: (input.description || '').trim(),
        orchestrator_agent_id: orchestrator.id,
        orchestrator_prompt: (input.orchestrator_prompt || '').trim(),
        max_parallel_steps: clampParallel(input.max_parallel_steps),
        enabled: 1,
        created_by: input.created_by || '',
      }),
    );
    this.logService.info('Orchestration', `team created ${team.id} (${team.name})`, {
      workspace_id: workspaceId,
      orchestrator_agent_id: orchestrator.id,
    });
    return this.getTeam(team.id, workspaceId);
  }

  async updateTeam(
    teamId: string,
    workspaceId: string,
    patch: {
      name?: string;
      description?: string;
      orchestrator_agent_id?: string;
      orchestrator_prompt?: string;
      max_parallel_steps?: number;
      enabled?: boolean;
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw orchestrationError(400, 'name cannot be empty');
      team.name = name;
    }
    if (patch.description !== undefined) team.description = String(patch.description).trim();
    if (patch.orchestrator_prompt !== undefined) team.orchestrator_prompt = String(patch.orchestrator_prompt).trim();
    if (patch.max_parallel_steps !== undefined) team.max_parallel_steps = clampParallel(patch.max_parallel_steps);
    if (patch.orchestrator_agent_id !== undefined) {
      const agent = await this.requireWorkspaceAgent(
        patch.orchestrator_agent_id,
        workspaceId,
        'orchestrator_agent_id',
      );
      team.orchestrator_agent_id = agent.id;
    }
    if (patch.enabled !== undefined) team.enabled = patch.enabled ? 1 : 0;

    await this.teamRepo.save(team);
    return this.getTeam(team.id, workspaceId);
  }

  async deleteTeam(teamId: string, workspaceId: string): Promise<void> {
    const team = await this.requireTeam(teamId, workspaceId);
    const live = await this.missionRepo.count({
      where: { team_id: team.id, status: Not(In(TERMINAL_MISSION_STATUSES as unknown as string[])) },
    });
    if (live > 0) {
      throw orchestrationError(
        409,
        `team has ${live} mission(s) still running — cancel or finish them before deleting the team`,
      );
    }
    await this.memberRepo.delete({ team_id: team.id });
    await this.teamRepo.delete({ id: team.id });
    this.logService.info('Orchestration', `team deleted ${team.id}`, { workspace_id: workspaceId });
  }

  async addMember(
    teamId: string,
    workspaceId: string,
    input: { agent_id: string; role_label?: string; capabilities?: string; max_concurrent?: number },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    const agent = await this.requireWorkspaceAgent(input.agent_id, workspaceId, 'agent_id');

    const existing = await this.memberRepo.findOne({ where: { team_id: team.id, agent_id: agent.id } });
    if (existing) throw orchestrationError(409, `${agent.name} is already a member of this team`);

    const count = await this.memberRepo.count({ where: { team_id: team.id } });
    await this.memberRepo.save(
      this.memberRepo.create({
        team_id: team.id,
        workspace_id: workspaceId,
        agent_id: agent.id,
        role_label: (input.role_label || '').trim(),
        capabilities: (input.capabilities || '').trim(),
        max_concurrent: clampConcurrent(input.max_concurrent),
        position: count,
      }),
    );
    return this.getTeam(team.id, workspaceId);
  }

  async updateMember(
    teamId: string,
    workspaceId: string,
    memberId: string,
    patch: { role_label?: string; capabilities?: string; max_concurrent?: number; position?: number },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');

    if (patch.role_label !== undefined) member.role_label = String(patch.role_label).trim();
    if (patch.capabilities !== undefined) member.capabilities = String(patch.capabilities).trim();
    if (patch.max_concurrent !== undefined) member.max_concurrent = clampConcurrent(patch.max_concurrent);
    if (patch.position !== undefined && Number.isFinite(patch.position)) {
      member.position = Math.max(0, Math.floor(Number(patch.position)));
    }

    await this.memberRepo.save(member);
    return this.getTeam(team.id, workspaceId);
  }

  async removeMember(teamId: string, workspaceId: string, memberId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');
    await this.memberRepo.delete({ id: member.id });
    return this.getTeam(team.id, workspaceId);
  }

  /** Agents already used as orchestrator or member anywhere in the workspace — UI hint only. */
  async listAssignableAgents(workspaceId: string): Promise<Agent[]> {
    // Workspace agents plus workspace-less ones (see Agent.workspace_id doc),
    // minus manager identities which are not executable workers.
    const agents = await this.agentRepo.find({
      where: [
        { workspace_id: workspaceId, is_active: 1 },
        { workspace_id: IsNull(), is_active: 1 },
      ],
      order: { name: 'ASC' },
    });
    return agents.filter((a) => a.type !== 'manager');
  }
}

function clampParallel(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(MAX_PARALLEL_CEILING, Math.max(1, Math.floor(n)));
}

function clampConcurrent(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PARALLEL_CEILING, Math.max(1, Math.floor(n)));
}

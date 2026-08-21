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
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { MAX_PARALLEL_CEILING, MAX_OPEN_MISSIONS_CEILING, TERMINAL_MISSION_STATUSES } from './orchestration.constants';
import { orchestrationError } from './orchestration-errors';
import { resolveAgentDisplayMap } from '../../utils/agent-name';
import { visibleScopeWhere } from '../skills/skill-scope';

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

export interface AssignableAgentView {
  id: string;
  name: string;
  manager_agent_id: string | null;
  manager_name: string | null;
  type: string;
  is_online: boolean;
  description: string;
}

export interface TeamView {
  id: string;
  workspace_id: string | null;
  is_global: boolean;
  owner_workspace_id: string | null;
  allowed_workspace_ids: string[];
  name: string;
  description: string;
  orchestrator_agent_id: string | null;
  orchestrator_name: string;
  orchestrator_online: boolean;
  orchestrator_prompt: string;
  max_parallel_steps: number;
  max_open_missions: number;
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
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    private readonly logService: LogService,
  ) {}

  /**
   * `allowed_workspace_ids`가 실존하는 workspace만 가리키도록 원자적으로 검증한다.
   * 정규화(중복/공백 제거)만으로는 REST 호출자가 임의 UUID를 허용목록에 저장하는 걸
   * 막지 못한다 — `createMission`은 이 목록에 대해 문자열 포함 여부만 확인하므로,
   * 존재하지 않는 workspace를 대상으로 미션(그리고 그 budget/room)이 생성되어 고아
   * 스코프가 남을 수 있다. 저장 전에 거절해 그 경로를 원천 차단한다.
   */
  private async assertWorkspacesExist(ids: string[] | null): Promise<void> {
    if (!ids || ids.length === 0) return;
    const found = await this.workspaceRepo.find({ where: { id: In(ids) }, select: { id: true } });
    const foundIds = new Set(found.map((w) => w.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw orchestrationError(400, `allowed_workspace_ids references workspace(s) that do not exist: ${missing.join(', ')}`);
    }
  }

  // ── Agent resolution ──────────────────────────────────────────────────────

  /**
   * `teamWorkspaceId`에 스코프된 팀에서 정당하게 쓸 수 있는 에이전트를 확인한다.
   *
   * workspace 비종속 에이전트(manager identity)는 설계상 어디서나 보인다 —
   * Agent.workspace_id 문서 참고 — 하지만 Runtime Host manager는 실행 가능한
   * worker가 아니므로 orchestrator/member로는 무조건 거절된다.
   *
   * `teamWorkspaceId === null`은 팀 자체가 글로벌이라는 뜻이다(티켓 1b62b437) —
   * "글로벌 에이전트는 어디서나 통과"의 자연스러운 확장이 "글로벌 로스터에는 글로벌
   * 에이전트만 통과"다: workspace 종속 에이전트가 글로벌 팀 로스터에 들어가면
   * dispatchStep이 그 workspace의 에이전트에게 다른 workspace의 미션으로 지어진
   * room을 조용히 넘겨주게 된다 — 팀이 workspace 종속이 아니게 된 순간 이를 막을
   * 다른 장치가 없기 때문이다. 호출자는 반드시 팀 자신의 `workspace_id`를 넘겨야
   * 한다 — 요청을 보낸 쪽의 workspace_id가 아니다. 이 둘은 workspace 종속 팀에서만
   * 일치한다.
   */
  private async requireWorkspaceAgent(agentId: string, teamWorkspaceId: string | null, label: string): Promise<Agent> {
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
    if (teamWorkspaceId === null) {
      if (agent.workspace_id) {
        throw orchestrationError(
          400,
          `${label}: ${agent.name} belongs to a workspace, but this is a global team — only global agents ` +
            `(no workspace) may orchestrate or join a global team's roster.`,
        );
      }
    } else if (agent.workspace_id && agent.workspace_id !== teamWorkspaceId) {
      throw orchestrationError(400, `${label}: agent ${agent.name} belongs to a different workspace`);
    }
    return agent;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** 이 workspace 소유 팀 + 모든 글로벌 팀(티켓 1b62b437). */
  async listTeams(workspaceId: string): Promise<TeamView[]> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    const teams = await this.teamRepo.find({
      where: visibleScopeWhere<OrchestrationTeam>(workspaceId),
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

  /**
   * READ 레벨 조회: 이 workspace 소유 팀 OR 임의의 글로벌 팀(티켓 1b62b437)에
   * 매칭된다 — 글로벌 팀은 설계상 모든 workspace에서 보여야 한다. 의도적으로 쓰기
   * 권한 검사는 겸하지 않는다 — update/delete/addMember/updateMember/removeMember는
   * 이 뒤에 `assertTeamWritable`을 따로 호출하며, "글로벌 팀의 로스터/설정은 소유
   * workspace만 편집 가능"을 강제하는 건 그쪽이다.
   */
  async requireTeam(teamId: string, workspaceId: string): Promise<OrchestrationTeam> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    const team = await this.teamRepo.findOne({
      where: visibleScopeWhere<OrchestrationTeam>(workspaceId, { id: teamId }),
    });
    if (!team) throw orchestrationError(404, 'orchestration team not found in workspace');
    return team;
  }

  /**
   * `requireTeam`으로 이미 조회된 팀에 대한 WRITE 레벨 게이트. workspace 종속 팀은
   * 항상 자기 workspace에서 쓸 수 있다(`requireTeam`의 매칭이 이미 그걸 증명했다).
   * 글로벌 팀은 `owner_workspace_id` — 만든 workspace — 에서만 쓸 수 있다. 그렇지
   * 않으면 `requireTeam` 만으로는 MANAGE_ACTIONS을 가진 아무 workspace나 공유
   * 로스터를 편집할 수 있게 되어버린다 — workspace 종속이 아니게 된 그 순간부터
   * (OrchestrationTeam 문서 참고).
   */
  private assertTeamWritable(team: OrchestrationTeam, workspaceId: string): void {
    if (team.workspace_id === null && team.owner_workspace_id !== workspaceId) {
      throw orchestrationError(
        403,
        `orchestration team "${team.name}" is a global team owned by a different workspace — only the ` +
          `workspace that created it may edit its roster or settings.`,
      );
    }
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
    // Agent identity is ALWAYS `<Manager>/<Agent>` on every surface — see
    // utils/agent-name.ts. Resolving here (once, batched) means the whole
    // orchestration UI + the orchestrator's own prompt roster read the same
    // name the AI Agents listing shows.
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

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
        is_global: t.workspace_id === null,
        owner_workspace_id: t.owner_workspace_id,
        allowed_workspace_ids: Array.isArray(t.allowed_workspace_ids) ? t.allowed_workspace_ids : [],
        name: t.name,
        description: t.description,
        orchestrator_agent_id: t.orchestrator_agent_id,
        orchestrator_name: orch ? displayById.get(orch.id) ?? orch.name : '',
        orchestrator_online: !!orch?.is_online,
        orchestrator_prompt: t.orchestrator_prompt,
        max_parallel_steps: t.max_parallel_steps,
        max_open_missions: t.max_open_missions,
        enabled: t.enabled !== 0,
        members: members
          .filter((m) => m.team_id === t.id)
          .map((m) => {
            const a = byId.get(m.agent_id) ?? null;
            return {
              id: m.id,
              agent_id: m.agent_id,
              agent_name: a ? displayById.get(a.id) ?? a.name : '(deleted agent)',
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
    max_open_missions?: number;
    created_by?: string;
    /** 글로벌 팀으로 생성(티켓 1b62b437). 기본 false — 기존 호출자는 영향 없음. */
    is_global?: boolean;
    /** 글로벌 팀 전용: 이 팀의 orchestrator가 create_orchestration_mission으로 지정 가능한 workspace 목록. */
    allowed_workspace_ids?: string[];
  }): Promise<TeamView> {
    // 실행/생성 주체 workspace — 글로벌 팀이어도 항상 필수다: 이후 팀을 편집할 수
    // 있는 유일한 값인 owner_workspace_id가 된다(assertTeamWritable). "글로벌"은
    // 로스터가 workspace 비종속이라는 뜻일 뿐, 생성 자체에 workspace 컨텍스트가
    // 필요 없다는 뜻이 아니다.
    const callerWorkspaceId = (input.workspace_id || '').trim();
    const name = (input.name || '').trim();
    if (!callerWorkspaceId) throw orchestrationError(400, 'workspace_id is required');
    if (!name) throw orchestrationError(400, 'name is required');

    const isGlobal = !!input.is_global;
    const teamWorkspaceId: string | null = isGlobal ? null : callerWorkspaceId;

    const orchestrator = await this.requireWorkspaceAgent(
      input.orchestrator_agent_id,
      teamWorkspaceId,
      'orchestrator_agent_id',
    );

    const allowedWorkspaceIds = isGlobal ? normalizeWorkspaceIds(input.allowed_workspace_ids) : null;
    await this.assertWorkspacesExist(allowedWorkspaceIds);

    const team = await this.teamRepo.save(
      this.teamRepo.create({
        workspace_id: teamWorkspaceId,
        owner_workspace_id: callerWorkspaceId,
        allowed_workspace_ids: allowedWorkspaceIds,
        name,
        description: (input.description || '').trim(),
        orchestrator_agent_id: orchestrator.id,
        orchestrator_prompt: (input.orchestrator_prompt || '').trim(),
        max_parallel_steps: clampParallel(input.max_parallel_steps),
        max_open_missions: clampOpenMissions(input.max_open_missions),
        enabled: 1,
        created_by: input.created_by || '',
      }),
    );
    this.logService.info('Orchestration', `team created ${team.id} (${team.name})`, {
      workspace_id: teamWorkspaceId,
      owner_workspace_id: callerWorkspaceId,
      orchestrator_agent_id: orchestrator.id,
    });
    return this.getTeam(team.id, callerWorkspaceId);
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
      max_open_missions?: number;
      enabled?: boolean;
      /** 글로벌 팀 전용: workspace 허용목록을 통째로 교체한다. */
      allowed_workspace_ids?: string[];
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    this.assertTeamWritable(team, workspaceId);

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw orchestrationError(400, 'name cannot be empty');
      team.name = name;
    }
    if (patch.description !== undefined) team.description = String(patch.description).trim();
    if (patch.orchestrator_prompt !== undefined) team.orchestrator_prompt = String(patch.orchestrator_prompt).trim();
    if (patch.max_parallel_steps !== undefined) team.max_parallel_steps = clampParallel(patch.max_parallel_steps);
    if (patch.max_open_missions !== undefined) team.max_open_missions = clampOpenMissions(patch.max_open_missions);
    if (patch.orchestrator_agent_id !== undefined) {
      // 호출자가 아니라 팀 자신의 workspace_id를 기준으로 스코핑한다 — 글로벌
      // 팀은 이 둘이 다르다(team.workspace_id는 null인데 workspaceId는 편집 중인
      // 소유 workspace다), 그리고 로스터 규칙은 편집자가 아니라 팀의 스코프에
      // 관한 것이다.
      const agent = await this.requireWorkspaceAgent(
        patch.orchestrator_agent_id,
        team.workspace_id,
        'orchestrator_agent_id',
      );
      team.orchestrator_agent_id = agent.id;
    }
    if (patch.enabled !== undefined) team.enabled = patch.enabled ? 1 : 0;
    // 글로벌 팀에만 적용 — 이 파일의 다른 is_global 게이팅 규칙(requireWorkspaceAgent,
    // assertTeamWritable)과 동일하게. workspace 종속 팀은 허용목록을 쓸 데가
    // 없으므로(createMission이 그 팀에는 이 값을 참조하지 않는다) 여기서 조용히
    // 저장해봤자 아무도 손댈 수 없는 죽은 데이터가 된다.
    if (patch.allowed_workspace_ids !== undefined && team.workspace_id === null) {
      const normalized = normalizeWorkspaceIds(patch.allowed_workspace_ids);
      await this.assertWorkspacesExist(normalized);
      team.allowed_workspace_ids = normalized;
    }

    await this.teamRepo.save(team);
    return this.getTeam(team.id, workspaceId);
  }

  async deleteTeam(teamId: string, workspaceId: string): Promise<void> {
    const team = await this.requireTeam(teamId, workspaceId);
    this.assertTeamWritable(team, workspaceId);
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
    this.assertTeamWritable(team, workspaceId);
    // 편집 호출자가 아니라 팀 자신의 workspace를 기준으로 스코핑한다 — updateTeam의
    // orchestrator 교체 분기와 같은 이유.
    const agent = await this.requireWorkspaceAgent(input.agent_id, team.workspace_id, 'agent_id');

    const existing = await this.memberRepo.findOne({ where: { team_id: team.id, agent_id: agent.id } });
    if (existing) throw orchestrationError(409, `${agent.name} is already a member of this team`);

    const count = await this.memberRepo.count({ where: { team_id: team.id } });
    await this.memberRepo.save(
      this.memberRepo.create({
        team_id: team.id,
        workspace_id: team.workspace_id,
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
    this.assertTeamWritable(team, workspaceId);
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
    this.assertTeamWritable(team, workspaceId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');
    await this.memberRepo.delete({ id: member.id });
    return this.getTeam(team.id, workspaceId);
  }

  /**
   * 이 workspace 어딘가에서 이미 orchestrator나 member로 쓰인 에이전트들 — UI 힌트
   * 용도일 뿐. `globalOnly`(티켓 1b62b437)는 이를 workspace 비종속 에이전트로만
   * 좁힌다 — 글로벌 팀 picker용: 어차피 requireWorkspaceAgent가 workspace 종속
   * 에이전트를 글로벌 팀에서 거절하므로, UI가 애초에 그런 선택지를 보여줄 이유가 없다.
   */
  async listAssignableAgents(workspaceId: string, opts?: { globalOnly?: boolean }): Promise<AssignableAgentView[]> {
    // Workspace agents plus workspace-less ones (see Agent.workspace_id doc),
    // minus manager identities which are not executable workers.
    const agents = await this.agentRepo.find({
      where: opts?.globalOnly
        ? { workspace_id: IsNull(), is_active: 1 }
        : [
            { workspace_id: workspaceId, is_active: 1 },
            { workspace_id: IsNull(), is_active: 1 },
          ],
      order: { name: 'ASC' },
    });
    const assignable = agents.filter((a) => a.type !== 'manager');
    // Carry the manager identity so the orchestration pickers can render the
    // canonical `<Manager>/<Agent>` name. A bare `name` is ambiguous the moment
    // two managers each run an agent called "coder".
    const managerIds = Array.from(
      new Set(assignable.map((a) => a.manager_agent_id).filter((id): id is string => !!id)),
    );
    const managers = managerIds.length
      ? await this.agentRepo.find({ where: { id: In(managerIds) }, select: { id: true, name: true } as any })
      : [];
    const managerNameById = new Map(managers.map((m) => [m.id, m.name]));
    return assignable.map((a) => ({
      id: a.id,
      name: a.name,
      manager_agent_id: a.manager_agent_id ?? null,
      manager_name: a.manager_agent_id ? managerNameById.get(a.manager_agent_id) ?? null : null,
      type: a.type,
      is_online: !!a.is_online,
      description: a.description,
    }));
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

/** 하한은 1이 아니라 0이다 — OrchestrationTeam.max_open_missions 참고: 0은 "에이전트가
 *  미션을 만들 수 없음"을 의도적으로 나타내는 값이지, 미설정/무효값이 아니다. */
function clampOpenMissions(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_OPEN_MISSIONS_CEILING, Math.max(0, Math.floor(n)));
}

/** 중복 제거 + 빈 값 제거; 결과가 비면 []이 아니라 null — OrchestrationTeam.allowed_workspace_ids가
 *  다른 곳에서도 동일하게 그렇듯(빈 목록과 "한 번도 설정 안 함"은 둘 다 같은 deny-by-default를
 *  의미하므로) simple-json으로 그대로 왕복시키기 위함. */
function normalizeWorkspaceIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean)));
  return ids.length ? ids : null;
}

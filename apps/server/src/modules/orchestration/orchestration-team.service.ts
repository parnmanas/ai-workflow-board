/**
 * Team + membership CRUD for Orchestration mode.
 *
 * Kept separate from the runner so the "who is on the team" surface (a plain
 * REST-driven admin concern) never drags the dispatch engine's dependencies
 * into a request that only wants to rename a team.
 *
 * A roster slot — orchestrator or member — is declared as a **runtime spec**
 * (Runtime Host + CLI + model + working folder + folder scope, see
 * common/orchestration-member-spec.ts), not as a reference to an Agent somebody
 * created beforehand. `OrchestrationAgentProvisionerService` turns each spec
 * into the backing Agent identity that dispatch needs, so the `agent_id` /
 * `orchestrator_agent_id` columns this service writes are outputs of the edit
 * rather than inputs to it. Everything downstream of the roster (dispatch, SSE,
 * MCP report-back) is unchanged and still keyed on those ids.
 *
 * Invariants enforced here rather than at the DB level (SQLite + Postgres dual
 * support means we avoid partial/functional constraints):
 *   - every slot has a valid spec whose Runtime Host / credential / profile exist
 *   - (team_id, agent_id) is unique
 *   - a team the operator is trying to disable/delete must not have a live mission
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
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
import {
  MemberFolderScope,
  TeamAgentSpec,
  TeamAgentSpecError,
  mergeTeamAgentSpec,
  normalizeTeamAgentSpec,
  parseTeamAgentSpec,
} from '../../common/orchestration-member-spec';
import {
  OrchestrationAgentProvisionerService,
  RuntimeHostView,
} from './orchestration-agent-provisioner.service';

/**
 * A slot's runtime as the UI and the orchestrator read it back: the stored spec
 * plus the resolved names the client would otherwise need extra round trips for.
 *
 * `shared_with` is the folder-sharing signal — the other slots on this team
 * pointing at the same (host, folder). It is computed rather than stored so it
 * can never disagree with the specs it summarizes, and it is surfaced to the
 * orchestrator too: knowing that two members sit in one tree is what lets it
 * plan "A writes the file, B reads it" instead of shipping artifacts around.
 */
export interface SlotRuntimeView {
  manager_agent_id: string;
  manager_name: string;
  manager_online: boolean;
  cli: string;
  model: string | null;
  working_dir: string;
  folder_scope: MemberFolderScope;
  credential_id: string | null;
  cli_runtime_profile: string | null;
  runtime_config: Record<string, any> | null;
  /** Display names of the other slots on this team sharing this exact folder. */
  shared_with: string[];
}

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
  /**
   * null only for a legacy row whose stored spec is missing or unreadable — the
   * member still dispatches (it has a backing agent) but cannot be edited as a
   * spec until it is re-saved. The client renders that state explicitly instead
   * of showing an empty form that would silently drop fields on submit.
   */
  runtime: SlotRuntimeView | null;
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
  orchestrator_runtime: SlotRuntimeView | null;
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
    private readonly provisioner: OrchestrationAgentProvisionerService,
    private readonly logService: LogService,
  ) {}

  /** Runtime Hosts + their CLI / model / working-folder candidates (team editor). */
  listRuntimeHosts(workspaceId: string): Promise<RuntimeHostView[]> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    return this.provisioner.listRuntimeHosts(workspaceId);
  }

  /**
   * Validate a slot spec from REST/MCP input. Wraps the shape error as an
   * orchestration HTTP error so the controller's `fail()` reports 400 with the
   * specific field, rather than a generic 500.
   */
  private parseSpecInput(input: unknown, label: string): TeamAgentSpec {
    try {
      return normalizeTeamAgentSpec(input, label);
    } catch (e) {
      if (e instanceof TeamAgentSpecError) throw orchestrationError(400, e.message);
      throw e;
    }
  }

  private mergeSpecInput(current: TeamAgentSpec | null, patch: unknown, label: string): TeamAgentSpec {
    try {
      return mergeTeamAgentSpec(current, patch, label);
    } catch (e) {
      if (e instanceof TeamAgentSpecError) throw orchestrationError(400, e.message);
      throw e;
    }
  }

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

  // ── Slot provisioning ─────────────────────────────────────────────────────

  /**
   * Provision (or re-provision) the backing Agent identity for one roster slot.
   *
   * `teamWorkspaceId` must be the TEAM's own workspace_id, never the editing
   * caller's — they differ for a global team (the team is workspace-less while
   * the editor acts from the owning workspace) and the identity has to be
   * stamped with the team's scope. Getting this backwards is how a global team
   * would end up holding a workspace-scoped worker, which `dispatchStep`'s
   * defensive re-check would then refuse at run time (ticket 1b62b437).
   *
   * Note what is NOT validated here any more: the old roster gate rejected
   * manager identities and cross-workspace agents because the operator picked
   * the agent by hand. A spec cannot express either mistake — the Runtime Host
   * is a separate field from the worker, and the provisioner stamps the
   * workspace itself — so the check moved from "reject bad input" to "construct
   * only valid identities".
   */
  private async provisionSlot(args: {
    spec: TeamAgentSpec;
    teamWorkspaceId: string | null;
    teamName: string;
    label: string;
    currentAgentId: string | null;
  }): Promise<Agent> {
    const result = await this.provisioner.provisionSlot({
      spec: args.spec,
      workspaceId: args.teamWorkspaceId,
      teamName: args.teamName,
      label: args.label,
      currentAgentId: args.currentAgentId,
    });
    if (result.manager_notice) {
      this.logService.info(
        'Orchestration',
        `roster slot "${args.label}" of team "${args.teamName}": ${result.manager_notice}`,
        { workspace_id: args.teamWorkspaceId ?? undefined },
      );
    }
    return result.agent;
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

    // Runtime Host names + presence for the `runtime` blocks. Hosts are Agent
    // rows too, but they are NOT in `agents` above (a slot references its host
    // through the spec, not through `agent_id`), so they need their own lookup.
    const hostIds = new Set<string>();
    const collectHost = (spec: TeamAgentSpec | null) => {
      if (spec) hostIds.add(spec.manager_agent_id);
    };
    for (const m of members) collectHost(parseTeamAgentSpec(m.spec));
    for (const t of teams) collectHost(parseTeamAgentSpec(t.orchestrator_spec));
    const hosts = hostIds.size
      ? await this.agentRepo.find({
          where: { id: In(Array.from(hostIds)) },
          select: { id: true, name: true, is_online: true } as any,
        })
      : [];
    const hostById = new Map(hosts.map((h) => [h.id, h]));

    return teams.map((t) => {
      const orch = t.orchestrator_agent_id ? byId.get(t.orchestrator_agent_id) ?? null : null;
      const orchName = orch ? displayById.get(orch.id) ?? orch.name : '';
      const teamMembers = members.filter((m) => m.team_id === t.id);

      // All slots on this team, so each one can report who it shares a folder
      // with. Built per team (not globally) because sharing a tree only means
      // anything between agents the same orchestrator drives.
      const slots: Array<{ name: string; spec: TeamAgentSpec | null }> = [
        { name: orchName || 'orchestrator', spec: parseTeamAgentSpec(t.orchestrator_spec) },
        ...teamMembers.map((m) => {
          const a = byId.get(m.agent_id) ?? null;
          return {
            name: a ? displayById.get(a.id) ?? a.name : m.role_label || '(unnamed slot)',
            spec: parseTeamAgentSpec(m.spec),
          };
        }),
      ];
      const runtimeFor = (spec: TeamAgentSpec | null, selfName: string): SlotRuntimeView | null => {
        if (!spec) return null;
        const host = hostById.get(spec.manager_agent_id) ?? null;
        return {
          manager_agent_id: spec.manager_agent_id,
          manager_name: host?.name ?? '(unknown Runtime Host)',
          manager_online: !!host?.is_online,
          cli: spec.cli,
          model: spec.model,
          working_dir: spec.working_dir,
          folder_scope: spec.folder_scope,
          credential_id: spec.credential_id,
          cli_runtime_profile: spec.cli_runtime_profile,
          runtime_config: (spec.runtime_config as Record<string, any>) ?? null,
          shared_with: slots
            .filter(
              (s) =>
                s.name !== selfName
                && s.spec
                && s.spec.manager_agent_id === spec.manager_agent_id
                && s.spec.working_dir === spec.working_dir,
            )
            .map((s) => s.name),
        };
      };

      return {
        id: t.id,
        workspace_id: t.workspace_id,
        is_global: t.workspace_id === null,
        owner_workspace_id: t.owner_workspace_id,
        allowed_workspace_ids: Array.isArray(t.allowed_workspace_ids) ? t.allowed_workspace_ids : [],
        name: t.name,
        description: t.description,
        orchestrator_agent_id: t.orchestrator_agent_id,
        orchestrator_name: orchName,
        orchestrator_online: !!orch?.is_online,
        orchestrator_runtime: runtimeFor(parseTeamAgentSpec(t.orchestrator_spec), orchName || 'orchestrator'),
        orchestrator_prompt: t.orchestrator_prompt,
        max_parallel_steps: t.max_parallel_steps,
        max_open_missions: t.max_open_missions,
        enabled: t.enabled !== 0,
        members: teamMembers.map((m) => {
          const a = byId.get(m.agent_id) ?? null;
          const name = a ? displayById.get(a.id) ?? a.name : '(deleted agent)';
          return {
            id: m.id,
            agent_id: m.agent_id,
            agent_name: name,
            agent_type: a?.type ?? '',
            is_online: !!a?.is_online,
            role_label: m.role_label,
            capabilities: m.capabilities,
            max_concurrent: m.max_concurrent,
            position: m.position,
            runtime: runtimeFor(parseTeamAgentSpec(m.spec), name),
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
    /**
     * The orchestrator's runtime spec (Runtime Host / CLI / model / working
     * folder). Required, and the only way to name an orchestrator — the old
     * `orchestrator_agent_id` input is gone, because "pick an Agent that already
     * exists" is exactly the prerequisite this refactor removes.
     */
    orchestrator: unknown;
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

    const orchestratorSpec = this.parseSpecInput(input.orchestrator, 'orchestrator');

    const allowedWorkspaceIds = isGlobal ? normalizeWorkspaceIds(input.allowed_workspace_ids) : null;
    await this.assertWorkspacesExist(allowedWorkspaceIds);

    // Provision the orchestrator identity BEFORE inserting the team: a team row
    // with no orchestrator cannot run a mission, so a half-applied create must
    // leave nothing behind rather than an unusable team the operator has to
    // notice and clean up.
    const orchestrator = await this.provisionSlot({
      spec: orchestratorSpec,
      teamWorkspaceId,
      teamName: name,
      label: 'orchestrator',
      currentAgentId: null,
    });

    const team = await this.teamRepo.save(
      this.teamRepo.create({
        workspace_id: teamWorkspaceId,
        owner_workspace_id: callerWorkspaceId,
        allowed_workspace_ids: allowedWorkspaceIds,
        name,
        description: (input.description || '').trim(),
        orchestrator_agent_id: orchestrator.id,
        orchestrator_spec: orchestratorSpec as unknown as Record<string, any>,
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
      /** Partial patch over the orchestrator's stored spec (see mergeTeamAgentSpec). */
      orchestrator?: unknown;
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
    if (patch.orchestrator !== undefined) {
      // 호출자가 아니라 팀 자신의 workspace_id를 기준으로 스코핑한다 — 글로벌
      // 팀은 이 둘이 다르다(team.workspace_id는 null인데 workspaceId는 편집 중인
      // 소유 workspace다), 그리고 로스터 규칙은 편집자가 아니라 팀의 스코프에
      // 관한 것이다.
      const merged = this.mergeSpecInput(parseTeamAgentSpec(team.orchestrator_spec), patch.orchestrator, 'orchestrator');
      const previousAgentId = team.orchestrator_agent_id;
      const agent = await this.provisionSlot({
        spec: merged,
        teamWorkspaceId: team.workspace_id,
        teamName: team.name,
        label: 'orchestrator',
        currentAgentId: previousAgentId,
      });
      team.orchestrator_agent_id = agent.id;
      team.orchestrator_spec = merged as unknown as Record<string, any>;
      // Retire a replaced identity only after the team row points at the new
      // one, so a failure between the two leaves a team that still dispatches.
      if (previousAgentId && previousAgentId !== agent.id) {
        await this.teamRepo.save(team);
        await this.provisioner.releaseIdentity(previousAgentId);
      }
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
    const members = await this.memberRepo.find({ where: { team_id: team.id }, select: { id: true, agent_id: true } as any });
    await this.memberRepo.delete({ team_id: team.id });
    await this.teamRepo.delete({ id: team.id });
    // Rows are gone, so `releaseIdentity` sees zero references and can delete
    // any identity this team owned. Identities the operator authored are left
    // alone by the provisioner's origin check.
    for (const m of members) await this.provisioner.releaseIdentity(m.agent_id);
    await this.provisioner.releaseIdentity(team.orchestrator_agent_id);
    this.logService.info('Orchestration', `team deleted ${team.id}`, { workspace_id: workspaceId });
  }

  async addMember(
    teamId: string,
    workspaceId: string,
    input: {
      /** Runtime spec for the new slot — Runtime Host / CLI / model / working folder. */
      runtime?: unknown;
      /**
       * Put the ORCHESTRATOR on the roster as an executing member, reusing its
       * identity and runtime instead of provisioning a new one. `runtime` is
       * ignored when this is set.
       *
       * This exists because a slot now MINTS an identity, so "add the
       * orchestrator as a member too" — a supported pattern, and the shape of a
       * rollup mission where the planner also does a step — stopped being
       * expressible: sending the orchestrator's own spec would produce a second,
       * separate worker with the same configuration rather than the orchestrator
       * itself. It is a flag rather than an identity-reuse rule ("same spec ⇒
       * same worker") on purpose: that rule would also collapse the two members
       * who deliberately share one working folder into a single worker, which is
       * the exact case this feature exists to support.
       */
      as_orchestrator?: boolean;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    this.assertTeamWritable(team, workspaceId);

    let spec: TeamAgentSpec | null;
    let agent: Agent;
    if (input.as_orchestrator) {
      if (!team.orchestrator_agent_id) {
        throw orchestrationError(400, `team "${team.name}" has no orchestrator to put on the roster`);
      }
      const orchestrator = await this.agentRepo.findOne({ where: { id: team.orchestrator_agent_id } });
      if (!orchestrator) throw orchestrationError(404, "this team's orchestrator agent no longer exists");
      agent = orchestrator;
      spec = parseTeamAgentSpec(team.orchestrator_spec);
    } else {
      spec = this.parseSpecInput(input.runtime, 'runtime');
      // 편집 호출자가 아니라 팀 자신의 workspace를 기준으로 스코핑한다 — updateTeam의
      // orchestrator 교체 분기와 같은 이유.
      agent = await this.provisionSlot({
        spec,
        teamWorkspaceId: team.workspace_id,
        teamName: team.name,
        label: (input.role_label || '').trim() || spec.cli,
        currentAgentId: null,
      });
    }

    // Belt-and-braces: a team-owned identity is minted fresh per slot so it
    // cannot already be on the roster, but a slot re-provisioned onto an
    // operator-authored agent still could be, and `(team_id, agent_id)` has to
    // stay unique for the concurrency accounting in `dispatchReadySteps`.
    const existing = await this.memberRepo.findOne({ where: { team_id: team.id, agent_id: agent.id } });
    if (existing) {
      // Only release an identity we just minted. The `as_orchestrator` path
      // adopted an existing one — deleting it would take the team's
      // orchestrator with it. (`releaseIdentity` would refuse anyway, since the
      // team row still references it, but not relying on that keeps the
      // intent local.)
      if (!input.as_orchestrator) await this.provisioner.releaseIdentity(agent.id);
      throw orchestrationError(409, `${agent.name} is already a member of this team`);
    }

    const count = await this.memberRepo.count({ where: { team_id: team.id } });
    await this.memberRepo.save(
      this.memberRepo.create({
        team_id: team.id,
        workspace_id: team.workspace_id,
        agent_id: agent.id,
        spec: (spec as unknown as Record<string, any>) ?? null,
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
    patch: {
      /** Partial patch over the slot's stored runtime spec. Absent = unchanged. */
      runtime?: unknown;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
      position?: number;
    },
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

    let replacedAgentId: string | null = null;
    if (patch.runtime !== undefined && member.agent_id === team.orchestrator_agent_id) {
      // This row is the orchestrator sitting on its own roster (`as_orchestrator`).
      // Re-provisioning from here would silently split it into a second worker
      // and leave the team with a member that merely looks like its orchestrator.
      // The orchestrator's runtime has exactly one editing surface.
      throw orchestrationError(
        409,
        'this member IS the team orchestrator — edit its runtime on the team itself, not on the roster row',
      );
    }
    if (patch.runtime !== undefined) {
      const merged = this.mergeSpecInput(parseTeamAgentSpec(member.spec), patch.runtime, 'runtime');
      const agent = await this.provisionSlot({
        spec: merged,
        teamWorkspaceId: team.workspace_id,
        teamName: team.name,
        label: member.role_label || merged.cli,
        currentAgentId: member.agent_id,
      });
      if (agent.id !== member.agent_id) {
        // Re-provisioning onto a different identity (host change, or a spec edit
        // on a back-filled operator-owned agent we must not mutate). Guard the
        // roster's `(team_id, agent_id)` uniqueness before committing.
        const clash = await this.memberRepo.findOne({ where: { team_id: team.id, agent_id: agent.id } });
        if (clash) {
          await this.provisioner.releaseIdentity(agent.id, { excludeMemberIds: [member.id] });
          throw orchestrationError(409, `${agent.name} is already a member of this team`);
        }
        replacedAgentId = member.agent_id;
        member.agent_id = agent.id;
      }
      member.spec = merged as unknown as Record<string, any>;
    }

    await this.memberRepo.save(member);
    // Only after the row points at the new identity — see updateTeam.
    if (replacedAgentId) await this.provisioner.releaseIdentity(replacedAgentId);
    return this.getTeam(team.id, workspaceId);
  }

  async removeMember(teamId: string, workspaceId: string, memberId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, workspaceId);
    this.assertTeamWritable(team, workspaceId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');
    await this.memberRepo.delete({ id: member.id });
    await this.provisioner.releaseIdentity(member.agent_id);
    return this.getTeam(team.id, workspaceId);
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

/**
 * Team + membership CRUD for Orchestration mode.
 *
 * Kept separate from the runner so the "who is on the team" surface (a plain
 * REST-driven admin concern) never drags the dispatch engine's dependencies
 * into a request that only wants to rename a team.
 *
 * A roster slot — orchestrator or member — is declared as a **slot spec**
 * (Runtime Host + CLI + model + credential + execution config, see
 * common/orchestration-member-spec.ts `TeamSlotSpec`), not as a reference to an
 * Agent somebody created beforehand. A slot has no folder and therefore no
 * execution identity of its own: a mission places every slot in its projects'
 * folders when it starts (orchestration-roster.ts) and freezes the result. So
 * editing a slot here never touches a live runtime — missions already started
 * keep the roster they were briefed with, and the next mission (or a reopen)
 * picks the edit up.
 *
 * Invariants enforced here rather than at the DB level (SQLite + Postgres dual
 * support means we avoid partial/functional constraints):
 *   - every slot has a valid spec whose Runtime Host / credential / profile exist
 *   - a team the operator is trying to disable/delete must not have a live mission
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, Not } from 'typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Credential } from '../../entities/Credential';
import { Account } from '../../entities/Account';
import { LogService } from '../../services/log.service';
import { CLI_RUNTIME_NONE } from '../../common/cli-runtime-profiles';
import { globalRuntimeProfiles } from '../../common/claude-backend-registry';
import { MAX_PARALLEL_CEILING, MAX_OPEN_MISSIONS_CEILING, TERMINAL_MISSION_STATUSES, type OrchestrationCaller } from './orchestration.constants';
import { orchestrationError } from './orchestration-errors';
import { visibleScopeWhere } from '../skills/skill-scope';
import {
  TeamAgentSpecError,
  TeamSlotSpec,
  mergeTeamSlotSpec,
  normalizeTeamSlotSpec,
  parseTeamSlotSpec,
  sameTeamSlotSpec,
} from '../../common/orchestration-member-spec';
import { OrchestrationHostsService, RuntimeHostView } from './orchestration-hosts.service';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';
import { teamsForIdentities } from './orchestration-slot-identities';
import { slotDisplayName } from './orchestration-roster';

/**
 * A slot as the UI and the orchestrator read it back: the stored spec plus the
 * resolved Runtime Host name/presence the client would otherwise need an extra
 * round trip for. No folder — a mission decides where a slot works.
 */
export interface SlotRuntimeView {
  manager_agent_id: string;
  manager_name: string;
  manager_online: boolean;
  cli: string;
  model: string | null;
  credential_id: string | null;
  cli_runtime_profile: string | null;
  runtime_config: Record<string, any> | null;
}

export interface TeamMemberView {
  /** The slot's address — missions exclude it and assign steps to it by this id. */
  id: string;
  agent_name: string;
  agent_type: string;
  is_online: boolean;
  role_label: string;
  capabilities: string;
  max_concurrent: number;
  position: number;
  /**
   * null only for a legacy row whose stored spec is missing or unreadable — the
   * slot is left out of every mission's roster and cannot be edited as a spec
   * until it is re-saved. The client renders that state explicitly instead of
   * showing an empty form that would silently drop fields on submit.
   */
  runtime: SlotRuntimeView | null;
}

export interface TeamView {
  id: string;
  account_id: string | null;
  is_global: boolean;
  owner_account_id: string | null;
  allowed_account_ids: string[];
  name: string;
  description: string;
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
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
    private readonly hosts: OrchestrationHostsService,
    private readonly logService: LogService,
    @InjectDataSource() private readonly dataSource: DataSource,
    // @Global 이라 import edge 불필요 (host-models.service 와 같은 패턴).
    private readonly registry?: InstanceRegistryService,
  ) {}

  /** Runtime Hosts + their CLI / model candidates (team editor). */
  listRuntimeHosts(accountId: string): Promise<RuntimeHostView[]> {
    if (!accountId) throw orchestrationError(400, 'account_id is required');
    return this.hosts.listRuntimeHosts(accountId);
  }

  /** Re-enumerate one host's per-CLI model lists (slot editor's model dropdown). */
  refreshRuntimeHostModels(managerAgentId: string, accountId: string): Promise<RuntimeHostView | null> {
    if (!accountId) throw orchestrationError(400, 'account_id is required');
    return this.hosts.refreshHostModels(managerAgentId, accountId);
  }

  /**
   * Validate a slot spec from REST/MCP input. Wraps the shape error as an
   * orchestration HTTP error so the controller's `fail()` reports 400 with the
   * specific field, rather than a generic 500.
   */
  private parseSpecInput(input: unknown, label: string): TeamSlotSpec {
    try {
      return normalizeTeamSlotSpec(input, label);
    } catch (e) {
      if (e instanceof TeamAgentSpecError) throw orchestrationError(400, e.message);
      throw e;
    }
  }

  private mergeSpecInput(current: TeamSlotSpec | null, patch: unknown, label: string): TeamSlotSpec {
    try {
      return mergeTeamSlotSpec(current, patch, label);
    } catch (e) {
      if (e instanceof TeamAgentSpecError) throw orchestrationError(400, e.message);
      throw e;
    }
  }

  /**
   * `allowed_account_ids`가 실존하는 account만 가리키도록 원자적으로 검증한다.
   * 정규화(중복/공백 제거)만으로는 REST 호출자가 임의 UUID를 허용목록에 저장하는 걸
   * 막지 못한다 — `createMission`은 이 목록에 대해 문자열 포함 여부만 확인하므로,
   * 존재하지 않는 account를 대상으로 미션(그리고 그 budget/room)이 생성되어 고아
   * 스코프가 남을 수 있다. 저장 전에 거절해 그 경로를 원천 차단한다.
   */
  private async assertAccountsExist(ids: string[] | null): Promise<void> {
    if (!ids || ids.length === 0) return;
    const found = await this.accountRepo.find({ where: { id: In(ids) }, select: { id: true } });
    const foundIds = new Set(found.map((w) => w.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw orchestrationError(400, `allowed_account_ids references account(s) that do not exist: ${missing.join(', ')}`);
    }
  }

  // ── Slot references ───────────────────────────────────────────────────────

  /**
   * Check a slot's references: the Runtime Host, the credential and the backend
   * profile it names must exist (and the credential must be usable by this
   * team). Fails fast because a silently-ignored typo surfaces much later as a
   * mysterious spawn failure on somebody else's machine.
   *
   * `teamAccountId` must be the TEAM's own account_id, never the editing
   * caller's — they differ for a global team (the team is account-less while
   * the editor acts from the owning account) and the credential-visibility
   * rule below is scoped to the team's scope.
   */
  private async assertSlotReferences(spec: TeamSlotSpec, teamAccountId: string | null): Promise<void> {
    const host = await this.hostRepo.findOne({ where: { id: spec.manager_agent_id } });
    if (!host?.is_active || !teamAccountId || host.account_id !== teamAccountId) throw orchestrationError(400, 'Runtime Host is not available to this team');
    if (spec.credential_id) {
      const cred = await this.credentialRepo.findOne({ where: { id: spec.credential_id } });
      if (!cred || (cred.account_id !== null && cred.account_id !== teamAccountId)) {
        throw orchestrationError(400, `credential ${spec.credential_id} is not available to this team`);
      }
    }
    if (spec.cli_runtime_profile && spec.cli_runtime_profile !== CLI_RUNTIME_NONE) {
      const profiles = await globalRuntimeProfiles(this.dataSource);
      if (!profiles.some((p) => p.id === spec.cli_runtime_profile)) {
        throw orchestrationError(400, `cli_runtime_profile "${spec.cli_runtime_profile}" does not exist`);
      }
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** 이 account 소유 팀 + 모든 글로벌 팀(티켓 1b62b437). */
  async listTeams(accountId: string): Promise<TeamView[]> {
    if (!accountId) throw orchestrationError(400, 'account_id is required');
    const teams = await this.teamRepo.find({
      where: visibleScopeWhere<OrchestrationTeam>(accountId),
      order: { created_at: 'DESC' },
    });
    if (teams.length === 0) return [];
    return this.projectTeams(teams);
  }

  /**
   * Teams an agent belongs to, as orchestrator or member — the agent-scoped
   * counterpart to `listTeams` (account-scoped, human/REST use). No account
   * filter: a runtime is not an account member, and the same slot legitimately
   * runs for several accounts.
   *
   * "Belongs" is computed (orchestration-slot-identities.ts): the caller's
   * identity is a slot of the team running in some project folder on the
   * slot's host.
   */
  async listTeamsForAgent(caller: OrchestrationCaller): Promise<TeamView[]> {
    const ids = [caller.agentId, caller.runtimeKey].filter((v): v is string => !!v);
    if (ids.length === 0) return [];
    const membership = await teamsForIdentities(this.dataSource, ids);
    if (membership.size === 0) return [];
    const teams = await this.teamRepo.find({ where: { id: In(Array.from(membership.keys())) }, order: { created_at: 'DESC' } });
    return this.projectTeams(teams);
  }

  /** Is the caller this team's orchestrator — its orchestrator slot in some project folder? */
  async isTeamOrchestrator(team: OrchestrationTeam, caller: OrchestrationCaller): Promise<boolean> {
    const ids = [caller.agentId, caller.runtimeKey].filter((v): v is string => !!v);
    if (ids.length === 0) return false;
    return !!(await teamsForIdentities(this.dataSource, ids)).get(team.id)?.orchestrator;
  }

  async getTeam(teamId: string, accountId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    const [view] = await this.projectTeams([team]);
    return view;
  }

  /**
   * READ 레벨 조회: 이 account 소유 팀 OR 임의의 글로벌 팀(티켓 1b62b437)에
   * 매칭된다 — 글로벌 팀은 설계상 모든 account에서 보여야 한다. 의도적으로 쓰기
   * 권한 검사는 겸하지 않는다 — update/delete/addMember/updateMember/removeMember는
   * 이 뒤에 `assertTeamWritable`을 따로 호출하며, "글로벌 팀의 로스터/설정은 소유
   * account만 편집 가능"을 강제하는 건 그쪽이다.
   */
  async requireTeam(teamId: string, accountId: string): Promise<OrchestrationTeam> {
    if (!accountId) throw orchestrationError(400, 'account_id is required');
    const team = await this.teamRepo.findOne({
      where: visibleScopeWhere<OrchestrationTeam>(accountId, { id: teamId }),
    });
    if (!team) throw orchestrationError(404, 'orchestration team not found in account');
    return team;
  }

  /**
   * `requireTeam`으로 이미 조회된 팀에 대한 WRITE 레벨 게이트. account 종속 팀은
   * 항상 자기 account에서 쓸 수 있다(`requireTeam`의 매칭이 이미 그걸 증명했다).
   * 글로벌 팀은 `owner_account_id` — 만든 account — 에서만 쓸 수 있다. 그렇지
   * 않으면 `requireTeam` 만으로는 MANAGE_ACTIONS을 가진 아무 account나 공유
   * 로스터를 편집할 수 있게 되어버린다 — account 종속이 아니게 된 그 순간부터
   * (OrchestrationTeam 문서 참고).
   */
  private assertTeamWritable(team: OrchestrationTeam, accountId: string): void {
    if (team.account_id === null && team.owner_account_id !== accountId) {
      throw orchestrationError(
        403,
        `orchestration team "${team.name}" is a global team owned by a different account — only the ` +
          `account that created it may edit its roster or settings.`,
      );
    }
  }

  /**
   * Account-unscoped team lookup for the agent-created mission path
   * (`create_orchestration_mission`), which — like the other orchestration
   * MCP tools — never takes a account_id input. The ownership check the
   * caller must still pass (`isTeamOrchestrator`) is a strictly stronger
   * scope than a account match would add.
   */
  async requireTeamById(teamId: string): Promise<OrchestrationTeam> {
    const id = (teamId || '').trim();
    if (!id) throw orchestrationError(400, 'team_id is required');
    const team = await this.teamRepo.findOne({ where: { id } });
    if (!team) throw orchestrationError(404, 'orchestration team not found');
    return team;
  }

  /** Members of a team, in roster order. */
  listMembers(teamId: string): Promise<OrchestrationTeamMember[]> {
    return this.memberRepo.find({
      where: { team_id: teamId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
  }

  private async projectTeams(teams: OrchestrationTeam[]): Promise<TeamView[]> {
    const teamIds = teams.map((t) => t.id);
    const members = await this.memberRepo.find({
      where: { team_id: In(teamIds) },
      order: { position: 'ASC', created_at: 'ASC' },
    });

    // One grouped count instead of a per-team query.
    const liveMissions = await this.missionRepo.find({
      where: { team_id: In(teamIds), status: Not(In(TERMINAL_MISSION_STATUSES as unknown as string[])) },
      select: ['id', 'team_id'],
    });
    const liveByTeam = new Map<string, number>();
    for (const m of liveMissions) liveByTeam.set(m.team_id, (liveByTeam.get(m.team_id) ?? 0) + 1);

    // Runtime Host names + presence for the `runtime` blocks.
    const hostIds = new Set<string>();
    const collectHost = (spec: TeamSlotSpec | null) => {
      if (spec) hostIds.add(spec.manager_agent_id);
    };
    for (const m of members) collectHost(parseTeamSlotSpec(m.spec));
    for (const t of teams) collectHost(parseTeamSlotSpec(t.orchestrator_spec));
    const hostIdList = Array.from(hostIds);
    const hostRows = hostIdList.length
      ? await this.hostRepo.find({
        where: { id: In(hostIdList) },
        select: { id: true, name: true } as any,
      })
      : [];
    const hostById = new Map<string, { id: string; name: string; is_online?: number }>();
    for (const h of hostRows) hostById.set(h.id, { id: h.id, name: h.name });
    // Host 행에는 presence 컬럼이 없다 — 레지스트리 heartbeat 로 보정한다.
    if (this.registry) {
      for (const rec of this.registry.list()) {
        if (rec.mode !== 'manager') continue;
        for (const id of [rec.agent_id, rec.host_id].filter((v): v is string => !!v)) {
          const e = hostById.get(id);
          if (e && e.is_online !== 1) e.is_online = 1;
        }
      }
    }

    const runtimeFor = (spec: TeamSlotSpec | null): SlotRuntimeView | null => {
      if (!spec) return null;
      const host = hostById.get(spec.manager_agent_id) ?? null;
      return {
        manager_agent_id: spec.manager_agent_id,
        manager_name: host?.name ?? '(unknown Runtime Host)',
        manager_online: !!host?.is_online,
        cli: spec.cli,
        model: spec.model,
        credential_id: spec.credential_id,
        cli_runtime_profile: spec.cli_runtime_profile,
        runtime_config: (spec.runtime_config as Record<string, any>) ?? null,
      };
    };

    return teams.map((t) => {
      // `<Host>/<leaf>` (runbook agent-display-name): the same role label
      // legitimately exists on several hosts, so the host is part of the name.
      const orchSpec = parseTeamSlotSpec(t.orchestrator_spec);
      const orchName = orchSpec
        ? slotDisplayName(hostById.get(orchSpec.manager_agent_id)?.name, '', orchSpec.cli)
        : '';
      const teamMembers = members.filter((m) => m.team_id === t.id);

      return {
        id: t.id,
        account_id: t.account_id,
        is_global: t.account_id === null,
        owner_account_id: t.owner_account_id,
        allowed_account_ids: Array.isArray(t.allowed_account_ids) ? t.allowed_account_ids : [],
        name: t.name,
        description: t.description,
        orchestrator_name: orchName,
        orchestrator_online: !!hostById.get(orchSpec?.manager_agent_id ?? '')?.is_online,
        orchestrator_runtime: runtimeFor(orchSpec),
        orchestrator_prompt: t.orchestrator_prompt,
        max_parallel_steps: t.max_parallel_steps,
        max_open_missions: t.max_open_missions,
        enabled: t.enabled !== 0,
        members: teamMembers.map((m) => {
          const mSpec = parseTeamSlotSpec(m.spec);
          const mHost = mSpec ? hostById.get(mSpec.manager_agent_id) ?? null : null;
          return {
            id: m.id,
            agent_name: mSpec ? slotDisplayName(mHost?.name, m.role_label, mSpec.cli) : (m.role_label || '(no runtime)'),
            agent_type: mSpec?.cli ?? '',
            is_online: !!mHost?.is_online,
            role_label: m.role_label,
            capabilities: m.capabilities,
            max_concurrent: m.max_concurrent,
            position: m.position,
            runtime: runtimeFor(mSpec),
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
    account_id: string;
    name: string;
    description?: string;
    /**
     * The orchestrator's slot spec (Runtime Host / CLI / model / credential —
     * no folder; missions decide where). Required, and the only way to name an
     * orchestrator.
     */
    orchestrator: unknown;
    orchestrator_prompt?: string;
    max_parallel_steps?: number;
    max_open_missions?: number;
    created_by?: string;
    /** 글로벌 팀으로 생성(티켓 1b62b437). 기본 false — 기존 호출자는 영향 없음. */
    is_global?: boolean;
    /** 글로벌 팀 전용: 이 팀의 orchestrator가 create_orchestration_mission으로 지정 가능한 account 목록. */
    allowed_account_ids?: string[];
  }): Promise<TeamView> {
    // 실행/생성 주체 account — 글로벌 팀이어도 항상 필수다: 이후 팀을 편집할 수
    // 있는 유일한 값인 owner_account_id가 된다(assertTeamWritable). "글로벌"은
    // 로스터가 account 비종속이라는 뜻일 뿐, 생성 자체에 account 컨텍스트가
    // 필요 없다는 뜻이 아니다.
    const callerAccountId = (input.account_id || '').trim();
    const name = (input.name || '').trim();
    if (!callerAccountId) throw orchestrationError(400, 'account_id is required');
    if (!name) throw orchestrationError(400, 'name is required');

    const isGlobal = !!input.is_global;
    const teamAccountId: string | null = isGlobal ? null : callerAccountId;

    const orchestratorSpec = this.parseSpecInput(input.orchestrator, 'orchestrator');

    const allowedAccountIds = isGlobal ? normalizeAccountIds(input.allowed_account_ids) : null;
    await this.assertAccountsExist(allowedAccountIds);

    // Check the orchestrator's references BEFORE inserting the team: a team row
    // with no usable orchestrator cannot run a mission, so a half-applied create
    // must leave nothing behind rather than an unusable team the operator has to
    // notice and clean up.
    await this.assertSlotReferences(orchestratorSpec, teamAccountId);

    const team = await this.teamRepo.save(
      this.teamRepo.create({
        account_id: teamAccountId,
        owner_account_id: callerAccountId,
        allowed_account_ids: allowedAccountIds,
        name,
        description: (input.description || '').trim(),
        orchestrator_agent_id: null,
        orchestrator_spec: orchestratorSpec as unknown as Record<string, any>,
        orchestrator_prompt: (input.orchestrator_prompt || '').trim(),
        max_parallel_steps: clampParallel(input.max_parallel_steps),
        max_open_missions: clampOpenMissions(input.max_open_missions),
        enabled: 1,
        created_by: input.created_by || '',
      }),
    );
    this.logService.info('Orchestration', `team created ${team.id} (${team.name})`, {
      account_id: teamAccountId,
      owner_account_id: callerAccountId,
    });
    return this.getTeam(team.id, callerAccountId);
  }

  async updateTeam(
    teamId: string,
    accountId: string,
    patch: {
      name?: string;
      description?: string;
      /** Partial patch over the orchestrator's stored slot spec (see mergeTeamSlotSpec). */
      orchestrator?: unknown;
      orchestrator_prompt?: string;
      max_parallel_steps?: number;
      max_open_missions?: number;
      enabled?: boolean;
      /** 글로벌 팀 전용: account 허용목록을 통째로 교체한다. */
      allowed_account_ids?: string[];
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);

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
      // 호출자가 아니라 팀 자신의 account_id를 기준으로 스코핑한다 — 글로벌
      // 팀은 이 둘이 다르다(team.account_id는 null인데 accountId는 편집 중인
      // 소유 account다), 그리고 로스터 규칙은 편집자가 아니라 팀의 스코프에
      // 관한 것이다.
      // 실행 중인 미션은 시작 때 확정한 로스터로 돈다 — 여기서 바뀐 slot 은 다음 미션
      // (또는 다시 열기)부터 쓰이므로 살아 있는 런타임을 건드릴 일이 없다.
      const before = parseTeamSlotSpec(team.orchestrator_spec);
      const merged = this.mergeSpecInput(before, patch.orchestrator, 'orchestrator');
      await this.assertSlotReferences(merged, team.account_id);
      team.orchestrator_spec = merged as unknown as Record<string, any>;
      // 로스터에 앉은 오케스트레이터(`as_orchestrator` 행)는 오케스트레이터 slot 의 사본이다.
      // 함께 옮기지 않으면 사본이 옛 spec 에 남아 updateMember 의 "이 행은 오케스트레이터다"
      // 판정(같은 slot spec)에서 빠지고, 그때부터 그 행을 따로 고칠 수 있게 된다 — 오케스트레이터
      // 런타임의 편집 창구를 하나로 두려는 가드가 첫 편집에서 풀린다.
      const mirrors = (await this.memberRepo.find({ where: { team_id: team.id } }))
        .filter((m) => sameTeamSlotSpec(parseTeamSlotSpec(m.spec), before));
      for (const m of mirrors) m.spec = merged as unknown as Record<string, any>;
      if (mirrors.length) await this.memberRepo.save(mirrors);
    }
    if (patch.enabled !== undefined) team.enabled = patch.enabled ? 1 : 0;
    // 글로벌 팀에만 적용 — 이 파일의 다른 is_global 게이팅 규칙(requireAccountAgent,
    // assertTeamWritable)과 동일하게. account 종속 팀은 허용목록을 쓸 데가
    // 없으므로(createMission이 그 팀에는 이 값을 참조하지 않는다) 여기서 조용히
    // 저장해봤자 아무도 손댈 수 없는 죽은 데이터가 된다.
    if (patch.allowed_account_ids !== undefined && team.account_id === null) {
      const normalized = normalizeAccountIds(patch.allowed_account_ids);
      await this.assertAccountsExist(normalized);
      team.allowed_account_ids = normalized;
    }

    await this.teamRepo.save(team);
    return this.getTeam(team.id, accountId);
  }

  async deleteTeam(teamId: string, accountId: string): Promise<void> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);
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
    this.logService.info('Orchestration', `team deleted ${team.id}`, { account_id: accountId });
  }

  async addMember(
    teamId: string,
    accountId: string,
    input: {
      /** Slot spec for the new member — Runtime Host / CLI / model / credential (no folder). */
      runtime?: unknown;
      /**
       * Put the ORCHESTRATOR on the roster as an executing member. `runtime`
       * is ignored when this is set; the row copies the orchestrator's slot.
       * The updateMember guard then rejects runtime edits on that row so the
       * orchestrator keeps exactly one editing surface (updateTeam) instead of
       * silently forking on the roster.
       */
      as_orchestrator?: boolean;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);

    let spec: TeamSlotSpec;
    if (input.as_orchestrator) {
      const orchestrator = parseTeamSlotSpec(team.orchestrator_spec);
      if (!orchestrator) {
        throw orchestrationError(400, `team "${team.name}" has no orchestrator to put on the roster`);
      }
      spec = orchestrator;
    } else {
      spec = this.parseSpecInput(input.runtime, 'runtime');
      // 편집 호출자가 아니라 팀 자신의 account를 기준으로 스코핑한다 — updateTeam의
      // orchestrator 교체 분기와 같은 이유.
      await this.assertSlotReferences(spec, team.account_id);
    }

    // 같은 spec 의 슬롯이 둘이어도 거부하지 않는다 — 미션에서 같은 폴더에 놓이면 실행
    // identity 를 공유하지만 로스터에서는 행 id 로 따로 배정·상한 관리된다. 이름은
    // role_label 이 구분한다.
    const count = await this.memberRepo.count({ where: { team_id: team.id } });
    await this.memberRepo.save(
      this.memberRepo.create({
        team_id: team.id,
        account_id: team.account_id,
        agent_id: null,
        spec: spec as unknown as Record<string, any>,
        role_label: (input.role_label || '').trim(),
        capabilities: (input.capabilities || '').trim(),
        max_concurrent: clampConcurrent(input.max_concurrent),
        position: count,
      }),
    );
    return this.getTeam(team.id, accountId);
  }

  async updateMember(
    teamId: string,
    accountId: string,
    memberId: string,
    patch: {
      /** Partial patch over the slot's stored spec. Absent = unchanged. */
      runtime?: unknown;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
      position?: number;
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');

    if (patch.role_label !== undefined) member.role_label = String(patch.role_label).trim();
    if (patch.capabilities !== undefined) member.capabilities = String(patch.capabilities).trim();
    if (patch.max_concurrent !== undefined) member.max_concurrent = clampConcurrent(patch.max_concurrent);
    if (patch.position !== undefined && Number.isFinite(patch.position)) {
      member.position = Math.max(0, Math.floor(Number(patch.position)));
    }

    if (patch.runtime !== undefined) {
      const before = parseTeamSlotSpec(member.spec);
      if (sameTeamSlotSpec(before, parseTeamSlotSpec(team.orchestrator_spec))) {
        // This row is the orchestrator sitting on its own roster (`as_orchestrator`).
        // Editing it here would silently split it from the orchestrator and leave
        // the team with a member that merely looks like its orchestrator. The
        // orchestrator's runtime has exactly one editing surface.
        throw orchestrationError(
          409,
          'this member IS the team orchestrator — edit its runtime on the team itself, not on the roster row',
        );
      }
      const merged = this.mergeSpecInput(before, patch.runtime, 'runtime');
      await this.assertSlotReferences(merged, team.account_id);
      member.spec = merged as unknown as Record<string, any>;
    }

    // 실행 중인 미션은 시작 때 확정한 로스터로 돈다 — 슬롯 편집이 살아 있는 런타임을
    // 건드리지 않으므로 재시작/프로비저닝할 것이 없다(다음 미션·다시 열기가 반영한다).
    await this.memberRepo.save(member);
    return this.getTeam(team.id, accountId);
  }

  async removeMember(teamId: string, accountId: string, memberId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');
    await this.memberRepo.delete({ id: member.id });
    return this.getTeam(team.id, accountId);
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

/** 중복 제거 + 빈 값 제거; 결과가 비면 []이 아니라 null — OrchestrationTeam.allowed_account_ids가
 *  다른 곳에서도 동일하게 그렇듯(빈 목록과 "한 번도 설정 안 함"은 둘 다 같은 deny-by-default를
 *  의미하므로) simple-json으로 그대로 왕복시키기 위함. */
function normalizeAccountIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean)));
  return ids.length ? ids : null;
}

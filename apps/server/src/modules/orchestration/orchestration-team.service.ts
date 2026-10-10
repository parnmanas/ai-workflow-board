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
 * created beforehand. The `agent_id` / `orchestrator_agent_id` columns this
 * service writes carry the slot's runtime identity key
 * (`runtimeIdentityKey(spec)`, common/runtime-spec.ts) — outputs of the edit
 * rather than inputs to it. Dispatch resolves those keys without an Agent row
 * (tuple match, else auto-provision on first dispatch).
 *
 * Invariants enforced here rather than at the DB level (SQLite + Postgres dual
 * support means we avoid partial/functional constraints):
 *   - every slot has a valid spec whose Runtime Host / credential / profile exist
 *   - P4c-4: (team_id, agent_id) is NOT unique — slots sharing one spec address
 *     one shared worker (shared-folder collaboration). Concurrency caps are
 *     summed per identity, and slots stay distinguishable by role_label.
 *   - a team the operator is trying to disable/delete must not have a live mission
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, Not } from 'typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { Credential } from '../../entities/Credential';
import { Account } from '../../entities/Account';
import { LogService } from '../../services/log.service';
import { CLI_RUNTIME_NONE } from '../../common/cli-runtime-profiles';
import { globalRuntimeProfiles } from '../../common/claude-backend-registry';
import { MAX_PARALLEL_CEILING, MAX_OPEN_MISSIONS_CEILING, TERMINAL_MISSION_STATUSES, type OrchestrationCaller } from './orchestration.constants';
import { orchestrationError } from './orchestration-errors';
import { resolveAgentDisplayNamesByIds } from '../../utils/agent-name';
import { visibleScopeWhere } from '../skills/skill-scope';
import {
  MemberFolderScope,
  TeamAgentSpec,
  TeamAgentSpecError,
  mergeTeamAgentSpec,
  normalizeTeamAgentSpec,
  parseTeamAgentSpec,
} from '../../common/orchestration-member-spec';
import { OrchestrationHostsService, RuntimeHostView } from './orchestration-hosts.service';
import { InstanceRegistryService, type InstanceRecord } from '../agent-manager/instance-registry.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { isUuidShapedId } from '../../utils/agent-name';
import { runtimeIdentityKey } from '../../common/runtime-spec';

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
  account_id: string | null;
  is_global: boolean;
  owner_account_id: string | null;
  allowed_account_ids: string[];
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
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
    private readonly hosts: OrchestrationHostsService,
    private readonly logService: LogService,
    @InjectDataSource() private readonly dataSource: DataSource,
    // @Global 이라 import edge 불필요 (host-models.service 와 같은 패턴).
    private readonly registry?: InstanceRegistryService,
    // restart_agent 발사용. AgentManagerModule 을 import 중이라 해결된다.
    // 테스트 직접 인스턴스화 대비 optional — 호출부에서 null-guard 한다.
    private readonly commands?: AgentManagerCommandService,
  ) {}

  /** Runtime Hosts + their CLI / model / working-folder candidates (team editor). */
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
   * `allowed_account_ids`가 실존하는 workspace만 가리키도록 원자적으로 검증한다.
   * 정규화(중복/공백 제거)만으로는 REST 호출자가 임의 UUID를 허용목록에 저장하는 걸
   * 막지 못한다 — `createMission`은 이 목록에 대해 문자열 포함 여부만 확인하므로,
   * 존재하지 않는 workspace를 대상으로 미션(그리고 그 budget/room)이 생성되어 고아
   * 스코프가 남을 수 있다. 저장 전에 거절해 그 경로를 원천 차단한다.
   */
  private async assertWorkspacesExist(ids: string[] | null): Promise<void> {
    if (!ids || ids.length === 0) return;
    const found = await this.accountRepo.find({ where: { id: In(ids) }, select: { id: true } });
    const foundIds = new Set(found.map((w) => w.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw orchestrationError(400, `allowed_account_ids references workspace(s) that do not exist: ${missing.join(', ')}`);
    }
  }

  // ── Slot identity ─────────────────────────────────────────────────────────

  /**
   * Resolve one roster slot's spec to its runtime identity key
   * (`runtimeIdentityKey`, common/runtime-spec.ts). No Agent row is created —
   * dispatch resolves the key without one (registry tuple match, else
   * auto-provision on first dispatch).
   *
   * `teamAccountId` must be the TEAM's own account_id, never the editing
   * caller's — they differ for a global team (the team is workspace-less while
   * the editor acts from the owning workspace) and the credential-visibility
   * rule below is scoped to the team's scope.
   *
   * Fails fast on bad references (unknown host / credential / profile) for the
   * same reason the old provisioner did: a silently-ignored typo surfaces much
   * later as a mysterious spawn failure on somebody else's machine.
   */
  private async resolveSlotAgentId(spec: TeamAgentSpec, teamAccountId: string | null): Promise<string> {
    // P4c-4: Host 직접 조회 후 api_keys 페어링 링크 (Agent 행 없음).
    const host = await this.hostRepo.findOne({ where: { id: spec.manager_agent_id } });
    if (!host) throw orchestrationError(400, `Runtime Host ${spec.manager_agent_id} does not exist`);
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
    return runtimeIdentityKey(spec);
  }

  // ── Manager notification ──────────────────────────────────────────────────

  /**
   * Re-sync a live Runtime Host after a slot runtime edit (the P4c-4 port of
   * the old provisioner's `notifyRuntimeChanged`).
   *
   * `restart_agent`, not `set_working_dir`: the manager caches the whole launch
   * context (cli, model, working_dir, runtime_config, cli-home) when it first
   * spawns an identity, so a single-field command leaves an edited CLI or model
   * stale indefinitely. `restart_agent` reaps the identity's live sessions and
   * re-reads the canonical spec, which is the only command that makes every
   * edited field take effect.
   *
   * Notified with the PREVIOUS identity key: a cli/dir/credential edit mints a
   * new key whose sessions don't exist yet, while the replaced key's sessions
   * keep running on the old launch context. Best-effort (offline → skip): the
   * dispatch path auto-spawns on next use, so an unreachable host must not fail
   * the edit.
   */
  private async notifySlotRuntimeChanged(
    before: TeamAgentSpec | null,
    previousAgentId: string | null,
    merged: TeamAgentSpec,
    teamAccountId: string | null,
  ): Promise<void> {
    if (!this.commands) return;
    if (!previousAgentId) return;
    if (!hostVisibleFieldsChanged(before, merged)) return;
    // Rehost 면 묵은 세션이 있는 쪽(이전 host)에, 아니면 슬롯의 host 에.
    const hostId = before?.manager_agent_id || merged.manager_agent_id;
    if (!hostId) return;
    let inst: InstanceRecord | null = null;
    try {
      inst = this.commands.resolveLiveManagerInstance(hostId);
    } catch {
      inst = null;
    }
    if (!inst) return;
    try {
      await this.commands.issue(
        inst,
        'restart_agent',
        { agent_id: previousAgentId, account_id: teamAccountId ?? undefined },
        'system:orchestration-roster',
      );
    } catch (e: any) {
      this.logService.warn('Orchestration',
        `restart_agent dispatch failed for ${String(previousAgentId).slice(0, 11)}`,
        { account_id: teamAccountId ?? undefined, error: e?.message });
    }
  }

  // ── Slot provisioning ───────────────────────────────────────────────────

  /**
   * Materialize one slot identity on its host right after it is authored.
   *
   * Dispatch alone never writes the slot's CLI credential files (the manager
   * only prepares an empty cli-home for unknown identities), so an identity
   * that never went through `spawn_agent` runs credential-less no matter what
   * credential the slot names. A fresh member — and any cli/dir/credential
   * edit, which mints a NEW identity key while `restart_agent` only reaps the
   * previous one — would otherwise first fail with "Not logged in" at
   * dispatch time. Best-effort: offline hosts and issue failures only log;
   * the mission-start hook retries.
   */
  private async provisionSlotBestEffort(
    spec: TeamAgentSpec,
    ownerAccountId: string | null,
    label: string,
  ): Promise<void> {
    if (!this.commands) return;
    try {
      await this.commands.provisionSlotIdentity(spec, {
        accountId: ownerAccountId || '',
        label,
        issuedBy: 'system:orchestration-roster',
      });
    } catch (e: any) {
      this.logService.warn('Orchestration', `slot provision dispatch failed for ${label}`, {
        account_id: ownerAccountId ?? undefined,
        error: e?.message,
      });
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** 이 workspace 소유 팀 + 모든 글로벌 팀(티켓 1b62b437). */
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
   * counterpart to `listTeams` (account-scoped, human/REST use). No
   * workspace filter: orchestrator/member agents are frequently workspace-less
   * manager identities (visible everywhere by design, see
   * `requireWorkspaceAgent`), so scoping by the caller's own workspace would
   * hide teams they legitimately belong to.
   */
  async listTeamsForAgent(caller: OrchestrationCaller): Promise<TeamView[]> {
    const ids = [caller.agentId, caller.runtimeKey].filter((v): v is string => !!v);
    if (ids.length === 0) return [];
    const [orchTeams, memberRows] = await Promise.all([
      this.teamRepo.find({ where: { orchestrator_agent_id: In(ids) }, select: ['id'] }),
      this.memberRepo.find({ where: { agent_id: In(ids) }, select: ['team_id'] }),
    ]);
    const teamIds = Array.from(new Set<string>([...orchTeams.map((t) => t.id), ...memberRows.map((m) => m.team_id)]));
    if (teamIds.length === 0) return [];
    const teams = await this.teamRepo.find({ where: { id: In(teamIds) }, order: { created_at: 'DESC' } });
    return this.projectTeams(teams);
  }

  async getTeam(teamId: string, accountId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
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
  async requireTeam(teamId: string, accountId: string): Promise<OrchestrationTeam> {
    if (!accountId) throw orchestrationError(400, 'account_id is required');
    const team = await this.teamRepo.findOne({
      where: visibleScopeWhere<OrchestrationTeam>(accountId, { id: teamId }),
    });
    if (!team) throw orchestrationError(404, 'orchestration team not found in workspace');
    return team;
  }

  /**
   * `requireTeam`으로 이미 조회된 팀에 대한 WRITE 레벨 게이트. workspace 종속 팀은
   * 항상 자기 workspace에서 쓸 수 있다(`requireTeam`의 매칭이 이미 그걸 증명했다).
   * 글로벌 팀은 `owner_account_id` — 만든 workspace — 에서만 쓸 수 있다. 그렇지
   * 않으면 `requireTeam` 만으로는 MANAGE_ACTIONS을 가진 아무 workspace나 공유
   * 로스터를 편집할 수 있게 되어버린다 — workspace 종속이 아니게 된 그 순간부터
   * (OrchestrationTeam 문서 참고).
   */
  private assertTeamWritable(team: OrchestrationTeam, accountId: string): void {
    if (team.account_id === null && team.owner_account_id !== accountId) {
      throw orchestrationError(
        403,
        `orchestration team "${team.name}" is a global team owned by a different workspace — only the ` +
          `workspace that created it may edit its roster or settings.`,
      );
    }
  }

  /**
   * Account-unscoped team lookup for the agent-created mission path
   * (`create_orchestration_mission`), which — like the other 9 orchestration
   * MCP tools — never takes a account_id input. The ownership check the
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

  /** Members of a team, ordered, with the agent row joined in (null for rt- slots). */
  // P4c-4: agent 자리는 항상 null (Agent 테이블 없음 — 호출자는 spec 으로 해소).
  async listMembers(teamId: string): Promise<Array<OrchestrationTeamMember & { agent: null }>> {
    const members = await this.memberRepo.find({
      where: { team_id: teamId },
      order: { position: 'ASC', created_at: 'ASC' },
    });
    if (members.length === 0) return [];
    // P4c-4: Agent 행 없음 — agent 자리는 항상 null (호출자는 spec/display 로 해소).
    return members.map((m) => Object.assign(m, { agent: null }));
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
    // P4c-4: Agent 행 없음 (displayById 가 Host/링크 이름으로 해소한다).
    // P4c-4: Host/링크 이름으로 해소한다 (Agent 테이블 없음).
    const displayById = await resolveAgentDisplayNamesByIds(this.dataSource, Array.from(agentIds));

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
    // P4c-4: Host 행 + api_keys 링크 이름으로 해소한다 (Agent 테이블 없음).
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

    return teams.map((t) => {
      // P4c-4: Agent 행 없음 — 슬롯 표시는 `<Host>/<leaf>` 로 합성한다.
      // displayById 는 linked uuid 를 Host bare name 으로만 해소하고 rt- 키는
      // 모른다. spec 의 host + role_label/cli leaf 가 둘 다 있으면 합성해야
      // 서로 다른 호스트의 동일 스펙 슬롯이 구분된다 (runbook agent-display-name).
      const orchSpec = parseTeamAgentSpec(t.orchestrator_spec);
      const orchHost = orchSpec ? hostById.get(orchSpec.manager_agent_id) ?? null : null;
      const orchResolved = t.orchestrator_agent_id ? displayById.get(t.orchestrator_agent_id) : undefined;
      const orchHostPart = orchHost?.name
        ?? (orchResolved && !orchResolved.includes('/') ? orchResolved : undefined);
      const orchLeaf = orchSpec?.cli ?? '';
      const orchName = orchHostPart && orchLeaf
        ? `${orchHostPart}/${orchLeaf}`
        : (orchResolved ?? (t.orchestrator_agent_id ? orchLeaf || t.orchestrator_agent_id.slice(0, 8) : orchLeaf));
      const teamMembers = members.filter((m) => m.team_id === t.id);

      // All slots on this team, so each one can report who it shares a folder
      // with. Built per team (not globally) because sharing a tree only means
      // anything between agents the same orchestrator drives.
      const slotName = (agentId: string, spec: TeamAgentSpec | null, leaf: string, fallback: string): string => {
        const host = spec ? hostById.get(spec.manager_agent_id) ?? null : null;
        const resolved = displayById.get(agentId);
        const hostPart = host?.name
          ?? (resolved && !resolved.includes('/') ? resolved : undefined);
        return hostPart && leaf ? `${hostPart}/${leaf}` : (resolved ?? leaf ?? fallback);
      };
      const slots: Array<{ name: string; spec: TeamAgentSpec | null }> = [
        { name: orchName || 'orchestrator', spec: parseTeamAgentSpec(t.orchestrator_spec) },
        ...teamMembers.map((m) => {
          const mSpec = parseTeamAgentSpec(m.spec);
          return {
            name: slotName(m.agent_id, mSpec, m.role_label || mSpec?.cli || '', '(deleted agent)'),
            spec: mSpec,
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
        account_id: t.account_id,
        is_global: t.account_id === null,
        owner_account_id: t.owner_account_id,
        allowed_account_ids: Array.isArray(t.allowed_account_ids) ? t.allowed_account_ids : [],
        name: t.name,
        description: t.description,
        orchestrator_agent_id: t.orchestrator_agent_id,
        orchestrator_name: orchName,
        // P4c-4: Host presence 로 판정 (Agent 행 없음).
        orchestrator_online: !!hostById.get(parseTeamAgentSpec(t.orchestrator_spec)?.manager_agent_id ?? '')?.is_online,
        orchestrator_runtime: runtimeFor(parseTeamAgentSpec(t.orchestrator_spec), orchName || 'orchestrator'),
        orchestrator_prompt: t.orchestrator_prompt,
        max_parallel_steps: t.max_parallel_steps,
        max_open_missions: t.max_open_missions,
        enabled: t.enabled !== 0,
        members: teamMembers.map((m) => {
          // P4c-4: Agent 행 없음 — 이름은 위 slots 와 같은 합성 (Host/링크 + spec leaf).
          const mSpec = parseTeamAgentSpec(m.spec);
          const mHost = mSpec ? hostById.get(mSpec.manager_agent_id) ?? null : null;
          const name = slotName(m.agent_id, mSpec, m.role_label || mSpec?.cli || '', '(deleted agent)');
          return {
            id: m.id,
            agent_id: m.agent_id,
            agent_name: name,
            agent_type: mSpec?.cli ?? '',
            is_online: !!mHost?.is_online,
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
    account_id: string;
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
    allowed_account_ids?: string[];
  }): Promise<TeamView> {
    // 실행/생성 주체 workspace — 글로벌 팀이어도 항상 필수다: 이후 팀을 편집할 수
    // 있는 유일한 값인 owner_account_id가 된다(assertTeamWritable). "글로벌"은
    // 로스터가 workspace 비종속이라는 뜻일 뿐, 생성 자체에 workspace 컨텍스트가
    // 필요 없다는 뜻이 아니다.
    const callerAccountId = (input.account_id || '').trim();
    const name = (input.name || '').trim();
    if (!callerAccountId) throw orchestrationError(400, 'account_id is required');
    if (!name) throw orchestrationError(400, 'name is required');

    const isGlobal = !!input.is_global;
    const teamAccountId: string | null = isGlobal ? null : callerAccountId;

    const orchestratorSpec = this.parseSpecInput(input.orchestrator, 'orchestrator');

    const allowedAccountIds = isGlobal ? normalizeAccountIds(input.allowed_account_ids) : null;
    await this.assertWorkspacesExist(allowedAccountIds);

    // Resolve the orchestrator identity BEFORE inserting the team: a team row
    // with no orchestrator cannot run a mission, so a half-applied create must
    // leave nothing behind rather than an unusable team the operator has to
    // notice and clean up.
    const orchestratorAgentId = await this.resolveSlotAgentId(orchestratorSpec, teamAccountId);

    const team = await this.teamRepo.save(
      this.teamRepo.create({
        account_id: teamAccountId,
        owner_account_id: callerAccountId,
        allowed_account_ids: allowedAccountIds,
        name,
        description: (input.description || '').trim(),
        orchestrator_agent_id: orchestratorAgentId,
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
      orchestrator_agent_id: orchestratorAgentId,
    });
    return this.getTeam(team.id, callerAccountId);
  }

  async updateTeam(
    teamId: string,
    accountId: string,
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
      allowed_account_ids?: string[];
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);
    let orchRuntimeEdited: { before: TeamAgentSpec | null; previousAgentId: string | null; merged?: TeamAgentSpec } | null = null;

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
      orchRuntimeEdited = {
        before: parseTeamAgentSpec(team.orchestrator_spec),
        previousAgentId: team.orchestrator_agent_id,
      };
      const merged = this.mergeSpecInput(orchRuntimeEdited.before, patch.orchestrator, 'orchestrator');
      // P4c-2b: 구 Agent 행은 정리하지 않는다 — 미션 이력이 참조할 수 있어
      // 남겨둔다 (P4c-4에서 무참조 행을 일괄 정리).
      team.orchestrator_agent_id = await this.resolveSlotAgentId(merged, team.account_id);
      team.orchestrator_spec = merged as unknown as Record<string, any>;
      orchRuntimeEdited.merged = merged;
    }
    if (patch.enabled !== undefined) team.enabled = patch.enabled ? 1 : 0;
    // 글로벌 팀에만 적용 — 이 파일의 다른 is_global 게이팅 규칙(requireWorkspaceAgent,
    // assertTeamWritable)과 동일하게. workspace 종속 팀은 허용목록을 쓸 데가
    // 없으므로(createMission이 그 팀에는 이 값을 참조하지 않는다) 여기서 조용히
    // 저장해봤자 아무도 손댈 수 없는 죽은 데이터가 된다.
    if (patch.allowed_account_ids !== undefined && team.account_id === null) {
      const normalized = normalizeAccountIds(patch.allowed_account_ids);
      await this.assertWorkspacesExist(normalized);
      team.allowed_account_ids = normalized;
    }

    await this.teamRepo.save(team);
    if (orchRuntimeEdited?.merged) {
      await this.notifySlotRuntimeChanged(
        orchRuntimeEdited.before, orchRuntimeEdited.previousAgentId, orchRuntimeEdited.merged, team.account_id);
      // 멤버 슬롯과 같은 회전 함정: orchestrator 스펙 변경이 새 identity를
      // 민 경우 restart는 이전 키에만 가므로 새 키를 프로비저닝한다.
      if (team.orchestrator_agent_id && team.orchestrator_agent_id !== orchRuntimeEdited.previousAgentId) {
        await this.provisionSlotBestEffort(
          orchRuntimeEdited.merged,
          team.account_id ?? team.owner_account_id,
          `${team.name}/orchestrator`,
        );
      }
    }
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
    // P4c-2b: Agent 행을 정리하지 않는다 — runtime identity는 행이 없고, 구
    // provisioned 행은 미션 이력이 참조할 수 있다 (P4c-4에서 일괄 정리).
    this.logService.info('Orchestration', `team deleted ${team.id}`, { account_id: accountId });
  }

  async addMember(
    teamId: string,
    accountId: string,
    input: {
      /** Runtime spec for the new slot — Runtime Host / CLI / model / working folder. */
      runtime?: unknown;
      /**
       * Put the ORCHESTRATOR on the roster as an executing member. `runtime`
       * is ignored when this is set; the row takes the orchestrator's current
       * identity and spec.
       *
       * P4c-4: identical specs already address one shared worker, so this is
       * the same identity the orchestrator's spec would resolve to anyway. The
       * flag remains the explicit marker for "the orchestrator working as a
       * member", and the updateMember guard still rejects runtime edits on
       * such a row so the orchestrator keeps exactly one editing surface
       * (updateTeam) instead of silently forking on the roster.
       */
      as_orchestrator?: boolean;
      role_label?: string;
      capabilities?: string;
      max_concurrent?: number;
    },
  ): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);

    let spec: TeamAgentSpec | null;
    let agentId: string;
    if (input.as_orchestrator) {
      if (!team.orchestrator_agent_id) {
        throw orchestrationError(400, `team "${team.name}" has no orchestrator to put on the roster`);
      }
      agentId = team.orchestrator_agent_id;
      spec = parseTeamAgentSpec(team.orchestrator_spec);
    } else {
      spec = this.parseSpecInput(input.runtime, 'runtime');
      // 편집 호출자가 아니라 팀 자신의 workspace를 기준으로 스코핑한다 — updateTeam의
      // orchestrator 교체 분기와 같은 이유.
      agentId = await this.resolveSlotAgentId(spec, team.account_id);
    }

    // P4c-3b: 같은 runtime identity를 두 슬롯이 공유할 수 있다 (shared 폴더
    // 협업). agent_id 중복을 거부하지 않는다 — 동시성 상한은 identity 단위로
    // 합쳐서 본다 (runner capByAgent). 이름 충돌은 role_label이 구분한다.
    const count = await this.memberRepo.count({ where: { team_id: team.id } });
    await this.memberRepo.save(
      this.memberRepo.create({
        team_id: team.id,
        account_id: team.account_id,
        agent_id: agentId,
        spec: (spec as unknown as Record<string, any>) ?? null,
        role_label: (input.role_label || '').trim(),
        capabilities: (input.capabilities || '').trim(),
        max_concurrent: clampConcurrent(input.max_concurrent),
        position: count,
      }),
    );
    // 새로 만든 identity는 아직 어느 호스트에도 materialize된 적 없다 — 지금
    // 프로비저닝하지 않으면 첫 디스패치가 빈 cli-home으로 나가 "Not logged in"이
    // 된다. 실패해도 저장은 유효하고 미션 시작 훅이 재시도한다.
    if (spec) {
      await this.provisionSlotBestEffort(
        spec,
        team.account_id ?? team.owner_account_id,
        `${team.name}/${input.role_label || spec.cli || agentId.slice(0, 8)}`,
      );
    }
    return this.getTeam(team.id, accountId);
  }

  async updateMember(
    teamId: string,
    accountId: string,
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
      const before = parseTeamAgentSpec(member.spec);
      const previousAgentId = member.agent_id;
      const merged = this.mergeSpecInput(before, patch.runtime, 'runtime');
      // P4c-3b: identity가 바뀌어도 중복 검사는 하지 않는다 (addMember와 동일 이유).
      member.agent_id = await this.resolveSlotAgentId(merged, team.account_id);
      member.spec = merged as unknown as Record<string, any>;
      await this.memberRepo.save(member);
      // 슬롯이 가리키던 worker(교체 전 키)의 살아있는 세션을 새 스펙으로
      // 갈아태운다. cli/dir 가 바뀌면 키도 바뀌어 새 worker 는 깨끗이 뜨지만,
      // 묵은 키의 세션은 예전 launch context 로 계속 돌기 때문이다.
      await this.notifySlotRuntimeChanged(before, previousAgentId, merged, team.account_id);
      // credential 변경도 identity를 회전시킨다 — restart는 이전 키에만 가므로
      // 새 키를 여기서 프로비저닝하지 않으면 새 identity가 빈 cli-home으로
      // 디스패치돼 "Not logged in"이 된다.
      if (member.agent_id !== previousAgentId) {
        await this.provisionSlotBestEffort(
          merged,
          team.account_id ?? team.owner_account_id,
          `${team.name}/${member.role_label || merged.cli || member.agent_id.slice(0, 8)}`,
        );
      }
      return this.getTeam(team.id, accountId);
    }

    await this.memberRepo.save(member);
    return this.getTeam(team.id, accountId);
  }

  async removeMember(teamId: string, accountId: string, memberId: string): Promise<TeamView> {
    const team = await this.requireTeam(teamId, accountId);
    this.assertTeamWritable(team, accountId);
    const member = await this.memberRepo.findOne({ where: { id: memberId, team_id: team.id } });
    if (!member) throw orchestrationError(404, 'team member not found');
    await this.memberRepo.delete({ id: member.id });
    // P4c-2b: Agent 행을 정리하지 않는다 (deleteTeam과 동일).
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

/**
 * The spawn-relevant slice of a slot spec (old provisioner's
 * `spawnRelevantFields`, ported from the Agent row to the spec): cli, model,
 * working_dir, credential, cli_runtime_profile, runtime_config. folder_scope
 * is deliberately excluded — it changes where a STEP runs (a per-dispatch
 * decision), not how the identity is spawned.
 */
function hostVisibleFieldsChanged(before: TeamAgentSpec | null, merged: TeamAgentSpec): boolean {
  const pick = (s: TeamAgentSpec | null) => [
    s?.cli ?? '',
    s?.model ?? '',
    s?.working_dir ?? '',
    s?.credential_id ?? '',
    s?.cli_runtime_profile ?? '',
    JSON.stringify(s?.runtime_config ?? null),
  ].join('\u0000');
  return pick(before) !== pick(merged);
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
function normalizeAccountIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean)));
  return ids.length ? ids : null;
}

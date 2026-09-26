/**
 * Turns an Orchestration team slot's runtime spec (Runtime Host / CLI / model /
 * working folder) into a dispatchable Agent identity, and keeps the two in sync
 * for the life of the slot.
 *
 * This is the whole mechanism behind "you no longer pre-create Agents to build a
 * team". The team editor writes a `TeamAgentSpec`; this service owns the Agent
 * row that spec implies — creating it, editing it in place when the spec
 * changes, deleting it when the slot goes away, and nudging the owning manager
 * (`set_working_dir` / `spawn_agent`) so a live host picks the change up without
 * a restart.
 *
 * Two deliberate ownership rules:
 *
 *  1. **We only ever mutate rows we created** (`Agent.origin === 'orchestration'`).
 *     A slot that still points at an operator-authored Agent — every row
 *     back-filled from the pre-refactor roster does — is left untouched; editing
 *     its spec provisions a NEW team-owned identity instead. Mutating an
 *     operator's agent would change the cwd/model of whatever else uses it
 *     (tickets, chat, other teams) as a side effect of editing one team.
 *
 *  2. **A team-owned identity belongs to exactly one slot.** No cross-slot
 *     reuse, even for an identical spec. That is what makes in-place editing
 *     safe (nothing else can be reading the row) and deletion unambiguous, and
 *     it is also what lets two members legitimately share a working folder while
 *     staying separately addressable — which is the point of the folder-sharing
 *     feature: they need distinct identities to be assigned distinct steps, and a
 *     shared folder to collaborate in.
 *
 * Every write here is followed by a best-effort control command to the manager.
 * Best-effort is correct rather than lax: the dispatch path already recovers on
 * its own (RoomMessagingService raises an autostart request for an offline
 * assignee, AgentAutostartService issues `spawn_agent`, the DispatchIntent
 * outbox re-dispatches once it connects), so a manager that is offline while the
 * operator edits the team must not fail the edit.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Credential } from '../../entities/Credential';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { LogService } from '../../services/log.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { InstanceRegistryService, InstanceRecord } from '../agent-manager/instance-registry.service';
import { globalRuntimeProfiles } from '../../common/claude-backend-registry';
import { CLI_RUNTIME_NONE } from '../../common/cli-runtime-profiles';
import {
  ORCHESTRATION_AGENT_ORIGIN,
  TeamAgentSpec,
  workingDirLeaf,
} from '../../common/orchestration-member-spec';
import { orchestrationError } from './orchestration-errors';
import { HostModelsError, HostModelsService } from '../agent-manager/host-models.service';

export { ORCHESTRATION_AGENT_ORIGIN };

const ISSUED_BY = 'system:orchestration-roster';

// The host's re-enumeration is a per-adapter parallel scan with a few seconds of
// worst case, plus the ack POST round trip. Same window the client helper uses.

export interface ProvisionSlotInput {
  spec: TeamAgentSpec;
  /** The TEAM's workspace_id (null = global team). Not the editing caller's. */
  workspaceId: string | null;
  teamName: string;
  /** Distinguishing label for the identity name: a role_label, or 'orchestrator'. */
  label: string;
  /** The identity this slot currently points at, if any. */
  currentAgentId: string | null;
}

export interface ProvisionSlotResult {
  agent: Agent;
  /** True when a new identity was minted (as opposed to editing the existing one). */
  created: boolean;
  /**
   * Why the owning manager could not be nudged, when it could not be. Purely
   * informational — the slot is saved and dispatchable either way, because the
   * dispatch path auto-starts the agent when work first arrives.
   */
  manager_notice: string | null;
}

/** One Runtime Host as the team editor needs to see it. */
export interface RuntimeHostView {
  manager_agent_id: string;
  manager_name: string;
  hostname: string;
  is_online: boolean;
  instance_id: string | null;
  last_seen_at: string | null;
  /** CLIs this host actually has installed, per its heartbeat. */
  clis: string[];
  /** cliType → model ids the host enumerated at boot. */
  available_models: Record<string, string[]>;
  cli_versions: Record<string, string>;
  /**
   * Working folders already in use on this host — the "share a folder with a
   * teammate" picker. Union of every Agent row's `working_dir` under this host
   * and every team slot spec naming it, so a folder shows up whether it was
   * first typed on the AI Agents screen or in a team editor.
   */
  working_dirs: string[];
}

@Injectable()
export class OrchestrationAgentProvisionerService {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    @InjectRepository(OrchestrationTeamMember) private readonly memberRepo: Repository<OrchestrationTeamMember>,
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    private readonly registry: InstanceRegistryService,
    private readonly commands: AgentManagerCommandService,
    private readonly hostModels: HostModelsService,
    private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  // ── Referential validation ────────────────────────────────────────────────

  /**
   * Checks the spec's foreign keys. Shape validation already happened in
   * `normalizeTeamAgentSpec`; this is the half that needs the database.
   *
   * Fails fast rather than dropping a bad reference, for the same reason
   * `createManagedAgent` does: a silently-ignored typo surfaces much later as a
   * mysterious spawn failure on somebody else's machine.
   */
  private async assertSpecReferences(spec: TeamAgentSpec, workspaceId: string | null): Promise<Agent> {
    const manager = await this.agentRepo.findOne({ where: { id: spec.manager_agent_id } });
    if (!manager) throw orchestrationError(400, `Runtime Host ${spec.manager_agent_id} does not exist`);
    if (manager.type !== 'manager') {
      throw orchestrationError(400, `${manager.name} is not a Runtime Host (paired manager) identity`);
    }

    if (spec.credential_id) {
      // Accept a global credential (workspace_id NULL) or one scoped to the
      // team's own workspace. A global team (workspaceId null) therefore gets
      // global credentials only — the same deny rule the roster uses for
      // agents, for the same leak reason.
      const cred = await this.credentialRepo.findOne({ where: { id: spec.credential_id } });
      if (!cred || (cred.workspace_id !== null && cred.workspace_id !== workspaceId)) {
        throw orchestrationError(400, `credential ${spec.credential_id} is not available to this team`);
      }
    }

    if (spec.cli_runtime_profile && spec.cli_runtime_profile !== CLI_RUNTIME_NONE) {
      const profiles = await globalRuntimeProfiles(this.dataSource);
      if (!profiles.some((p) => p.id === spec.cli_runtime_profile)) {
        throw orchestrationError(400, `cli_runtime_profile "${spec.cli_runtime_profile}" does not exist`);
      }
    }

    return manager;
  }

  // ── Provision / release ───────────────────────────────────────────────────

  async provisionSlot(input: ProvisionSlotInput): Promise<ProvisionSlotResult> {
    const { spec, workspaceId } = input;
    await this.assertSpecReferences(spec, workspaceId);

    const current = input.currentAgentId
      ? await this.agentRepo.findOne({ where: { id: input.currentAgentId } })
      : null;

    // Reusable in place only if WE own it and it still lives on the same host.
    // A host change is not an edit: the manager owns the per-agent cli-home, api
    // key and spawn state, so moving an identity between hosts would leave that
    // state stranded on the old machine. Mint a fresh identity and retire the
    // old one instead.
    const reusable =
      current
      && current.origin === ORCHESTRATION_AGENT_ORIGIN
      && current.manager_agent_id === spec.manager_agent_id;

    if (reusable) {
      // `applySpec` sets is_active = 1, which is also how a slot re-adopts an
      // identity that a previous `releaseIdentity` retired.
      const before = spawnRelevantFields(current!);
      const updated = await this.applySpec(current!, spec, input, workspaceId);
      const changed = spawnRelevantFields(updated) !== before;
      const notice = changed ? await this.notifyRuntimeChanged(updated) : null;
      return { agent: updated, created: false, manager_notice: notice };
    }

    const agent = await this.createIdentity(spec, input, workspaceId);
    // Retire the identity we just replaced — but only if it was ours. An
    // operator-authored row (every back-filled legacy member) is left alone.
    if (current && current.origin === ORCHESTRATION_AGENT_ORIGIN && current.id !== agent.id) {
      await this.releaseIdentity(current.id, { excludeMemberIds: [], excludeTeamIds: [] });
    }
    const notice = await this.notifySpawn(agent);
    return { agent, created: true, manager_notice: notice };
  }

  /**
   * Retire a team-owned identity once no roster slot references it any more.
   *
   * Deleted or deactivated, not both-or-neither — which one depends on whether
   * the identity ever did any work:
   *
   *   - **Never ran** (no mission orchestrated, no step assigned): the row is
   *     deleted. This is the mis-clicked slot, the wrong host picked and
   *     corrected a minute later. Nothing refers to it, so leaving a row behind
   *     would only accumulate clutter.
   *   - **Ran at least once**: the row is DEACTIVATED (`is_active = 0`), never
   *     deleted. Mission timelines, step assignees and room participants store
   *     the agent id and resolve the name at read time, so deleting the row
   *     would silently rewrite finished history into "(deleted agent)". An
   *     operator removing a member from a roster is not asking to erase what
   *     that member did. A deactivated identity cannot be dispatched to and
   *     stays out of every picker (`origin`), so it costs nothing but a row.
   *
   * The reference scan is what keeps this safe against the obvious ordering
   * hazard: `removeMember` deletes the member row and then releases, while
   * `updateMember` releases a replaced identity while its row still points at
   * the NEW one. Callers that have already committed the change pass no
   * exclusions; callers releasing mid-transaction pass the rows to ignore.
   */
  async releaseIdentity(
    agentId: string | null | undefined,
    opts: { excludeMemberIds?: string[]; excludeTeamIds?: string[] } = {},
  ): Promise<void> {
    const id = (agentId || '').trim();
    if (!id) return;
    const agent = await this.agentRepo.findOne({ where: { id } });
    // Never touch an identity we did not create.
    if (!agent || agent.origin !== ORCHESTRATION_AGENT_ORIGIN) return;

    const excludeMemberIds = opts.excludeMemberIds ?? [];
    const excludeTeamIds = opts.excludeTeamIds ?? [];
    const memberRefs = await this.memberRepo.count({
      where: excludeMemberIds.length
        ? { agent_id: id, id: Not(In(excludeMemberIds)) }
        : { agent_id: id },
    });
    if (memberRefs > 0) return;
    const teamRefs = await this.teamRepo.count({
      where: excludeTeamIds.length
        ? { orchestrator_agent_id: id, id: Not(In(excludeTeamIds)) }
        : { orchestrator_agent_id: id },
    });
    if (teamRefs > 0) return;

    const [stepHistory, missionHistory] = await Promise.all([
      this.stepRepo.count({ where: { assignee_agent_id: id } }),
      this.missionRepo.count({ where: { orchestrator_agent_id: id } }),
    ]);
    if (stepHistory > 0 || missionHistory > 0) {
      if (agent.is_active !== 0) {
        agent.is_active = 0;
        await this.agentRepo.save(agent);
      }
      this.logService.info(
        'Orchestration',
        `retired team-owned agent identity ${id.slice(0, 8)} (${agent.name}) — kept for mission history ` +
          `(${missionHistory} mission(s), ${stepHistory} step(s))`,
        { workspace_id: agent.workspace_id ?? undefined },
      );
      return;
    }

    await this.agentRepo.delete({ id });
    this.logService.info(
      'Orchestration',
      `deleted unused team-owned agent identity ${id.slice(0, 8)} (${agent.name}) — it never ran`,
      { workspace_id: agent.workspace_id ?? undefined },
    );
  }

  // ── Identity construction ─────────────────────────────────────────────────

  private async createIdentity(
    spec: TeamAgentSpec,
    input: ProvisionSlotInput,
    workspaceId: string | null,
  ): Promise<Agent> {
    const name = await this.uniqueName(spec, input, null);
    return this.agentRepo.save(
      this.agentRepo.create({
        name,
        description: this.describeSlot(spec, input),
        // The CLI selector lives in `type`, as it does for every managed agent.
        type: spec.cli,
        is_active: 1,
        workspace_id: workspaceId,
        working_dir: spec.working_dir,
        manager_agent_id: spec.manager_agent_id,
        model: spec.model,
        credential_id: spec.credential_id,
        cli_runtime_profile: spec.cli_runtime_profile,
        runtime_config: spec.runtime_config as any,
        origin: ORCHESTRATION_AGENT_ORIGIN,
        roles: '[]',
      }),
    );
  }

  private async applySpec(
    agent: Agent,
    spec: TeamAgentSpec,
    input: ProvisionSlotInput,
    workspaceId: string | null,
  ): Promise<Agent> {
    agent.type = spec.cli;
    agent.working_dir = spec.working_dir;
    agent.model = spec.model;
    agent.credential_id = spec.credential_id;
    agent.cli_runtime_profile = spec.cli_runtime_profile;
    agent.runtime_config = spec.runtime_config as any;
    agent.workspace_id = workspaceId;
    agent.description = this.describeSlot(spec, input);
    agent.is_active = 1;
    const name = await this.uniqueName(spec, input, agent.id);
    if (name) agent.name = name;
    return this.agentRepo.save(agent);
  }

  /**
   * Identity name for a slot. Displayed everywhere as `<Manager>/<Agent>` (see
   * utils/agent-name.ts), so the leaf only has to disambiguate within one host:
   * `<team> · <role or cli>`, with the working-folder leaf appended when two
   * slots on the same host would otherwise collide — which is exactly the case
   * a multi-machine, multi-folder team creates, and precisely when the folder is
   * the distinguishing fact worth showing.
   */
  private async uniqueName(
    spec: TeamAgentSpec,
    input: ProvisionSlotInput,
    selfId: string | null,
  ): Promise<string> {
    const team = clip(input.teamName, 24) || 'team';
    const role = clip(input.label, 18) || spec.cli;
    const base = `${team} · ${role}`;

    const siblings = await this.agentRepo.find({
      where: { manager_agent_id: spec.manager_agent_id },
      select: { id: true, name: true } as any,
    });
    const taken = new Set(siblings.filter((a) => a.id !== selfId).map((a) => a.name));
    if (!taken.has(base)) return base;

    const withFolder = `${base} @${clip(workingDirLeaf(spec.working_dir), 16)}`;
    if (!taken.has(withFolder)) return withFolder;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${withFolder} #${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${withFolder} #${Date.now().toString(36)}`;
  }

  /**
   * Human-readable summary on the Agent row so the AI Agents screen explains
   * where a team-owned identity came from instead of showing a blank row.
   */
  private describeSlot(spec: TeamAgentSpec, input: ProvisionSlotInput): string {
    const scope = spec.folder_scope === 'shared'
      ? 'shared working folder'
      : 'per-step isolated folder';
    return (
      `Orchestration team slot "${input.label}" of team "${input.teamName}" — ` +
      `${spec.cli}${spec.model ? ` (${spec.model})` : ''} in ${spec.working_dir} (${scope}). ` +
      `Managed by AWB; edit it from the team's roster.`
    );
  }

  // ── Manager notification ──────────────────────────────────────────────────

  /**
   * Ask the owning manager to start the freshly minted identity. Returns a
   * human-readable notice when it could not, or null on success.
   */
  private async notifySpawn(agent: Agent): Promise<string | null> {
    const result = await this.commands.issueSpawnAgent(
      agent.id,
      ISSUED_BY,
      agent.workspace_id ?? undefined,
    );
    if (result.ok) return null;
    return spawnNotice(result.reason);
  }

  /**
   * Re-sync a live Runtime Host after an in-place runtime change.
   *
   * `restart_agent`, not `set_working_dir`. The manager caches the whole launch
   * context (cli, model, working_dir, runtime_config, cli-home) when it first
   * spawns an identity, and rebuilds that cache from its own on-disk copy on
   * restart — so a `set_working_dir` would carry a new folder while leaving an
   * edited CLI or model stale indefinitely. `restart_agent` reaps the identity's
   * live sessions and then re-reads the canonical record from AWB, which is the
   * only command that makes every field of an edited slot take effect.
   *
   * Reaping matters as much as re-reading: a persistent chat/ticket session is
   * keyed on (room, agent) with the CLI baked in at spawn, so a still-running
   * session would keep answering on the OLD CLI even after the context cache is
   * corrected. It also re-pushes any in-flight ticket work it interrupted.
   */
  private async notifyRuntimeChanged(agent: Agent): Promise<string | null> {
    if (!agent.manager_agent_id) return null;
    const inst = this.commands.resolveLiveManagerInstance(agent.manager_agent_id);
    if (!inst) {
      return 'Runtime Host is offline — the new runtime applies the next time it connects.';
    }
    try {
      await this.commands.issue(
        inst,
        'restart_agent',
        { agent_id: agent.id, workspace_id: agent.workspace_id ?? undefined },
        ISSUED_BY,
      );
      return null;
    } catch (e: any) {
      this.logService.warn('Orchestration', `restart_agent dispatch failed for ${agent.id.slice(0, 8)}`, {
        error: e?.message || String(e),
      });
      return 'Could not notify the Runtime Host of the change — restart the agent to pick it up.';
    }
  }

  // ── Runtime Host catalogue (the team editor's data source) ─────────────────

  /**
   * Every Runtime Host an operator can place a team slot on, with the CLI /
   * model / working-folder candidates for each.
   *
   * Offline hosts are included, with `is_online: false`. Hiding them would make
   * a team un-editable exactly when a machine is down — and since dispatch
   * queues work for an offline assignee anyway (autostart + DispatchIntent
   * outbox), authoring against an offline host is legitimate. Their CLI/model
   * lists come from Agent rows already on that host, which is the only thing
   * available with no heartbeat.
   *
   * Deliberately NOT narrowed by workspace. A Runtime Host is a machine, not a
   * workspace member — managers are paired once by an admin and legitimately run
   * slots for several workspaces (the cross-workspace `listManagers` endpoint
   * takes the same position). The workspace scope that matters is stamped onto
   * the identity by `provisionSlot` from the TEAM's own workspace_id. The
   * parameter stays in the signature because the caller is workspace-scoped and
   * a future per-workspace host allowlist would land here.
   */
  async listRuntimeHosts(_workspaceId: string): Promise<RuntimeHostView[]> {
    const managers = await this.agentRepo.find({ where: { type: 'manager' }, order: { name: 'ASC' } });
    if (managers.length === 0) return [];

    const live = new Map<string, InstanceRecord>();
    for (const rec of this.registry.list()) {
      if (rec.mode !== 'manager') continue;
      const seen = live.get(rec.agent_id);
      if (!seen || rec.last_seen_at > seen.last_seen_at) live.set(rec.agent_id, rec);
    }

    // Folder + CLI candidates known from the agent rows on each host. Includes
    // operator-authored agents on purpose: "reuse the folder my ticket agent
    // already works in" is the main way a mission gets to share a real checkout.
    const managerIds = managers.map((m) => m.id);
    const hosted = await this.agentRepo.find({
      where: { manager_agent_id: In(managerIds) },
      select: { id: true, manager_agent_id: true, type: true, working_dir: true } as any,
    });
    const folders = new Map<string, Set<string>>();
    const clisFromRows = new Map<string, Set<string>>();
    for (const a of hosted) {
      const host = a.manager_agent_id!;
      if (a.working_dir && a.working_dir.trim()) {
        addTo(folders, host, a.working_dir.trim());
      }
      if (a.type && a.type !== 'manager') addTo(clisFromRows, host, a.type);
    }

    // Folders named by team slots but not (yet) by any agent row — e.g. a slot
    // authored while its host was offline, before the identity ever spawned.
    for (const dir of await this.specWorkingDirs()) {
      addTo(folders, dir.manager_agent_id, dir.working_dir);
    }

    return managers.map((m) => {
      const rec = live.get(m.id) ?? null;
      const clis = new Set<string>([
        ...(rec?.cli_adapters ?? []),
        ...(clisFromRows.get(m.id) ?? []),
      ]);
      return {
        manager_agent_id: m.id,
        manager_name: m.name,
        hostname: rec?.hostname ?? '',
        is_online: !!rec,
        instance_id: rec?.instance_id ?? null,
        last_seen_at: rec?.last_seen_at ?? null,
        clis: Array.from(clis).sort(),
        // 모델 목록은 **단일 출처**에서 그대로 가져온다(HostModelsService). 예전에는
        // 여기서 하트비트 + 기존 agent 행에 핀된 모델을 합쳐 알파벳순으로 다시 정렬했다 —
        // 그래서 같은 호스트의 opencode 목록이 팀 슬롯(mission)과 세션/Agent 다이얼로그
        // 에서 내용도 순서도 달랐다. 열거가 실패한 호스트에서 저장된 값이 사라지는 문제는
        // 화면이 이미 다루고 있다(슬롯 편집기가 저장된 model 을 목록에 덧붙이고 자유
        // 입력도 받는다) — 그것 때문에 목록 자체를 갈라놓을 이유는 없다.
        available_models: this.hostModels.modelsByCli(m.id),
        cli_versions: rec?.cli_versions ?? {},
        working_dirs: Array.from(folders.get(m.id) ?? []).sort(),
      };
    });
  }

  /**
   * Ask a Runtime Host to re-enumerate its per-CLI model lists, then return the
   * refreshed catalogue entry.
   *
   * A host enumerates models once at boot, per CLI, by shelling out to that CLI
   * with a short timeout (`opencode models`, `claude --help`, …) and treating any
   * failure as "no models". A cold or slow CLI therefore leaves its key missing
   * from the heartbeat, and the slot editor would offer free text for that CLI
   * forever even though the host can perfectly well list them a second later.
   * That is the gap this closes — the same one the admin agent dialog closes with
   * its own probe (ticket 40110b64).
   *
   * Why this lives here rather than reusing `/api/admin/agent-manager/...`: those
   * endpoints are ADMIN_ACCESS, while authoring a team is MANAGE_ACTIONS. An
   * operator who may build a roster must be able to fill its model dropdown
   * without also being an instance admin.
   *
   * The ack wait is server-side because the ledger is server-side: the browser
   * would otherwise poll an admin-only outcome endpoint. A timeout is NOT an
   * error — the command is already dispatched, so a late enumeration still
   * arrives on the next heartbeat; the caller just gets the current list back.
   */
  async refreshHostModels(managerAgentId: string, workspaceId: string): Promise<RuntimeHostView | null> {
    // 재열거 + ack 대기는 HostModelsService 가 한다 — Agent 다이얼로그 · 세션 설정과
    // 같은 경로. 여기서는 그 결과에 이 로스터 화면 고유의 병합(agent 행에 핀된 모델)만 얹는다.
    let id: string;
    try {
      id = (await this.hostModels.refresh(managerAgentId, ISSUED_BY)).manager_agent_id;
    } catch (err) {
      if (err instanceof HostModelsError) throw orchestrationError(err.status, err.message);
      throw err;
    }
    const hosts = await this.listRuntimeHosts(workspaceId);
    return hosts.find((h) => h.manager_agent_id === id) ?? null;
  }

  /** `(manager, working_dir)` pairs named by existing team slots. */
  private async specWorkingDirs(): Promise<Array<{ manager_agent_id: string; working_dir: string }>> {
    const out: Array<{ manager_agent_id: string; working_dir: string }> = [];
    const push = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const spec = raw as Record<string, unknown>;
      const host = typeof spec.manager_agent_id === 'string' ? spec.manager_agent_id.trim() : '';
      const dir = typeof spec.working_dir === 'string' ? spec.working_dir.trim() : '';
      if (host && dir) out.push({ manager_agent_id: host, working_dir: dir });
    };
    for (const m of await this.memberRepo.find({ select: { id: true, spec: true } as any })) push(m.spec);
    for (const t of await this.teamRepo.find({ select: { id: true, orchestrator_spec: true } as any })) {
      push(t.orchestrator_spec);
    }
    return out;
  }

}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/**
 * The identity fields the Runtime Host bakes into a spawned process. Joined into
 * one string so the caller can compare before/after with a single `!==` and
 * cannot forget a field when the spec grows — the failure mode this guards is
 * silent (the manager keeps running the previous value), so it must not depend
 * on remembering to extend a condition.
 */
function spawnRelevantFields(agent: Agent): string {
  return [
    agent.type,
    agent.model ?? '',
    agent.working_dir,
    agent.credential_id ?? '',
    agent.cli_runtime_profile ?? '',
    JSON.stringify(agent.runtime_config ?? null),
  ].join('\u0000');
}

function clip(value: string, max: number): string {
  const trimmed = (value || '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function spawnNotice(reason: string): string {
  switch (reason) {
    case 'manager_offline':
      return 'Runtime Host is offline — the agent starts automatically once it connects and work is dispatched.';
    case 'no_working_dir':
      return 'No working folder set — set one before this slot can run.';
    case 'runtime_host_required':
      return 'No Runtime Host linked — pick one before this slot can run.';
    case 'agent_not_found':
      return 'Provisioned identity could not be started; it will be retried on first dispatch.';
    default:
      return `Runtime Host could not start the agent yet (${reason}); it will be retried on first dispatch.`;
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { InstanceRegistryService, InstanceRecord } from './instance-registry.service';
import { CommandLedgerService } from './command-ledger.service';
import { runtimeIdentityKey } from '../../common/runtime-spec';
import type { AgentManagerCommand, AgentManagerCommandPayload } from '../../common/types/stream-events';
import type { AutostartFeasibility } from '../../common/agent-lifecycle';


/**
 * Result of an auto-start (spawn_agent) attempt. `ok:true` means the command was
 * dispatched to a live manager; otherwise `reason` classifies why it could not
 * be — the caller surfaces that to the user (chat system message / ticket
 * activity) so a failed auto-start is never itself a silent drop (ticket
 * bfdd80b7 req 3).
 */
export interface SpawnAgentResult {
  ok: boolean;
  reason: AutostartFeasibility | 'agent_not_found';
  command_id?: string;
  instance_id?: string;
}

/**
 * AgentManagerCommandService (ticket bfdd80b7).
 *
 * Extracts the `agent_manager_command` emit path (ledger-record → SSE emit, plus
 * spawn_agent arg hydration) out of AgentManagerController.sendCommand so BOTH
 * the admin "Start" button endpoint AND server-side auto-start issue commands
 * through one code path with identical hydration and ack-race ordering.
 *
 * Lives in AgentManagerModule (owns InstanceRegistry + CommandLedger). It never
 * depends on the agents / chat modules, so the auto-start hub (AgentAutostart-
 * Service in AgentsModule) can inject it without reopening the module cycle.
 */
@Injectable()
export class AgentManagerCommandService {
  constructor(
    private readonly registry: InstanceRegistryService,
    private readonly commandLedger: CommandLedgerService,
    private readonly logService: LogService,
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(ApiKey) private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  /**
   * Newest live `mode:'manager'` instance whose identity supervises
   * `managerAgentId`, or null when no manager is heartbeating for it. The
   * registry TTL (90s) is what makes "no live instance" mean "manager offline".
   */
  resolveLiveManagerInstance(managerAgentId: string): InstanceRecord | null {
    if (!managerAgentId) return null;
    // P4c-4: agent 바인딩 uuid 또는 Host id 둘 다 본다.
    const managers = this.registry
      .list()
      .filter((i) => i.mode === 'manager' && (i.agent_id === managerAgentId || i.host_id === managerAgentId));
    if (managers.length === 0) return null;
    // Newest by started_at (registry.list sorts hostname→started_at asc).
    return managers.reduce((a, b) => (a.started_at >= b.started_at ? a : b));
  }

  /**
   * Emit an `agent_manager_command` to a specific manager instance. Records the
   * command in the ledger BEFORE emitting (a fast manager could ack before the
   * local write commits, which the ack handler would then 410) — same ordering
   * the controller used. For spawn_agent, hydrates missing args from the target
   * Agent row so admin-Start and auto-start fill identical fields server-side.
   */
  async issue(
    instance: InstanceRecord,
    command: AgentManagerCommand,
    args: Record<string, any>,
    issuedBy: string,
  ): Promise<{ command_id: string; issued_at: string }> {
    // P4c-4: spawn 인자는 호출자가 완성해서 준다 (Agent 행 hydration 제거).
    const hydrated: Record<string, any> = { ...args };

    const command_id = randomBytes(8).toString('hex');
    const issued_at = new Date().toISOString();
    const payload: AgentManagerCommandPayload = {
      command_id,
      instance_id: instance.instance_id,
      agent_id: instance.agent_id,
      command,
      args: hydrated,
      issued_by: issuedBy,
      issued_at,
    };
    this.commandLedger.record({
      command_id,
      instance_id: instance.instance_id,
      agent_id: instance.agent_id,
      command,
      // The managed agent this command acts on (ticket 1f750878). For
      // spawn_agent it's the hydrated args.agent_id (the spawn target) — the
      // `/command/ack` handler reads it to markStartError the right agent on a
      // spawn failure. Undefined for verbs without a per-agent target.
      target_agent_id: typeof hydrated.agent_id === 'string' && hydrated.agent_id ? hydrated.agent_id : undefined,
      issued_at,
    });
    activityEvents.emit('agent_manager_command', { ...payload, timestamp: issued_at });
    this.logService.info(
      'AgentManager',
      `Issued ${command} to instance ${instance.instance_id} (agent=${instance.agent_id})`,
      { command_id, issued_by: issuedBy },
    );
    return { command_id, issued_at };
  }

  /**
   * Auto-start (ticket bfdd80b7). Resolve the target agent's owning manager and,
   * if a live manager instance exists and the agent has a working_dir, issue
   * spawn_agent. Every failure is CLASSIFIED (never thrown) so the caller can
   * surface an accurate reason:
   *  - agent_not_found — no Host row and no host-bound key link (P4c-4:
   *    Host 바인딩 없는 identity 는 실행 경로 자체가 없다)
   *   - manager_offline   — a manager is linked but none is heartbeating
   *   - no_working_dir    — a live manager exists but the agent has no working dir
   */
  // P4c-4: Agent 행 없음 — Host/link 해소 후 live 인스턴스 확인. working_dir 은
  // 이 레이어에 없으므로 spawn 실발행은 불가하고 'no_working_dir' 로 분류한다
  // (호출자의 피드백 문구가 정직하게 "시작 불가"를 말한다).
  async issueSpawnAgent(targetAgentId: string, issuedBy: string, accountId?: string): Promise<SpawnAgentResult> {
    if (!targetAgentId) return { ok: false, reason: 'agent_not_found' };
    void accountId;
    void issuedBy;
    let hostId: string | null = null;
    const direct = await this.hostRepo.findOne({ where: { id: targetAgentId } });
    hostId = direct?.id ?? null;
    if (!hostId) return { ok: false, reason: 'agent_not_found' };
    const inst = this.resolveLiveManagerInstance(hostId);
    if (!inst) return { ok: false, reason: 'manager_offline' };
    return { ok: false, reason: 'no_working_dir' };
  }

  /**
   * Materialize one slot-declared runtime identity on its host (`spawn_agent`,
   * best-effort, fire-and-forget — `issue` never waits for the ack).
   *
   * Why callers need this: the dispatch path (`#provisionRuntimeContext` on
   * the manager) only prepares an empty cli-home plus an MCP/apiKey pair —
   * the slot's CLI credential files are written exclusively by the
   * `spawn_agent` / `restart_agent` command path (which fetches them from
   * `GET managed-agents/:id/credential`). An identity that never went through
   * one of those commands therefore runs credential-less ("Not logged in"),
   * no matter what credential the slot names. That happens exactly when the
   * identity is new: a freshly added slot, or any cli/dir/credential edit
   * (the identity hash covers all three, so the edit mints a new key while
   * `restart_agent` only reaps the previous one).
   *
   * Heartbeat-aware skip: when the host already reports a materialized
   * credential (`subscription` / `api_key`) for this key AND the slot still
   * names a credential, there is nothing to do — steady-state mission starts
   * and ticket dispatches stay silent. Everything else (missing metadata,
   * `operator_home`, `missing`, or a slot with no credential that never got
   * its operator-HOME symlink) is (re-)provisioned: `spawn_agent` is
   * idempotent (apiKey reuse, cli-home prep from a clean slate).
   *
   * Never throws — callers treat a failure as "dispatch proceeds as before".
   */
  async provisionSlotIdentity(
    spec: {
      manager_agent_id: string;
      cli: string;
      model?: string | null;
      working_dir: string;
      credential_id?: string | null;
      runtime_config?: unknown;
    },
    opts: { accountId: string; label?: string; issuedBy: string },
  ): Promise<{ ok: boolean; reason: string; skipped?: boolean }> {
    const hostId = String(spec?.manager_agent_id || '').trim();
    const cli = String(spec?.cli || '').trim().toLowerCase();
    const dir = String(spec?.working_dir || '').trim();
    const absolute = dir.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\');
    if (!hostId || !cli || !absolute) return { ok: false, reason: 'bad_spec' };
    const key = runtimeIdentityKey({
      cli,
      working_dir: dir,
      credential_id: spec?.credential_id ?? null,
    });
    let inst: InstanceRecord | null = null;
    try {
      inst = this.resolveLiveManagerInstance(hostId);
    } catch {
      inst = null;
    }
    if (!inst) return { ok: false, reason: 'manager_offline' };
    const slotCredentialId = String(spec?.credential_id || '').trim();
    const reported = inst.agent_credentials?.find((row) => row?.agent_id === key);
    if (
      slotCredentialId &&
      (reported?.kind === 'subscription' || reported?.kind === 'api_key')
    ) {
      return { ok: true, reason: 'already_materialized', skipped: true };
    }
    const model = String((spec as any)?.model || '').trim();
    try {
      const { command_id } = await this.issue(
        inst,
        'spawn_agent',
        {
          agent_id: key,
          name: String(opts.label || cli).slice(0, 120),
          cli,
          working_dir: dir,
          model,
          runtime_config: (spec as any)?.runtime_config ?? null,
          credential_id: slotCredentialId,
          account_id: opts.accountId,
        },
        opts.issuedBy,
      );
      this.logService.info(
        'AgentManager',
        `provisioned slot identity ${key.slice(0, 11)} on host=${hostId.slice(0, 8)} (credential=${slotCredentialId.slice(0, 8) || 'operator-home'})`,
        { command_id, issued_by: opts.issuedBy },
      );
      return { ok: true, reason: 'provisioned' };
    } catch (e: any) {
      this.logService.warn('AgentManager', `slot provision failed for ${key.slice(0, 11)}`, {
        error: e?.message,
      });
      return { ok: false, reason: 'issue_failed' };
    }
  }
}

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
  async issueSpawnAgent(targetAgentId: string, issuedBy: string, workspaceId?: string): Promise<SpawnAgentResult> {
    if (!targetAgentId) return { ok: false, reason: 'agent_not_found' };
    void workspaceId;
    void issuedBy;
    let hostId: string | null = null;
    const direct = await this.hostRepo.findOne({ where: { id: targetAgentId } });
    if (direct) {
      hostId = direct.id;
    } else {
      const link = await this.apiKeyRepo.findOne({
        where: { agent_id: targetAgentId },
        select: { agent_id: true, host_id: true },
      });
      if (link?.host_id) {
        const linked = await this.hostRepo.findOne({ where: { id: link.host_id } });
        if (linked) hostId = linked.id;
      }
    }
    if (!hostId) return { ok: false, reason: 'agent_not_found' };
    const inst = this.resolveLiveManagerInstance(hostId);
    if (!inst) return { ok: false, reason: 'manager_offline' };
    return { ok: false, reason: 'no_working_dir' };
  }
}

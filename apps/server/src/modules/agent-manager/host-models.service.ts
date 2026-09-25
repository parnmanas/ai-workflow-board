import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { AgentManagerCommandService } from './agent-manager-command.service';
import { CommandLedgerService } from './command-ledger.service';
import { InstanceRecord, InstanceRegistryService } from './instance-registry.service';

/**
 * Runtime Host 별 "이 CLI 가 받아들이는 모델 목록" — 모델이 보이는 모든 화면의
 * **단일 출처**.
 *
 * 예전에는 같은 사실을 세 곳이 각자 다른 경로로 읽었다:
 *   - Agent 생성/편집 다이얼로그: admin 전용 command 엔드포인트로
 *     `refresh_available_models` 를 보내고 브라우저가 ack 를 폴링한 뒤 인스턴스
 *     목록을 다시 읽음
 *   - 오케스트레이션 슬롯 편집기: MANAGE_ACTIONS 용 별도 엔드포인트가 서버에서
 *     ack 를 기다림
 *   - Agent Session CLI 설정 / 새 세션: 세션이 한 번 열려 ACP 가 보고한 목록을
 *     DB 에 캐시한 것만 보여주고, 갱신 수단이 없음 — 호스트에 provider 를 새로
 *     로그인해도 세션을 다시 열기 전에는 dropdown 이 옛 목록에 머묾
 *
 * 이제 모든 화면이 (1) 이 서비스의 snapshot 을 읽고 (2) 같은 `refresh()` 로 호스트에
 * 재열거를 시키며, 매니저는 스스로도 주기적으로 재열거해 `available_models_at` 을
 * 하트비트에 싣는다. 클라이언트 훅(`src/cli/hostModels.ts`)은 그 시각으로 오래된
 * 목록을 자동 갱신한다.
 *
 * 열거 자체는 매니저의 CLI 모듈(`clis/<id>` → 어댑터 `listModels()`)이 한다 —
 * 서버는 CLI 이름을 모른다.
 */
export interface HostModelsView {
  manager_agent_id: string;
  manager_name: string;
  is_online: boolean;
  instance_id: string | null;
  /** 매니저가 마지막으로 재열거한 시각. 구버전 매니저는 null. */
  refreshed_at: string | null;
  /** cli → 모델 id. 열거에 실패했거나 모델 개념이 없는 CLI 는 키가 없다. */
  models: Record<string, string[]>;
}

export class HostModelsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const REFRESH_ACK_INTERVAL_MS = 800;
const REFRESH_ACK_ATTEMPTS = 15;

@Injectable()
export class HostModelsService {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly registry: InstanceRegistryService,
    private readonly commands: AgentManagerCommandService,
    private readonly commandLedger: CommandLedgerService,
  ) {}

  private liveRecord(managerAgentId: string): InstanceRecord | null {
    let best: InstanceRecord | null = null;
    for (const rec of this.registry.list()) {
      if (rec.mode !== 'manager' || rec.agent_id !== managerAgentId) continue;
      if (!best || rec.last_seen_at > best.last_seen_at) best = rec;
    }
    return best;
  }

  private async requireManager(managerAgentId: string): Promise<Agent> {
    const id = (managerAgentId || '').trim();
    if (!id) throw new HostModelsError(400, 'manager_agent_id is required');
    const manager = await this.agentRepo.findOne({ where: { id } });
    if (!manager || manager.type !== 'manager') throw new HostModelsError(404, 'Runtime Host not found');
    return manager;
  }

  /** 최신 하트비트 기준 목록. 오프라인이면 빈 목록(마지막 값이 아니라 — 레지스트리 TTL 이 지운다). */
  async snapshot(managerAgentId: string): Promise<HostModelsView> {
    const manager = await this.requireManager(managerAgentId);
    return this.viewOf(manager, this.liveRecord(manager.id));
  }

  /** 하트비트가 보고한 한 CLI 의 목록. 없으면 빈 배열. */
  modelsFor(managerAgentId: string, cli: string): string[] {
    const models = this.liveRecord(managerAgentId)?.available_models?.[cli];
    return Array.isArray(models) ? models.filter((m) => typeof m === 'string' && !!m) : [];
  }

  /**
   * 호스트에 재열거를 시키고 ack 까지 기다린 뒤 갱신된 목록을 돌려준다.
   *
   * ack 대기는 서버에서 한다 — 브라우저가 admin 전용 outcome 엔드포인트를 폴링하지
   * 않아도 되고, 권한 이야기가 "이 호스트의 모델을 볼 수 있으면 갱신도 할 수 있다"
   * 하나로 남는다. 창 안에 ack 가 안 오면 실패가 아니다: 커맨드는 이미 나갔고 늦게
   * 처리돼도 다음 하트비트에 실리므로 현재 목록을 그대로 돌려준다.
   */
  async refresh(managerAgentId: string, issuedBy: string): Promise<HostModelsView> {
    const manager = await this.requireManager(managerAgentId);
    const inst = this.commands.resolveLiveManagerInstance(manager.id);
    if (!inst) {
      throw new HostModelsError(409, `Runtime Host "${manager.name}" is offline — it can only re-list its models while connected.`);
    }
    const { command_id } = await this.commands.issue(inst, 'refresh_available_models', {}, issuedBy);
    await this.awaitAck(command_id);
    return this.viewOf(manager, this.liveRecord(manager.id));
  }

  private async awaitAck(commandId: string): Promise<void> {
    for (let attempt = 0; attempt < REFRESH_ACK_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_ACK_INTERVAL_MS));
      if (this.commandLedger.getOutcome(commandId)) return;
      if (!this.commandLedger.get(commandId)) return; // expired without an ack
    }
  }

  private viewOf(manager: Agent, rec: InstanceRecord | null): HostModelsView {
    const models: Record<string, string[]> = {};
    for (const [cli, list] of Object.entries(rec?.available_models ?? {})) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter((m) => typeof m === 'string' && !!m);
      if (clean.length) models[cli] = clean;
    }
    return {
      manager_agent_id: manager.id,
      manager_name: manager.name,
      is_online: !!rec,
      instance_id: rec?.instance_id ?? null,
      refreshed_at: rec?.available_models_at ?? null,
      models,
    };
  }
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
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

/**
 * 살아 있는 세션이 알려 준 모델 id 를 얼마나 오래 인정하는가. 하트비트가 이미 그
 * 모델을 실어 오면 이 관측은 없어도 되지만, 열거가 실패하는 CLI(또는 provider 를
 * 방금 로그인한 직후)에서는 이것만이 목록의 유일한 출처가 된다. 너무 길면 지운
 * provider 의 모델이 남고, 너무 짧으면 세션을 닫자마자 목록이 줄어든다.
 */
const OBSERVED_MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/** 영속된 ACP 보고 목록을 다시 읽는 최소 간격(스냅샷 조회 시). */
const REPORTED_RELOAD_MS = 60 * 1000;

/**
 * `known_config_options`(ACP 가 보고한 선택지 JSON)에서 model 후보 id 만 뽑는다.
 * 파싱 실패·모양 변화는 빈 배열로 접는다 — 목록 하나가 화면을 막지 않는다.
 */
export function modelIdsFromConfigOptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const option of parsed) {
      if (!option || typeof option !== 'object' || (option as any).category !== 'model') continue;
      for (const choice of (option as any).options ?? []) {
        const value = choice && typeof choice === 'object' ? (choice as any).value : null;
        if (typeof value !== 'string' || !value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

@Injectable()
export class HostModelsService implements OnModuleInit {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(AgentSessionCliSetting) private readonly cliSettings: Repository<AgentSessionCliSetting>,
    private readonly registry: InstanceRegistryService,
    private readonly commands: AgentManagerCommandService,
    private readonly commandLedger: CommandLedgerService,
  ) {}

  /**
   * ACP 어댑터가 보고한 모델 목록은 세션이 열릴 때 `agent_session_cli_settings.
   * known_config_options` 에 **영속**된다. 부팅 때 그것을 읽어 둔다 — 그러지 않으면
   * "세션을 이 프로세스에서 한 번 열었는가" 에 따라 목록이 갈린다.
   *
   * 이것이 운영자가 본 마지막 차이였다: Ralf 의 opencode 는 ACP 가 108개(`opencode-go/*`)를
   * 보고해 세션 화면에는 그게 나왔지만, 하트비트 열거(`opencode models`)는 다른 짧은
   * 목록이었고 팀 슬롯(mission)은 그 짧은 목록만 봤다.
   */
  async onModuleInit(): Promise<void> {
    await this.reloadReportedModels();
  }

  /** 영속된 ACP 보고 목록을 다시 읽는다(부팅·스냅샷 조회 시). 실패는 조용히 접는다. */
  async reloadReportedModels(): Promise<void> {
    try {
      const rows = await this.cliSettings.find();
      const byKey = new Map<string, string[]>();
      for (const row of rows) {
        const models = modelIdsFromConfigOptions(row.known_config_options);
        if (!models.length) continue;
        const key = `${row.manager_id}::${row.cli}`;
        // 같은 host×cli 행이 워크스페이스마다 있다. 가장 많이 아는 행을 쓴다.
        const prev = byKey.get(key);
        if (!prev || models.length > prev.length) byKey.set(key, models);
      }
      this.#reported = byKey;
      this.#reportedAt = Date.now();
    } catch {
      /* 목록 조회 실패가 화면을 막지는 않는다 — 하트비트 목록만으로 답한다. */
    }
  }

  /** 영속된 ACP 보고 목록(부팅 시 로드). host×cli → 모델 id. */
  #reported = new Map<string, string[]>();
  #reportedAt = 0;

  /**
   * 라이브 ACP 세션이 보고한 모델 id — host×cli 별 관측. Agent Session 화면이
   * `noteObservedModels()` 로 넣는다.
   *
   * 왜 필요한가: 세션이 열리면 ACP 어댑터가 그 CLI 가 **실제로** 받아들이는 목록을
   * 보고한다. 예전에는 그 사실이 세션 화면에만 남아 Agent 다이얼로그·팀 슬롯은 더
   * 가난한 목록을 보여줬다 — "session/chat 다르고 mission 다르다"의 절반이 이것이다.
   * 이제 관측은 이 단일 출처로 흘러들어 모든 화면이 같은 목록을 본다.
   */
  #observed = new Map<string, { models: string[]; at: number }>();

  private observedKey(managerAgentId: string, cli: string): string {
    return `${managerAgentId}::${cli}`;
  }

  /** 라이브 세션이 보고한 목록을 기록한다(같은 host×cli 의 이전 관측을 대체). */
  noteObservedModels(managerAgentId: string, cli: string, models: readonly string[]): void {
    const clean = Array.from(new Set(models.filter((m) => typeof m === 'string' && !!m.trim()).map((m) => m.trim())));
    const key = this.observedKey(managerAgentId, cli);
    if (!clean.length) {
      this.#observed.delete(key);
      return;
    }
    this.#observed.set(key, { models: clean, at: Date.now() });
  }

  private observedModels(managerAgentId: string, cli: string): string[] {
    const entry = this.#observed.get(this.observedKey(managerAgentId, cli));
    if (!entry) return [];
    if (Date.now() - entry.at > OBSERVED_MODELS_TTL_MS) {
      this.#observed.delete(this.observedKey(managerAgentId, cli));
      return [];
    }
    return entry.models;
  }

  /**
   * 최종 목록 = **ACP 가 보고한 목록 먼저**, 그 뒤에 하트비트가 아는 나머지.
   *
   * 순서까지 한 규칙으로 정하는 이유: 세션 화면은 ACP 목록을 앞에 두고 호스트가 나중에
   * 알게 된 모델만 뒤에 붙인다(`withModelFallback`). 여기서 하트비트를 앞에 두면 같은
   * 호스트의 같은 CLI 가 화면마다 **다른 순서**로 보인다 — 내용이 같아도 다른 목록처럼
   * 읽힌다. 그래서 두 규칙을 하나로 맞췄다.
   *
   * ACP 보고는 두 갈래를 같은 자격으로 본다: 영속된 것(`known_config_options`, 재시작
   * 후에도 유효)과 지금 살아 있는 세션의 관측(`noteObservedModels`, 더 최신).
   */
  private mergeModels(managerAgentId: string, cli: string, heartbeat: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (m: unknown) => {
      if (typeof m !== 'string' || !m || seen.has(m)) return;
      seen.add(m);
      out.push(m);
    };
    const live = this.observedModels(managerAgentId, cli);
    const persisted = this.#reported.get(this.observedKey(managerAgentId, cli)) ?? [];
    // 라이브 관측이 있으면 그것이 더 최신이다 — 앞에 둔다. 영속 목록은 그 뒤를 채운다.
    for (const m of live) push(m);
    for (const m of persisted) push(m);
    for (const m of heartbeat) push(m);
    return out;
  }

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
    // 다른 화면이 세션을 열어 새 목록을 영속했을 수 있다 — 조회 때 싸게 다시 읽는다.
    if (Date.now() - this.#reportedAt > REPORTED_RELOAD_MS) await this.reloadReportedModels();
    return this.viewOf(manager, this.liveRecord(manager.id));
  }

  /**
   * 이 host×cli 의 모델 목록 — **모델을 보여주는 모든 화면이 이 값을 본다**
   * (Agent 다이얼로그·팀 슬롯·세션 설정·새 세션·Runtime Hosts·오케스트레이션 로스터).
   * 하트비트 열거 + 라이브 세션 관측의 합집합이고, 없으면 빈 배열.
   *
   * 자기만의 합집합을 따로 만들지 말 것 — 그렇게 갈라진 목록이 화면마다 달랐다.
   */
  modelsFor(managerAgentId: string, cli: string): string[] {
    const models = this.liveRecord(managerAgentId)?.available_models?.[cli];
    return this.mergeModels(managerAgentId, cli, Array.isArray(models) ? models : []);
  }

  /** 이 호스트가 아는 모든 CLI 의 목록(로스터·카탈로그용). */
  modelsByCli(managerAgentId: string): Record<string, string[]> {
    const heartbeat = this.liveRecord(managerAgentId)?.available_models ?? {};
    const clis = new Set<string>(Object.keys(heartbeat));
    for (const key of [...this.#observed.keys(), ...this.#reported.keys()]) {
      const [id, cli] = key.split('::');
      if (id === managerAgentId && cli) clis.add(cli);
    }
    const out: Record<string, string[]> = {};
    for (const cli of clis) {
      const list = this.modelsFor(managerAgentId, cli);
      if (list.length) out[cli] = list;
    }
    return out;
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
    const models = this.modelsByCli(manager.id);
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

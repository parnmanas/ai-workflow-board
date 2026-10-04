/**
 * Runtime Host catalogue for the team editor (P4c-2b successor of
 * OrchestrationAgentProvisionerService's read half).
 *
 * The provisioner used to ALSO mint a backing Agent row per slot; slots are
 * now addressed by their runtime identity key (`runtimeIdentityKey(spec)`,
 * common/runtime-spec.ts) and dispatch resolves them without an Agent row, so
 * the mint/edit/delete half is gone. What remains is the read half the team
 * editor needs: every Runtime Host with its CLI / model / working-folder
 * candidates.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { InstanceRegistryService, InstanceRecord } from '../agent-manager/instance-registry.service';
import { orchestrationError } from './orchestration-errors';
import { HostModelsError, HostModelsService } from '../agent-manager/host-models.service';

/** One Runtime Host as the team editor needs to see it. */
export interface RuntimeHostView {
  /**
   * 이 Host 에 슬롯을 걸 때 spec.manager_agent_id 에 넣는 키. P4부터는
   * RuntimeHost id 가 우선 (링크된 manager Agent 행이 있어도 host id) —
   * 새로 만드는 spec 은 더 이상 Agent uuid 를 퍼뜨리지 않는다.
   */
  manager_agent_id: string;
  /**
   * 링크된 manager Agent 행의 uuid (dual-write 시절 spec 이 들고 있던 값).
   * 기존 슬롯이 새 키와 매칭되도록 별칭으로 내려준다 — 클라이언트는 둘 중
   * 하나만 맞아도 같은 Host 로 본다. 이력 rewrite 때 제거 대상.
   */
  legacy_agent_id: string | null;
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

const ISSUED_BY = 'system:orchestration-roster';

@Injectable()
export class OrchestrationHostsService {
  constructor(
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(ApiKey) private readonly apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    @InjectRepository(OrchestrationTeamMember) private readonly memberRepo: Repository<OrchestrationTeamMember>,
    private readonly registry: InstanceRegistryService,
    private readonly hostModels: HostModelsService,
  ) {}

  /**
   * Every Runtime Host an operator can place a team slot on, with the CLI /
   * model / working-folder candidates for each.
   *
   * Offline hosts are included, with `is_online: false`. Hiding them would make
   * a team un-editable exactly when a machine is down — and since dispatch
   * resolves runtime identities without an Agent row anyway (auto-provision on
   * first dispatch), authoring against an offline host is legitimate. Their
   * CLI/working-dir candidates come from team slot specs, which is the only
   * thing available with no heartbeat (model lists stay single-sourced from
   * HostModelsService and are simply absent offline).
   *
   * Deliberately NOT narrowed by workspace. A Runtime Host is a machine, not a
   * workspace member — managers are paired once by an admin and legitimately run
   * slots for several workspaces (the cross-workspace `listManagers` endpoint
   * takes the same position). The workspace scope that matters is stamped onto
   * the slot's credential visibility check at roster-write time.
   */
  async listRuntimeHosts(_workspaceId: string): Promise<RuntimeHostView[]> {
    // P4 (manager identity → RuntimeHost): 카탈로그의 원천을 runtime_hosts 로
    // 옮긴다. manager Agent 행은 legacy 별칭으로만 남는다 (같은 페어링의
    // dual-write 쌍은 api_keys 의 agent_id/host_id 쌍으로 묶어 하나로 합친다).
    // P4c-4: runtime_hosts 원천 (Agent 테이블 없음 — legacy 별칭은
    // api_keys 링크에서 복원한다).
    const hostRows = await this.hostRepo.find({ order: { name: 'ASC' } });
    if (hostRows.length === 0) return [];

    interface Entry {
      key: string;
      name: string;
      legacyAgentId: string | null;
      hostId: string;
      hostname: string;
    }
    const entries = new Map<string, Entry>();
    for (const h of hostRows) {
      entries.set(h.id, {
        key: h.id,
        name: h.name,
        legacyAgentId: null,
        hostId: h.id,
        hostname: h.hostname || '',
      });
    }
    const live = new Map<string, InstanceRecord>();
    for (const rec of this.registry.list()) {
      if (rec.mode !== 'manager') continue;
      for (const id of [rec.agent_id, rec.host_id].filter((v): v is string => !!v)) {
        const seen = live.get(id);
        if (!seen || rec.last_seen_at > seen.last_seen_at) live.set(id, rec);
      }
    }
    const liveFor = (e: Entry): InstanceRecord | null => {
      const cands = [e.hostId && live.get(e.hostId), e.legacyAgentId && live.get(e.legacyAgentId)]
        .filter((r): r is InstanceRecord => !!r)
        .sort((a, b) => (a.last_seen_at > b.last_seen_at ? -1 : 1));
      return cands[0] ?? null;
    };

    // Working-folder candidates come from team slot specs (Agent 행 없음).
    // P4c-4: heartbeat 가 없을 때 CLI 후보도 spec 에서 복원한다 — 슬롯이 지목한
    // CLI 는 그 호스트에서 쓸 수 있음이 이미 입증된 선택지다.
    const folders = new Map<string, Set<string>>();
    const specClis = new Map<string, Set<string>>();
    const knownHostIds = new Set(hostRows.map((h) => h.id));
    const entryKeyFor = (raw: string): string => {
      if (knownHostIds.has(raw)) return raw;
      return raw;
    };
    for (const dir of await this.specWorkingDirs()) {
      addTo(folders, entryKeyFor(dir.manager_agent_id), dir.working_dir);
      if (dir.cli) addTo(specClis, entryKeyFor(dir.manager_agent_id), dir.cli);
    }

    return [...entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const rec = liveFor(e);
        const clis = new Set<string>([
          ...(rec?.cli_adapters ?? []),
          ...(specClis.get(e.key) ?? []),
        ]);
        return {
          manager_agent_id: e.key,
          legacy_agent_id: e.legacyAgentId,
          manager_name: e.name,
          hostname: rec?.hostname ?? e.hostname,
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
          available_models: this.hostModels.modelsByCli(e.hostId),
          cli_versions: rec?.cli_versions ?? {},
          working_dirs: Array.from(folders.get(e.key) ?? []).sort(),
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
  private async specWorkingDirs(): Promise<Array<{ manager_agent_id: string; working_dir: string; cli: string }>> {
    const out: Array<{ manager_agent_id: string; working_dir: string; cli: string }> = [];
    const push = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const spec = raw as Record<string, unknown>;
      const host = typeof spec.manager_agent_id === 'string' ? spec.manager_agent_id.trim() : '';
      const dir = typeof spec.working_dir === 'string' ? spec.working_dir.trim() : '';
      const cli = typeof spec.cli === 'string' ? spec.cli.trim() : '';
      if (host && dir) out.push({ manager_agent_id: host, working_dir: dir, cli });
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

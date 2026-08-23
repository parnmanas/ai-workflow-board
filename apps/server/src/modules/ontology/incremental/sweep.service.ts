/**
 * OntologyStaleSweepService — ticket 964014f5(DESIGN.md 축 4), 완료조건 3.
 *
 * 배경: Phase C(phase-c.ts)가 semantic/derived 엣지를 evidence-hash
 * 불일치로 stale 처리할 때마다 그 src 노드를 `ontology_enrichment_queue`에
 * 얹는다. 이 서비스는 그 대기열을 그래프별로 주기 관찰해 **크기/age
 * 퍼센타일을 로깅**한다 — "향후 arrival-vs-drain 모델링용 원자료"
 * (REVIEW-NOTES.md S5 해소 문단, 이 티켓 설명 완료조건 3 원문). 실제 LLM
 * 재요약(Tier 3 드레인)은 절대 여기서 하지 않는다 — ticket #9(LLM
 * enrichment, DESIGN.md 10a §2, 미배정)의 몫이고, 오늘 실제 데이터에는
 * semantic/derived 엣지 자체가 없어(Tier 1/1.5만 구현됨) 대기열은
 * 사실상 항상 비어 있다 — 이 서비스는 그 상태를 "0"으로 정직하게
 * 로깅하고, Tier 3가 나중에 대기열을 채우기 시작하면 코드 변경 없이
 * 즉시 유효해진다.
 *
 * 세 손잡이(research-incremental.md §5.2, Sourcegraph 오토인덱서와 같은
 * 세 손잡이 설계 — sweep interval/batch cap/per-node cooldown): 배치
 * cap과 cooldown은 "드레인"을 실제로 수행하는 대신 **cooldown_until만
 * 갱신하는 북키핑**으로 이 티켓 시점엔 구현된다 — DESIGN.md 축 4
 * Decision의 "사고 스윕은 수렴 보장이 아니라 비용 상한"이라는 정직한
 * 프레이밍 그대로, 이 스윕도 "대기열을 드레인해 수렴시킨다"고 과장하지
 * 않는다.
 *
 * 패턴은 QaRunReaperService와 동일 — OnModuleInit이 plain unref'd
 * setInterval을 심는다(@Cron/외부 스케줄러 의존 없음), onModuleDestroy가
 * 정리한다. Env: ONTOLOGY_SWEEP_ENABLED(기본 on),
 * ONTOLOGY_SWEEP_INTERVAL_MS(기본 5분, 1분~1시간), ONTOLOGY_SWEEP_BATCH_CAP
 * (기본 50), ONTOLOGY_SWEEP_COOLDOWN_MS(기본 10분, 1초~24시간).
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AppOntologyDataSource } from '../../../db';
import { LogService } from '../../../services/log.service';
import { OntologyEnrichmentQueue } from '../../../entities/OntologyEnrichmentQueue';

const DEFAULT_SWEEP_MS = 5 * 60_000;
const MIN_SWEEP_MS = 60_000;
const MAX_SWEEP_MS = 60 * 60_000;
const DEFAULT_BATCH_CAP = 50;
const MIN_BATCH_CAP = 1;
const MAX_BATCH_CAP = 10_000;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

/** p ∈ [0,100]. 정렬된 age(ms) 배열에서 nearest-rank 퍼센타일. 빈
 *  배열이면 0(호출자가 queueSize===0일 때만 그렇게 부른다). */
function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
  return sortedAscending[idx];
}

export interface SweepTelemetry {
  graphId: string;
  queueSize: number;
  ageMsP50: number;
  ageMsP90: number;
  ageMsP99: number;
  /** 이번 스윕에서 cooldown을 갱신한(=우선순위 상위 batchCap 안에 들고
   *  cooldown이 이미 지나 있던) 노드 수. */
  drainedThisSweep: number;
}

@Injectable()
export class OntologyStaleSweepService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly sweepMs = clampEnv('ONTOLOGY_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_MS, MIN_SWEEP_MS, MAX_SWEEP_MS);
  private readonly batchCap = clampEnv('ONTOLOGY_SWEEP_BATCH_CAP', DEFAULT_BATCH_CAP, MIN_BATCH_CAP, MAX_BATCH_CAP);
  private readonly cooldownMs = clampEnv('ONTOLOGY_SWEEP_COOLDOWN_MS', DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS);
  private readonly enabled = (process.env.ONTOLOGY_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectDataSource() private readonly nestDataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('OntologySweep', 'disabled via ONTOLOGY_SWEEP_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('OntologySweep', 'tick failed', { err: String(e) });
      });
    }, this.sweepMs);
    this.tickHandle.unref?.();
    this.logService.info('OntologySweep', 'Service initialized', {
      sweep_ms: this.sweepMs,
      batch_cap: this.batchCap,
      cooldown_ms: this.cooldownMs,
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** 한 번의 스윕 — 그래프별로 대기열 크기/age 퍼센타일을 로깅하고,
   *  cooldown이 지난 것 중 우선순위(낮을수록 먼저) 상위 batchCap개의
   *  cooldown_until을 갱신한다. 실제 LLM 호출은 없다. 그래프가 하나도
   *  없으면(대기열 전체가 빈 경우 — 오늘의 실제 데이터) 빈 배열을
   *  반환한다. */
  async runOnce(): Promise<SweepTelemetry[]> {
    const dataSource = this.resolveOntologyDataSource();
    const repo = dataSource.getRepository(OntologyEnrichmentQueue);
    const rows = await repo.find();
    if (rows.length === 0) return [];

    const byGraph = new Map<string, OntologyEnrichmentQueue[]>();
    for (const r of rows) {
      const list = byGraph.get(r.graph_id) ?? [];
      list.push(r);
      byGraph.set(r.graph_id, list);
    }

    const now = Date.now();
    const results: SweepTelemetry[] = [];
    for (const [graphId, queueRows] of byGraph) {
      const ages = queueRows.map((r) => now - new Date(r.staled_at).getTime()).sort((a, b) => a - b);
      const eligible = queueRows
        .filter((r) => !r.cooldown_until || new Date(r.cooldown_until).getTime() <= now)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, this.batchCap);

      if (eligible.length > 0) {
        await repo.update({ id: In(eligible.map((r) => r.id)) }, { cooldown_until: new Date(now + this.cooldownMs) });
      }

      const telemetry: SweepTelemetry = {
        graphId,
        queueSize: queueRows.length,
        ageMsP50: percentile(ages, 50),
        ageMsP90: percentile(ages, 90),
        ageMsP99: percentile(ages, 99),
        drainedThisSweep: eligible.length,
      };
      results.push(telemetry);
      this.logService.info('OntologySweep', 'stale queue telemetry', {
        graph_id: graphId,
        queue_size: telemetry.queueSize,
        age_ms_p50: telemetry.ageMsP50,
        age_ms_p90: telemetry.ageMsP90,
        age_ms_p99: telemetry.ageMsP99,
        drained_this_sweep: telemetry.drainedThisSweep,
      });
    }
    return results;
  }
}

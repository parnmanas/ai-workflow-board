import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MigrationRun } from '../../entities/MigrationRun';
import { LogService } from '../../services/log.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { encrypt, decryptStrict } from '../../services/encryption.service';
import { MigrationSourceClient } from './migration-client';
import { reencryptRowForImport } from './migration-crypto';
import { computeLocalPreflightMeta, comparePreflight } from './migration-preflight';
import {
  ATTACHMENT_ENTITIES,
  MIGRATION_ENTITY_ORDER,
  SELF_FK_BACKFILL,
} from './migration-entity-registry';

function makeError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

type ProgressMap = Record<string, { pulled: number; done: boolean }>;

const PAGE_SIZE = 500;

/**
 * 도착지 주도 live import 오케스트레이션 (ticket 0f638509).
 *
 * DispatchIntent/DispatchReconcilerService(내구성 outbox, DB에서 상태
 * 재도출, 재시작 생존)를 참조 모델로 삼는다 — Agent가 개입하지 않는 서버
 * 자체 구동 job이라는 점이 QaRunBatch보다 이쪽에 더 가깝다는 판단(진행 중
 * 티켓 코멘트 기록). 진행 상황은 매 페이지마다 MigrationRun 행에 커밋되므로
 * 프로세스가 죽어도 onModuleInit의 resumeIncompleteRuns()가 정확히 그
 * 지점부터 재개한다 — 재스캔이 아니라 진짜 재개.
 */
@Injectable()
export class MigrationRunService implements OnModuleInit {
  // 같은 프로세스 안에서 동일 runId가 두 번 동시에 루프를 돌지 못하게 막는다
  // (보기: startRun 직후 응답 전에 boot-reconciler가 겹치는 극단적 케이스는
  // 없지만, 재시작 없이 같은 run에 대해 pull-attachments를 두 번 누르는
  // 실수 등은 실제로 일어날 수 있다). 두 프로세스가 동시에 같은 run을 도는
  // 경우까지는 막지 않는다 — Deployment 엔티티 문서가 명시하듯 이 서버는
  // 단일 프로세스 배포가 전제다.
  private readonly _activeRuns = new Set<string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(MigrationRun) private readonly runRepo: Repository<MigrationRun>,
    private readonly logService: LogService,
    private readonly instanceQuiesce: InstanceQuiesceService,
  ) {}

  /**
   * `MigrationSourceClient`를 만드는 유일한 지점 — 테스트가 실제 네트워크
   * 요청(그리고 guardedFetch의 루프백 차단) 없이 pull-loop 로직을 검증할 수
   * 있도록 서브클래싱으로 대체 가능하게 뽑아뒀다. 프로덕션 동작은 이전과
   * 동일(`new MigrationSourceClient(...)`).
   */
  protected createClient(sourceUrl: string, token: string): MigrationSourceClient {
    return new MigrationSourceClient(sourceUrl, token);
  }

  async onModuleInit(): Promise<void> {
    const stuck = await this.runRepo.find({ where: [{ status: 'running' as const }, { status: 'preflight' as const }] });
    for (const run of stuck) {
      this.logService.info('Migration', 'resuming interrupted migration run on boot', { run_id: run.id });
      this._runLoop(run.id).catch((e: unknown) => {
        this.logService.error('Migration', 'resumed run loop crashed', { err: String(e), run_id: run.id });
      });
    }
  }

  async listRuns(): Promise<MigrationRun[]> {
    return this.runRepo.find({ order: { created_at: 'DESC' } });
  }

  async getRun(id: string): Promise<MigrationRun> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw makeError(404, `Migration run ${id} not found`);
    return run;
  }

  /**
   * 완료 기준 1+2 — 소스 URL + 단기 토큰으로 import 시작, 프리플라이트가
   * 버전/스키마 불일치·비어있지 않은 도착지를 거부. 프리플라이트를 통과한
   * 뒤에야 MigrationRun 행을 만들고 인스턴스를 quiesce한 다음(완료 기준 6 —
   * 데이터가 한 줄이라도 옮겨지기 전에) 실제 pull 루프를 백그라운드로 띄운다.
   */
  async startRun(params: {
    sourceUrl: string;
    sourceToken: string;
    skipAttachments: boolean;
    allowMerge: boolean;
    createdBy: string;
  }): Promise<MigrationRun> {
    const sourceUrl = (params.sourceUrl || '').trim().replace(/\/+$/, '');
    if (!sourceUrl) throw makeError(400, 'source_url is required');
    if (!params.sourceToken) throw makeError(400, 'source_token is required');

    const client = this.createClient(sourceUrl, params.sourceToken);
    const sourceMeta = await client.getMeta();

    const localMeta = computeLocalPreflightMeta(this.dataSource);
    const comparison = comparePreflight(sourceMeta, localMeta);
    if (!comparison.ok) {
      throw makeError(409, `Preflight failed: ${comparison.reasons.join('; ')}`);
    }

    if (!params.allowMerge) {
      const totalRows = await this._countLocalRows();
      if (totalRows > 0) {
        throw makeError(
          409,
          `Destination is not empty (${totalRows} row(s) across migrated tables) — pass allow_merge=true to proceed. ` +
          `Existing rows are kept as-is; only rows missing on the destination are inserted (no overwrite).`,
        );
      }
    }

    const entityOrder = MIGRATION_ENTITY_ORDER.filter((e) => !params.skipAttachments || !ATTACHMENT_ENTITIES.includes(e));

    let run = this.runRepo.create({
      source_url: sourceUrl,
      source_token_encrypted: encrypt(params.sourceToken),
      status: 'preflight',
      phase: 'core',
      skip_attachments: params.skipAttachments ? 1 : 0,
      allow_merge: params.allowMerge ? 1 : 0,
      entity_order: entityOrder,
      progress: {},
      preflight_report: { source: sourceMeta, local: localMeta, comparison },
      created_by: params.createdBy || '',
      started_at: new Date(),
    });
    run = await this.runRepo.save(run);

    // 완료 기준 6 — 데이터가 한 줄이라도 옮겨지기 전에 quiesce. 운영자가
    // unquiesce하기 전까지 프로세스 재시작을 넘어 유지된다(SystemSetting 백엹).
    await this.instanceQuiesce.setQuiesced(true, `live import run ${run.id} from ${sourceUrl}`);

    run.status = 'running';
    run = await this.runRepo.save(run);

    this._runLoop(run.id).catch((e: unknown) => {
      this.logService.error('Migration', 'run loop crashed', { err: String(e), run_id: run.id });
    });

    return run;
  }

  /**
   * 완료 기준 7 — 본문만 먼저 당긴 실행에 첨부/임베딩을 별도 단계로 채운다.
   * 같은 run 행을 재사용 — phase를 core에서 attachments로 옮기고 두
   * ATTACHMENT_ENTITIES만 pull loop에 태운다.
   *
   * 전제조건은 `status=completed && phase=core` — core pull이 skip_attachments=1로
   * 끝나면 phase를 'done'으로 올리지 않고 'core'에 머무르게 해서, 이 두
   * 필드만으로 "본문은 끝났고 첨부가 남았다"를 UI가 구분할 수 있게 한다
   * (phase='done'은 오직 더 이상 남은 작업이 없는 진짜 최종 상태에만 쓴다).
   */
  async pullAttachments(runId: string): Promise<MigrationRun> {
    const run = await this.getRun(runId);
    if (run.status !== 'completed' || run.phase !== 'core' || !run.skip_attachments) {
      throw makeError(409, `Run ${runId} has no pending attachments step (current: status=${run.status} phase=${run.phase} skip_attachments=${run.skip_attachments})`);
    }

    run.phase = 'attachments';
    run.status = 'running';
    run.entity_order = ATTACHMENT_ENTITIES;
    run.current_entity = null;
    run.cursor = null;
    // ATTACHMENT_ENTITIES 두 엔티티는 progress에서 지워 재-pull 대상으로
    // 만든다 — 나머지 엔티티의 progress(모두 done)는 그대로 둬 재확인하지
    // 않는다.
    const progress = { ...(run.progress || {}) };
    for (const e of ATTACHMENT_ENTITIES) delete progress[e];
    run.progress = progress;
    // 방어적 체크 — 정상 경로라면 core-only 완료는 토큰을 지우지 않으므로 항상
    // 존재해야 한다(위 전제조건 주석 참고). 그래도 비어 있다면 이 run으로는
    // 더 이상 진행할 수 없다는 뜻이라 새 run을 시작하라고 안내한다.
    if (!run.source_token_encrypted) {
      throw makeError(409, `Run ${runId} has no usable source token — start a new run instead`);
    }
    const saved = await this.runRepo.save(run);

    this._runLoop(saved.id).catch((e: unknown) => {
      this.logService.error('Migration', 'attachments run loop crashed', { err: String(e), run_id: saved.id });
    });
    return saved;
  }

  private async _countLocalRows(): Promise<number> {
    let total = 0;
    for (const entityName of MIGRATION_ENTITY_ORDER) {
      try {
        total += await this.dataSource.getRepository(entityName).count();
      } catch {
        // 알 수 없는 엔티티명은 카운트 스킵 — registry는 barrel과 항상 동기화되어야
        // 하지만, 방어적으로 여기서 전체 프리플라이트를 죽이지 않는다.
      }
    }
    return total;
  }

  private async _runLoop(runId: string): Promise<void> {
    if (this._activeRuns.has(runId)) return;
    this._activeRuns.add(runId);
    try {
      const initial = await this.runRepo.findOne({ where: { id: runId } });
      if (!initial || initial.status === 'completed' || initial.status === 'failed') return;

      const token = decryptStrict(initial.source_token_encrypted);
      const client = this.createClient(initial.source_url, token);
      const order = initial.entity_order && initial.entity_order.length ? initial.entity_order : MIGRATION_ENTITY_ORDER;
      const progress: ProgressMap = { ...(initial.progress || {}) };

      try {
        for (const entityName of order) {
          if (!progress[entityName]?.done) {
            const resumeCursor = initial.current_entity === entityName ? initial.cursor : null;
            await this._pullEntity(runId, client, entityName, resumeCursor, progress);
          }

          const fkColumn = SELF_FK_BACKFILL[entityName];
          if (fkColumn) {
            const backfillKey = `${entityName}.${fkColumn}_backfill`;
            if (!progress[backfillKey]?.done) {
              const resumeCursor = initial.current_entity === backfillKey ? initial.cursor : null;
              await this._backfillSelfFk(runId, client, entityName, fkColumn, backfillKey, resumeCursor, progress);
            }
          }
        }

        // core phase 완료인데 skip_attachments=1이면 아직 최종 완료가 아니다 —
        // phase를 'core'에 머무르게 해 pullAttachments()의 전제조건이 이
        // 상태를 정확히 인식하게 한다(완료 기준 7). 토큰도 지우지 않는다 —
        // pullAttachments가 나중에(분/시간/일 단위로 늦을 수 있음) 같은
        // 토큰으로 재접속해야 한다. attachments phase 완료, 또는 애초에
        // skip_attachments=0이었던 core 완료는 진짜 최종 완료 — phase='done'으로
        // 올리고 이 프로세스가 들고 있던 토큰 사본을 지운다(hygiene — 소스
        // 자신의 단기 TTL/폐기가 진짜 만료를 담당).
        const isFinal = initial.phase === 'attachments' || !initial.skip_attachments;
        await this.runRepo.update(runId, {
          status: 'completed',
          phase: isFinal ? 'done' : 'core',
          completed_at: new Date(),
          current_entity: null,
          cursor: null,
          ...(isFinal ? { source_token_encrypted: '' } : {}),
        });
        this.logService.info('Migration', `run ${initial.phase} phase completed${isFinal ? ' (final)' : ' (attachments pending)'}`, { run_id: runId });
      } catch (e: any) {
        await this.runRepo.update(runId, { status: 'failed', error_message: String(e?.message || e) });
        this.logService.error('Migration', 'run failed', { run_id: runId, err: String(e?.message || e) });
      }
    } finally {
      this._activeRuns.delete(runId);
    }
  }

  /**
   * 한 엔티티를 keyset 페이지네이션으로 끝까지 당긴다. 매 페이지 후
   * MigrationRun.{current_entity,cursor,progress}를 커밋 — 이게 크래시 재개의
   * 체크포인트다. `.orIgnore()`(ON CONFLICT DO NOTHING / INSERT OR IGNORE)라
   * 같은 페이지를 두 번 넣어도 안전(완료 기준 3, 멱등).
   */
  private async _pullEntity(
    runId: string,
    client: MigrationSourceClient,
    entityName: string,
    resumeCursor: string | null,
    progress: ProgressMap,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(entityName);
    const selfFkColumn = SELF_FK_BACKFILL[entityName];
    let cursor = resumeCursor;
    let pulled = progress[entityName]?.pulled || 0;

    for (;;) {
      const page = await client.getTablePage(entityName, cursor, PAGE_SIZE);
      if (page.rows.length > 0) {
        const rowsToInsert = page.rows.map((row) => {
          const reencrypted = reencryptRowForImport(entityName, row);
          // Ticket.parent_id처럼 자기참조 FK는 전체 테이블이 로드되기 전엔
          // 대상 행이 존재하지 않을 수 있다(랜덤 UUID PK라 id 순서와 부모/자식
          // 순서가 무관) — NULL로 넣고 테이블 전체 pull이 끝난 뒤
          // _backfillSelfFk가 원래 값으로 채운다.
          const withFkNulled = selfFkColumn ? { ...reencrypted, [selfFkColumn]: null } : reencrypted;
          return coerceRowForInsert(repo, withFkNulled);
        });
        await repo.createQueryBuilder().insert().values(rowsToInsert).orIgnore().execute();
        pulled += rowsToInsert.length;
      }
      cursor = page.next_cursor;
      progress[entityName] = { pulled, done: !page.has_more };
      await this.runRepo.update(runId, { current_entity: entityName, cursor, progress: { ...progress } });
      if (!page.has_more) break;
    }
  }

  /**
   * `entityName`을 소스에서 다시 전체 스캔하며 `fkColumn`(예: Ticket.parent_id)
   * 값을 UPDATE로 채운다. `_pullEntity`가 NULL로 심어둔 것과 정확히 같은 컬럼을
   * 원복 — 이 두 번째 스캔은 그 컬럼값을 얻기 위한 것일 뿐, 원본 row가
   * `_pullEntity`에서 이미 원래 값을 갖고 반환된 것을 그냥 다시 읽는 것이라
   * 별도 export 엔드포인트가 필요 없다.
   */
  private async _backfillSelfFk(
    runId: string,
    client: MigrationSourceClient,
    entityName: string,
    fkColumn: string,
    backfillKey: string,
    resumeCursor: string | null,
    progress: ProgressMap,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(entityName);
    const pkName = repo.metadata.primaryColumns[0]?.propertyName;
    if (!pkName) return;

    let cursor = resumeCursor;
    let pulled = progress[backfillKey]?.pulled || 0;

    for (;;) {
      const page = await client.getTablePage(entityName, cursor, PAGE_SIZE);
      const rowsNeedingBackfill = page.rows.filter((r) => r[fkColumn] != null);
      if (rowsNeedingBackfill.length > 0) {
        await Promise.all(rowsNeedingBackfill.map((r) =>
          repo.createQueryBuilder()
            .update()
            .set({ [fkColumn]: r[fkColumn] })
            .where(`${pkName} = :pk`, { pk: r[pkName] })
            .execute(),
        ));
        pulled += rowsNeedingBackfill.length;
      }
      cursor = page.next_cursor;
      progress[backfillKey] = { pulled, done: !page.has_more };
      await this.runRepo.update(runId, { current_entity: backfillKey, cursor, progress: { ...progress } });
      if (!page.has_more) break;
    }
  }
}

// JSON 왕복을 거치면 Date 컬럼값이 ISO 문자열로 들어온다. TypeORM 드라이버가
// Date 타입 컬럼에 문자열을 넘겼을 때 어떻게 다루는지는 sqlite/Postgres
// 드라이버마다 미묘하게 다를 수 있어, 명시적으로 다시 Date 인스턴스로
// 변환해 양쪽에서 동일하게 동작하도록 만든다. simple-json 컬럼은 이미 JSON
// round-trip으로 진짜 JS 객체/배열이 복원되어 있어 손댈 필요가 없다.
function isTemporalColumnType(type: unknown): boolean {
  if (type === Date) return true;
  return typeof type === 'string' && ['datetime', 'date', 'timestamp', 'timestamptz', 'time'].includes(type);
}

function coerceRowForInsert(repo: Repository<any>, row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...row };
  for (const col of repo.metadata.columns) {
    const key = col.propertyName;
    if (out[key] == null || typeof out[key] !== 'string') continue;
    if (isTemporalColumnType(col.type)) {
      const d = new Date(out[key]);
      if (!isNaN(d.getTime())) out[key] = d;
    }
  }
  return out;
}

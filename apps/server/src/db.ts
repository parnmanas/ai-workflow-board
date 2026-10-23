import { preSyncAgentCleanup } from './database/pre-sync-agent-cleanup';
import { preSyncAccountOwnership } from './database/pre-sync-account-ownership';
import { preSyncBoardRemoval } from './database/pre-sync-board-removal';
/**
 * Database compatibility module
 *
 * Provides AppDataSource + buildDataSourceOptions() for modules that need
 * direct DataSource access (mcp-tools.ts, mcp-server.ts) and for the NestJS
 * DatabaseModule, which imports buildDataSourceOptions() to keep the
 * TypeORM configuration unified (D-05).
 *
 * Invariants (locked by .planning/phases/01-foundation/01-CONTEXT.md):
 * - D-01: synchronize is HARDCODED on in every branch (sqlite/mysql/postgres).
 *         It is NOT keyed off NODE_ENV. Schema DDL is driven by entity definitions.
 * - D-02: Migrations handle DATA only, not schema. The migrationsRun flag is
 *         hardcoded off so we can invoke runMigrations() manually from
 *         DatabaseModule.onModuleInit() after the synchronize step has completed (P-03).
 * - D-05: This file is the single source of truth for DataSource options.
 */
import 'reflect-metadata';
import { DataSource, DataSourceOptions, EntityManager, EntitySubscriberInterface, EventSubscriber, QueryRunner, ReplicationMode } from 'typeorm';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import * as path from 'path';
import * as fs from 'fs';
import * as entitiesBarrel from './entities';
import { OntologyNode } from './entities/OntologyNode';
import { OntologyEdge } from './entities/OntologyEdge';
import { OntologyReverseEdgeIndex } from './entities/OntologyReverseEdgeIndex';
import { OntologyEnrichmentQueue } from './entities/OntologyEnrichmentQueue';
import { OntologyGraph } from './entities/OntologyGraph';

const entities = Object.values(entitiesBarrel);

// Ontology Graph 테이블(ticket 6ca4894a, DESIGN.md 축 3)은 sql.js에서 자체
// DataSource를 갖는다 — 아래 buildOntologyDataSourceOptions() 참고. 그래서
// PRIMARY sqljs entities 배열(아래)에서는 제외해야 `synchronize`가 공유
// data.db에 절대 DDL하지 않는다. Postgres/MySQL은 배럴을 그대로 유지 — 이
// 티켓 이전과 똑같이 단일 DataSource에 온톨로지가 다른 모든 것과 함께 있다.
const ONTOLOGY_ENTITIES = [OntologyNode, OntologyEdge, OntologyReverseEdgeIndex, OntologyEnrichmentQueue, OntologyGraph];
const ontologyEntitySet = new Set<unknown>(ONTOLOGY_ENTITIES);
const primarySqljsEntities = entities.filter((e) => !ontologyEntitySet.has(e));

/**
 * True when the active backend is the dev sql.js (in-memory WASM) database.
 * `DB_TYPE` unset or 'sqlite' both map to the sqljs driver (see
 * buildDataSourceOptions). Postgres/MySQL (prod) return false — the batched
 * flush machinery below is a no-op for them, they persist per-commit natively.
 */
export function isSqljsBackend(): boolean {
  return (process.env.DB_TYPE || 'sqlite') === 'sqlite';
}

// ── dev sql.js batched-flush state (ticket d5a8594a) ─────────────────────────
// Background: with `autoSave: true` the TypeORM sqljs driver re-serialized the
// ENTIRE in-memory DB to a fresh Uint8Array and rewrote data.db on EVERY
// non-SELECT query. Under the system's high-frequency audit writes — ActivityLog
// (trigger_emitted/dispatched, backlog_promotion_* every few ms), AgentErrorLog,
// Subagent / SubagentLogLine — that is large-allocation churn + sustained GC
// pressure that accumulates over a long-lived dev session and contributes to the
// memory-pressure stalls this ticket targets.
//
// Fix: `autoSave` is now OFF for sqljs (see buildDataSourceOptions). Writes are
// coalesced and persisted by a single periodic flush (default 30s) plus a final
// flush on graceful shutdown — at most one full-DB export/write per interval
// instead of one per write, and ZERO work while the server is idle (the dirty
// flag below gates the export). Trade-off: a HARD crash (SIGKILL / OOM kill /
// power loss) can lose up to one flush-interval of the most recent writes;
// graceful SIGTERM/SIGINT flush via the shutdown hook. Acceptable for DEV sql.js
// — it is local, disposable data. Postgres/MySQL (prod) are untouched.
//
// `sqljsDirty` is process-global because the sql.js DB is a single in-memory
// image per process and exactly one DataSource is initialized per entry point
// (NestJS server → injected DataSource; standalone MCP server → AppDataSource).
let sqljsDirty = false;
// Holds the currently-running flush so an overlapping call can coalesce into it
// (periodic tick) or AWAIT it (forced shutdown flush) instead of skipping. null
// when no flush is in flight. See flushSqljs() for the supersede/await contract
// (ticket 84a6d207).
let sqljsFlushInFlight: Promise<boolean> | null = null;

export function markSqljsDirty(): void {
  sqljsDirty = true;
}

export function isSqljsDirty(): boolean {
  return sqljsDirty;
}

/**
 * TypeORM subscriber that flips the dirty flag whenever a write hits the sql.js
 * DB. Registered only for the sqljs backend (see buildDataSourceOptions).
 *
 * `afterQuery` fires for EVERY statement the query runner executes — repository
 * save/insert/update/remove, QueryBuilder .delete()/.update(), AND raw
 * dataSource.query() calls — so unlike an entity-level afterInsert/afterUpdate
 * subscriber it can't miss bulk/raw writes (e.g. the retention DELETEs or the
 * boot-time manager-account strip). It mirrors the driver's own isDirty
 * heuristic: anything that isn't a SELECT/PRAGMA is treated as a mutation.
 * Marking dirty too eagerly only ever costs a redundant flush — never data loss.
 *
 * The `@EventSubscriber()` decorator is REQUIRED: TypeORM's buildSubscribers
 * filters the `subscribers` option against the global metadata-args storage, so
 * an undecorated class passed in `subscribers` is silently dropped and never
 * receives events. The decorator registers it globally; the buildDataSourceOptions
 * `subscribers: [SqljsWriteSubscriber]` entry scopes it to the sqljs connection
 * only (the prod backends never list it, so it never attaches there).
 */
@EventSubscriber()
export class SqljsWriteSubscriber implements EntitySubscriberInterface {
  // Typed structurally rather than against TypeORM's AfterQueryEvent (which the
  // package index does not re-export) — we only read `query` / `success`.
  afterQuery(event: { query?: string; success?: boolean }): void {
    if (event.success === false) return;
    const command = (event.query || '').trimStart().split(/\s/, 1)[0].toUpperCase();
    if (command && command !== 'SELECT' && command !== 'PRAGMA') {
      markSqljsDirty();
    }
  }
}

// ── dev sql.js 트랜잭션 직렬화 큐 (ticket 762fbe05, 13f5b0f6) ─────────────────
// 배경: SqljsDriver.createQueryRunner()는 커넥션이 살아있는 동안 단 하나의
// SqljsQueryRunner를 메모이즈해 재사용한다 — 진짜 풀링이 없고, WASM 인스턴스도
// 커넥션도 하나뿐이다(node_modules/typeorm/driver/sqljs/SqljsDriver.js). 그래서
// 트랜잭션은 연결 전체의 상태이고, 열려 있는 동안 그 runner 로 실행되는 문장은 누가
// 보냈든 그 트랜잭션에 들어간다. 두 갈래로 터졌다.
//
// 1. 겹치는 두 transaction() (ticket 02c85264). 진 쪽은 단순히 깔끔하게 실패하지
//    않는다: 이미 하나가 활성 상태인데 raw "BEGIN TRANSACTION"을 또 날리는
//    startTransaction()이 도중에 throw하고, EntityManager.transaction()은 그 throw에
//    반응해 같은 SHARED runner에 raw ROLLBACK을 날린다 — 이때 이긴 쪽의 아직 진행
//    중이던 트랜잭션까지 조용히 중단시켜 버린다. 서로 다른 두 에러 문자열이 동시에
//    나타나는 이유가 여기 있다: raw BEGIN에서 나는 "cannot start a transaction within
//    a transaction", 그리고 이긴 쪽이 나중에 이미 남이 롤백해버린 runner에 커밋을
//    시도할 때 나는 "Transaction is not started yet, start transaction before
//    committing or rolling it back."
// 2. 트랜잭션 밖 쓰기 (ticket 13f5b0f6). save/remove/softRemove/recover 는 runner 의
//    isTransactionActive 가 true 면 자기 트랜잭션을 열지 않고 열린 트랜잭션에
//    합류하고(EntityPersistExecutor), insert/update/delete · QueryBuilder execute() ·
//    raw query() 는 그 안에서 그대로 실행된다. 무관한 요청의 쓰기가, 이미 id 와 함께
//    성공으로 끝난 뒤에 남의 트랜잭션 롤백과 함께 사라지거나 남의 커밋에 묶였다.
//
// 해결: 한 sqljs DataSource 에서 연결에 쓰는 일을 FIFO 큐의 **차례**로 직렬화한다.
//   - 이 DataSource 의 모든 EntityManager(루트 + createQueryRunner() 가 만드는 것)의
//     transaction · save · remove · softRemove · recover — 통째로 한 차례다. 뒤의 넷은
//     암묵 트랜잭션을 연다.
//   - synchronize · runMigrations · undoLastMigration · dropDatabase — runner 에 직접
//     트랜잭션을 연다.
//   - 공유 runner 의 그 밖의 쓰기 문장(SELECT 와 쓰기 없는 WITH 를 뺀 모든 문장) — 문장
//     하나만큼. insert/update/delete/upsert/increment, QueryBuilder execute(), raw query() 가
//     여기다. 문장은 보낼 때 줄을 선다.
//   - afterSqljsTransactions() 작업(파일 export).
// 읽기(SELECT, 쓰기 없는 WITH)는 차례를 타지 않는다. 남의 트랜잭션 도중에 읽어도 잃는 것이 없고(커밋
// 전 값을 볼 수는 있다 — 이 큐는 격리를 재현하지 않는다), 줄 세우면 모든 조회가 긴
// 트랜잭션 뒤에 멈추며, 트랜잭션 콜백이 다른 체인이 진행 중인 조회 결과(in-flight
// 캐시 등)를 기다리는 순간 데드락이 된다.
// 큐 밖에서 여는 트랜잭션(queryRunner.startTransaction() 직접 호출,
// QueryBuilder.useTransaction(true))은 거부한다 — 열려 있는 동안 다른 요청의 쓰기와
// 구분할 방법이 없다. dataSource.transaction() 을 쓴다.
// Postgres/MySQL은 네이티브 풀 기반 동시 트랜잭션을 그대로 유지 — sqljs가 아닌
// DataSource에서는 즉시 no-op.
//
// 패치는 전부 인스턴스 단위다. 루트 manager 는 이미 만들어져 있으니 직접 걸고, 이후
// manager 는 createEntityManager() 에서, runner 는 driver.createQueryRunner() 에서
// (destroy 뒤 다시 initialize 하면 새로 만들어진다) 건다. Repository 는 자기를 만든
// manager 를 부르므로 dataSource.transaction() · repo.manager.transaction() ·
// repo.save() 호출부를 손대지 않고 전부 덮는다.
//
// 재진입(reentrancy): 차례를 쥔 체인 안에서 부른 일은 기다리지 않고 그 차례 안에서
// 바로 돈다 — transaction() 콜백 안의 transaction() 은 같은 runner 위 SAVEPOINT 로
// 중첩되고, 콜백 안의 save()·쓰기는 그 트랜잭션의 일부다. 자기 뒤에 줄 세우면
// 데드락이다(바깥은 안쪽이 끝나야 끝나는데 안쪽은 바깥 차례를 기다린다).
// AsyncLocalStorage로 그 작업의 전체 비동기 체인 동안 차례를 표시한다.
//
// 차례는 첫 작업과, 그 차례 안에서 시작한 작업·쓰기 문장이 **모두** 끝나야 넘어간다.
// 트랜잭션 콜백이 await 없이 던진 save() 가 커밋 뒤까지 이어져도 다음 차례의
// 트랜잭션 안에서 돌지 않는다.
//
// 저장값은 단순 `true`가 아니라 `active` 를 가진 차례 객체여야 한다 — AsyncLocalStorage는
// run() 콜백이 반환한 프라미스가 settle된 뒤에도, 그 콜백 실행 중에 만들어진 비동기
// 자손(예: await 없이 던져둔 setTimeout)에는 계속 같은 store가 전파된다. 차례가
// 넘어가는 순간 active 를 false 로 닫으므로, 그 뒤에 깨어난 자손은 재진입으로
// 오인되지 않고 정상적으로 큐를 다시 탄다.
//
// 데드락 주의: 차례를 쥔 콜백이 **다른 체인의** DB 쓰기를 기다리면(그 체인이 쥔 락,
// 남이 시작한 in-flight 작업, 이벤트 응답 등) 그 쓰기는 이 차례 뒤에 줄 서 있어서 서로를
// 기다린다. 콜백 안에서는 자기 manager 로 쓰고, 다른 체인의 결과를 기다리지 말 것.
// 그렇게 멈춘 차례는 아래 감시(watchSqljsTurns)가 경고로 알린다.

/** 큐 차례 하나. 첫 작업과, 그 차례 안에서 시작한 작업·쓰기 문장이 모두 끝나면(pending 0) 다음으로 넘어간다. */
type SqljsTurn = {
  active: boolean;
  pending: number;
  release: () => void;
  /** 차례를 연 일 — manager · DataSource 메서드 이름, 쓰기 문장의 첫 단어, afterSqljsTransactions() 의 이름('export'). */
  label: string;
  /** 차례가 시작된 시각(performance.now()) — 줄 서 있던 시간은 세지 않는다. */
  startedAt: number;
  /** 차례를 연 호출 위치. 기록하는 동안, 차례가 넘어갈 때까지만 있다(watchSqljsTurns 참고). */
  site?: { stack?: string };
  /** 오래 쥔 차례 경고를 남겼는가 — 차례마다 한 번이다. */
  warned: boolean;
};

/** 차례를 여는 함수. `above` 는 호출 위치에서 뺄 프레임 — 그 함수와 그 위(큐 안쪽)는 위치가 아니다. */
type SqljsEnqueue = <T>(work: () => Promise<T>, label: string, above: Function) => Promise<T>;

const sqljsWorkQueues = new WeakMap<DataSource, {
  enqueue: SqljsEnqueue;
  holdsTurn: () => boolean;
}>();

// ── 오래 쥔 차례 경고 (ticket 61622dbb) ──
// 차례를 쥔 콜백이 다른 체인의 쓰기를 기다리거나(데드락) 느린 I/O 를 하면, 그 연결의 모든 쓰기가 소리 없이 멈춘다.
// 그래서 차례마다 이름과 시작 시각을 남기고, 한 차례가 SQLJS_TURN_WARN_MS(기본 30초) 넘게 잡혀 있으면 경고를 한 번
// 남긴다 — 쥔 일, 쥔 시간, 기다리는 일 수, 차례를 연 호출 위치. 경고한 차례가 풀리면 걸린 시간을 한 줄 더 남긴다.
// 풀림 줄이 끝내 없으면 데드락이고, 있으면 느린 콜백이다. 쥔 동안 감시가 보지 못한 긴 차례(이벤트 루프가 막혔거나 두
// tick 사이에 끝났다)는 풀릴 때 알린다 — 기준을 넘긴 차례는 어느 쪽으로든 한 번 알려진다.
//
// 감시 주기는 DataSource 마다 하나이고 unref 다 — 차례마다 타이머를 만들지 않는다. 큐가 바쁜 동안만 돈다. 차례가
// 시작될 때 주기가 없으면 걸고, 쥔 차례도 기다리는 일도 없는 것을 본 tick 에서 스스로 멈춘다. 그래서 큐가 빈 DataSource
// 에는(닫힌 것도) 타이머가 남지 않는다. 주기는 큐를 건(serializeSqljsTransactions) 비동기 문맥에서 건다 — 차례를 시작한
// 요청의 문맥에서 걸면 주기가 그 요청의 AsyncLocalStorage 값을 붙잡고, 다른 요청이 쥔 차례의 경고도 그 문맥에서 남는다.
//
// 호출 위치(stack)는 늘 걷지 않는다. 쓰기 차례 하나가 100–450µs 인데 걷는 데 6–11µs 가 든다(티켓 61622dbb 측정).
// SQLJS_TURN_STACKS=1 이면 처음부터 걷고, 아니면 그 연결에서 첫 경고를 남긴 뒤부터 재시작할 때까지 걷는다 — 긴 마이그레이션
// 같은 정당한 긴 차례 하나로도 켜진다. 반복되는 느린 콜백은 다음 경고에 위치가 실린다. 데드락은 그 뒤로 시작하는 차례가
// 없어서 첫 경고뿐이다 — 플래그를 켜고 재현해야 위치가 나온다.
// 위치는 차례를 연 순간의 stack 이다. transaction · save · export 차례에는 그것을 부른 앱 코드가 남는다. 쓰기 문장 차례는
// TypeORM 이 문장을 보내는 자리라서, TypeORM 안에서 async stack 이 끊기는 경로(repo.insert() · upsert())는 TypeORM 프레임만 남는다.

export const DEFAULT_SQLJS_TURN_WARN_MS = 30_000;
const MIN_SQLJS_TURN_WARN_MS = 50;
const MAX_SQLJS_TURN_WATCH_TICK_MS = 5_000;

// 감시 주기의 타이머 함수는 이 모듈을 불러올 때 잡아 둔다. 테스트가 나중에 전역 setInterval 을 가짜로 바꾸면(node:test
// mock timers), 가짜에 걸린 주기는 되돌린 뒤로 돌지 않아 그 DataSource 의 감시가 꺼지고, 가짜 clearInterval 은 진짜 주기를
// 멈추지 못한다.
const sqljsWatchTimers = { setInterval, clearInterval };

/** 차례를 이만큼 넘게 쥐면 경고한다. SQLJS_TURN_WARN_MS 가 비었거나 숫자가 아니면(`30s`) 기본값, 너무 작으면 하한. */
export function resolveSqljsTurnWarnMs(): number {
  const raw = Number(process.env.SQLJS_TURN_WARN_MS || '');
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SQLJS_TURN_WARN_MS;
  return Math.max(MIN_SQLJS_TURN_WARN_MS, Math.round(raw));
}

function sqljsTurnStacksRequested(): boolean {
  const raw = (process.env.SQLJS_TURN_STACKS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** 경고에 쓰는 연결 이름 — sql.js 파일 이름(data.db, ontology.db). */
function sqljsConnectionName(dataSource: DataSource): string {
  const { location } = dataSource.options as { location?: string };
  return location ? path.basename(location) : 'in-memory';
}

/** 쓰기 문장 차례의 이름 — 문장의 첫 단어(INSERT, UPDATE, PRAGMA …). */
function sqljsStatementLabel(sql: string): string {
  return (/^\s*(\S+)/.exec(sql)?.[1] ?? 'statement').slice(0, 32).toUpperCase();
}

const sqljsSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 기준을 넘겨 쥔 차례의 경고. `released` — 쥔 동안 감시가 보지 못해 풀린 뒤에 남긴다. */
function sqljsLongTurnWarning(connection: string, turn: SqljsTurn, heldMs: number, waiting: number, released: boolean): string {
  const opened = `[DB] sql.js write queue (${connection}): the turn opened by "${turn.label}"`;
  const head = released
    ? `${opened} was held for ${sqljsSeconds(heldMs)} before it was released, ${waiting} waiting behind it — ` +
      'the watch could not check it while it was held (the event loop was blocked, or the turn ended between checks).'
    : `${opened} has been held for ${sqljsSeconds(heldMs)}, ${waiting} waiting behind it — ` +
      'every write on this connection waits until it is released.';
  if (!turn.site) {
    return `${head} Its call site was not recorded; turns opened from now on record theirs. ` +
      'Set SQLJS_TURN_STACKS=1 to record them from the start.';
  }
  return `${head} Opened at:\n${sqljsCallSiteFrames(turn.site)}`;
}

/** 위치의 프레임들. 꾸미지 못하면(Error.prepareStackTrace 가 던짐) 그 사실만 적는다 — 경고의 나머지는 그대로 남는다. */
function sqljsCallSiteFrames(site: { stack?: string }): string {
  try {
    // String(): Error.prepareStackTrace 를 바꾼 라이브러리는 문자열이 아닌 stack 을 돌려줄 수 있다.
    const frames = String(site.stack ?? '').split('\n').slice(1).join('\n');
    return frames || '    (no stack frames were captured)';
  } catch {
    return '    (the call site could not be formatted — Error.prepareStackTrace threw)';
  }
}

/**
 * 감시의 경고는 tick(타이머 — 던지면 프로세스가 죽는다)과 차례 넘기기(던지면 큐가 멈춘다) 안에서 남는다. 그래서 경고를
 * 만들거나 쓰다 실패하면 경고만 버린다.
 */
function warnSqljsQueue(message: () => string): void {
  try {
    console.warn(message());
  } catch {
    // 경고를 못 남겼을 뿐이다 — 큐와 프로세스는 그대로 간다.
  }
}

/**
 * 한 DataSource 의 차례를 지켜보는 감시 — serializeSqljsTransactions() 가 차례의 시작 · 끝을 알린다. begin · end 는 큐가
 * 차례를 넘기는 길에서 불린다. 거기서 던지면 차례가 넘어가지 않아 그 연결의 쓰기가 영원히 멈추므로, 감시가 실패하면
 * 감시만 거른다.
 */
function watchSqljsTurns(connection: string) {
  const warnMs = resolveSqljsTurnWarnMs();
  const tickMs = Math.min(MAX_SQLJS_TURN_WATCH_TICK_MS, Math.ceil(warnMs / 4));
  let recordSites = sqljsTurnStacksRequested();
  let current: SqljsTurn | null = null;
  let waiting = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 기준을 넘겨 쥔 차례를 알린다 — 그 뒤로 이 연결은 차례를 연 호출 위치를 기록한다. */
  const warnLongTurn = (turn: SqljsTurn, heldMs: number, released: boolean) => {
    turn.warned = true;
    recordSites = true;
    warnSqljsQueue(() => sqljsLongTurnWarning(connection, turn, heldMs, waiting, released));
  };

  const tick = () => {
    const turn = current;
    if (!turn) {
      if (waiting === 0 && timer) {
        sqljsWatchTimers.clearInterval(timer);
        timer = null;
      }
      return;
    }
    if (turn.warned) return;
    const heldMs = performance.now() - turn.startedAt;
    if (heldMs >= warnMs) warnLongTurn(turn, heldMs, false);
  };
  // 주기는 큐를 건 비동기 문맥에서 건다(위 주석 — 차례를 시작한 요청의 문맥이 아니다).
  const startTicking = AsyncResource.bind(() => sqljsWatchTimers.setInterval(tick, tickMs));

  return {
    /** 새 차례를 연 호출 위치. 기록하지 않는 동안은 undefined 다. */
    callSite(above: Function): SqljsTurn['site'] {
      if (!recordSites) return undefined;
      const site: { stack?: string } = {};
      Error.captureStackTrace(site, above);
      return site;
    },
    queued() {
      waiting += 1;
    },
    begin(turn: SqljsTurn) {
      waiting -= 1;
      turn.startedAt = performance.now();
      current = turn;
      if (timer) return;
      try {
        timer = startTicking();
        if (typeof timer.unref === 'function') timer.unref();
      } catch {
        // 주기를 못 걸었을 뿐이다 — 차례는 그대로 시작하고, 다음 차례가 다시 건다.
      }
    },
    end(turn: SqljsTurn) {
      if (current === turn) current = null;
      const heldMs = performance.now() - turn.startedAt;
      if (turn.warned) {
        warnSqljsQueue(
          () => `[DB] sql.js write queue (${connection}): the turn opened by "${turn.label}" was released after ${sqljsSeconds(heldMs)}`,
        );
      } else if (heldMs >= warnMs) {
        // 쥔 동안 tick 이 보지 못했다 — 이벤트 루프가 막혔거나 두 tick 사이에 끝났다.
        warnLongTurn(turn, heldMs, true);
      }
      // 위치는 .stack 을 읽기 전까지 각 프레임의 receiver · 함수를 붙잡는다. 차례 객체는 그 안에서 만든 비동기 자원(타이머 ·
      // 프라미스)마다 AsyncLocalStorage 값으로 남으므로, 넘어간 차례의 위치는 버린다 — 아니면 그 자원이 사는 동안 호출자가 산다.
      turn.site = undefined;
    },
  };
}

/** 통째로 한 차례를 타는 EntityManager 메서드 — transaction 과, 암묵 트랜잭션을 여는 넷. */
const SQLJS_QUEUED_MANAGER_METHODS = ['transaction', 'save', 'remove', 'softRemove', 'recover'] as const;
/** runner 에 직접 트랜잭션을 여는 DataSource 메서드. */
const SQLJS_QUEUED_DATASOURCE_METHODS = ['synchronize', 'runMigrations', 'undoLastMigration', 'dropDatabase'] as const;

const SQLJS_UNQUEUED_TRANSACTION_ERROR =
  'sql.js: open transactions with dataSource.transaction() — a transaction started outside the transaction queue ' +
  "(queryRunner.startTransaction(), QueryBuilder.useTransaction()) would take in other requests' writes on the only connection";

/**
 * 읽기만 하는 문장 — 큐 차례를 타지 않는다. SELECT, 그리고 쓰기 키워드가 없는 WITH(온톨로지 그래프 탐색의 재귀
 * CTE). 그 밖의 문장(PRAGMA 포함)과 키워드가 문자열·이름에만 든 WITH 는 쓰기로 본다 — 틀려도 기다릴 뿐이다.
 */
function isSqljsReadStatement(sql: string): boolean {
  if (/^\s*select\b/i.test(sql)) return true;
  return /^\s*with\b/i.test(sql) && !/\b(insert|update|delete|replace)\b/i.test(sql);
}

/**
 * 같은 sql.js 연결에 쓰는 일(트랜잭션 · 쓰기)이 끝난 뒤 연결을 직접 만지는 작업을 실행한다. work 가 도는 동안
 * 큐에 선 일은 시작하지 않는다. 이미 큐 차례를 쥔 체인(트랜잭션 콜백, 또는 다른 work) 안에서 부르면 기다리지
 * 않고 그 차례 안에서 바로 실행한다 — 자기 뒤에 줄 서면 데드락이다. 그래서 트랜잭션 안에서 부르면 그 트랜잭션이
 * 열린 채로 돈다 — 파일 export 는 flushSqljs()/flushOntologySqljs() 를 쓴다(exportSqljsWhenIdle 참고).
 * `label` 은 이 work 가 차례를 오래 쥘 때 경고에 실리는 이름이다 — 이미 쥔 차례 안에서 부르면 그 차례의 이름이 실린다.
 */
export function afterSqljsTransactions<T>(
  dataSource: DataSource,
  work: () => Promise<T>,
  label = 'afterSqljsTransactions',
): Promise<T> {
  const queue = sqljsWorkQueues.get(dataSource);
  return queue ? queue.enqueue(work, label, afterSqljsTransactions) : work();
}

/** 지금 호출 체인이 이 연결의 큐 차례를 이미 쥐고 있는가 — 트랜잭션 콜백이나 afterSqljsTransactions() work 안. */
function holdsSqljsTurn(dataSource: DataSource): boolean {
  return sqljsWorkQueues.get(dataSource)?.holdsTurn() ?? false;
}

export function serializeSqljsTransactions(dataSource: DataSource): void {
  if (dataSource.options.type !== 'sqljs') return;
  if (sqljsWorkQueues.has(dataSource)) return;

  const reentry = new AsyncLocalStorage<SqljsTurn>();
  const watch = watchSqljsTurns(sqljsConnectionName(dataSource));
  let tail: Promise<void> = Promise.resolve();
  const heldTurn = (): SqljsTurn | undefined => {
    const turn = reentry.getStore();
    return turn?.active ? turn : undefined;
  };
  // turn 안에서 work 를 돌리고, 끝날 때까지 그 차례를 붙잡는다.
  const within = <T>(turn: SqljsTurn, work: () => Promise<T>): Promise<T> => {
    turn.pending += 1;
    let running: Promise<T>;
    try {
      running = Promise.resolve(work());
    } catch (e) {
      running = Promise.reject(e);
    }
    return running.finally(() => {
      turn.pending -= 1;
      if (turn.pending === 0) turn.release();
    });
  };
  const enqueue: SqljsEnqueue = (work, label, above) => {
    const held = heldTurn();
    if (held) return within(held, work);
    let next!: () => void;
    const released = new Promise<void>((resolve) => { next = resolve; });
    const turn: SqljsTurn = {
      active: true,
      pending: 0,
      label,
      startedAt: 0,
      site: watch.callSite(above),
      warned: false,
      release: () => {
        turn.active = false;
        watch.end(turn);
        next();
      },
    };
    watch.queued();
    // 다음 차례는 결과와 무관하게 이 차례가 넘어간 뒤 시작한다 — 실패한 트랜잭션이 뒤에 선 일을 막지 않는다.
    // 실패 자체는 `run` 으로 이 호출자에게 간다.
    const run = tail.then(() => {
      watch.begin(turn);
      return reentry.run(turn, () => within(turn, work));
    });
    tail = released;
    return run;
  };
  sqljsWorkQueues.set(dataSource, { enqueue, holdsTurn: () => heldTurn() !== undefined });

  type Method = (...args: unknown[]) => Promise<unknown>;
  // 원본은 부를 때 prototype 에서 찾는다 — 인스턴스에 얹은 이 패치를 다시 부르지 않는다.
  const queuedManagerMethods: Record<string, Method> = {};
  for (const name of SQLJS_QUEUED_MANAGER_METHODS) {
    queuedManagerMethods[name] = function queued(this: EntityManager, ...args: unknown[]) {
      const original = (Object.getPrototypeOf(this) as Record<string, Method>)[name];
      return enqueue(() => original.apply(this, args), name, queued);
    };
  }
  const queueManager = <M extends EntityManager>(manager: M): M => Object.assign(manager, queuedManagerMethods);
  queueManager(dataSource.manager);
  const createEntityManager = dataSource.createEntityManager.bind(dataSource);
  dataSource.createEntityManager = (queryRunner?: QueryRunner) => queueManager(createEntityManager(queryRunner));

  const queuedDataSource = dataSource as unknown as Record<(typeof SQLJS_QUEUED_DATASOURCE_METHODS)[number], Method>;
  for (const name of SQLJS_QUEUED_DATASOURCE_METHODS) {
    const original = queuedDataSource[name].bind(dataSource);
    queuedDataSource[name] = function queuedDataSourceMethod(...args: unknown[]) {
      return enqueue(() => original(...args), name, queuedDataSourceMethod);
    };
  }

  const gatedRunners = new WeakSet<QueryRunner>();
  const gateRunner = (runner: QueryRunner): QueryRunner => {
    if (gatedRunners.has(runner)) return runner;
    gatedRunners.add(runner);
    const query = runner.query as Method;
    runner.query = function gatedQuery(this: QueryRunner, sql: string, ...rest: unknown[]) {
      const run = () => query.call(this, sql, ...rest);
      return isSqljsReadStatement(sql) ? run() : enqueue(run, sqljsStatementLabel(sql), gatedQuery);
    } as QueryRunner['query'];
    const startTransaction = runner.startTransaction as Method;
    runner.startTransaction = function gatedStartTransaction(this: QueryRunner, ...args: unknown[]) {
      if (!heldTurn()) return Promise.reject(new Error(SQLJS_UNQUEUED_TRANSACTION_ERROR));
      return startTransaction.apply(this, args);
    } as QueryRunner['startTransaction'];
    return runner;
  };
  const driver = dataSource.driver as unknown as {
    queryRunner?: QueryRunner;
    createQueryRunner: (mode: ReplicationMode) => QueryRunner;
  };
  const createQueryRunner = driver.createQueryRunner.bind(driver);
  driver.createQueryRunner = (mode: ReplicationMode) => gateRunner(createQueryRunner(mode));
  if (driver.queryRunner) gateRunner(driver.queryRunner);
}


/**
 * Resolve the dev sql.js database directory + on-disk file location.
 *
 * Single source of truth for the SQLite path so both buildDataSourceOptions()
 * and the boot-time corruption guard (ensureSqljsDbHealthy) agree on which
 * file to open / recover.
 *
 * Allow the QA flow-test subprocess to target an isolated db file via env.
 * Two processes writing sqljs to the same file clobber each other on
 * autoSave, so the admin "Run Flow Tests" endpoint sets SQLJS_DB_PATH to e.g.
 * database/qa-flows.db before spawning node --test.
 */
export function resolveSqljsLocation(): { dbDir: string; location: string } {
  const dbDir = path.join(__dirname, '..', '..', '..', 'database');
  const location = process.env.SQLJS_DB_PATH
    ? (path.isAbsolute(process.env.SQLJS_DB_PATH)
        ? process.env.SQLJS_DB_PATH
        : path.join(dbDir, process.env.SQLJS_DB_PATH))
    : path.join(dbDir, 'data.db');
  return { dbDir, location };
}

/**
 * Ontology Graph 자체 sql.js 파일을 위한 resolveSqljsLocation()의 자매 함수
 * (ticket 6ca4894a, DESIGN.md 축 3) — 같은 디렉터리, 다른 파일명, 절대
 * primary와 같은 경로가 되지 않는다. SQLJS_ONTOLOGY_DB_PATH는
 * SQLJS_DB_PATH의 env-override/격리 관례(qa-flow 서브프로세스 격리, 테스트)를
 * 그대로 따른다.
 */
export function resolveOntologySqljsLocation(): { dbDir: string; location: string } {
  const dbDir = path.join(__dirname, '..', '..', '..', 'database');
  const location = process.env.SQLJS_ONTOLOGY_DB_PATH
    ? (path.isAbsolute(process.env.SQLJS_ONTOLOGY_DB_PATH)
        ? process.env.SQLJS_ONTOLOGY_DB_PATH
        : path.join(dbDir, process.env.SQLJS_ONTOLOGY_DB_PATH))
    : path.join(dbDir, 'ontology.db');
  return { dbDir, location };
}

export function buildDataSourceOptions(): DataSourceOptions {
  const dbType = (process.env.DB_TYPE || 'sqlite') as 'sqlite' | 'mysql' | 'postgres';
  // Migrations glob — matches both src/.ts (tsx dev mode) and dist/.js (compiled)
  const migrationsGlob = [path.join(__dirname, 'database', 'migrations', '*.{js,ts}')];

  if (dbType === 'mysql') {
    return {
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01: always true, never NODE_ENV-gated
      migrationsRun: false, // D-02: invoked manually from DatabaseModule.onModuleInit()
      logging: false,
    };
  }

  if (dbType === 'postgres') {
    const schema = process.env.DB_SCHEMA || undefined;
    // Keep this lowercase-only: pg parses `options: -c search_path=...` as an
    // unquoted identifier and folds it to lowercase. Accepting uppercase here
    // would let TypeORM's quoted `schema` and raw migrations target different
    // schemas.
    if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`Invalid DB_SCHEMA identifier: ${schema}`);
    }
    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      // DB_SCHEMA (default unset → 'public', i.e. production untouched) lets the
      // qa-flows Postgres matrix give each test process its OWN schema so the
      // suite — every file connecting to the same ephemeral CI database — does
      // not cross-contaminate the way SQLJS_DB_PATH isolates the sqljs path.
      // bootApp() creates the schema before TypeORM synchronize builds the
      // tables into it (ticket 0c175408).
      schema,
      // TypeORM's `schema` option qualifies synchronize's own DDL, but raw,
      // unqualified SQL in DATA migrations is resolved through the connection
      // search_path. Apply the isolated QA schema first on every pg pool
      // connection so those migrations operate on the same tables synchronize
      // created, while retaining public for extensions such as uuid-ossp.
      // No DB_SCHEMA means no override, preserving Postgres' production default.
      ...(schema ? { extra: { options: `-c search_path=${schema},public` } } : {}),
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01
      migrationsRun: false, // D-02
      logging: false,
    };
  }

  // Default: SQLite (sql.js — pure WASM, no native build required)
  const { dbDir, location: sqliteLocation } = resolveSqljsLocation();
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return {
    type: 'sqljs',
    location: sqliteLocation,
    // autoSave OFF (ticket d5a8594a): the driver would otherwise re-serialize
    // and rewrite the WHOLE DB on every write. Persistence is now batched by
    // SqljsFlushService (NestJS server) / startSqljsAutoFlush (standalone MCP
    // server) — periodic + on graceful shutdown. See the flush block below.
    autoSave: false,
    // SqljsWriteSubscriber flips the dirty flag on writes so an idle server
    // flushes nothing. sqljs-only — the prod backends never construct it.
    subscribers: [SqljsWriteSubscriber],
    // Ontology* 엔티티는 여기서 제외한다(ticket 6ca4894a, 축 3) — 이들은
    // buildOntologyDataSourceOptions()가 만드는 두 번째 DataSource에 들어가고,
    // 이 DataSource의 dirty flag/flush timer/data.db 파일을 절대 공유하지 않는다.
    entities: primarySqljsEntities,
    migrations: migrationsGlob,
    synchronize: true,   // D-01
    migrationsRun: false, // D-02
    logging: false,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
// standalone 진입점(mcp-server.ts, mcp-tools.ts)은 이 인스턴스에 직접
// .transaction()을 호출한다 — NestJS 서버는 TypeOrmModule.forRoot()가 만든
// 별도의 DataSource 인스턴스를 쓰므로 database.module.ts의 DatabaseModule
// 생성자에서 따로 적용한다.
serializeSqljsTransactions(AppDataSource);

// ── dev sql.js batched flush (ticket d5a8594a) ───────────────────────────────
// Default cadence for the periodic flush. Tunable via SQLJS_FLUSH_INTERVAL_MS;
// the resolver clamps to a sane window so a typo can't disable persistence
// (too-low → per-write churn returns) or strand writes for minutes.
export const DEFAULT_SQLJS_FLUSH_INTERVAL_MS = 30_000;
const MIN_SQLJS_FLUSH_INTERVAL_MS = 1_000;       // 1s — floor; tighter defeats batching
const MAX_SQLJS_FLUSH_INTERVAL_MS = 5 * 60_000;  // 5m — ceiling on the crash-loss window

export function resolveSqljsFlushIntervalMs(): number {
  const raw = Number.parseInt(process.env.SQLJS_FLUSH_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SQLJS_FLUSH_INTERVAL_MS;
  return Math.min(MAX_SQLJS_FLUSH_INTERVAL_MS, Math.max(MIN_SQLJS_FLUSH_INTERVAL_MS, raw));
}

/**
 * Persist the in-memory sql.js DB to disk if there are pending writes.
 *
 * - No-op for non-sqljs backends and for an uninitialized DataSource.
 * - Skips the expensive full-DB export when nothing is dirty (unless `force`,
 *   used by the shutdown flush to guarantee a final write).
 * - Overlap handling depends on `force`:
 *     • periodic tick (force=false) — coalesces: if a flush is already running it
 *       returns immediately rather than double-exporting; the running flush (or
 *       the next tick) covers the pending writes.
 *     • shutdown flush (force=true) — supersedes: it AWAITS the in-flight flush,
 *       then exports again. This matters because the in-flight flush cleared the
 *       dirty flag and took its snapshot at its own start; a write that lands in
 *       its async window re-marks dirty but is NOT in that snapshot. On graceful
 *       shutdown there is no "next tick" to catch it, so the forced flush must
 *       re-export to guarantee the last sub-interval batch reaches disk
 *       (ticket 84a6d207).
 *
 * The export itself waits for its turn in the transaction queue and until no
 * transaction is open on the connection (see exportSqljsWhenIdle) — so a flush
 * can take as long as the transactions it waits for, and the forced shutdown
 * flush includes every transaction and write that was already queued when it was
 * called. A forced flush awaited from inside a transaction cannot write while its
 * own caller is open: it does not wait for the in-flight flush, which may be
 * queued behind that very transaction, and fails after the export deadline
 * instead, leaving the batch dirty.
 *
 * Ordering note: the dirty flag is cleared right before the (synchronous) export
 * so a write that lands during the async file write re-marks dirty and is caught
 * on the next tick / by the forced re-export — it is never silently dropped. A
 * failed save re-marks dirty so the batch is retried.
 *
 * @returns true if a save was actually performed.
 */
export async function flushSqljs(dataSource: DataSource, force = false): Promise<boolean> {
  if (!isSqljsBackend()) return false;
  if (!dataSource?.isInitialized) return false;

  if (sqljsFlushInFlight) {
    // A periodic tick coalesces into the running flush; only a forced flush
    // (shutdown) waits it out and then re-exports below.
    if (!force) return false;
    // Inside a transaction the in-flight export is queued behind that
    // transaction, which is waiting for us — never wait for it from there.
    if (!holdsSqljsTurn(dataSource)) {
      try {
        await sqljsFlushInFlight;
      } catch {
        // The in-flight flush's error is surfaced to ITS own caller; we proceed to
        // a fresh forced export regardless so the final batch still gets a shot.
      }
    }
  }

  if (!force && !sqljsDirty) return false;

  const run = doSqljsExport(dataSource);
  sqljsFlushInFlight = run;
  try {
    return await run;
  } finally {
    // Only clear if we're still the current in-flight flush — a forced flush that
    // superseded us may have installed its own promise after awaiting this one.
    if (sqljsFlushInFlight === run) sqljsFlushInFlight = null;
  }
}

/**
 * Perform a single full-DB export. Clears the dirty flag right before the export
 * (so a write during the async file write re-marks dirty) and re-marks dirty on
 * failure so the batch is retried. Internal — callers go through flushSqljs(),
 * which owns the in-flight coalesce/supersede contract.
 */
async function doSqljsExport(dataSource: DataSource): Promise<boolean> {
  try {
    await exportSqljsWhenIdle(dataSource, () => { sqljsDirty = false; });
    return true;
  } catch (e) {
    sqljsDirty = true; // surface for retry on the next tick / shutdown
    throw e;
  }
}

/** How long an export waits for a transaction it cannot wait out in the queue — see exportSqljsWhenIdle(). */
export const SQLJS_EXPORT_TXN_WAIT_MS = 1_000;
const SQLJS_EXPORT_TXN_POLL_MS = 5;

/** The file write of each DataSource's latest export — exports write one at a time (exportSqljsWhenIdle). */
const sqljsFileWrites = new WeakMap<DataSource, { writing: Promise<void>; done: boolean }>();

/**
 * Write a sql.js DataSource to its file without ending an open transaction.
 *
 * sql.js Database.export() closes and reopens the connection. SQLite rolls back
 * whatever transaction is open at that moment; that transaction's remaining
 * statements then autocommit on the reopened connection and its COMMIT fails
 * with "cannot commit - no transaction is active", while TypeORM's single
 * shared runner keeps believing a transaction is active. So the export waits:
 *
 *   1. for its turn in the transaction queue (afterSqljsTransactions) — no queued
 *      transaction or write is running, and none starts until the export is done;
 *   2. then until the connection has no transaction open. Every transaction goes
 *      through the queue, so what is still open here is the caller's own — a
 *      flush awaited inside a transaction — or one a raw `BEGIN` statement opened.
 *
 * Reopening also puts every PRAGMA back to its default, and TypeORM sets
 * foreign_keys = ON only when it opens the connection — after the first flush,
 * foreign keys went unchecked until the process ended (ticket 7e8b1d0c). So the
 * export sets foreign_keys again right after export() (foreignKeysAfterExport).
 *
 * The last check and the export run in one synchronous step — export() happens
 * inside saveDatabase() before its first await — so nothing can open a
 * transaction in between. `markClean` and the foreign_keys restore run in that
 * same step, so no statement runs with foreign keys off (a restore that fails
 * fails the flush, and the next flush that takes its own turn sets them again).
 * The file write that
 * follows does not touch the connection, so the turn is handed on before it:
 * writes and transactions do not wait for disk I/O. File writes still go one at a
 * time, since two overlapping fs.writeFile calls on one file can interleave into a
 * corrupt file: an export whose turn comes while the previous export is still
 * writing waits for that write — holding its turn — and "no write in progress" is
 * part of the same synchronous check. flushSqljs() normally keeps exports apart
 * anyway; only forced flushes inside a held turn can meet here.
 *
 * A transaction still open after SQLJS_EXPORT_TXN_WAIT_MS is not cut: the export
 * fails, the caller keeps its dirty flag, and the next flush tries again. Only a
 * flush awaited from inside a transaction gets that far — it waits on its own
 * caller. A queued transaction that never settles holds up this export (the
 * shutdown flush included) just as it holds up every write behind it.
 */
async function exportSqljsWhenIdle(dataSource: DataSource, markClean: () => void): Promise<void> {
  // Asked before taking the turn — inside the work below, this chain always holds one.
  const callerHoldsTurn = holdsSqljsTurn(dataSource);
  const exported = await afterSqljsTransactions(dataSource, async () => {
    const deadline = Date.now() + SQLJS_EXPORT_TXN_WAIT_MS;
    for (;;) {
      const previous = sqljsFileWrites.get(dataSource);
      if (previous && !previous.done) {
        await previous.writing.catch(() => undefined);
        continue;
      }
      if (!sqljsTransactionOpen(dataSource)) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `sql.js export skipped: a transaction has been open for over ${SQLJS_EXPORT_TXN_WAIT_MS}ms ` +
          `and exporting would end it (Database.export() reopens the connection)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, SQLJS_EXPORT_TXN_POLL_MS));
    }
    markClean();
    const foreignKeys = foreignKeysAfterExport(dataSource, callerHoldsTurn);
    const write = { writing: dataSource.sqljsManager.saveDatabase(), done: false };
    write.writing.then(() => { write.done = true; }, () => { write.done = true; });
    sqljsFileWrites.set(dataSource, write);
    // A failed restore is reported after the write's own outcome: a failed export can leave the
    // connection closed, and then the restore fails too. Boxed so that any thrown value counts —
    // sql.js throws bare strings.
    let restoreFailure: { error: unknown } | null = null;
    try {
      sqljsConnection(dataSource).exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    } catch (error) {
      restoreFailure = { error };
    }
    // Wrapped, not returned: returning the promise would keep this turn until the file write is done.
    return { writing: write.writing, restoreFailure };
  }, 'export');
  await exported.writing;
  if (exported.restoreFailure) throw exported.restoreFailure.error;
}

/**
 * Whether the sql.js connection has a transaction open right now. SQLite itself
 * answers: BEGIN fails with "cannot start a transaction within a transaction"
 * exactly when one is open, and is rolled back at once when none is (sql.js does
 * not expose sqlite3_get_autocommit). TypeORM's queryRunner.isTransactionActive
 * is not a substitute — it stays true for good once a COMMIT fails because the
 * transaction was already gone, which is the state a cutting export left behind,
 * and then no export would ever run again.
 */
function sqljsTransactionOpen(dataSource: DataSource): boolean {
  const db = sqljsConnection(dataSource);
  try {
    db.exec('BEGIN');
  } catch (e) {
    if (/cannot start a transaction within a transaction/.test(String((e as Error)?.message ?? e))) return true;
    throw e;
  }
  db.exec('ROLLBACK');
  return false;
}

/**
 * What foreign_keys goes back to after an export — the reopened connection has it
 * off. exportSqljsWhenIdle() asks before Database.export() and sets the answer
 * right after.
 *
 * On, for an export that waited for its own queue turn. TypeORM turns the checks
 * on when it opens the connection, and only synchronize, migrations and
 * dropDatabase turn them off (beforeMigration … afterMigration, clearDatabase),
 * each inside the one queue turn it holds — the boot synchronize runs before
 * anything can flush — so such an export never lands in that window. Setting them
 * on also undoes whatever left them off: a restore that failed, or a migration
 * that threw before afterMigration.
 *
 * An export called from inside a turn its caller already holds may be in that
 * window, so it puts back the value it found instead.
 */
function foreignKeysAfterExport(dataSource: DataSource, callerHoldsTurn: boolean): boolean {
  if (!callerHoldsTurn) return true;
  const [[on]] = sqljsConnection(dataSource).exec('PRAGMA foreign_keys')[0].values;
  return on === 1;
}

type SqljsConnection = { exec(sql: string): { values: unknown[][] }[] };

/** The sql.js Database a sqljs DataSource runs every statement on — the same object across export(). */
function sqljsConnection(dataSource: DataSource): SqljsConnection {
  return (dataSource.driver as unknown as { databaseConnection: SqljsConnection }).databaseConnection;
}

/**
 * Start a periodic flush loop for a raw (non-NestJS) entry point — the
 * standalone MCP server (mcp-server.ts) owns its DataSource (AppDataSource)
 * directly and has no DI lifecycle, so it wires the timer + shutdown flush here.
 * The NestJS server uses SqljsFlushService instead (DI-managed lifecycle).
 *
 * Returns a `stop()` that clears the timer and performs a final forced flush —
 * call it from the process's SIGINT/SIGTERM handler. No-op (returns an
 * idempotent stop) on non-sqljs backends.
 */
export function startSqljsAutoFlush(
  dataSource: DataSource,
  opts: { onError?: (e: unknown) => void } = {},
): () => Promise<void> {
  if (!isSqljsBackend()) {
    return async () => {};
  }
  const intervalMs = resolveSqljsFlushIntervalMs();
  const handle = setInterval(() => {
    flushSqljs(dataSource).catch((e) => opts.onError?.(e));
  }, intervalMs);
  // Don't let the flush timer alone keep the process alive.
  if (typeof handle.unref === 'function') handle.unref();

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    try {
      await flushSqljs(dataSource, true);
    } catch (e) {
      opts.onError?.(e);
    }
  };
}

// ── dev sql.js 온톨로지 그래프 DataSource (ticket 6ca4894a) ──────────────────
// DESIGN.md 축 3(REVIEW-NOTES.md S1/S3, 둘 다 critical/major): 온톨로지
// 테이블은 primary data.db의 dirty flag, flush timer, 또는
// serializeSqljsTransactions() 큐를 절대 공유해서는 안 된다. 공유한다면
// 온톨로지 테이블 증가(이 설계 자체의 10 MLOC 투영: ~10-15만 노드 +
// ~24만-80만 엣지)가 공유 파일의 이후 모든 flush를 부풀리게 되고 — 무관한
// 티켓 코멘트 하나가 트리거한 flush조차 — 온톨로지 사용자뿐 아니라 모든
// 사용자의 인스턴스 전체 요청 처리를 블로킹하게 된다(S1). 그래서 이 섹션은
// 공유 상태로 리팩터링한 게 아니라, 위 primary flush 메커니즘을 의도적으로
// 거의 그대로 복제한 것이다 — sqljsDirty/sqljsFlushInFlight는 프로세스
// 전역 모듈 변수라(위 자신들의 코멘트 참고) 두 번째 DataSource를 위해
// 재사용하면 이 티켓이 막으려는 바로 그 교차 오염이 조용히 재발한다(한
// DataSource로의 쓰기가 다른 쪽의 dirty flag를 지운다거나, 한 DataSource의
// flush가 다른 쪽의 진행 중인 export에 "합류"해 자기 것을 건너뛴다거나).
// Postgres/MySQL은 이 중 아무것도 구성하지 않는다 — 온톨로지 테이블은 다른
// 모든 배치 flush 메커니즘과 같은 방식(isSqljsBackend())으로 게이트되어
// 기존 단일 DataSource에 변경 없이 synchronize된다.
let ontologySqljsDirty = false;
let ontologySqljsFlushInFlight: Promise<boolean> | null = null;

export function markOntologySqljsDirty(): void {
  ontologySqljsDirty = true;
}

export function isOntologySqljsDirty(): boolean {
  return ontologySqljsDirty;
}

/** SqljsWriteSubscriber의 Ontology-DataSource 전용 자매 클래스 — 위 docstring 참고. */
@EventSubscriber()
export class OntologySqljsWriteSubscriber implements EntitySubscriberInterface {
  afterQuery(event: { query?: string; success?: boolean }): void {
    if (event.success === false) return;
    const command = (event.query || '').trimStart().split(/\s/, 1)[0].toUpperCase();
    if (command && command !== 'SELECT' && command !== 'PRAGMA') {
      markOntologySqljsDirty();
    }
  }
}

/**
 * buildDataSourceOptions()의 자매 함수(DESIGN.md 축 3의 명시적 통합
 * 지점) — DB_TYPE과 무관하게 항상 sql.js 형태다. Postgres/MySQL 변형은
 * 없다: 그 백엔드에서는 Ontology* 엔티티가 이미 단일 primary DataSource에
 * synchronize되므로(거기서는 `entities`에서 절대 제외되지 않음),
 * isSqljsBackend()가 true일 때가 아니면 이 옵션으로 DataSource를 만들 일이
 * 없어야 한다. 호출부는 이 파일의 다른 모든 sqljs 전용 코드 경로와 같은
 * 방식으로 게이트한다.
 */
export function buildOntologyDataSourceOptions(): DataSourceOptions {
  const { dbDir, location } = resolveOntologySqljsLocation();
  // 리뷰 지적(6ca4894a Review round 1): SQLJS_ONTOLOGY_DB_PATH가 잘못
  // 설정되어 정규화 후 primary sql.js DB와 우연히 같은 파일을 가리키면 이
  // 티켓 전체가 조용히 무력화된다 — 독립된 두 sql.js/WASM 인스턴스가 각각
  // 그 파일의 자기 메모리 사본을 들고 서로 다른 스케줄로 export/덮어쓰기를
  // 하면서, 나중에 flush한 쪽이 먼저 flush한 쪽을 손상시키거나 날려버린다.
  // 조용히 그렇게 되도록 두는 대신 부팅을 즉시, 크게 실패시킨다.
  const primaryLocation = path.resolve(resolveSqljsLocation().location);
  const ontologyLocation = path.resolve(location);
  if (ontologyLocation === primaryLocation) {
    throw new Error(
      `[DB] SQLJS_ONTOLOGY_DB_PATH resolves to the same file as the primary sql.js DB ` +
      `(${ontologyLocation}). The ontology DataSource must never share a file with the ` +
      `primary DataSource (ticket 6ca4894a, DESIGN.md axis 3 / REVIEW-NOTES.md S1) — point ` +
      `SQLJS_ONTOLOGY_DB_PATH at a different file.`,
    );
  }
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return {
    type: 'sqljs',
    location,
    autoSave: false,
    subscribers: [OntologySqljsWriteSubscriber],
    entities: ONTOLOGY_ENTITIES,
    synchronize: true,   // D-01
    migrationsRun: false, // D-02 — 여기선 무의미(온톨로지 마이그레이션 자체가 없음), 대칭성 위해 유지
    logging: false,
  };
}

// 활성 백엔드가 sql.js일 때만 생성된다 — Postgres/MySQL에서는 null로
// 남아서 buildOntologyDataSourceOptions()(그리고 그 mkdir 부수효과)가 아예
// 호출조차 안 되고, "Postgres: 변경 없음"과 정확히 일치한다.
export const AppOntologyDataSource: DataSource | null = isSqljsBackend()
  ? new DataSource(buildOntologyDataSourceOptions())
  : null;
if (AppOntologyDataSource) {
  // 자체 트랜잭션 큐(S3) — serializeSqljsTransactions()는 인스턴스별로
  // 동작한다(이 DataSource 자신의 manager를 패치하고, 클로저 로컬 큐 +
  // AsyncLocalStorage로 키잉되므로), 여기서 두 번째로 호출해도 이미
  // 안전하고 함수 자체를 바꿀 필요가 없다.
  serializeSqljsTransactions(AppOntologyDataSource);
}

/** doSqljsExport()의 Ontology-DataSource 전용 자매 함수 — 위 docstring 참고. */
async function doOntologySqljsExport(dataSource: DataSource): Promise<boolean> {
  try {
    // sql.js export는 활성 트랜잭션을 암묵적으로 끝낼 수 있다. 전체 그래프
    // 빌드가 양보한 사이 주기 flush가 끼어들어 COMMIT을 무효화하지 않도록
    // primary와 같은 경로로, 이 DataSource의 트랜잭션이 모두 닫힌 뒤에만 내보낸다.
    await exportSqljsWhenIdle(dataSource, () => { ontologySqljsDirty = false; });
    return true;
  } catch (e) {
    ontologySqljsDirty = true;
    throw e;
  }
}

/** flushSqljs()의 Ontology-DataSource 전용 자매 함수 — 위 docstring 참고. */
export async function flushOntologySqljs(dataSource: DataSource, force = false): Promise<boolean> {
  if (!isSqljsBackend()) return false;
  if (!dataSource?.isInitialized) return false;

  if (ontologySqljsFlushInFlight) {
    if (!force) return false;
    // 트랜잭션 안이면 진행 중인 export 가 바로 그 트랜잭션 뒤에 줄 서 있다 — 기다리면 서로를 기다린다.
    if (!holdsSqljsTurn(dataSource)) {
      try {
        await ontologySqljsFlushInFlight;
      } catch {
        // 그 flush 자신의 호출자에게 전달됨; 새로운 강제 export를 진행한다.
      }
    }
  }

  if (!force && !ontologySqljsDirty) return false;

  const run = doOntologySqljsExport(dataSource);
  ontologySqljsFlushInFlight = run;
  try {
    return await run;
  } finally {
    if (ontologySqljsFlushInFlight === run) ontologySqljsFlushInFlight = null;
  }
}

/**
 * 이 백엔드에 Ontology DataSource가 있으면 초기화한다. Postgres/MySQL에서는
 * no-op(AppOntologyDataSource가 null — 온톨로지 테이블이 이미 primary
 * DataSource에 있음). 멱등적 — NestJS 부트 경로(DatabaseModule.onModuleInit)와
 * standalone MCP 진입점(mcp-server.ts) 양쪽에서 호출해도 안전, 아래
 * initDb()와 같은 자세.
 */
export async function initOntologyDb(): Promise<void> {
  if (!AppOntologyDataSource) return;
  if (!AppOntologyDataSource.isInitialized) {
    await preSyncAccountOwnership(AppOntologyDataSource.options);
    await AppOntologyDataSource.initialize();

  }
}

/** startSqljsAutoFlush()의 Ontology-DataSource 전용 자매 함수 — 위 docstring 참고. */
export function startOntologySqljsAutoFlush(
  dataSource: DataSource | null,
  opts: { onError?: (e: unknown) => void } = {},
): () => Promise<void> {
  if (!dataSource || !isSqljsBackend()) {
    return async () => {};
  }
  const intervalMs = resolveSqljsFlushIntervalMs();
  const handle = setInterval(() => {
    flushOntologySqljs(dataSource).catch((e) => opts.onError?.(e));
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    try {
      await flushOntologySqljs(dataSource, true);
    } catch (e) {
      opts.onError?.(e);
    }
  };
}

/**
 * 온톨로지 sql.js DataSource의 row-count ceiling(ticket 6ca4894a,
 * REVIEW-NOTES.md S1의 defense-in-depth 완화책 — 위 듀얼 DataSource
 * 분리는 온톨로지 증가가 AWB 나머지를 블로킹하는 것은 막지만, 한
 * 계정의 온톨로지 그래프가 같은 sql.js 파일을 공유하는 다른
 * 계정의 온톨로지 그래프 flush를 여전히 느리게 만들 수 있다).
 * sql.js/dev 전용 — Postgres는 매 flush마다 전체 파일을 재export하는
 * 단계 자체가 없으므로 이 ceiling이 적용되지 않는다.
 *
 * 기본값은 추측이 아니라 실제 고정 빌드 실측에서 도출했다:
 * `scripts/benchmark-ontology-flush.mjs`가 이 설계 자체의 워스트케이스 10
 * MLOC 투영(`research-storage.md` §6.3: 150,000 nodes + 800,000 edges =
 * 950,000 rows)을 채운 뒤 실제 saveDatabase() export 시간을 측정 — 536.2
 * MB 파일에 676ms wall-clock(2026-08-22 측정, sql.js@1.12.0, 재현 명령은 그
 * 스크립트 헤더 참고). 1,000,000은 설계된 워스트케이스 전체가 ceiling에
 * 안 걸리고 여유 있게 끝나도록 하면서, 그 이상의 폭주 증가(한 계정에
 * 여러 대형 저장소, 재삽입 버그 등)는 export 비용이 무한정 커지게 두는
 * 대신 실측된 서브초 단위 flush 비용 안으로 제한한다.
 *
 * 이 상수는 숫자만 제공한다 — enforcement(DESIGN.md의 "마지막 스냅샷 기준
 * 읽기 전용으로 격하, 또는 해당 계정의 기능 비활성화")는 여기서
 * 의도적으로 구현하지 않는다. 이 티켓의 범위는 스키마 + DataSource
 * 분리이고, 이 ceiling은 온톨로지 대량 쓰기를 실제로 수행하는 티켓(추출
 * 워커)이나 온톨로지 읽기를 제공하는 티켓이 참조해야 할 값이지,
 * DataSource/flush 레이어 안에서 강제되는 것이 아니다.
 */
export const DEFAULT_ONTOLOGY_SQLJS_ROW_CEILING = 1_000_000;

export function resolveOntologySqljsRowCeiling(): number {
  const raw = Number.parseInt(process.env.ONTOLOGY_SQLJS_ROW_CEILING || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ONTOLOGY_SQLJS_ROW_CEILING;
  return raw;
}

// Matches the family of errors sql.js / SQLite raises when the file on disk
// is not a valid, intact database. Used to distinguish a corrupt-DB failure
// (recoverable in dev — the data is disposable) from a real bug we must not
// mask.
const SQLITE_CORRUPT_RE = /malformed|disk image|file is not a database|not a database|encrypted/i;

/**
 * ensureSqljsDbHealthy() / ensureOntologySqljsDbHealthy() 공용 코어(ticket
 * b646ed54). PRAGMA integrity_check 선제 검사 + AWB_DB_AUTORECOVER 복구
 * 로직은 대상 파일 경로만 다를 뿐 두 DataSource(primary data.db / ontology.db)에
 * 대해 완전히 동일하므로 여기로 추출했다. `pathEnvVarName`은 FATAL 메시지의
 * "다른 파일을 가리키게 하라" 안내에만 쓰인다 — 그 파일의 위치를 오버라이드하는
 * 실제 env var 이름(SQLJS_DB_PATH 또는 SQLJS_ONTOLOGY_DB_PATH)이 그대로
 * 나가야 안내가 정확하다.
 */
async function checkAndRecoverSqljsFile(location: string, pathEnvVarName: string): Promise<void> {
  // Nothing to validate — sql.js will create a fresh DB on initialize().
  if (!fs.existsSync(location)) return;
  if (fs.statSync(location).size === 0) return;

  let SQL: any;
  try {
    // Same package TypeORM's sqljs driver uses; loading it here is a one-time
    // ~100ms WASM init. If sql.js itself can't load, don't block boot — let
    // TypeORM surface whatever the real problem is.
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
  } catch {
    return;
  }

  let corruptDetail: string | null = null;
  try {
    const buf = fs.readFileSync(location);
    const db = new SQL.Database(buf);
    try {
      const res = db.exec('PRAGMA integrity_check');
      const first = res?.[0]?.values?.[0]?.[0];
      if (typeof first === 'string' && first.toLowerCase() !== 'ok') {
        corruptDetail = `integrity_check: ${first}`;
      }
    } finally {
      db.close();
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    if (SQLITE_CORRUPT_RE.test(msg)) {
      corruptDetail = msg;
    } else {
      // Unexpected failure (e.g. permissions) — don't mask it as corruption;
      // let TypeORM's initialize() produce the canonical error.
      console.warn(`[DB] sql.js pre-flight check skipped (unexpected error): ${msg}`);
      return;
    }
  }

  if (!corruptDetail) return;

  const autoRecover =
    process.env.AWB_DB_AUTORECOVER === '1' || process.env.AWB_DB_AUTORECOVER === 'true';

  if (autoRecover) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${location}.corrupt-${ts}`;
    fs.renameSync(location, backup);
    console.error(
      `[DB] ⚠️  Dev sql.js database is CORRUPT (${corruptDetail}).\n` +
      `[DB]     Path: ${location}\n` +
      `[DB]     AWB_DB_AUTORECOVER is set — backed up to ${backup} and recreating an empty DB.`,
    );
    return; // sql.js recreates an empty DB during initialize()
  }

  console.error(
    `\n[DB] ✗ FATAL: dev sql.js database is corrupt — ${corruptDetail}\n` +
    `[DB]     Path: ${location}\n` +
    `[DB]     This is local dev data and is disposable. To fix, either:\n` +
    `[DB]       • delete it so sql.js recreates an empty DB:  rm "${location}"\n` +
    `[DB]       • set AWB_DB_AUTORECOVER=1 to auto-backup + recreate on boot\n` +
    `[DB]       • or point ${pathEnvVarName} at a different file\n` +
    `[DB]     (Aborting now instead of hanging ~25s — ticket e9847153.)\n`,
  );
  process.exit(1);
}

/**
 * Boot-time integrity guard for the dev sql.js database (ticket e9847153).
 *
 * Why this exists: a corrupt `data.db` ("database disk image is malformed")
 * otherwise makes TypeORM's initialize() hang ~25s as synchronize introspects
 * a broken file before finally erroring — long enough that an agent subagent
 * gets SIGTERM-killed (exit 143) before it can report anything. We open the
 * file with sql.js directly here and run PRAGMA integrity_check, so a bad file
 * is caught in <1s with an actionable message *before* TypeORM touches it.
 *
 * Scope: sql.js (dev SQLite) ONLY. Postgres/MySQL return immediately, so
 * production behavior is unchanged. A fresh/missing/empty file also returns
 * early — sql.js creates it on initialize().
 *
 * Recovery: set AWB_DB_AUTORECOVER=1 (dev convenience) to back the corrupt
 * file up to `<file>.corrupt-<ts>` and let sql.js recreate an empty DB.
 * Otherwise we print how to clear it and process.exit(1). Never auto-deletes
 * for non-sqlite backends.
 */
export async function ensureSqljsDbHealthy(): Promise<void> {
  const dbType = process.env.DB_TYPE || 'sqlite';
  if (dbType !== 'sqlite') return;

  const { location } = resolveSqljsLocation();
  await checkAndRecoverSqljsFile(location, 'SQLJS_DB_PATH');
}

/**
 * ensureSqljsDbHealthy()의 Ontology-DataSource 전용 자매 함수(ticket
 * b646ed54) — 같은 PRAGMA integrity_check 선제 검사를
 * resolveOntologySqljsLocation()이 가리키는 파일(기본 database/ontology.db,
 * ticket 6ca4894a)에 대해 수행한다.
 *
 * 이 가드가 빠져 있던 이유가 곧 이 티켓의 존재 이유다: AppOntologyDataSource도
 * (isSqljsBackend()일 때) 표준 TypeORM sqljs DataSource이므로, 손상된
 * ontology.db는 위 primary data.db와 정확히 같은 ~25초 synchronize() hang을
 * 일으킬 수 있다 — 그런데 이 가드는 resolveSqljsLocation()(primary 경로)만
 * 검사하도록 하드코딩되어 있어 두 번째 DataSource는 무방비 상태였다.
 *
 * 로직은 대상 위치만 다를 뿐 ensureSqljsDbHealthy()와 완전히 동일 — 공유
 * 코어는 checkAndRecoverSqljsFile()로 추출했다(AWB_DB_AUTORECOVER 복구
 * 규약도 그대로 재사용: `<file>.corrupt-<ts>` 백업 후 sql.js가 빈 DB를
 * 재생성).
 */
export async function ensureOntologySqljsDbHealthy(): Promise<void> {
  const dbType = process.env.DB_TYPE || 'sqlite';
  if (dbType !== 'sqlite') return;

  const { location } = resolveOntologySqljsLocation();
  await checkAndRecoverSqljsFile(location, 'SQLJS_ONTOLOGY_DB_PATH');
}

export async function initDb() {
  // Catch a corrupt dev DB before TypeORM hangs on it (ticket e9847153).
  await ensureSqljsDbHealthy();
  // 두 번째 sql.js DataSource(ontology.db, ticket 6ca4894a)도 같은 hang을
  // 일으킬 수 있어 아래 initOntologyDb() → AppOntologyDataSource.initialize()
  // 이전에 동일 가드를 돌린다(ticket b646ed54).
  await ensureOntologySqljsDbHealthy();
  await preSyncAccountOwnership(buildDataSourceOptions());
  await preSyncAgentCleanup(buildDataSourceOptions());
  await preSyncBoardRemoval(buildDataSourceOptions());
  await AppDataSource.initialize();
  const applied = await AppDataSource.runMigrations({ transaction: 'each' });
  if (applied.length) console.log(`[DB] Applied ${applied.length} migration(s): ${applied.map(m => m.name).join(', ')}`);
  // Ticket 6ca4894a — Postgres/MySQL에서는 no-op(그쪽은 AppOntologyDataSource가 null).
  await initOntologyDb();
  const dbType = process.env.DB_TYPE || 'sqlite';
  console.log(`[DB] Connected using ${dbType}`);
}

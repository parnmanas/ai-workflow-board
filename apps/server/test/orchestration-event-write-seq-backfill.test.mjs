// 회귀 테스트: 레거시 `orchestration_events.write_seq` 백필 — 티켓 c17b5c2c.
//
// 무엇이 깨져 있나
// ───────────────
//
// `listMissionEvents()` 의 keyset 커서는 `(created_at, write_seq)` 가 전순서라는 전제
// 위에 있다. 그런데 라이브 실측에서 기존 297행은 `write_seq` 가 전부 0 아니면 전부 1
// 이었다 — 미션 하나의 모든 행이 같은 값이라 타이브레이커가 통째로 없는 상태다. 원인이
// 두 갈래다: 컬럼 도입(4d065f82) 이전 행은 기본값 0 이 남았고, 그 이후 행은 85efcb69 가
// 고친 "등호가 Postgres 에서 0건" 결함 때문에 1 에 고정됐다. 채번을 고친 티켓들은
// **앞으로 쓰이는** 행에만 적용되므로 이 구간은 백필 없이는 영원히 남는다.
//
// 왜 컬럼 값 확인만으로는 부족한가
// ──────────────────────────────
//
// 이 백필이 존재하는 이유는 "숫자가 1..N 이어서" 가 아니라 **커서가 이벤트를 잃지 않게**
// 하려는 것이다. 그래서 컬럼 단언과 별개로, 진짜 `OrchestrationMissionService`
// 인스턴스의 `listMissionEvents()` 를 끝까지 순회시켜 백필 **전에는 실제로 유실되고**
// 백필 **후에는 전량이 덮이는지**를 같은 픽스처에서 확인한다. 전자가 비어 있으면
// 백필이 아무것도 고치지 않아도 테스트가 통과해 버린다(비공허성).
//
// 픽스처의 `created_at` 은 원시 UPDATE 로 심는다
// ─────────────────────────────────────────────
//
// sql.js 의 `@CreateDateColumn` 자동 값은 `datetime('now')` 라 **소수점 없는 초 단위
// 문자열**(`'2026-09-02 20:07:26'`)이고, 커서의 tied-group 판정(`tiedCreatedAtWhere`)도
// `sinceBoundaryParam()` 이 만든 같은 형식의 문자열과 등호로 비교한다. 반면 엔티티에
// `created_at` 을 직접 넣어 `save()` 하면 `'....000'` 으로 밀리초가 붙어 저장돼 그 등호가
// 영영 매칭되지 않는다 — 즉 저장 포맷을 프로덕션과 다르게 만들면 테스트가 검증하려던
// 경로 자체를 비껴간다. 그래서 행은 정상 저장한 뒤 `created_at`/`write_seq` 만 원시
// UPDATE 로 레거시 형태에 맞춘다.
//
// Postgres 쪽(마이크로초 정밀도에서 정렬이 어긋나지 않는가)은 이 파일이 재현할 수 없어
// `qa-flows/orchestration-event-write-seq-backfill-pg.test.mjs` 로 분리돼 있다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Agent } from '../dist/entities/Agent.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { OrchestrationStep } from '../dist/entities/OrchestrationStep.js';
import { OrchestrationEvent } from '../dist/entities/OrchestrationEvent.js';
import { OrchestrationTeam } from '../dist/entities/OrchestrationTeam.js';
import { OrchestrationTeamMember } from '../dist/entities/OrchestrationTeamMember.js';
import { OrchestrationMissionService } from '../dist/modules/orchestration/orchestration-mission.service.js';
import { BackfillOrchestrationEventWriteSeq1760000000086 } from '../dist/database/migrations/1760000000086-BackfillOrchestrationEventWriteSeq.js';

const WS = '11111111-1111-4111-8111-111111111111';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** 같은 초에 3건씩 4개 초에 걸친 12건 — 라이브의 `write_seq=0` 구간(컬럼 도입 이전)을 본뜬다. */
const ZERO_SECONDS = ['2026-08-22 02:12:31', '2026-08-22 02:12:32', '2026-08-22 02:12:33', '2026-08-22 02:12:34'];
const ZERO_PER_SECOND = 3;
/** 초가 모두 다른 5건 — 85efcb69 가 고친 `write_seq=1` 고정 구간을 본뜬다. */
const ONE_SECONDS = ['2026-09-02 22:51:50', '2026-09-02 22:51:55', '2026-09-02 23:00:01', '2026-09-02 23:10:00', '2026-09-02 23:17:12'];

let dataSource;
let missionService;
let eventRepo;

/** 미션 행 하나. `listMissionEvents` 가 `requireMission` 으로 실제 행을 읽으므로 필요하다. */
async function seedMission(title) {
  const missionRepo = dataSource.getRepository(OrchestrationMission);
  return missionRepo.save(missionRepo.create({
    workspace_id: WS,
    team_id: 'team-1',
    title,
    objective: 'backfill fixture',
    status: 'running',
    created_by_type: 'user',
    created_by: '33333333-3333-4333-8333-333333333333',
  }));
}

/**
 * 이벤트를 저장한 뒤 `created_at`/`write_seq` 를 레거시 형태로 원시 UPDATE 한다.
 * 저장 포맷을 프로덕션(초 단위, 소수점 없음)과 같게 맞추는 것이 핵심이다(헤더 참고).
 */
async function seedEvent(missionId, createdAt, writeSeq, message, id) {
  let rowId = id;
  if (rowId) {
    // 명시 id 는 `insert()` 로 넣는다 — `save()` 는 PK 가 있으면 조회 후 갱신을 시도한다.
    await eventRepo.insert({ id: rowId, mission_id: missionId, workspace_id: WS, type: 'note', message });
  } else {
    rowId = (await eventRepo.save(eventRepo.create({
      mission_id: missionId, workspace_id: WS, type: 'note', message,
    }))).id;
  }
  await dataSource.query(
    'UPDATE orchestration_events SET created_at = ?, write_seq = ? WHERE id = ?',
    [createdAt, writeSeq, rowId],
  );
  return rowId;
}

/** `up()` 을 실제 QueryRunner 로 돌리고, 마이그레이션이 남긴 요약 로그 줄을 돌려준다. */
async function runBackfill() {
  const queryRunner = dataSource.createQueryRunner();
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await new BackfillOrchestrationEventWriteSeq1760000000086().up(queryRunner);
  } finally {
    console.log = original;
    await queryRunner.release();
  }
  return lines.filter((l) => l.includes('BackfillOrchestrationEventWriteSeq'));
}

/** 한 미션의 행을 `created_at ASC, id ASC`(= 백필이 쓰는 순서) 로 돌려준다. */
async function rowsInBackfillOrder(missionId) {
  return dataSource.query(
    'SELECT id, write_seq FROM orchestration_events WHERE mission_id = ? ORDER BY created_at ASC, id ASC',
    [missionId],
  );
}

/** 커서로 타임라인을 끝까지 순회해 본 이벤트 id 목록을 돌려준다. */
async function walkTimeline(missionId, limit) {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const res = await missionService.listMissionEvents(missionId, WS, {
      limit,
      before_at: cursor?.at,
      before_seq: cursor?.seq,
    });
    for (const e of res.events) seen.push(e.id);
    cursor = res.next_cursor;
    if (!res.has_more) break;
  }
  return seen;
}

before(async () => {
  dataSource = new DataSource({
    type: 'sqljs',
    entities: [Agent, OrchestrationMission, OrchestrationStep, OrchestrationEvent, OrchestrationTeam, OrchestrationTeamMember],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  eventRepo = dataSource.getRepository(OrchestrationEvent);

  missionService = new OrchestrationMissionService(
    dataSource.getRepository(OrchestrationMission),
    dataSource.getRepository(OrchestrationStep),
    eventRepo,
    dataSource.getRepository(OrchestrationTeam),
    dataSource.getRepository(OrchestrationTeamMember),
    dataSource.getRepository(Agent),
    dataSource,
    noopLog,
  );
});

after(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('레거시 write_seq 백필', () => {
  it('미션마다 created_at 순서대로 1..N 을 재부여하고 커서 유실을 닫는다', async () => {
    // ── 픽스처: 라이브에서 실제로 관측된 두 형태 + 이미 올바른 미션 하나 ──
    const zeroMission = await seedMission('legacy write_seq=0');
    const oneMission = await seedMission('legacy write_seq=1');
    const okMission = await seedMission('already correct');

    const zeroIds = [];
    for (const second of ZERO_SECONDS) {
      for (let i = 0; i < ZERO_PER_SECOND; i += 1) {
        zeroIds.push(await seedEvent(zeroMission.id, second, 0, `zero ${second} #${i}`));
      }
    }
    for (const second of ONE_SECONDS) {
      await seedEvent(oneMission.id, second, 1, `one ${second}`);
    }
    const okSeconds = ['2026-09-10 01:00:00', '2026-09-10 01:00:01', '2026-09-10 01:00:02'];
    for (let i = 0; i < okSeconds.length; i += 1) {
      await seedEvent(okMission.id, okSeconds[i], i + 1, `ok #${i}`);
    }
    const okBefore = await rowsInBackfillOrder(okMission.id);
    const createdAtBefore = await dataSource.query(
      'SELECT id, created_at FROM orchestration_events ORDER BY id ASC',
    );

    // ── 비공허성: 백필 전에는 커서가 실제로 이벤트를 잃는다 ──
    const walkedBefore = await walkTimeline(zeroMission.id, 5);
    assert.ok(
      walkedBefore.length < zeroIds.length,
      `백필 전에는 커서 순회가 전체를 덮지 못해야 한다 — 이 단언이 실패하면 픽스처가 결함을 재현하지 못한 것이다 ` +
        `(순회 ${walkedBefore.length} / 전체 ${zeroIds.length})`,
    );

    // ── 백필 ──
    // 로그 단언은 이 테스트 **맨 끝**에 둔다 — 앞에 두면 백필이 아무것도 안 했을 때
    // 실질 불변식(1..N, 커서 전량 커버)이 검증되기 전에 먼저 터져 실패 원인이 가려진다.
    const firstRunLog = await runBackfill();

    // 완료 조건 1-a: 미션별 seq 가 정확히 1..N 이고 created_at 순서와 일치한다.
    for (const [missionId, expectedCount] of [[zeroMission.id, zeroIds.length], [oneMission.id, ONE_SECONDS.length], [okMission.id, okSeconds.length]]) {
      const rows = await rowsInBackfillOrder(missionId);
      assert.equal(rows.length, expectedCount, '픽스처 행 수가 유지돼야 한다');
      assert.deepEqual(
        rows.map((r) => r.write_seq),
        rows.map((_, i) => i + 1),
        `미션 ${missionId} 의 write_seq 는 created_at ASC, id ASC 순서대로 1..N 이어야 한다`,
      );
    }

    // 완료 조건 1-b: (mission_id, write_seq) 중복이 0 이다.
    const dupes = await dataSource.query(
      'SELECT mission_id, write_seq, COUNT(*) AS c FROM orchestration_events GROUP BY mission_id, write_seq HAVING COUNT(*) > 1',
    );
    assert.deepEqual(dupes, [], `(mission_id, write_seq) 중복이 남으면 커서의 전순서 전제가 깨진다: ${JSON.stringify(dupes)}`);

    // 이미 올바른 미션은 손대지 않는다 — 재부여가 "전부 다시 쓰기" 가 아님을 고정한다.
    assert.deepEqual(await rowsInBackfillOrder(okMission.id), okBefore, '이미 1..N 인 미션의 행은 그대로여야 한다');

    // `created_at` 은 백필이 기준으로 삼는 축이다. UPDATE 가 이 컬럼까지 건드리면 방금
    // 계산한 순서가 그 자리에서 무효가 되고 재실행마다 다른 번호가 나온다 — 암묵적으로
    // 통과하는 데 기대지 말고 못 박는다.
    assert.deepEqual(
      await dataSource.query('SELECT id, created_at FROM orchestration_events ORDER BY id ASC'),
      createdAtBefore,
      '백필은 write_seq 만 쓰고 created_at 은 건드리지 않아야 한다',
    );

    // ── 제품 불변식: 백필 후 커서가 전량을 덮고 중복이 없다 ──
    const walkedAfter = await walkTimeline(zeroMission.id, 5);
    assert.equal(
      walkedAfter.length, zeroIds.length,
      `백필 후 커서 순회는 전체를 덮어야 한다 (순회 ${walkedAfter.length} / 전체 ${zeroIds.length})`,
    );
    assert.equal(new Set(walkedAfter).size, walkedAfter.length, '커서가 같은 이벤트를 두 번 돌려주면 안 된다');

    assert.equal(firstRunLog.length, 1, '첫 실행은 재부여 요약을 한 줄 남겨야 한다');
  });

  it('created_at 이 동률이면 uuid 가 아니라 이미 기록된 write_seq 순서를 지킨다', async () => {
    // 티켓 50031353 이 랜딩한 뒤의 기록 경로를 본뜬다. `nextEventOrderingKey()` 는
    // Postgres 에서 `created_at` 을 밀리초 정밀도 JS Date 로 직접 박고 기존 최댓값으로
    // clamp 하므로, 한 밀리초(sqljs 에서는 한 초) 안의 여러 건은 `created_at` 이 정확히
    // 같고 `write_seq` 만 증가한다 — burst 에서는 정상 경로다.
    //
    // 이때 동률을 `id` 로만 가르면 uuid 가 무작위라, 잠금이 애써 직렬화해 기록한 삽입
    // 순서를 백필이 도로 뒤섞는다. 그래서 **id 오름차순을 write_seq 오름차순의 정확한
    // 역순**으로 깔아 두 정렬을 갈라놓고, 백필이 write_seq 쪽을 따르는지 본다.
    const mission = await seedMission('post-fix ties');
    const SAME_SECOND = '2026-09-19 10:00:00';
    const RECORDED_SEQS = [3, 4, 5, 6];
    const idAt = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const idsBySeq = RECORDED_SEQS.map((_, i) => idAt(RECORDED_SEQS.length - i));

    for (let i = 0; i < RECORDED_SEQS.length; i += 1) {
      await seedEvent(mission.id, SAME_SECOND, RECORDED_SEQS[i], `tie #${i}`, idsBySeq[i]);
    }

    const byId = await dataSource.query(
      'SELECT id FROM orchestration_events WHERE mission_id = ? ORDER BY id ASC', [mission.id],
    );
    assert.deepEqual(
      byId.map((r) => r.id), [...idsBySeq].reverse(),
      'id 오름차순은 write_seq 오름차순의 역순이어야 한다 — 그래야 두 정렬 기준이 갈린다',
    );

    await runBackfill();

    const renumbered = await dataSource.query(
      'SELECT id, write_seq FROM orchestration_events WHERE mission_id = ? ORDER BY write_seq ASC', [mission.id],
    );
    assert.deepEqual(
      renumbered.map((r) => r.write_seq), [1, 2, 3, 4],
      '동률 그룹도 1..N 으로 재부여돼야 한다',
    );
    assert.deepEqual(
      renumbered.map((r) => r.id), idsBySeq,
      '재부여 순서는 기록된 write_seq 순서를 따라야 한다 — id 로 가르면 삽입 순서가 뒤집힌다',
    );
  });

  it('두 번 돌려도 결과가 같다(멱등)', async () => {
    const snapshotBefore = await dataSource.query(
      'SELECT id, mission_id, write_seq FROM orchestration_events ORDER BY id ASC',
    );

    // 선행 상태 확인 — 앞 테스트가 실제로 백필된 상태를 남겼어야 이 테스트가 의미를 갖는다.
    // 이게 없으면 up() 이 no-op 이어도 "두 번 돌려도 같다" 가 공허하게 통과한다.
    // 기준은 미션별 최댓값이 아니라 **중복 0** 이다 — 픽스처에 이미 올바른 미션이 섞여
    // 있어 최댓값만 보면 레거시 미션이 손대지 않은 채로도 가드를 통과해 버린다.
    const dupesBefore = await dataSource.query(
      'SELECT mission_id, write_seq, COUNT(*) AS c FROM orchestration_events GROUP BY mission_id, write_seq HAVING COUNT(*) > 1',
    );
    assert.deepEqual(
      dupesBefore, [],
      '멱등 검증은 이미 백필된 상태 위에서만 의미가 있다 — 중복이 남아 있다면 앞 테스트가 재부여하지 못한 것이다',
    );

    const secondRunLog = await runBackfill();
    assert.deepEqual(
      secondRunLog, [],
      '재실행이 행을 하나도 바꾸지 않았다면 요약 로그도 남지 않아야 한다 — 남았다면 같은 값을 다시 쓰고 있다는 뜻이다',
    );

    const snapshotAfter = await dataSource.query(
      'SELECT id, mission_id, write_seq FROM orchestration_events ORDER BY id ASC',
    );
    assert.deepEqual(snapshotAfter, snapshotBefore, '백필은 멱등해야 한다 — 두 번째 실행이 값을 바꾸면 안 된다');
  });
});

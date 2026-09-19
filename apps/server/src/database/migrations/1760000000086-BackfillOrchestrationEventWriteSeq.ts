import { MigrationInterface, QueryRunner } from 'typeorm';
import { OrchestrationEvent } from '../../entities/OrchestrationEvent';

/**
 * Backfill: 이미 쌓여 있는 `orchestration_events` 행의 `write_seq` 를 미션별로
 * 1..N 으로 재부여한다 (티켓 c17b5c2c).
 *
 * 왜 필요한가 — 런타임 수정으로는 절대 메워지지 않는 구간이다
 * ────────────────────────────────────────────────────────────
 *
 * `listMissionEvents()` 의 keyset 커서는 `(created_at, write_seq)` 가 **전순서**라는
 * 전제 위에 서 있다. 그런데 라이브 Postgres 실측(2026-09-19, 읽기 전용 SELECT)에서
 * 기존 297행의 분포는 `write_seq=0` 이 280행(미션 3개), `write_seq=1` 이 17행(미션 1개)
 * 이고 2 이상은 0건이었다 — 즉 **모든 기존 미션이 단 한 개의 seq 값만 갖는다.** 원인이
 * 두 가지다.
 *
 * - `0` 구간: `write_seq` 컬럼 도입(티켓 4d065f82) 이전에 쌓인 행이라 컬럼 기본값 0 이
 *   그대로 남았다.
 * - `1` 구간: 티켓 85efcb69 가 고친 결함 — tied group 조회의 등호가 Postgres 의
 *   마이크로초 정밀도 때문에 0건이 되어 max 가 늘 0, 따라서 seq 가 영구히 1 에 고정됐다.
 *
 * 한 미션의 모든 행이 같은 seq 면 타이브레이커가 통째로 사라진다. 같은 밀리초에 몰린
 * 구간에 페이지 경계가 떨어지면 그 사이 이벤트가 조용히 빠진다 — `write_seq` 컬럼이
 * 존재하는 이유가 바로 그 손실을 막는 것이다. 채번을 고친 티켓들(85efcb69,
 * 50031353)은 **앞으로 쓰이는** 행에만 적용되므로, 이 구간은 여기서 한 번 훑지 않으면
 * 영원히 남는다.
 *
 * 정렬을 JS 가 아니라 SQL 로 하는 이유 (이 마이그레이션의 핵심)
 * ──────────────────────────────────────────────────────────────
 *
 * 커서가 요구하는 진짜 불변식은 "1..N 을 아무렇게나 붙인다" 가 아니라 **한 밀리초 버킷
 * 안에서 `created_at` 의 마이크로초 순서와 `write_seq` 순서가 일치한다** 이다. keyset
 * 술어(`tiedCreatedAtWhere`)가 Postgres 에서 tied group 을 `[t, t+1ms)` **밀리초 단위**로
 * 묶는 반면 `ORDER BY` 는 마이크로초 전량으로 정렬하기 때문이다. 둘이 어긋나면 같은
 * 밀리초 안의 행이 페이지 경계에서 누락되거나 중복된다.
 *
 * 그래서 행을 JS 로 읽어 `created_at` 으로 정렬하면 **안 된다**. TypeORM 이 엔티티로
 * 물려주는 `created_at` 은 JS `Date` 라 밀리초까지만 남고, 마이크로초만 다른 두 행은
 * JS 에서 동률이 되어 2차 키(`id`)로 갈린다 — 그 순서는 DB 의 실제 마이크로초 순서와
 * 무관하므로, 방금 말한 불변식을 고치러 온 마이그레이션이 되레 그것을 깨뜨린다.
 * `ORDER BY e.created_at ASC, e.write_seq ASC, e.id ASC` 를 **DB 에 맡겨** 저장 정밀도
 * 그대로 정렬시키고, 코드는 그 순서에 번호만 붙인다. sqljs 는 초 단위 문자열이라 같은 초
 * 안에서는 뒤의 두 키가 실제 타이브레이커가 되는데, 그쪽 커서도 tied group 을 초 단위로
 * 묶으므로 동일하게 정합적이다.
 *
 * 2차 키가 `id` 가 아니라 `write_seq` 인 이유 (티켓 50031353 랜딩 이후)
 * ───────────────────────────────────────────────────────────────────
 *
 * `nextEventOrderingKey()` 는 Postgres 에서 `created_at` 을 **밀리초 정밀도 JS `Date`** 로
 * 직접 박고 기존 최댓값으로 clamp 한다. 그래서 한 밀리초 안에 여러 건이 기록되면
 * `created_at` 이 **정확히 같고** `write_seq` 만 증가하는 행들이 나온다 — burst 에서는
 * 예외가 아니라 정상 경로다. 이때 `id` 만으로 동률을 가르면 uuid 는 무작위라, 잠금이
 * 애써 직렬화해 기록한 삽입 순서를 이 백필이 도로 뒤섞어 버린다. 그래서 동률에서는 먼저
 * **이미 기록된 `write_seq`** 를 존중하고, 그것마저 같을 때만(= 레거시 구간처럼 한 미션이
 * 단일 seq 값인 경우) `id` 로 내려간다. 레거시 구간에서는 `write_seq` 가 전부 같으므로
 * 이 키가 아무것도 바꾸지 않는다 — 즉 기존 동작은 그대로다.
 *
 * 불변식 (1760000000075 / 1760000000084 와 동일한 태도)
 * ─────────────────────────────────────────────────────
 *
 * - DATA 전용, DDL 없음. 레포지토리/QueryBuilder API 라 sqlite·mysql·postgres 이식 가능.
 * - **멱등**하다 — 재부여 결과가 입력에 대해 결정적이고, 기대값과 이미 같은 행은
 *   건너뛴다. 두 번째 실행은 0행을 쓴다.
 * - 메모리는 미션 한 건 분량으로 제한한다(전체 테이블을 한 번에 물지 않는다).
 * - `(mission_id, write_seq)` **유니크 제약은 걸지 않는다.** 의도적으로 범위 밖이다 —
 *   `db.ts` 의 `synchronize` 가 모든 분기에서 하드코딩 on 이라 엔티티에 제약을 얹으면
 *   라이브에 즉시 적용되고, 이 백필이 랜딩·배포되기 전에는 부팅이 실패한다. 걸 거라면
 *   백필이 배포된 뒤 별도 판단이다.
 *
 * `down()` 은 no-op 이다 — 이전 값(전부 0 또는 전부 1)은 정보가 아니라 결함 그 자체라
 * 되돌릴 의미가 없고, 행별 원본을 남긴 감사 기록도 없다.
 */
export class BackfillOrchestrationEventWriteSeq1760000000086 implements MigrationInterface {
  name = 'BackfillOrchestrationEventWriteSeq1760000000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const repo = queryRunner.manager.getRepository(OrchestrationEvent);

    // `.select('DISTINCT ...')` 는 TypeORM 이 별칭을 뒤에 붙이면서 무효 SQL 이 된다 —
    // `.distinct(true)` 로만 쓴다.
    const missionRows = await repo
      .createQueryBuilder('e')
      .select('e.mission_id', 'mission_id')
      .distinct(true)
      .getRawMany<{ mission_id: string | null }>();

    let updated = 0;
    let missionsTouched = 0;

    for (const row of missionRows) {
      const missionId = row.mission_id;
      if (!missionId) continue;

      // 정렬은 DB 가 저장 정밀도 그대로 수행한다(헤더 참고). 코드로 가져오는 값은
      // `id` 와 현재 `write_seq` 뿐이고 `created_at` 값 자체는 쓰지 않는다.
      const events = await repo
        .createQueryBuilder('e')
        .select(['e.id', 'e.write_seq'])
        .where('e.mission_id = :missionId', { missionId })
        .orderBy('e.created_at', 'ASC')
        .addOrderBy('e.write_seq', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .getMany();

      let changedInMission = 0;
      for (let i = 0; i < events.length; i += 1) {
        const expected = i + 1;
        if ((events[i].write_seq ?? 0) === expected) continue;
        await repo.update(events[i].id, { write_seq: expected });
        changedInMission += 1;
      }

      if (changedInMission > 0) {
        updated += changedInMission;
        missionsTouched += 1;
      }
    }

    if (updated > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[Migration] BackfillOrchestrationEventWriteSeq: renumbered write_seq on ${updated} event row(s) ` +
          `across ${missionsTouched} mission(s)`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 되돌릴 의미가 있는 이전 값이 없다 — 헤더 참고.
  }
}

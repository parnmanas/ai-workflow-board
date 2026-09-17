import type { DataSource } from 'typeorm';

/**
 * Normalizes a ROLLING-WINDOW `created_at >= :since`-style query parameter so
 * it compares correctly against sql.js/sqlite (ticket 8fc94adf).
 *
 * Root cause: `@CreateDateColumn()` fields (Comment.created_at,
 * ActivityLog.created_at, ...) that are left unset when the entity is
 * created get their value from the column's DB-level `DEFAULT
 * (datetime('now'))` — sqlite's own `datetime('now')` has NO fractional
 * seconds ("2026-07-22 14:48:30"). A bound `Date` query parameter, however,
 * is always formatted by TypeORM's sqlite driver WITH milliseconds
 * ("2026-07-22 14:48:30.000"). Since the comparison is a plain lexicographic
 * string compare on sqlite, a stored value is a strict *prefix* of a same-
 * second parameter and therefore always sorts before it — `created_at >=
 * :since` silently excludes any row created in the same wall-clock second as
 * `since`, no matter its true sub-second ordering.
 *
 * Postgres stores/compares real `timestamp` values at full precision and
 * has no such mismatch, so this is a no-op for every driver except sqljs.
 *
 * The fix floors `since` to a whole-second string in the exact format
 * sqlite's own default produces, so same-second rows compare equal (and
 * therefore match `>=`) instead of being silently dropped. This WIDENS the
 * matched set by less than one second — safe for a pure rolling window
 * (`since = now - windowMs`, e.g. respawn-storm-detector.service.ts's
 * forward-progress veto) where there is no other invariant to protect.
 *
 * DO NOT use this for an EPOCH-ANCHORED comparison (`since` = the ticket's
 * last human-unpend timestamp, as in common/hard-budget-guard.ts's
 * `countAutoResponses`/`countWindowDispatches`). There, the exact same
 * same-second EXCLUSION this function removes is load-bearing: it guarantees
 * a comment/dispatch from BEFORE the unpend epoch never gets recounted as
 * "after" it. Widening that comparison to be same-second-inclusive lets
 * pre-epoch events leak into the post-unpend count and reopens the
 * permanent-death loop ticket a940d75b closed (see hard-budget-guard.ts's
 * doc comments on those two functions, and hard-budget-guard.test.mjs's "a
 * human unpend actually clears the ceiling" regression test).
 */
export function sinceBoundaryParam(dataSource: DataSource, since: Date): Date | string {
  if (dataSource.options.type !== 'sqljs') return since;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${since.getUTCFullYear()}-${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())} ` +
    `${pad(since.getUTCHours())}:${pad(since.getUTCMinutes())}:${pad(since.getUTCSeconds())}`
  );
}

/**
 * "가장 최근 `created_at` 과 같은 시각" 인 행을 고르는 WHERE 조건을 드라이버별로
 * 만든다 (ticket 62407d4e).
 *
 * 왜 등호(=) 비교로는 안 되는가 — Postgres 에서 조용히 0건이 된다:
 * `@CreateDateColumn()` 은 INSERT 시 `CURRENT_TIMESTAMP` 로 채워지고 Postgres 의
 * `timestamp` 기본 정밀도는 마이크로초다(예: `05:11:20.689432`). 그 행을 엔티티로
 * 읽으면 JS `Date` 라 **밀리초까지만** 남으므로(`05:11:20.689`), 그 값을 그대로
 * 등호 파라미터로 되돌리면 자기 자신을 포함해 **어떤 행과도 일치하지 않는다.**
 * 실측(라이브 Postgres, 티켓 3건·코멘트 45건)에서 tied group 이 항상 비어
 * `_comment_write_seq` 가 전부 1 이었고, `add_comment` 의 dedupe 합치기가 한 번도
 * 발동하지 못한 채 같은 `dedupe_key` 자동 알림이 중복 row 로 쌓였다.
 *
 * 그래서 sqljs 가 아닌 드라이버에는 **[t, t+1ms) 반개구간**을 쓴다 — JS `Date` 가
 * 표현할 수 있는 최소 단위 하나만큼만 넓히므로, 잘려나간 마이크로초 꼬리를 가진
 * 원래 행은 반드시 포함되고 다음 밀리초의 행은 절대 들어오지 않는다.
 *
 * sqljs 는 반대 방향의 문제라 기존 처리를 그대로 둔다: 저장 포맷이 초 단위
 * 문자열이고 비교가 사전식이므로, `sinceBoundaryParam()` 이 만든 초 단위 문자열과의
 * 등호가 정확히 "같은 초에 저장된 행" 을 집는다(위 함수의 근본원인 설명 참고).
 */
export function tiedCreatedAtWhere(
  dataSource: DataSource,
  alias: string,
  at: Date,
): { clause: string; params: Record<string, unknown> } {
  if (dataSource.options.type === 'sqljs') {
    return {
      clause: `${alias}.created_at = :tiedCreatedAtEq`,
      params: { tiedCreatedAtEq: sinceBoundaryParam(dataSource, at) },
    };
  }
  return {
    clause: `${alias}.created_at >= :tiedCreatedAtFrom AND ${alias}.created_at < :tiedCreatedAtTo`,
    params: { tiedCreatedAtFrom: at, tiedCreatedAtTo: new Date(at.getTime() + 1) },
  };
}

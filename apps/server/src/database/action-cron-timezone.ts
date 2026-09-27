// `1760000000088-MoveActionCronToWorkspaceSchedules` 가 쓰는 순수 헬퍼.
//
// **왜 마이그레이션 파일 밖에 있나**: TypeORM 은 migrations glob
// (`src/database/migrations/*.{js,ts}`) 에 걸린 파일의 **모든 export** 를 마이그레이션
// 클래스로 취급한다. 헬퍼를 그 파일에서 export 하면 부팅이
// `Object migration name is wrong` 으로 죽는다(실측). 테스트가 직접 부를 수 있으면서
// glob 에는 안 걸리는 자리가 여기다.

import type { QueryRunner } from 'typeorm';

/** sqlite 는 `?`, postgres 는 `$n` 을 쓴다. 한 줄짜리 어댑터. */
export function bindParams<T = any>(runner: QueryRunner, sql: string, params: any[]): Promise<T[]> {
  if (runner.connection.options.type !== 'postgres') return runner.query(sql, params);
  let i = 0;
  return runner.query(sql.replace(/\?/g, () => `$${++i}`), params);
}

/**
 * 로컬시간 5-field 크론을 UTC 로 옮긴다. 벽시계 시각을 보존하는 것이 목표다.
 *
 * 옮길 수 없으면 `null` 을 돌려준다 — 호출부가 그 스케줄을 꺼 둔다. 옮길 수 없는
 * 경우는 하나뿐이다: 시를 되돌리면서 날짜가 넘어가는데 dom/month 가 고정된 행.
 * 그건 "매달 3일 03시" 같은 뜻인데 UTC 로는 2일이 될 수도 3일이 될 수도 있어
 * 한 식으로 옮길 수 없다.
 *
 * export 하는 이유는 테스트가 직접 부르기 때문이다.
 */
export function localCronToUtc(expr: string, offsetMinutes: number): { cron: string | null } {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return { cron: null };
  const [min, hour, dom, month, dow] = parts;
  if (offsetMinutes === 0) return { cron: expr.trim() };
  // 분 단위 오프셋(인도 등)은 시 필드만으로 표현할 수 없다 — 분도 같이 옮겨야
  // 하는데 그러면 `*` 분과 섞이지 않는다. 그런 배포에서는 꺼서 눈에 띄게 한다.
  if (offsetMinutes % 60 !== 0) return { cron: null };
  if (hour === '*') return { cron: expr.trim() }; // 매시 실행은 시간대와 무관하다
  const h = Number(hour);
  if (!Number.isInteger(h)) return { cron: null }; // 목록/범위 시각은 옛 파서가 애초에 거부했다

  const shifted = h - offsetMinutes / 60;
  const utcHour = ((shifted % 24) + 24) % 24;
  const dayShift = Math.floor(shifted / 24); // -1, 0, +1

  if (dayShift === 0) return { cron: `${min} ${utcHour} ${dom} ${month} ${dow}` };
  if (dom !== '*' || month !== '*') return { cron: null };
  if (dow === '*') return { cron: `${min} ${utcHour} ${dom} ${month} ${dow}` };
  const d = Number(dow);
  if (!Number.isInteger(d)) return { cron: null };
  const utcDow = ((d + dayShift) % 7 + 7) % 7;
  return { cron: `${min} ${utcHour} ${dom} ${month} ${utcDow}` };
}

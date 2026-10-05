// 크론은 Action 이 아니라 Account Schedule 이 갖는다.
//
// 고치는 증상: 크론 구현이 두 벌이었다. Action 쪽(`modules/actions/cron.ts`)은
// **로컬시간** tick-match 라 그 1분에 서버가 죽어 있으면 그날 실행이 조용히
// 사라졌고, Schedule 쪽(`modules/qa/qa-cron.ts`)은 **UTC** + `next_run_at` 커서라
// 놓친 실행을 따라잡았다. 같은 개념이 두 곳에서 다르게 동작했고, 운영자는 어느
// 화면에서 예약을 걸었는지에 따라 다른 보장을 받았다.
//
// 그래서 고정하는 것:
//   1. Action 은 이제 "무엇을 · 누가 · 어디서" 만 정의한다 — `schedule_cron` 을
//      저장하려 하면 거부하고 갈 곳을 알려 준다(조용히 무시하면 "예약했는데
//      안 돈다" 가 된다).
//   2. Schedule 은 `task_prompt` 와 `action_id` 중 **정확히 하나**를 갖는다.
//   3. 이관 시 벽시계 시각이 보존된다(로컬 → UTC 변환).
//
// 발화가 실제로 Action 파이프라인을 타는지는
// `test/automation-schedule-action-dispatch.test.mjs` 가 본다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { localCronToUtc } from '../dist/database/action-cron-timezone.js';

// KST(+9). 이 저장소가 실제로 도는 시간대이고 이관이 겨냥한 값이다.
const KST = 540;

test('벽시계 시각을 보존한다 — 로컬 04:00 은 UTC 19:00 이다', () => {
  // 실측 대상: "Package 보안 점검" 이 매일 04:00 KST 에 돌던 크론.
  assert.equal(localCronToUtc('0 4 * * *', KST).cron, '0 19 * * *');
  // 같은 날 안에서 끝나는 경우.
  assert.equal(localCronToUtc('30 22 * * *', KST).cron, '30 13 * * *');
});

test('자정을 넘어가면 요일도 함께 되돌린다', () => {
  // 실측 대상: "에이전트 홈 위생 점검" — 월요일 05:00 KST = 일요일 20:00 UTC.
  assert.equal(localCronToUtc('0 5 * * 1', KST).cron, '0 20 * * 0');
  // 일요일(0) 에서 하루 되돌리면 토요일(6) 로 감싼다.
  assert.equal(localCronToUtc('0 5 * * 0', KST).cron, '0 20 * * 6');
  // 요일이 `*` 면 되돌릴 것이 없다.
  assert.equal(localCronToUtc('0 5 * * *', KST).cron, '0 20 * * *');
});

test('UTC 서버에서는 식이 그대로다', () => {
  assert.equal(localCronToUtc('0 4 * * 1', 0).cron, '0 4 * * 1');
});

test('매시 실행은 시간대와 무관하므로 건드리지 않는다', () => {
  assert.equal(localCronToUtc('15 * * * *', KST).cron, '15 * * * *');
});

test('한 식으로 옮길 수 없는 경우는 null — 호출부가 그 스케줄을 꺼 둔다', () => {
  // 날짜가 넘어가는데 날짜(dom)가 고정: "매달 3일 05시" 는 UTC 로 2일이 될 수도
  // 3일이 될 수도 있어 5-field 하나로 표현할 수 없다. 조용히 틀린 날 도는 것보다
  // 꺼진 채 눈에 띄는 편이 낫다.
  assert.equal(localCronToUtc('0 5 3 * *', KST).cron, null);
  // 분 단위 오프셋(예: +5:30)은 시 필드만으로 못 옮긴다.
  assert.equal(localCronToUtc('0 5 * * *', 330).cron, null);
  // 5개 필드가 아니면 애초에 크론이 아니다.
  assert.equal(localCronToUtc('0 5 * *', KST).cron, null);
  assert.equal(localCronToUtc('', KST).cron, null);
});

test('날짜가 안 넘어가면 dom 이 고정이어도 옮길 수 있다', () => {
  // 로컬 23:00 → UTC 14:00, 같은 날. dom 을 건드릴 이유가 없다.
  assert.equal(localCronToUtc('0 23 3 * *', KST).cron, '0 14 3 * *');
});

// ─── 옛 구현이 사라졌는지 ────────────────────────────────────────────────

import { readFile, access } from 'node:fs/promises';

test('Action 쪽 크론 구현과 스케줄러가 저장소에서 사라졌다', async () => {
  for (const gone of [
    '../src/modules/actions/cron.ts',
    '../src/modules/actions/action-scheduler.service.ts',
  ]) {
    await assert.rejects(
      () => access(new URL(gone, import.meta.url)),
      `${gone} 는 삭제돼야 한다 — 남겨 두면 두 번째 크론 구현이 다시 자란다`,
    );
  }
});

test('Action 저장 경로가 schedule_cron 을 거부하고 갈 곳을 알려 준다', async () => {
  const src = await readFile(new URL('../src/modules/actions/actions.service.ts', import.meta.url), 'utf8');
  // 조용히 버리면 "예약했는데 안 돈다" 가 된다 — 400 으로 막는다.
  assert.match(src, /SCHEDULE_CRON_MOVED/);
  assert.match(src, /schedule_cron has moved off Action/);
  // 어디로 가야 하는지까지 말한다. 슬러그만 던지면 사용자는 다음 행동을 모른다.
  assert.match(src, /automation-schedules/);
  assert.match(src, /action_id/);
  // 옛 파서를 다시 끌어오지 않았다.
  assert.doesNotMatch(src, /from '\.\/cron'/);
});

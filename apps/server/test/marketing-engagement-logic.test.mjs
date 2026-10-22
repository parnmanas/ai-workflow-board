// Marketing 참여 지표 자동 수집의 순수 규칙 — docs/marketing.md "참여 지표 자동 수집", common/marketing/engagement.ts.
//
// 고정하는 것:
//   1. 서버가 읽는 채널은 reddit · github outreach 채널뿐이다.
//   2. 일정: 게시 1 시간 뒤 첫 읽기, 나이 1 일 미만 1 시간 · 3 일 미만 3 시간 · 그 뒤 12 시간, 14 일째에 마지막으로 읽고 끝.
//   3. rate limit: 채널 cap 이 있으면 남은 것 가운데 절반 몫은 남긴다. cap 이 없으면 제한 없음. 지금 읽지 못한 글은 30 분 뒤 다시
//      보되 기간 끝을 넘기지 않는다(기간이 끝났으면 끝 — 미룬 글이 영원히 남지 않는다).
//   4. 변화량: 직전 값과의 차이만 남긴다(변화 없으면 없음, 음수 가능, 감춘 값은 직전 값 유지). 행의 합 = 마지막 값.
//
// 실행: node --test test/marketing-engagement-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGAGEMENT_ALIGN_MS,
  ENGAGEMENT_DEFER_MS,
  ENGAGEMENT_RESERVED_SHARE,
  ENGAGEMENT_SOURCE,
  ENGAGEMENT_WINDOW_MS,
  deferEngagementReadAt,
  engagementChanges,
  engagementIntervalMs,
  engagementRequestBudget,
  engagementTracked,
  firstEngagementReadAt,
  nextEngagementReadAt,
} from '../dist/common/marketing/engagement.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

test('only reddit/github outreach channels are read by the server', () => {
  assert.equal(ENGAGEMENT_SOURCE, 'connector');
  assert.equal(engagementTracked({ kind: 'outreach', platform: 'reddit' }), true);
  assert.equal(engagementTracked({ kind: 'outreach', platform: 'github' }), true);
  assert.equal(engagementTracked({ kind: 'manual', platform: 'reddit' }), false, 'a person posts manual channels — no platform id to read');
  assert.equal(engagementTracked({ kind: 'email', platform: 'email' }), false);
  assert.equal(engagementTracked({ kind: 'outreach', platform: 'hacker_news' }), false);
});

test('schedule: first read after an hour, interval by age, last read at the end of the 14-day window', () => {
  const published = new Date('2026-10-01T00:00:00Z');
  const at = (ms) => new Date(published.getTime() + ms);
  assert.equal(ENGAGEMENT_WINDOW_MS, 14 * DAY);
  assert.equal(firstEngagementReadAt(published).toISOString(), at(HOUR).toISOString());
  assert.equal(engagementIntervalMs(0), HOUR);
  assert.equal(engagementIntervalMs(DAY - 1), HOUR);
  assert.equal(engagementIntervalMs(DAY), 3 * HOUR);
  assert.equal(engagementIntervalMs(3 * DAY - 1), 3 * HOUR);
  assert.equal(engagementIntervalMs(3 * DAY), 12 * HOUR);
  assert.equal(nextEngagementReadAt(published, at(HOUR)).toISOString(), at(2 * HOUR).toISOString());
  assert.equal(nextEngagementReadAt(published, at(2 * DAY)).toISOString(), at(2 * DAY + 3 * HOUR).toISOString());
  assert.equal(nextEngagementReadAt(published, at(5 * DAY)).toISOString(), at(5 * DAY + 12 * HOUR).toISOString());
  assert.equal(nextEngagementReadAt(published, at(14 * DAY - 2 * HOUR)).toISOString(), at(14 * DAY).toISOString(), 'clamped to the window end');
  assert.equal(nextEngagementReadAt(published, at(14 * DAY)), null, 'the read at the window end is the last one');
  assert.equal(nextEngagementReadAt(published, at(20 * DAY)), null, 'a late read after the window ends it too');
  // Every scheduled read stays inside the window, and the whole schedule is small.
  let t = firstEngagementReadAt(published);
  let reads = 0;
  while (t) {
    reads++;
    assert.ok(t.getTime() <= published.getTime() + ENGAGEMENT_WINDOW_MS);
    t = nextEngagementReadAt(published, t);
  }
  assert.ok(reads > 40 && reads < 80, `reads over the window: ${reads}`);
});

test('deferral: look again in 30 minutes, never past the window end, and end with the window', () => {
  const published = new Date('2026-10-01T00:00:00Z');
  const at = (ms) => new Date(published.getTime() + ms);
  assert.equal(ENGAGEMENT_DEFER_MS, 30 * 60_000);
  assert.equal(ENGAGEMENT_ALIGN_MS, 30 * 60_000);
  assert.equal(deferEngagementReadAt(published, at(5 * HOUR)).toISOString(), at(5 * HOUR + 30 * 60_000).toISOString());
  assert.equal(deferEngagementReadAt(published, at(14 * DAY - 10 * 60_000)).toISOString(), at(14 * DAY).toISOString());
  assert.equal(deferEngagementReadAt(published, at(14 * DAY)), null, 'a post that could not be read before its window ended leaves the queue');
});

test('rate budget: half of the channel cap is left to publishing and polling', () => {
  assert.equal(ENGAGEMENT_RESERVED_SHARE, 0.5);
  assert.equal(engagementRequestBudget(0, Infinity), Infinity, 'no cap configured → no limit from the cap');
  assert.equal(engagementRequestBudget(10, 10), 5);
  assert.equal(engagementRequestBudget(10, 6), 1);
  assert.equal(engagementRequestBudget(10, 5), 0);
  assert.equal(engagementRequestBudget(10, 0), 0);
  assert.equal(engagementRequestBudget(3, 3), 1, 'the reserve rounds up');
  assert.equal(engagementRequestBudget(1, 1), 0, 'a cap of one request an hour is left entirely to publishing');
});

test('changes: only differences are recorded, the platform value lives on the post', () => {
  const first = engagementChanges('reddit', {}, { reactions: 1, comments: 0 });
  assert.deepEqual(first.changes, [{ metric: 'engagements', delta: 1, note: 'reddit score 0 → 1' }], '0 → 0 comments is no change');
  assert.deepEqual(first.value, { engagements: 1, replies: 0 });

  const grew = engagementChanges('reddit', first.value, { reactions: 57, comments: 12 });
  assert.deepEqual(grew.changes, [
    { metric: 'engagements', delta: 56, note: 'reddit score 1 → 57' },
    { metric: 'replies', delta: 12, note: 'reddit comments 0 → 12' },
  ]);
  const same = engagementChanges('reddit', grew.value, { reactions: 57, comments: 12 });
  assert.deepEqual(same.changes, []);
  const fell = engagementChanges('reddit', same.value, { reactions: 50, comments: 11 });
  assert.deepEqual(fell.changes.map((c) => c.delta), [-7, -1], 'decreases are recorded so the rows still add up to the platform value');
  const sum = [first, grew, same, fell].flatMap((r) => r.changes).filter((c) => c.metric === 'engagements').reduce((a, c) => a + c.delta, 0);
  assert.equal(sum, fell.value.engagements);

  const hidden = engagementChanges('reddit', fell.value, { reactions: null, comments: 13 });
  assert.deepEqual(hidden.changes, [{ metric: 'replies', delta: 2, note: 'reddit comments 11 → 13' }]);
  assert.equal(hidden.value.engagements, 50, 'a hidden score keeps the last value');

  const reply = engagementChanges('github', null, { reactions: 3, comments: null });
  assert.deepEqual(reply.changes, [{ metric: 'engagements', delta: 3, note: 'GitHub reactions 0 → 3' }]);
  assert.deepEqual(reply.value, { engagements: 3 }, 'a comment has no comment count of its own');
  assert.deepEqual(engagementChanges('github', { engagements: 3, replies: 1 }, { reactions: 3, comments: 4 }).changes,
    [{ metric: 'replies', delta: 3, note: 'GitHub comments 1 → 4' }]);
});

import { parseEngagementPermalink, manualEngagementTarget } from '../dist/common/marketing/engagement-target.js';

test('manual permalinks resolve exact platform refs without following arbitrary URLs', () => {
  for (const host of ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com']) {
    assert.deepEqual(parseEngagementPermalink(`https://${host}/r/SelfHosted/comments/ABC123/title/?utm_source=x`), { platform: 'reddit', target: 'selfhosted', ref: 't3_abc123' });
    assert.equal(parseEngagementPermalink(`https://${host}/r/selfhosted/comments/abc123/title/DEF456/`).ref, 't1_def456');
  }
  assert.deepEqual(parseEngagementPermalink('https://github.com/Acme/Widget/issues/42'), { platform: 'github', target: 'acme/widget', ref: 'issue:acme/widget#42' });
  assert.equal(parseEngagementPermalink('https://github.com/acme/widget/issues/42#issuecomment-123').ref, 'comment:acme/widget#42:123');
  for (const url of ['garbage', 'https://reddit.com.evil/r/test/comments/abc', 'https://reddit.com@evil/r/test/comments/abc', 'https://user@reddit.com/r/test/comments/abc', 'https://reddit.com:8080/r/test/comments/abc', 'ftp://reddit.com/r/test/comments/abc', 'https://redd.it/abc', 'https://reddit.com/r/test/s/abc', 'https://github.com/acme/widget/pull/1', 'https://github.com/acme/widget/issues/1#discussion_r123', 'https://github.com/acme/widget/issues/9007199254740993', 'https://github.com/acme/widget/issues/1/more']) {
    assert.equal(parseEngagementPermalink(url), null, url);
  }
});

test('manual refs require the same account and exact target; overlapping whitelists choose one stable channel', () => {
  const post = { account_id: 'a', permalink: 'https://reddit.com/r/test/comments/abc/title' };
  const channel = { account_id: 'a', kind: 'manual' };
  const valid = { id: 'b', account_id: 'a', kind: 'reddit', targets: ['TEST'] };
  assert.equal(manualEngagementTarget(post, channel, [valid]).ref, 't3_abc');
  for (const invalid of [{ ...valid, account_id: 'other' }, { ...valid, targets: ['testing'] }, { ...valid, kind: 'github' }]) {
    assert.equal(manualEngagementTarget(post, channel, [invalid]), null);
  }
  assert.equal(manualEngagementTarget(post, { ...channel, account_id: 'other' }, [valid]), null);
  assert.equal(manualEngagementTarget(post, { ...channel, kind: 'outreach' }, [valid]), null);
  assert.equal(manualEngagementTarget(post, channel, [valid, { ...valid, id: 'a' }]).outreachId, 'a');
});

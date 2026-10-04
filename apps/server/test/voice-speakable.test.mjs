// 화면용 답 → 귀로 들을 문장(toSpeakable) · 합성 조각(splitSpeakable) 회귀 테스트.
//
// 고정하는 것 (docs/voice-operator.md "출력"):
//   1. 코드 블록 · 표 · URL · 이미지 · UUID · 커밋 해시는 읽지 않는다 — 화면에 남아 있고, 귀로는 소음이다.
//   2. 경로는 마지막 조각만 읽는다(apps/server/src/x.ts:12 → x.ts). 날짜(2026/10/04)는 경로가 아니다.
//   3. 목록·제목은 표지만 떼고 문장으로 끝맺는다 — 끝맺음이 없으면 엔진이 숨을 쉬지 않는다.
//   4. 언어 중립 — 지운 자리에 "코드는 화면을 보세요" 같은 대체 문구를 넣지 않는다.
//   5. 조각은 문장 경계에서 나누고, 첫 조각은 짧게(첫 소리까지의 지연), 너무 짧으면 다음과 묶는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { splitSpeakable, toSpeakable } from '../dist/modules/voice/speakable.js';

test('drops code, tables, URLs, images and identifiers; keeps the sentences', () => {
  const md = [
    '## 결과',
    '',
    '배포가 끝났어요. **rolf** 서버를 재시작했고 `agent-manager` 도 최신입니다.',
    '',
    '- 커밋 3f2c3761 을 main 에 올렸어요',
    '- 티켓 d1e2f3a4-1234-4abc-9def-0123456789ab 은 Done 으로 옮겼어요',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '![diagram](./docs/flow.png)',
    '자세한 건 [PR #21](https://github.com/parnmanas/ai-workflow-board/pull/21) 을 보세요.',
  ].join('\n');
  const spoken = toSpeakable(md);
  assert.match(spoken, /^결과\. 배포가 끝났어요\. rolf 서버를 재시작했고 agent-manager 도 최신입니다\./);
  assert.match(spoken, /자세한 건 PR #21 을 보세요\.$/);
  for (const noise of ['3f2c3761', 'd1e2f3a4', 'https://', 'const x', '| a |', '---', 'flow.png', '**', '`']) {
    assert.ok(!spoken.includes(noise), `"${noise}" must not be read aloud: ${spoken}`);
  }
});

test('paths are read by their last segment; dates and fractions are not paths', () => {
  assert.equal(toSpeakable('apps/server/src/modules/voice/voice.service.ts:42 수정'), 'voice.service.ts 수정.');
  assert.equal(toSpeakable('See ~/awb-operator/AGENTS.md and ./src/a.ts'), 'See AGENTS.md and a.ts.');
  assert.equal(toSpeakable('날짜 2026/10/04 기준, 3/4 완료'), '날짜 2026/10/04 기준, 3/4 완료.');
});

test('an answer that is only code has nothing to say — and no substitute phrase is invented', () => {
  assert.equal(toSpeakable('```bash\nnpm run build\n```'), '');
  assert.equal(toSpeakable('| a | b |\n|---|---|'), '');
  assert.equal(toSpeakable(''), '');
  // 스트리밍 중 닫히지 않은 펜스도 끝까지 코드다.
  assert.equal(toSpeakable('정리했습니다.\n```diff\n- a\n+ b'), '정리했습니다.');
});

test('list items and headings become terminated sentences; numbers with dots survive', () => {
  assert.equal(toSpeakable('# 상태\n1. 빌드 통과\n2. 테스트 통과!\n> 주의: 배포 전'), '상태. 빌드 통과. 테스트 통과! 주의: 배포 전.');
  assert.equal(toSpeakable('버전 1.5 입니다'), '버전 1.5 입니다.');
});

test('long answers are cut at a sentence boundary, never mid-word', () => {
  const sentence = '이 문장은 길이를 채우기 위한 문장입니다.';
  const spoken = toSpeakable(Array(200).fill(sentence).join(' '), 200);
  assert.ok(spoken.length <= 200);
  assert.ok(spoken.endsWith('입니다.'), spoken);
});

test('splitSpeakable cuts at sentence ends, keeps the first chunk short, packs the rest', () => {
  const chunks = splitSpeakable('네. 확인했어요. 미션 세 개가 진행 중이고 하나는 사용자 확인을 기다립니다. 나머지 두 개는 오늘 안에 끝날 것 같아요. 더 볼까요?', 60);
  assert.equal(chunks[0], '네. 확인했어요. 미션 세 개가 진행 중이고 하나는 사용자 확인을 기다립니다.');
  assert.deepEqual(chunks.slice(1), ['나머지 두 개는 오늘 안에 끝날 것 같아요. 더 볼까요?']);
  for (const c of chunks) assert.ok(c.length <= 60, c);
});

test('splitSpeakable breaks an over-long sentence at commas, then spaces', () => {
  const long = `${'가나다라 마바사, '.repeat(30)}끝.`;
  const chunks = splitSpeakable(long, 100);
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.ok(c.length <= 100, c);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim());
});

test("the operator's sleep marker is a signal for the screen, never something to say", () => {
  assert.equal(toSpeakable('알겠습니다, 필요하면 다시 불러 주세요. [[sleep]]'), '알겠습니다, 필요하면 다시 불러 주세요.');
  assert.equal(toSpeakable('좋아요.\n\n[[ SLEEP ]]'), '좋아요.');
  assert.equal(toSpeakable('[[sleep]]'), '', 'a marker alone has nothing to say');
});

test('splitSpeakable of nothing is nothing', () => {
  assert.deepEqual(splitSpeakable(''), []);
  assert.deepEqual(splitSpeakable('   '), []);
});

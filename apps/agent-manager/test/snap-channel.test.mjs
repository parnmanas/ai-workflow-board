// parseSnapInfo — snap 설치본의 "추적 채널 기준 최신" 을 읽는다.
//
// 왜 필요한가: `snap refresh` 는 **추적 중인 채널 안에서만** 올린다. 그 채널이
// 멈춰 있으면 refresh 는 exit 0 으로 "올릴 것 없음" 이고, 채널의 최신을 모르면
// 화면은 "성공했다" 고 말하면서 버전은 그대로, 버튼은 계속 눌리는 막다른 길이
// 된다(rolf 실측: 비공식 snap codex 가 latest/stable 0.114.0 에서 멈춤).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSnapInfo, readSnapChannelLatest } = await import('../dist/lib/snap-channel.js');

/** rolf 실측 출력(축약). */
const ROLF_CODEX = `name:      codex
summary:   OpenAI Codex CLI
publisher: jcat (jcat-nysasounds)
tracking:     latest/stable
refresh-date: 2026-04-04
channels:
  latest/stable:    0.114.0 2026-03-14 (34) 67.2MB -
  latest/candidate: ^                              
  latest/beta:      ^                              
  latest/edge:      0.154.0 2026-09-10 (70)  110MB -
installed:          0.114.0            (34) 67.2MB -
`;

test('추적 중인 채널의 버전을 고른다 — 다른 채널이 더 새로워도 그건 아니다', () => {
  // edge 에 0.154.0 이 있지만 이 설치본은 stable 을 추적한다. `snap refresh` 가
  // 도달할 수 있는 곳은 0.114.0 이고, 판정 기준은 그것이어야 한다.
  const info = parseSnapInfo(ROLF_CODEX);
  assert.deepEqual(info, { tracking: 'latest/stable', latest: '0.114.0' });
});

test('`^` 는 바로 위 채널과 같다는 표기다 — 물려받지 않으면 최신을 영영 못 읽는다', () => {
  const tracking = ROLF_CODEX.replace('tracking:     latest/stable', 'tracking:     latest/beta');
  const info = parseSnapInfo(tracking);
  assert.equal(info.tracking, 'latest/beta');
  assert.equal(info.latest, '0.114.0', 'beta 는 `^` 이므로 stable 값을 물려받는다');
});

test('edge 를 추적하면 edge 의 버전이 기준이다', () => {
  const info = parseSnapInfo(ROLF_CODEX.replace('tracking:     latest/stable', 'tracking:     latest/edge'));
  assert.deepEqual(info, { tracking: 'latest/edge', latest: '0.154.0' });
});

test('채널 목록이 끝나면 그 뒤 줄은 읽지 않는다', () => {
  // `installed:` 줄은 들여쓰기가 없으므로 채널로 오인하면 안 된다.
  const info = parseSnapInfo(ROLF_CODEX);
  assert.notEqual(info.latest, null);
  assert.equal(parseSnapInfo(ROLF_CODEX).tracking, 'latest/stable');
});

test('알아볼 수 없는 출력은 null 이다 — 모르는 것은 모른다고 둔다', () => {
  assert.deepEqual(parseSnapInfo(''), { tracking: null, latest: null });
  assert.deepEqual(parseSnapInfo('error: no snap found\n'), { tracking: null, latest: null });
  // tracking 은 읽혔지만 그 채널이 목록에 없는 경우.
  assert.deepEqual(parseSnapInfo('tracking:  weird/branch\nchannels:\n  latest/stable: 1.0.0 x\n'), {
    tracking: 'weird/branch',
    latest: null,
  });
});

test('snap info 실행이 실패하면 null — 호출자는 버튼을 잠그지 않는다', async () => {
  assert.deepEqual(await readSnapChannelLatest('codex', { run: async () => null }), {
    tracking: null,
    latest: null,
  });
  assert.deepEqual(await readSnapChannelLatest('', { run: async () => ROLF_CODEX }), {
    tracking: null,
    latest: null,
  });
});

test('정상 출력이면 그대로 파싱해 돌려준다', async () => {
  const asked = [];
  const info = await readSnapChannelLatest('codex', {
    run: async (name) => {
      asked.push(name);
      return ROLF_CODEX;
    },
  });
  assert.deepEqual(asked, ['codex']);
  assert.equal(info.latest, '0.114.0');
});

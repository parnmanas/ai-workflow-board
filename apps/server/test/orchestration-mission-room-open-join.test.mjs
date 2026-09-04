// mission 방은 자유 참여 ON, step 방은 OFF — 티켓 995a9519.
//
// "Mission 화면의 Chat 에는 참여자가 아니어도 낄 수 있어야 한다"가 이 기능의 요청
// 자체이므로, mission 방 생성이 `open_join: true` 를 잃어버리면 기능이 통째로 죽는다.
// 그런데 `startMission()` 은 팀·오케스트레이터·로스터·미션 락·프롬프트 렌더까지
// 엮여 있어 방 생성 한 줄을 확인하자고 통째로 띄우기 어렵다. 그래서 소스에서 두 생성
// 지점을 파싱해 검사한다.
//
// 정적 검사는 **아무것도 못 찾고 통과하는 공허성**이 가장 큰 위험이므로 세 겹으로 막는다:
//   1. 두 생성 지점이 실제로 발견됐는지 단언한다(못 찾으면 실패).
//   2. 각 지점의 판별 근거(mission 방 = step_id 가 null, step 방 = step.id)를 함께 확인한다.
//   3. 합성 샘플로 파서 자체를 자기검증한다 — 파서가 망가져 늘 통과하게 되는 것을 막는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(
  __dirname, '..', 'src', 'modules', 'orchestration', 'orchestration-runner.service.ts',
);

/**
 * `this.roomRepo.create({ ... })` 블록들을 괄호 균형으로 잘라낸다. 정규식 한 방으로는
 * 중첩된 템플릿 리터럴(`${mission.id.slice(0, 8)}`)의 괄호 때문에 블록 끝을 못 찾는다.
 */
function extractRoomCreateBlocks(src) {
  const blocks = [];
  const marker = 'this.roomRepo.create({';
  let from = 0;
  for (;;) {
    const start = src.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + marker.length - 1; // 여는 '{' 위치
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(start, i + 1));
    from = i + 1;
  }
  return blocks;
}

/** 주석을 걷어낸 뒤 필드가 그 값으로 설정돼 있는지 본다 (주석 속 문구에 속지 않게). */
function hasField(block, field, value) {
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return new RegExp(`\\b${field}\\s*:\\s*${value}\\s*[,}]`).test(code);
}

test('mission 방은 open_join: true 로, step 방은 그것 없이 생성된다', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const blocks = extractRoomCreateBlocks(src);
  assert.ok(blocks.length >= 2, `roomRepo.create 블록을 2개 이상 찾아야 한다 (찾은 수: ${blocks.length})`);

  // mission 방 = orchestration_step_id 가 null, step 방 = step.id 로 채워진다.
  const missionBlocks = blocks.filter(b => hasField(b, 'orchestration_step_id', 'null'));
  const stepBlocks = blocks.filter(b => hasField(b, 'orchestration_step_id', 'step\\.id'));

  assert.equal(missionBlocks.length, 1, 'mission 방 생성 지점은 정확히 하나여야 한다');
  assert.equal(stepBlocks.length, 1, 'step 방 생성 지점은 정확히 하나여야 한다');

  assert.ok(
    hasField(missionBlocks[0], 'open_join', 'true'),
    'mission 방은 open_join: true 로 만들어져야 한다 — 이 기능의 요청 자체가 ' +
      '"Mission 화면의 Chat 에 참여자가 아니어도 낄 수 있어야 한다"이다',
  );
  assert.ok(
    !hasField(stepBlocks[0], 'open_join', 'true'),
    'step 방은 자유 참여를 켜지 않는다 — 사람이 읽는 대화가 아니라 멤버 에이전트 한 명에게 ' +
      '내리는 작업 지시 채널이고 attempt 마다 새로 열려 미션 하나가 수십 개를 만든다',
  );
});

test('파서 자기검증 — 블록 추출과 필드 검사가 실제로 동작한다', () => {
  const sample = `
    const a = this.roomRepo.create({
      name: \`Mission: \${m.title} · \${m.id.slice(0, 8)}\`,
      orchestration_step_id: null,
      open_join: true,
    });
    const b = this.roomRepo.create({
      // open_join: true  ← 주석이므로 잡히면 안 된다
      orchestration_step_id: step.id,
    });
  `;
  const blocks = extractRoomCreateBlocks(sample);
  assert.equal(blocks.length, 2, '템플릿 리터럴 안의 괄호에도 블록 경계를 정확히 잡아야 한다');

  const mission = blocks.filter(b => hasField(b, 'orchestration_step_id', 'null'));
  const step = blocks.filter(b => hasField(b, 'orchestration_step_id', 'step\\.id'));
  assert.equal(mission.length, 1);
  assert.equal(step.length, 1);
  assert.ok(hasField(mission[0], 'open_join', 'true'), '실제 설정을 찾아야 한다');
  assert.ok(!hasField(step[0], 'open_join', 'true'), '주석 속 문구를 설정으로 오인하면 안 된다');

  // 설정이 빠진 mission 블록은 반드시 검출돼야 한다 — 이게 이 가드의 존재 이유다.
  const regressed = extractRoomCreateBlocks(`
    const a = this.roomRepo.create({ orchestration_step_id: null, name: 'x' });
  `);
  assert.equal(regressed.length, 1);
  assert.ok(
    !hasField(regressed[0], 'open_join', 'true'),
    'open_join 이 빠진 mission 블록을 통과시키면 가드가 죽은 것이다',
  );
});

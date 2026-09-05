// mission 방은 자유 참여 ON, step 방은 OFF — 티켓 995a9519, 티켓 9cfd8161 로 갱신.
//
// "Mission 화면의 Chat 에는 참여자가 아니어도 낄 수 있어야 한다"가 이 기능의 요청
// 자체이므로, mission 방 생성이 자유 참여를 잃어버리면 기능이 통째로 죽는다.
//
// 티켓 9cfd8161 부터 그 값은 `open_join: true` 하드코딩이 아니라 미션의 `user_chat_mode`
// 에서 계산된다. 그래서 검사가 두 조각으로 나뉜다 — 소스 grep 은 "미션 옵션에서 파생하는가"
// 를 보고, 별도 단언이 "그 파생의 기본값이 실제로 열림인가"를 본다. 둘 중 하나만 보면
// 각각 이렇게 뚫린다: grep 만 보면 기본값이 `off` 로 바뀌어도 통과하고, 기본값만 보면
// 러너가 파생을 그만두고 `false` 를 박아도 통과한다.
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
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

/** 필드가 미션 옵션 파생 함수로 채워져 있는가 — 하드코딩된 리터럴과 구분한다. */
function hasDerivedOpenJoin(block) {
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return /\bopen_join\s*:\s*openJoinForUserChatMode\s*\(/.test(code);
}

test('mission 방은 미션 옵션에서 파생한 자유 참여로, step 방은 그것 없이 생성된다', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const blocks = extractRoomCreateBlocks(src);
  assert.ok(blocks.length >= 2, `roomRepo.create 블록을 2개 이상 찾아야 한다 (찾은 수: ${blocks.length})`);

  // mission 방 = orchestration_step_id 가 null, step 방 = step.id 로 채워진다.
  const missionBlocks = blocks.filter(b => hasField(b, 'orchestration_step_id', 'null'));
  const stepBlocks = blocks.filter(b => hasField(b, 'orchestration_step_id', 'step\\.id'));

  assert.equal(missionBlocks.length, 1, 'mission 방 생성 지점은 정확히 하나여야 한다');
  assert.equal(stepBlocks.length, 1, 'step 방 생성 지점은 정확히 하나여야 한다');

  assert.ok(
    hasDerivedOpenJoin(missionBlocks[0]),
    'mission 방의 open_join 은 미션의 user_chat_mode 에서 openJoinForUserChatMode() 로 ' +
      '파생돼야 한다 — 하드코딩하면 옵션을 바꿔도 새로 시작하는 미션이 그것을 따르지 않는다',
  );
  assert.ok(
    !hasField(stepBlocks[0], 'open_join', 'true') && !hasDerivedOpenJoin(stepBlocks[0]),
    'step 방은 자유 참여를 켜지 않는다 — 사람이 읽는 대화가 아니라 멤버 에이전트 한 명에게 ' +
      '내리는 작업 지시 채널이고 attempt 마다 새로 열려 미션 하나가 수십 개를 만든다',
  );
});

// grep 의 짝 — 파생 자체는 확인했으니, 그 파생의 **기본값**이 열림인지는 실제 함수로 본다.
// 이 둘이 함께 있어야 "기본 상태의 mission 방은 자유 참여로 열린다"가 실제로 보장된다.
test('기본 chat 모드는 mission 방을 자유 참여로 연다', async () => {
  // src/*.ts 를 직접 import 하지 않는다 — 이 스위트의 확립된 방식은 컴파일된 dist/ 를
  // 읽는 것이고(`pretest` 가 build 를 선행한다), CI 의 Node 22 에서 .ts import 가
  // 로컬 Node 24 와 같게 동작한다고 가정할 수 없다.
  const { DEFAULT_USER_CHAT_MODE, openJoinForUserChatMode, normalizeUserChatMode } = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href
  );

  assert.equal(
    openJoinForUserChatMode(DEFAULT_USER_CHAT_MODE),
    true,
    '기본 모드는 자유 참여를 켜야 한다 — 옵션 도입 전에 이미 열려 있던 계약을 이름만 바꾼 것이다',
  );

  // 옵션 컬럼이 DDL 없이 추가되므로 기존 행은 ''/NULL 로 남을 수 있다. 그 값이 기본값으로
  // 접히지 않으면 기존 미션 방이 영영 닫힌 채로 남는다 — 백필 마이그레이션도 이 정규화에
  // 의존하므로 여기서 함께 못박는다.
  for (const legacy of ['', null, undefined, 'nonsense']) {
    assert.equal(
      openJoinForUserChatMode(normalizeUserChatMode(legacy)),
      true,
      `정규화되지 않은 기존 값(${JSON.stringify(legacy)})은 기본값으로 접혀 열려야 한다`,
    );
  }

  assert.equal(openJoinForUserChatMode(normalizeUserChatMode('participants_only')), false);
  assert.equal(openJoinForUserChatMode(normalizeUserChatMode('off')), false);
});

test('파서 자기검증 — 블록 추출과 필드 검사가 실제로 동작한다', () => {
  const sample = `
    const a = this.roomRepo.create({
      name: \`Mission: \${m.title} · \${m.id.slice(0, 8)}\`,
      orchestration_step_id: null,
      open_join: openJoinForUserChatMode(normalizeUserChatMode(mission.user_chat_mode)),
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
  assert.ok(hasDerivedOpenJoin(mission[0]), '실제 파생 설정을 찾아야 한다');
  assert.ok(!hasDerivedOpenJoin(step[0]), '주석 속 문구를 설정으로 오인하면 안 된다');

  // 설정이 빠진 mission 블록은 반드시 검출돼야 한다 — 이게 이 가드의 존재 이유다.
  const regressed = extractRoomCreateBlocks(`
    const a = this.roomRepo.create({ orchestration_step_id: null, name: 'x' });
  `);
  assert.equal(regressed.length, 1);
  assert.ok(
    !hasDerivedOpenJoin(regressed[0]),
    'open_join 이 빠진 mission 블록을 통과시키면 가드가 죽은 것이다',
  );

  // 하드코딩으로 되돌아간 블록도 검출돼야 한다 — 파생이 이 티켓의 계약이다.
  const hardcoded = extractRoomCreateBlocks(`
    const a = this.roomRepo.create({ orchestration_step_id: null, open_join: true });
  `);
  assert.equal(hardcoded.length, 1);
  assert.ok(
    !hasDerivedOpenJoin(hardcoded[0]),
    'open_join: true 하드코딩을 파생으로 인정하면 가드가 죽은 것이다',
  );
});

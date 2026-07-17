// AWB 어시스턴트 진입점 순수 로직 테스트 (에픽 bf65ca00 · Phase 1 · S2).
//
// resolveAssistant(미지정/무효/정상)·isEligibleAssistant(서버검증 동일 기준)·
// eligibleAssistantAgents(셀렉터 후보)·findAssistantDmRoomId(DM find-or-create)를
// node:test 로 직접 검증한다. fetch·라우팅 없는 순수 함수라 하니스 불필요.
//
// 실행:  node --import tsx --test apps/client/test/assistant-entry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isEligibleAssistant,
  eligibleAssistantAgents,
  resolveAssistant,
  findAssistantDmRoomId,
} from '../src/components/chat/assistantEntry.ts';

const WS = 'ws-1';
const activeAgent = { id: 'a1', name: 'Rolf/AWB', is_active: 1, type: 'claude', workspace_id: WS };
const inactiveAgent = { id: 'a2', name: 'Old', is_active: 0, type: 'claude', workspace_id: WS };
const managerAgent = { id: 'm1', name: 'Mgr', is_active: 1, type: 'manager', workspace_id: null };
const otherWsAgent = { id: 'a3', name: 'Foreign', is_active: 1, type: 'claude', workspace_id: 'ws-2' };

test('isEligibleAssistant: 활성·비매니저·해당 workspace 만 true', () => {
  assert.equal(isEligibleAssistant(activeAgent, WS), true);
  assert.equal(isEligibleAssistant(inactiveAgent, WS), false); // 비활성
  assert.equal(isEligibleAssistant(managerAgent, WS), false); // 매니저
  assert.equal(isEligibleAssistant(otherWsAgent, WS), false); // 타 workspace
  assert.equal(isEligibleAssistant(null, WS), false);
  assert.equal(isEligibleAssistant(undefined, WS), false);
});

test('eligibleAssistantAgents: 적격만 남기고 이름 정렬', () => {
  const out = eligibleAssistantAgents(
    [managerAgent, activeAgent, inactiveAgent, { id: 'a0', name: 'Aaron', is_active: 1, type: 'codex', workspace_id: WS }],
    WS,
  );
  assert.deepEqual(out.map((a) => a.id), ['a0', 'a1']); // Aaron, Rolf/AWB — 매니저·비활성 제외
  assert.equal(out[0].name, 'Aaron');
});

test('resolveAssistant: assistant_agent_id 미지정 → unset', () => {
  assert.deepEqual(resolveAssistant({}, [activeAgent], WS), { status: 'unset' });
  assert.deepEqual(resolveAssistant({ assistant_agent_id: null }, [activeAgent], WS), { status: 'unset' });
  assert.deepEqual(resolveAssistant(null, [activeAgent], WS), { status: 'unset' });
});

test('resolveAssistant: 지정 id 가 목록에 없거나 무효 → invalid', () => {
  // 목록에 없음(삭제된 것으로 간주)
  assert.deepEqual(resolveAssistant({ assistant_agent_id: 'gone' }, [activeAgent], WS), {
    status: 'invalid',
    agentId: 'gone',
  });
  // 비활성
  assert.deepEqual(resolveAssistant({ assistant_agent_id: 'a2' }, [activeAgent, inactiveAgent], WS), {
    status: 'invalid',
    agentId: 'a2',
  });
  // 매니저
  assert.deepEqual(resolveAssistant({ assistant_agent_id: 'm1' }, [activeAgent, managerAgent], WS), {
    status: 'invalid',
    agentId: 'm1',
  });
});

test('resolveAssistant: 유효한 지정 → ready + 최소 에이전트 정보', () => {
  const r = resolveAssistant({ assistant_agent_id: 'a1' }, [activeAgent], WS);
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.agent, { id: 'a1', name: 'Rolf/AWB', avatar_url: undefined });
});

test('findAssistantDmRoomId: 에이전트가 참여한 DM 룸을 찾는다', () => {
  const rooms = [
    { id: 'r-group', type: 'group', participants: [{ participant_type: 'agent', participant_id: 'a1' }] },
    { id: 'r-user-dm', type: 'dm', participants: [{ participant_type: 'user', participant_id: 'u9' }] },
    { id: 'r-assistant', type: 'dm', participants: [
      { participant_type: 'user', participant_id: 'u1' },
      { participant_type: 'agent', participant_id: 'a1' },
    ] },
  ];
  assert.equal(findAssistantDmRoomId(rooms, 'a1'), 'r-assistant'); // group 은 제외
  assert.equal(findAssistantDmRoomId(rooms, 'nope'), null);
  assert.equal(findAssistantDmRoomId(rooms, null), null);
  assert.equal(findAssistantDmRoomId([], 'a1'), null);
  // participants 투영 없는 구버전 응답 → 매칭 불가(새로 생성 위임)
  assert.equal(findAssistantDmRoomId([{ id: 'r', type: 'dm' }], 'a1'), null);
});

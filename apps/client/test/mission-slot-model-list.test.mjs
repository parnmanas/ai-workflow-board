// 미션(오케스트레이션 팀 슬롯)의 모델 dropdown 은 다른 화면과 **같은 목록**을 본다
// (운영 보고 2026-09-26/27: "mission 에는 모델 리스트가 제대로 나오지 않아. 다른곳과 달라").
//
// 고치기 전: 슬롯 편집기는 공유 스토어가 비면 로스터 응답의 `host.available_models` 로
// 떨어졌고, 서버는 그 필드를 다르게 계산했다(하트비트 + 기존 agent 행에 핀된 모델,
// 알파벳 재정렬). 그래서 같은 호스트의 opencode 목록이 mission 과 세션/Agent
// 다이얼로그에서 내용도 순서도 달랐다.
//
// 이 파일이 고정하는 계약:
//   ① dropdown 의 선택지는 공유 스토어(useHostModels)에서만 온다 — 로스터가 다른
//      목록을 실어 보내도 그것을 그리지 않는다.
//   ② 호스트가 열거한 **순서**를 지킨다(알파벳 재정렬 없음).
//   ③ 저장된 모델이 목록에 없으면 "(not listed by this host)" 로 덧붙여 남긴다 —
//      목록을 한 곳으로 좁힌 대가로 저장값이 사라지면 안 된다.
//   ④ 스토어가 비어 있으면 Default 하나만 두고 자유 입력으로 떨어진다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import TeamSlotRuntimeFields, { emptySlotDraft } from '../src/components/orchestration/TeamSlotRuntimeFields.tsx';

const h = React.createElement;
// 스토어(src/cli/hostModels.ts)는 모듈 수준 싱글턴이라 host id 로 캐시된다 — 테스트마다
// 다른 id 를 써서 앞 테스트의 목록이 새지 않게 한다(스토어를 비우는 API 를 화면용
// 코드에 만들지 않기 위한 선택).
let managerSeq = 0;
const nextManager = () => `mgr-rolf-${(managerSeq += 1)}`;

// 호스트가 열거한 순서 — 알파벳순이 아니다(재정렬을 잡아내는 픽스처).
const STORE_MODELS = [
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/big-pickle',
  'opencode-go/glm-5.3',
];
// 로스터가 (예전 서버처럼) 다르게 계산해 보낸 목록. 화면에 나오면 안 된다.
const ROSTER_MODELS = ['opencode/pinned-by-an-agent-row', 'opencode/zzz-sorted-differently'];

function host(managerId, overrides = {}) {
  return {
    manager_agent_id: managerId,
    manager_name: 'rolf',
    hostname: 'rolf',
    is_online: true,
    instance_id: 'inst-1',
    last_seen_at: new Date().toISOString(),
    clis: ['opencode'],
    available_models: { opencode: ROSTER_MODELS },
    cli_versions: {},
    working_dirs: ['/srv/work'],
    ...overrides,
  };
}

function draft(managerId, overrides = {}) {
  return {
    ...emptySlotDraft(),
    manager_agent_id: managerId,
    runtime: { ...emptySlotDraft().runtime, runtime: 'opencode' },
    working_dir: '/srv/work',
    ...overrides,
  };
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

/** 모델 dropdown(있으면). 'Default —' 항목을 가진 select 가 그것이다. */
function modelSelect(view) {
  return [...view.container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => /^Default —/.test(o.textContent || ''))) ?? null;
}

function modelOptions(view) {
  const select = modelSelect(view);
  assert.ok(select, '모델 dropdown 이 있어야 한다');
  return [...select.options].map((o) => o.value);
}

async function withSlot(t, { storeModels, managerId, slotOverrides = {}, rosterOverrides = {} }) {
  const slot = draft(managerId, slotOverrides);
  const rosterHost = host(managerId, rosterOverrides);
  const dom = setupDom({ width: 1280 });
  globalThis.localStorage = dom.window.localStorage;
  const previous = { getHostModels: api.getHostModels, refreshHostModels: api.refreshHostModels };
  api.getHostModels = async (managerAgentId) => ({
    manager_agent_id: managerAgentId,
    manager_name: 'rolf',
    is_online: true,
    instance_id: 'inst-1',
    // 방금 재열거한 것으로 둔다 — 훅이 stale 판정으로 refresh 를 보내지 않게.
    refreshed_at: new Date().toISOString(),
    models: storeModels ? { opencode: storeModels } : {},
  });
  api.refreshHostModels = async () => { throw new Error('이 테스트는 refresh 를 기대하지 않는다'); };

  const view = mount(h(TeamSlotRuntimeFields, {
    workspaceId: 'ws-1',
    value: slot,
    onChange: () => {},
    hosts: [rosterHost],
    credentials: [],
    backendProfiles: [],
  }));
  await settle();
  t.after(() => {
    view.unmount();
    Object.assign(api, previous);
    dom.cleanup();
  });
  return view;
}

test('① 모델 선택지는 공유 스토어에서만 온다 — 로스터가 실어 보낸 목록은 그리지 않는다', async (t) => {
  const view = await withSlot(t, { storeModels: STORE_MODELS, managerId: nextManager() });
  const values = modelOptions(view);
  assert.deepEqual(values, ['', ...STORE_MODELS], '스토어 목록을 순서 그대로 그린다');
  for (const stale of ROSTER_MODELS) {
    assert.ok(!values.includes(stale), `로스터 스냅샷(${stale})이 dropdown 에 새어 들어오면 안 된다`);
  }
});

test('② 저장된 모델이 목록에 없으면 표시를 달아 남긴다', async (t) => {
  const view = await withSlot(t, {
    storeModels: STORE_MODELS,
    managerId: nextManager(),
    slotOverrides: { model: 'opencode/typed-by-hand' },
  });
  const values = modelOptions(view);
  assert.ok(values.includes('opencode/typed-by-hand'), '저장된 값이 사라지면 "모델 미설정"으로 보인다');
  const labels = [...view.container.querySelectorAll('select')]
    .flatMap((s) => [...s.options].map((o) => o.textContent || ''));
  assert.ok(labels.some((l) => l.includes('not listed by this host')), '출처가 다르다는 사실을 말한다');
});

test('③ 스토어가 비면 dropdown 을 만들지 않고 자유 입력으로 떨어진다', async (t) => {
  const view = await withSlot(t, { storeModels: null, managerId: nextManager() });
  assert.equal(Boolean(modelSelect(view)), false, '로스터 스냅샷으로 목록을 만들어내지 않는다');
  const labels = [...view.container.querySelectorAll('label')].map((l) => l.textContent || '');
  assert.ok(labels.some((l) => l.includes('Model')), '대신 Model 자유 입력이 남는다');
  const inputs = [...view.container.querySelectorAll('input')].map((i) => i.placeholder || '');
  assert.ok(
    inputs.some((p) => p.includes('default') || p.includes('model list')),
    `자유 입력이 무엇을 비워 두면 되는지 말한다: ${inputs.join(' | ')}`,
  );
});

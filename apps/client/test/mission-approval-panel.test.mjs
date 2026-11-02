import { ui } from './helpers/i18n.mjs';
// 미션 실행 승인(docs/orchestration.md "실행 승인") — 화면 쪽 회귀.
//
// 고정하는 계약:
//   1. 사이드바 미션 행의 점이 "당신의 승인을 기다린다" 를 말한다 — 세션의 awaiting_permission 과
//      같은 attention tone. 기다리는 동안 미션 상태는 running 이라 상태만 보면 "돌고 있음" 이다.
//   2. 사용자에게 온 요청이 먼저, 오케스트레이터가 판단 중인 요청은 그 뒤에 — 둘 다 답할 수 있다.
//   3. 버튼이 올바른 decision 과 사유를 그 요청 id 로 보낸다. "세션 동안 허용" 은 CLI 가 기억할
//      규칙을 제안했을 때만 보인다.
//   4. 실패해도 화면을 다시 읽는다 — 그 사이 오케스트레이터가 먼저 답했을 수 있다(409).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import ApprovalRequestPanel from '../src/components/orchestration/ApprovalRequestPanel.tsx';
import { approvalsByStep, missionAttention, pendingApprovals } from '../src/components/orchestration/approvals.logic.ts';
import { buildWorkNavGroups } from '../src/components/workNavigation.ts';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

function approval(overrides = {}) {
  return {
    id: 'appr-1',
    mission_id: 'm1',
    step_id: 's1',
    step_key: 'build',
    requester_role: 'member',
    requester_agent_id: 'rt-1',
    requester_name: 'ralf/claude',
    tool_name: 'Bash',
    title: 'Run the test suite',
    description: 'npm test',
    input: '{\n  "command": "npm test"\n}',
    can_allow_session: true,
    status: 'pending',
    route: 'user',
    route_reason: 'orchestrator_not_trusted',
    routed_at: '2026-11-02T00:00:00.000Z',
    decision: null,
    decided_by_type: null,
    decided_by_name: '',
    decision_note: '',
    decided_at: null,
    created_at: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

// ── 사이드바 점 ──────────────────────────────────────────────────────────────

test('sidebar: a mission waiting on your approval shows the attention dot, not "Running"', () => {
  const [, missions] = buildWorkNavGroups({
    pathname: '/tickets',
    teams: [],
    missions: [
      { id: 'a', title: 'Needs approval', status: 'running', counts: { awaitingUser: 0, awaitingApproval: 2 } },
      { id: 'b', title: 'Needs decision', status: 'running', counts: { awaitingUser: 1, awaitingApproval: 0 } },
      { id: 'c', title: 'Just running', status: 'running', counts: { awaitingUser: 0, awaitingApproval: 0 } },
      { id: 'd', title: 'Old payload', status: 'running' },
    ],
  });
  const byId = Object.fromEntries(missions.children.map((c) => [c.id, c.activity]));
  assert.deepEqual(byId.a, { label: ui('Needs your approval'), tone: 'attention', live: false });
  assert.deepEqual(byId.b, { label: ui('Needs your decision'), tone: 'attention', live: false });
  assert.equal(byId.c.tone, 'live');
  assert.equal(byId.d.tone, 'live', 'a list from an older server (no counts) still shows the status dot');
});

test('logic: approval beats a confirm gate, user requests come first, steps count only yours', () => {
  assert.equal(missionAttention({ awaitingUser: 1, awaitingApproval: 1 }).label, ui('Needs your approval'));
  assert.equal(missionAttention({ awaitingUser: 0, awaitingApproval: 0 }), null);
  const list = [
    approval({ id: 'orch', route: 'orchestrator', route_reason: 'orchestrator_trusted', created_at: '2026-11-02T00:00:00Z' }),
    approval({ id: 'mine', created_at: '2026-11-02T00:05:00Z' }),
    approval({ id: 'done', status: 'approved', decision: 'allow' }),
  ];
  assert.deepEqual(pendingApprovals(list).map((a) => a.id), ['mine', 'orch']);
  assert.deepEqual([...approvalsByStep(list)], [['build', 1]]);
});

// ── 패널 ────────────────────────────────────────────────────────────────────

async function render(t, approvals, onDecided = () => {}) {
  const dom = setupDom();
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { constructor() { this.volume = 0; this.currentTime = 0; } play() { return Promise.resolve(); } pause() {} };
  const view = mount(h(ToastProvider, null, h(ApprovalRequestPanel, { approvals, accountId: 'ws-1', onDecided })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  t.after(() => {
    view.unmount();
    dom.cleanup();
    globalThis.Audio = previousAudio;
  });
  return view;
}

function stubDecide(t, impl) {
  const calls = [];
  const original = api.decideOrchestrationApproval;
  api.decideOrchestrationApproval = async (id, data) => {
    calls.push({ id, data });
    return impl ? impl(id, data) : { approval: approval({ status: 'approved' }), already_decided: false };
  };
  t.after(() => { api.decideOrchestrationApproval = original; });
  return calls;
}

const buttonIn = (card, label) => [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ui(label));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test('panel: nothing pending → nothing rendered', async (t) => {
  const { container } = await render(t, [approval({ status: 'denied', decision: 'deny' })]);
  assert.equal(Boolean(container.querySelector('[data-testid="approval-panel"]')), false, 'no pending request → no panel');
});

test('panel: shows who asks for what, and the orchestrator-decided request after yours', async (t) => {
  const { container } = await render(t, [
    approval({ id: 'orch', route: 'orchestrator', route_reason: 'orchestrator_trusted' }),
    approval({ id: 'mine' }),
  ]);
  const cards = [...container.querySelectorAll('[data-testid="approval-card"]')];
  assert.deepEqual(cards.map((c) => c.getAttribute('data-approval-id')), ['mine', 'orch']);
  assert.match(cards[0].textContent, /ralf\/claude/);
  assert.match(cards[0].textContent, /Bash/);
  assert.match(cards[0].querySelector('[data-testid="approval-input"]').textContent, /npm test/);
  assert.ok(cards[1].textContent.includes(ui('The orchestrator is deciding — it has trusted permissions. You can answer first.')));
  assert.ok(buttonIn(cards[1], 'Allow'), 'the user can answer before the orchestrator does');
});

test('panel: deny sends the reason with the request id; allow-for-session only when offered', async (t) => {
  const calls = stubDecide(t);
  let decided = 0;
  const { container } = await render(t, [approval(), approval({ id: 'appr-2', step_key: 'ship', can_allow_session: false })], () => { decided += 1; });
  const [first, second] = [...container.querySelectorAll('[data-testid="approval-card"]')];
  assert.ok(buttonIn(first, 'Allow for this session'));
  assert.equal(Boolean(buttonIn(second, 'Allow for this session')), false, 'no rule to remember → no session option');

  await typeInto(first.querySelector('textarea'), 'use the staging database');
  await click(buttonIn(first, 'Deny'));
  await settle();
  assert.deepEqual(calls[0], { id: 'appr-1', data: { account_id: 'ws-1', decision: 'deny', note: 'use the staging database' } });
  assert.equal(decided, 1);

  await click(buttonIn(second, 'Allow'));
  await settle();
  assert.deepEqual(calls[1], { id: 'appr-2', data: { account_id: 'ws-1', decision: 'allow', note: undefined } });
});

test('panel: a refused answer (someone answered first) still refreshes the mission', async (t) => {
  stubDecide(t, async () => { throw new Error('this request is already approved'); });
  let decided = 0;
  const { container } = await render(t, [approval()], () => { decided += 1; });
  const card = container.querySelector('[data-testid="approval-card"]');
  await click(buttonIn(card, 'Allow for this session'));
  await settle();
  assert.equal(decided, 1);
});

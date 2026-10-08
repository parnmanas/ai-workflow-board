// operator 의 작업 제안 — 화면 쪽(docs/voice-operator.md "작업 제안").
//   - 목록은 아직 정할 것(pending · queued)과 다시 보낼 수 있는 실패만 든다. 정해지면 빠진다.
//   - 세션 화면은 그 세션에 시키자는 것과, 그 세션이 operator 면 그 operator 가 낸 것을 보인다.
//   - 보낸 작업은 전사에서 "누가 제안 · 사용자 승인" 으로 보이고, 본문만 프롬프트로 그린다.
//   - 카드의 Send / Dismiss 는 그 제안 하나만 정하고 목록을 바로 고친다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupDom, mount, React, act, click } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api.ts';
import { applyProposal, proposalsForSession, sessionProposalStore } from '../src/components/sessions/sessionProposals.ts';
import { buildTranscript, parseOperatorTaskPrompt, OPERATOR_TASK_PREFIX } from '../src/components/sessions/sessionTranscript.logic.ts';
import SessionProposalCards from '../src/components/sessions/SessionProposalCards.tsx';

const h = React.createElement;
const proposal = (id, over = {}) => ({
  id, operator: { id: 'op-jarvis', name: 'Jarvis' }, origin: 'report',
  target: { manager_id: 'host', manager_name: 'rolf', cli: 'codex', cli_label: 'Codex', session_id: 'work', title: 'Build' },
  text: '테스트 돌려 줘', reason: '빌드는 고쳤다', status: 'pending', error: null, decided_via: null, delivered_turn_id: null,
  created_at: `2026-10-07T10:00:0${id.slice(-1)}.000Z`, decided_at: null, ...over,
});

test('the list keeps only what is still to decide', () => {
  let list = applyProposal([], proposal('p1'));
  list = applyProposal(list, proposal('p2'));
  assert.deepEqual(list.map((p) => p.id), ['p1', 'p2']);
  list = applyProposal(list, proposal('p1', { status: 'queued' }));
  assert.deepEqual(list.map((p) => [p.id, p.status]), [['p1', 'queued'], ['p2', 'pending']], 'updated in place, order by creation');
  for (const closed of ['sent', 'dismissed', 'withdrawn', 'superseded']) {
    assert.deepEqual(applyProposal(list, proposal('p2', { status: closed })).map((p) => p.id), ['p1'], `${closed} leaves the list`);
  }
  assert.equal(applyProposal(list, proposal('p2', { status: 'failed', error: 'host offline' })).length, 2, 'a failure stays so it can be retried');
});

test('a session shows proposals for it, and an operator session shows its own', () => {
  const list = [proposal('p1'), proposal('p2', { target: { ...proposal('p2').target, session_id: 'other' } }), proposal('p3', { operator: { id: 'op-friday', name: 'Friday' }, target: { ...proposal('p3').target, session_id: 'other' } })];
  assert.deepEqual(proposalsForSession(list, { manager_id: 'host', cli: 'codex', session_id: 'work' }, null).map((p) => p.id), ['p1']);
  assert.deepEqual(proposalsForSession(list, { manager_id: 'host', cli: 'claude', session_id: 'op-1' }, 'op-jarvis').map((p) => p.id), ['p1', 'p2']);
});

test('a delivered operator task is labelled with who proposed it', () => {
  const text = `${OPERATOR_TASK_PREFIX} Jarvis — 사용자 승인\n테스트 돌려 줘\n둘째 줄`;
  assert.deepEqual(parseOperatorTaskPrompt(text), { operator: 'Jarvis', text: '테스트 돌려 줘\n둘째 줄' });
  assert.equal(parseOperatorTaskPrompt('그냥 프롬프트'), null);
  const [block] = buildTranscript([{ id: 'e1', seq: 1, turn_id: 't1', type: 'user_prompt', payload: { text }, created_at: '2026-10-07T10:00:00.000Z' }]);
  assert.equal(block.kind, 'prompt');
  assert.equal(block.operatorTask, 'Jarvis');
  assert.equal(block.text, '테스트 돌려 줘\n둘째 줄', 'only the task body is drawn as the prompt');
});

test('Send and Dismiss decide one proposal and update the list at once', async (t) => {
  const dom = setupDom();
  sessionProposalStore.reset();
  const sent = t.mock.method(api, 'sendSessionProposal', async (id) => ({ proposal: proposal(id, { status: 'queued', decided_via: 'screen' }) }));
  const dismissed = t.mock.method(api, 'dismissSessionProposal', async (id) => ({ proposal: proposal(id, { status: 'dismissed' }) }));
  sessionProposalStore.apply(proposal('p1'));
  sessionProposalStore.apply(proposal('p2', { text: '로그 정리해 줘' }));
  let view;
  const render = () => h(MemoryRouter, null, h(SessionProposalCards, { proposals: sessionProposalStore.get(), showTarget: () => true }));
  t.after(() => { view?.unmount(); sessionProposalStore.reset(); dom.cleanup(); });
  view = mount(render());
  const cards = () => [...document.querySelectorAll('.awb-session-proposal')];
  assert.equal(cards().length, 2);
  assert.match(cards()[0].textContent, /Jarvis proposes.*→ rolf \/ Codex · Build/);
  assert.match(cards()[0].textContent, /테스트 돌려 줘/, 'the exact text is shown before sending');
  const buttonIn = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  click(buttonIn(cards()[0], 'Send'));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(sent.mock.calls.map((c) => c.arguments[0]), ['p1']);
  assert.equal(sessionProposalStore.get().find((p) => p.id === 'p1').status, 'queued');
  view.rerender?.(render());
  click(buttonIn(cards()[1], 'Dismiss'));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(dismissed.mock.calls.map((c) => c.arguments[0]), ['p2']);
  assert.deepEqual(sessionProposalStore.get().map((p) => p.id), ['p1'], 'dismissed leaves the list');
});

test('an operator session reads only the spoken summary of its answers', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../src/components/sessions/SessionsPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /speechPlayer\.speak\(answer, `\$\{speechKeyPrefix\}\$\{finished\.turnId\}`, \{ summary: !!op \}\)/);
  const player = await readFile(new URL('../src/voice/speechPlayer.ts', import.meta.url), 'utf8');
  assert.match(player, /api\.voiceSpeakable\(text, options\.summary === true\)/);
});

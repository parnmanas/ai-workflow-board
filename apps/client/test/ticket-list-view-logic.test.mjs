// Tickets 페이지 List 뷰 정렬 · 보기 전환 저장 · 담당자 표시/옵션 · 태그 입력 순수 로직.
//
// 실행: node --import tsx --test test/ticket-list-view-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TICKET_SORT,
  TICKET_VIEW_STORAGE_KEY,
  nextSort,
  readTicketView,
  sortTickets,
  writeTicketView,
} from '../src/tickets/ticketList.ts';
import { assigneeDisplayName, assigneeLeafName, assigneeOptions } from '../src/tickets/assignee.ts';
import { addTags, parseTagInput, removeTag, suggestTags } from '../src/tickets/tagInput.ts';

const rows = [
  { id: 'a', title: 'beta', status: 'done', priority: 'low', tags: ['x'], project_id: 'p2', assignee: null, updated_at: '2026-03-01T00:00:00Z' },
  { id: 'b', title: 'Alpha', status: 'todo', priority: 'critical', tags: [], project_id: null, assignee: { manager_agent_id: 'h1', cli: 'claude', working_dir: '/w/api', label: '' }, updated_at: '2026-03-03T00:00:00Z' },
  { id: 'c', title: 'gamma', status: 'in_progress', priority: 'high', tags: ['a', 'b'], project_id: 'p1', assignee: { manager_agent_id: 'h2', cli: 'codex', working_dir: '/w/web', label: 'web' }, updated_at: '2026-03-02T00:00:00Z' },
];
const ctx = { projectNames: { p1: 'Zeta', p2: 'Able' }, hostNames: { h1: 'rolf', h2: 'ralf' } };
const ids = (list) => list.map((r) => r.id);

test('정렬: 기본은 최근 수정순', () => {
  assert.deepEqual(DEFAULT_TICKET_SORT, { key: 'updated', dir: 'desc' });
  assert.deepEqual(ids(sortTickets(rows, DEFAULT_TICKET_SORT, ctx)), ['b', 'c', 'a']);
});

test('정렬: 제목(대소문자 무시)·상태(lifecycle 순)·우선순위', () => {
  assert.deepEqual(ids(sortTickets(rows, { key: 'title', dir: 'asc' }, ctx)), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortTickets(rows, { key: 'status', dir: 'asc' }, ctx)), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortTickets(rows, { key: 'priority', dir: 'desc' }, ctx)), ['b', 'c', 'a']);
});

test('정렬: 빈 값(프로젝트 없음·미지정·태그 없음)은 방향과 관계없이 맨 아래', () => {
  assert.deepEqual(ids(sortTickets(rows, { key: 'project', dir: 'asc' }, ctx)), ['a', 'c', 'b']);
  assert.deepEqual(ids(sortTickets(rows, { key: 'project', dir: 'desc' }, ctx)), ['c', 'a', 'b']);
  assert.deepEqual(ids(sortTickets(rows, { key: 'assignee', dir: 'asc' }, ctx)), ['c', 'b', 'a']);
  assert.deepEqual(ids(sortTickets(rows, { key: 'tags', dir: 'asc' }, ctx)), ['c', 'a', 'b']);
});

test('nextSort: 같은 열은 방향 반전, 새 열은 자연 방향', () => {
  assert.deepEqual(nextSort({ key: 'title', dir: 'asc' }, 'title'), { key: 'title', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'title', dir: 'asc' }, 'updated'), { key: 'updated', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'updated', dir: 'desc' }, 'status'), { key: 'status', dir: 'asc' });
});

test('보기(Kanban/List)는 localStorage 에 저장·복원되고, 모르는 값/오류는 kanban', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readTicketView(storage), 'kanban');
  writeTicketView(storage, 'list');
  assert.equal(mem.get(TICKET_VIEW_STORAGE_KEY), 'list');
  assert.equal(readTicketView(storage), 'list');
  mem.set(TICKET_VIEW_STORAGE_KEY, 'grid');
  assert.equal(readTicketView(storage), 'kanban');
  assert.equal(readTicketView({ getItem: () => { throw new Error('denied'); } }), 'kanban');
  assert.equal(readTicketView(null), 'kanban');
});

test('담당자 표시: <Host>/<label>, label 없으면 <폴더>/<cli>, Host 이름 모르면 raw id 대신 label 만', () => {
  assert.equal(assigneeDisplayName(rows[2].assignee, ctx.hostNames), 'ralf/web');
  assert.equal(assigneeDisplayName(rows[1].assignee, ctx.hostNames), 'rolf/api/claude');
  assert.equal(assigneeDisplayName(rows[1].assignee, {}), 'api/claude');
  assert.equal(assigneeDisplayName(null, ctx.hostNames), '');
  assert.equal(assigneeLeafName({ cli: 'codex', working_dir: '' }), 'codex');
});

test('담당자 옵션: assignee_key 별 하나, 표시 이름순, 개수 집계, 미지정 제외', () => {
  const tickets = [
    { assignee_key: 'rt-1', assignee: rows[2].assignee },
    { assignee_key: 'rt-2', assignee: rows[1].assignee },
    { assignee_key: 'rt-1', assignee: rows[2].assignee },
    { assignee_key: '', assignee: null },
  ];
  assert.deepEqual(assigneeOptions(tickets, ctx.hostNames), [
    { key: 'rt-1', label: 'ralf/web', count: 2 },
    { key: 'rt-2', label: 'rolf/api/claude', count: 1 },
  ]);
});

test('태그 입력: 콤마로만 나누고(공백은 태그의 일부) # 접두를 떼며 대소문자 무시 중복 제거', () => {
  assert.deepEqual(parseTagInput(' ui , #AWB Dev,,\nbug '), ['ui', 'AWB Dev', 'bug']);
  assert.deepEqual(addTags(['ui'], 'UI, api'), ['ui', 'api']);
  assert.deepEqual(addTags(['ui'], ['x', ' y ', '']), ['ui', 'x', 'y']);
  assert.deepEqual(removeTag(['a', 'b'], 'a'), ['b']);
});

test('태그 제안: 이미 고른 태그 제외, 접두 일치 우선, 많이 쓰인 순, 개수 제한', () => {
  const known = [{ tag: 'api', count: 1 }, { tag: 'ui-kit', count: 5 }, { tag: 'build', count: 9 }, 'ui'];
  assert.deepEqual(suggestTags(known, ['ui'], 'ui'), ['ui-kit', 'build']);
  assert.deepEqual(suggestTags(known, [], ''), ['build', 'ui-kit', 'api', 'ui']);
  assert.deepEqual(suggestTags(known, [], '', 2), ['build', 'ui-kit']);
  assert.deepEqual(suggestTags(known, ['API'], '#a'), []);
});

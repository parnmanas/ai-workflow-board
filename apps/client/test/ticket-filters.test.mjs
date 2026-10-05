// Tickets 페이지 필터 ⇄ URL 쿼리 + 태그 AND 필터/카운트 순수 로직 (docs/tickets.md).
//
// 고정하는 계약:
//   1. 필터는 URL 쿼리로 왕복한다(공유·북마크 가능) — 기본값은 URL 에 쓰지 않는다
//   2. 패널 소유 파라미터(`ticket`, `comment`)와 그 밖의 파라미터는 필터 쓰기가 건드리지 않는다
//   3. 서버 쿼리(GET /accounts/:wsId/tickets)는 contract 의 키 이름과 콤마 리스트를 쓴다
//   4. 태그 필터는 AND — 선택한 태그를 전부 가진 티켓만 남는다
//   5. 태그 facet 은 서버 카운트를 쓰고(없으면 로드된 행을 센다), 선택된 태그는 항상 남는다
//
// 실행: node --import tsx --test test/ticket-filters.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TICKET_FILTERS,
  countTags,
  filterTicketsByTags,
  filtersFromSearch,
  filtersToQuery,
  filtersToSearch,
  hasActiveFilters,
  sameFilters,
  tagFacet,
  ticketHasAllTags,
  toggleInList,
} from '../src/tickets/ticketFilters.ts';
import { ticketListQueryString } from '../src/api.ts';

const FULL = {
  q: 'login bug',
  statuses: ['in_progress', 'todo'],
  tags: ['ui', 'AWB Dev'],
  projectId: 'p-1',
  assigneeKey: 'rt-0123456789abcdef',
  archived: true,
};

test('필터 → URL → 필터 왕복이 값을 보존한다 (상태는 lifecycle 순서, 태그는 정렬)', () => {
  const params = filtersToSearch(FULL);
  const back = filtersFromSearch(params);
  assert.deepEqual(back, {
    q: 'login bug',
    statuses: ['todo', 'in_progress'],
    tags: ['AWB Dev', 'ui'],
    projectId: 'p-1',
    assigneeKey: 'rt-0123456789abcdef',
    archived: true,
  });
  assert.ok(sameFilters(FULL, back));
  // 문자열로도 같은 결과.
  assert.deepEqual(filtersFromSearch(params.toString()), back);
});

test('기본 필터는 URL 에 아무것도 쓰지 않는다', () => {
  assert.equal(filtersToSearch(EMPTY_TICKET_FILTERS).toString(), '');
  assert.equal(hasActiveFilters(EMPTY_TICKET_FILTERS), false);
  assert.equal(hasActiveFilters(FULL), true);
});

test('필터 쓰기는 ticket/comment 및 다른 파라미터를 보존하고, 꺼진 필터는 지운다', () => {
  const base = new URLSearchParams('ticket=t1&comment=c9&status=done&tags=x&foo=bar');
  const next = filtersToSearch({ ...EMPTY_TICKET_FILTERS, q: 'abc' }, base);
  assert.equal(next.get('ticket'), 't1');
  assert.equal(next.get('comment'), 'c9');
  assert.equal(next.get('foo'), 'bar');
  assert.equal(next.get('q'), 'abc');
  assert.equal(next.has('status'), false, '빈 상태 필터는 지운다');
  assert.equal(next.has('tags'), false);
  // 원본은 건드리지 않는다.
  assert.equal(base.get('status'), 'done');
});

test('URL 파싱은 모르는 상태값·중복·공백을 버린다', () => {
  const f = filtersFromSearch('status=done,bogus,done,%20todo&tags=a,,a,%20b%20&archived=true');
  assert.deepEqual(f.statuses, ['todo', 'done']);
  assert.deepEqual(f.tags, ['a', 'b']);
  assert.equal(f.archived, true);
  assert.equal(filtersFromSearch('archived=0').archived, false);
});

test('서버 쿼리는 contract 키(status/tags/project_id/assignee_key/q/archived_only)를 쓴다', () => {
  const query = filtersToQuery(FULL);
  assert.deepEqual(query, {
    status: ['todo', 'in_progress'],
    tags: ['AWB Dev', 'ui'],
    project_id: 'p-1',
    assignee_key: 'rt-0123456789abcdef',
    q: 'login bug',
    archived_only: true,
  });
  const qs = new URLSearchParams(ticketListQueryString(query));
  assert.equal(qs.get('status'), 'todo,in_progress');
  assert.equal(qs.get('tags'), 'AWB Dev,ui');
  assert.equal(qs.get('project_id'), 'p-1');
  assert.equal(qs.get('assignee_key'), 'rt-0123456789abcdef');
  assert.equal(qs.get('q'), 'login bug');
  assert.equal(qs.get('archived_only'), '1');
  assert.equal(qs.has('include_archived'), false);
  assert.deepEqual(filtersToQuery(EMPTY_TICKET_FILTERS), {});
  assert.equal(ticketListQueryString({}), '');
});

test('toggleInList 는 넣고 빼기를 오간다', () => {
  assert.deepEqual(toggleInList(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleInList(['a', 'b'], 'a'), ['b']);
});

const tickets = [
  { id: '1', tags: ['ui', 'bug'] },
  { id: '2', tags: ['ui'] },
  { id: '3', tags: ['bug', 'api', 'ui'] },
  { id: '4', tags: [] },
  { id: '5' },
];

test('태그 필터는 AND — 선택한 태그를 전부 가진 티켓만 남는다', () => {
  assert.deepEqual(filterTicketsByTags(tickets, ['ui']).map((t) => t.id), ['1', '2', '3']);
  assert.deepEqual(filterTicketsByTags(tickets, ['ui', 'bug']).map((t) => t.id), ['1', '3']);
  assert.deepEqual(filterTicketsByTags(tickets, ['ui', 'bug', 'api']).map((t) => t.id), ['3']);
  assert.deepEqual(filterTicketsByTags(tickets, ['nope']), []);
  assert.equal(filterTicketsByTags(tickets, []).length, tickets.length, '선택 없음 = 전부');
  assert.equal(ticketHasAllTags({ tags: null }, ['x']), false);
});

test('태그 카운트는 많이 쓰인 순, 같으면 이름순이고 한 티켓의 중복 태그는 한 번만 센다', () => {
  assert.deepEqual(countTags([...tickets, { id: '6', tags: ['api', 'api'] }]), [
    { tag: 'ui', count: 3 },
    { tag: 'api', count: 2 },
    { tag: 'bug', count: 2 },
  ]);
});

test('태그 facet: 서버 카운트 우선, 비면 로드된 행을 세고, 선택된 태그는 0건이어도 맨 앞에 남는다', () => {
  const server = [{ tag: 'ui', count: 10 }, { tag: 'bug', count: 4 }];
  assert.deepEqual(tagFacet(server, tickets, ['bug', 'gone']), [
    { tag: 'bug', count: 4, selected: true },
    { tag: 'gone', count: 0, selected: true },
    { tag: 'ui', count: 10, selected: false },
  ]);
  assert.deepEqual(
    tagFacet([], tickets, []).map((r) => `${r.tag}:${r.count}`),
    ['ui:3', 'bug:2', 'api:1'],
  );
});

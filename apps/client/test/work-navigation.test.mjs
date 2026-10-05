// WORK 계층 내비게이션 모델 단위 테스트 (티켓 03ca8b5b → board-less, docs/tickets.md).
//
// 여기서 고정하는 계약:
//   1. WORK 는 맨 위 평평한 Tickets 한 줄 + 계층형 Teams → Orchestrations 순서다 (Boards 없음)
//   2. 각 계층 메뉴가 자기 엔티티 목록을 서브메뉴로 갖고, 서브 경로가 기존 상세 화면을 가리킨다
//   3. 형제 메뉴가 동시에 active 로 보이지 않는다 (예전 /teams 접두사 겹침 회귀)
//   4. 목록이 비면 메뉴별 empty state 문구를 갖는다
//   5. Tickets 는 워크스페이스 전체 미읽음 배지를 싣는다
//
// 실제 렌더까지 태우는 검증은 sidebar-work-hierarchy.test.mjs 가 담당한다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTicketsNavItem, buildWorkNavGroups, activeWorkGroupKey } from '../src/components/workNavigation.ts';

const BASE = '';

function build(overrides = {}) {
  return buildWorkNavGroups({
    basePath: BASE,
    pathname: `${BASE}/tickets`,
    teams: [{ id: 't1', name: 'Platform squad' }],
    missions: [{ id: 'm1', title: 'Ship the nav' }],
    ...overrides,
  });
}

test('WORK 계층 메뉴는 Teams → Orchestrations 순서이고 Boards 는 없다', () => {
  const groups = build();
  assert.deepEqual(groups.map((g) => g.key), ['teams', 'orchestrations']);
  assert.deepEqual(groups.map((g) => g.label), ['Teams', 'Missions']);
  // 단수 표기가 남으면 안 된다.
  assert.ok(!groups.some((g) => g.label === 'Orchestration'));
  assert.ok(!groups.some((g) => g.label === 'Boards'));
});

test('각 최상위 메뉴는 자기 목록 화면을, 서브메뉴는 기존 상세 화면을 가리킨다', () => {
  const [teams, orchestrations] = build();

  assert.equal(teams.path, `${BASE}/teams`);
  assert.deepEqual(teams.children.map((c) => c.path), [`${BASE}/teams?team=t1`]);

  assert.equal(orchestrations.path, `${BASE}/missions`);
  assert.deepEqual(orchestrations.children.map((c) => c.path), [`${BASE}/missions/m1`]);
});

test('서브메뉴 라벨은 실제 팀/미션 이름이다', () => {
  const groups = build();
  assert.deepEqual(groups.map((g) => g.children.map((c) => c.label)), [['Platform squad'], ['Ship the nav']]);
});

test('Teams 화면에서는 Teams 만 active 다 (Orchestrations 와 동시 활성 금지)', () => {
  // 회귀 대상: Teams 가 /teams 였을 때는 Orchestrations 의 경로
  // 접두사에 걸려 두 메뉴가 함께 active 로 보였다.
  const groups = build({ pathname: `${BASE}/teams` });
  assert.deepEqual(groups.map((g) => g.active), [true, false]);
  assert.equal(activeWorkGroupKey(groups), 'teams');
});

test('미션 상세 딥링크는 Orchestrations 와 해당 서브 항목만 active 로 만든다', () => {
  const groups = build({
    pathname: `${BASE}/missions/m1`,
    missions: [
      { id: 'm1', title: 'Ship the nav' },
      { id: 'm2', title: 'Other mission' },
    ],
  });
  assert.deepEqual(groups.map((g) => g.active), [false, true]);
  assert.deepEqual(groups[1].children.map((c) => c.active), [true, false]);
});

test('Tickets 화면에서는 어떤 계층 그룹도 active 가 아니다', () => {
  const groups = build({ pathname: `${BASE}/tickets` });
  assert.deepEqual(groups.map((g) => g.active), [false, false]);
  assert.equal(activeWorkGroupKey(groups), null);
});

test('팀 서브 항목의 active 는 ?team= 쿼리로 판정한다', () => {
  const teamsList = [
    { id: 't1', name: 'Platform squad' },
    { id: 't2', name: 'Ops squad' },
  ];

  const noSelection = build({ pathname: `${BASE}/teams`, teams: teamsList });
  assert.deepEqual(noSelection[0].children.map((c) => c.active), [false, false]);

  const selected = build({ pathname: `${BASE}/teams`, teams: teamsList, selectedTeamId: 't2' });
  assert.deepEqual(selected[0].children.map((c) => c.active), [false, true]);

  // 다른 화면에 있으면 쿼리가 남아 있어도 팀 서브 항목은 active 가 아니다.
  const elsewhere = build({ pathname: `${BASE}/tickets`, teams: teamsList, selectedTeamId: 't2' });
  assert.deepEqual(elsewhere[0].children.map((c) => c.active), [false, false]);
});

test('팀 id 는 경로에 쓰이기 전에 인코딩된다', () => {
  const groups = build({ teams: [{ id: 'a b&c', name: 'Weird id' }] });
  assert.equal(groups[0].children[0].path, `${BASE}/teams?team=a%20b%26c`);
});

test('목록이 비면 메뉴별 empty state 문구를 갖는다', () => {
  const groups = build({ teams: [], missions: [] });
  assert.deepEqual(groups.map((g) => [g.children.length, g.emptyLabel]), [
    [0, 'No teams yet'],
    [0, 'No missions yet'],
  ]);
});

test('아직 응답 전이면 loading 이 켜져 empty state 와 구분된다', () => {
  const groups = build({ teams: [], missions: [], teamsLoading: true, missionsLoading: true });
  assert.deepEqual(groups.map((g) => g.loading), [true, true]);
});

test('Tickets 메뉴: /tickets 경로, 그 화면에서 active, 워크스페이스 전체 미읽음 배지', () => {
  const item = buildTicketsNavItem({ basePath: BASE, pathname: `${BASE}/tickets`, ticketUnreadTotal: 3 });
  assert.equal(item.key, 'tickets');
  assert.equal(item.label, 'Tickets');
  assert.equal(item.path, `${BASE}/tickets`);
  assert.equal(item.active, true);
  assert.equal(item.badge, 3);
  assert.match(item.badgeLabel, /3건/);

  assert.equal(buildTicketsNavItem({ basePath: BASE, pathname: `${BASE}/teams` }).active, false);
  assert.equal(buildTicketsNavItem({ basePath: BASE, pathname: `${BASE}/tickets-archive` }).active, false, '접두사만 겹치는 경로는 아니다');
  assert.equal(buildTicketsNavItem({ basePath: BASE, pathname: `${BASE}/teams` }).badge, 0);
});

test('작업 메뉴는 소유 account 없이도 활성 상태를 판정한다', () => {
  const groups = buildWorkNavGroups({
    basePath: '',
    pathname: '/admin/logs',
    teams: [],
    missions: [],
  });
  assert.equal(activeWorkGroupKey(groups), null);
  assert.equal(buildTicketsNavItem({ basePath: '', pathname: '/tickets' }).active, true);
});

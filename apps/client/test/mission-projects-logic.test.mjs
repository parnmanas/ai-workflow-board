// 미션 project ↔ 로스터 slot 순수 로직 (missionProjects.logic.ts, docs/orchestration.md → "미션 프로젝트").
//
// 팀은 재사용되므로 폴더를 모른다. 미션이 project 를 고르고, 각 slot 은 그 project 의
// **자기 Host** 폴더(ProjectHostFolder)에서 일한다. 미션 폼은 시작 전에 "누가 어느 project 를
// 맡을 수 있는가" 를 보여 주고, 서버 resolveMissionRoster 와 같은 규칙으로 시작을 막는다 —
// 운영자가 409 를 읽는 대신 폼에서 고치게 하려는 것이다. 이 파일은 그 규칙 자체를 고정한다:
//   1. slotCoverage — 고른 순서대로 project 마다 그 slot Host 의 폴더(없으면 null), 하나라도
//      있으면 workable. Host id 별칭 목록(Host id + legacy manager uuid)도 같은 Host 로 본다.
//   2. missionStartProblems — project 가 없으면 그 한 문장만, 있으면 orchestrator → 멤버(로스터
//      순서) 순으로 "어느 project 에도 폴더가 없는" slot 을 문장으로 나열한다. 화면과 토스트가
//      이 문장을 그대로 쓰므로 문구도 계약이다.
//   3. addMissionProject / makePrimaryProject — 첫 항목이 primary 다. 바뀔 게 없으면 **같은
//      배열**을 돌려준다(호출부가 상태 갱신을 건너뛸 수 있게).
//
// 렌더링 계약(선택·브랜치·payload·커버리지 표시·Set folder…)은 mission-form-projects.test.mjs 가 본다.
// 실행: node --import tsx --test test/mission-projects-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addMissionProject,
  makePrimaryProject,
  missionStartProblems,
  slotCoverage,
} from '../src/components/orchestration/missionProjects.logic.ts';

// rolf · ralf 두 Host. ralf 의 폴더 하나는 dual-write 시절 legacy manager uuid 로 등록돼 있다.
const PROJECTS = [
  {
    id: 'p-awb',
    name: 'AWB',
    host_folders: [
      { host_id: 'h-rolf', path: '/srv/awb' },
      { host_id: 'legacy-ralf', path: 'E:\\work\\awb' },
    ],
  },
  { id: 'p-game', name: 'GameClient', host_folders: [{ host_id: 'h-ralf', path: 'D:\\game' }] },
  { id: 'p-docs', name: 'Docs', host_folders: [{ host_id: 'h-rolf', path: '   ' }] },
];

const sel = (...ids) => ids.map((project_id) => ({ project_id, branch: '' }));
const slot = (key, label, ...host_ids) => ({ key, label, host_ids });

// ── 1. slotCoverage ─────────────────────────────────────────────────────────

test('slotCoverage: 고른 순서대로 project 마다 그 Host 의 폴더를, 없으면 null 을 준다', () => {
  const rolf = slot('m-impl', 'rolf/implementer', 'h-rolf');
  const coverage = slotCoverage(PROJECTS, sel('p-game', 'p-awb'), rolf);

  assert.deepEqual(
    coverage.folders,
    [
      { project_id: 'p-game', folder: null },
      { project_id: 'p-awb', folder: '/srv/awb' },
    ],
    '목록 순서가 아니라 선택 순서를 따른다 — 화면의 ✓/✗ 줄이 project 행 순서와 맞아야 한다',
  );
  assert.equal(coverage.workable, true, '하나라도 폴더가 있으면 그 slot 은 일할 수 있다');
  assert.equal(coverage.slot === rolf, true, '판정한 slot 을 그대로 돌려준다');
});

test('slotCoverage: Host id 별칭 중 하나라도 맞으면 같은 Host 의 폴더로 본다', () => {
  // 폴더는 legacy uuid 로 등록돼 있고 slot 은 Host id 로 말한다 — 둘 다 같은 Host 다.
  const ralf = slot('m-review', 'ralf/reviewer', 'h-ralf', 'legacy-ralf');
  assert.deepEqual(slotCoverage(PROJECTS, sel('p-awb', 'p-game'), ralf).folders, [
    { project_id: 'p-awb', folder: 'E:\\work\\awb' },
    { project_id: 'p-game', folder: 'D:\\game' },
  ]);

  // 별칭을 모르면 legacy 로 등록된 폴더는 보이지 않는다 — 별칭 목록이 실제로 쓰인다는 대조군.
  const hostOnly = slot('m-review', 'ralf/reviewer', 'h-ralf');
  assert.deepEqual(slotCoverage(PROJECTS, sel('p-awb'), hostOnly).folders, [{ project_id: 'p-awb', folder: null }]);
  assert.equal(slotCoverage(PROJECTS, sel('p-awb'), hostOnly).workable, false);
});

test('slotCoverage: 공백 경로·목록에 없는 project·빈 선택은 폴더가 아니다', () => {
  const rolf = slot('orchestrator', 'rolf/orchestrator', 'h-rolf');

  const blank = slotCoverage(PROJECTS, sel('p-docs'), rolf);
  assert.deepEqual(blank.folders, [{ project_id: 'p-docs', folder: null }], '공백만 있는 경로는 등록 안 된 것과 같다');
  assert.equal(blank.workable, false);

  // 삭제됐거나 아직 목록이 오지 않은 project — 던지지 않고 "폴더 없음" 으로 본다.
  const unknown = slotCoverage(PROJECTS, sel('p-deleted'), rolf);
  assert.deepEqual(unknown.folders, [{ project_id: 'p-deleted', folder: null }]);
  assert.equal(unknown.workable, false);

  const none = slotCoverage(PROJECTS, [], rolf);
  assert.deepEqual(none.folders, []);
  assert.equal(none.workable, false, '고른 project 가 없으면 맡을 것도 없다');

  assert.equal(slotCoverage(PROJECTS, sel('p-awb'), slot('m-x', 'nowhere')).workable, false, 'Host id 가 없는 slot');
});

// ── 2. missionStartProblems ────────────────────────────────────────────────

const ORCH = slot('orchestrator', 'rolf/orchestrator', 'h-rolf');
const IMPL = slot('m-impl', 'rolf/implementer', 'h-rolf');
const REVIEW = slot('m-review', 'ralf/reviewer', 'h-ralf');
const GPU = slot('extra:0', 'gpu-tester', 'h-ragnar');

test('missionStartProblems: project 를 하나도 안 골랐으면 그 한 문장만 낸다', () => {
  assert.deepEqual(
    missionStartProblems({ projects: PROJECTS, selected: [], orchestrator: ORCH, members: [IMPL, GPU] }),
    ['Pick at least one project — members work in its folder on their own host.'],
    'slot 별 문제를 늘어놓지 않는다 — project 가 없으면 모든 slot 이 "폴더 없음" 이라 소음뿐이다',
  );
});

test('missionStartProblems: 모든 slot 이 고른 project 중 하나라도 맡을 수 있으면 빈 배열', () => {
  // reviewer(ralf)는 AWB 폴더가 없지만 GameClient 폴더가 있다 — 전부가 아니라 하나면 된다.
  assert.deepEqual(
    missionStartProblems({ projects: PROJECTS, selected: sel('p-awb', 'p-game'), orchestrator: ORCH, members: [IMPL, REVIEW] }),
    [],
  );
});

test('missionStartProblems: orchestrator 먼저, 그다음 멤버를 로스터 순서대로 — 문구까지 고정', () => {
  // GameClient 는 ralf 에만 폴더가 있다 → rolf 의 orchestrator·implementer, ragnar 의 임시 멤버가 걸린다.
  const problems = missionStartProblems({
    projects: PROJECTS,
    selected: sel('p-game'),
    orchestrator: ORCH,
    members: [IMPL, REVIEW, GPU],
  });
  assert.deepEqual(problems, [
    'The orchestrator (rolf/orchestrator) has no folder for any selected project on its host.',
    'rolf/implementer has no folder for any selected project on its host — set one, or leave it out.',
    'gpu-tester has no folder for any selected project on its host — set one, or leave it out.',
  ]);
});

test('missionStartProblems: orchestrator runtime 이 없는 팀은 orchestrator 문제를 만들지 않는다', () => {
  assert.deepEqual(
    missionStartProblems({ projects: PROJECTS, selected: sel('p-awb'), orchestrator: null, members: [REVIEW] }),
    ['ralf/reviewer has no folder for any selected project on its host — set one, or leave it out.'],
  );
  assert.deepEqual(missionStartProblems({ projects: PROJECTS, selected: sel('p-awb'), orchestrator: null, members: [] }), []);
});

test('missionStartProblems: 별칭으로 등록된 폴더도 그 Host 의 폴더로 인정한다', () => {
  const reviewWithAlias = slot('m-review', 'ralf/reviewer', 'h-ralf', 'legacy-ralf');
  assert.deepEqual(
    missionStartProblems({ projects: PROJECTS, selected: sel('p-awb'), orchestrator: ORCH, members: [reviewWithAlias] }),
    [],
  );
});

test('missionStartProblems: 목록이 비면(로딩 중·조회 실패) 고른 project 가 있어도 모든 slot 이 걸린다', () => {
  // 폼은 이 결과로 "시작" 만 막는다 — draft 저장은 막지 않는다(mission-form-projects.test.mjs).
  assert.deepEqual(missionStartProblems({ projects: [], selected: sel('p-awb'), orchestrator: ORCH, members: [IMPL] }), [
    'The orchestrator (rolf/orchestrator) has no folder for any selected project on its host.',
    'rolf/implementer has no folder for any selected project on its host — set one, or leave it out.',
  ]);
});

// ── 3. addMissionProject / makePrimaryProject ──────────────────────────────

test('addMissionProject: 뒤에 붙인다(첫 항목이 primary 로 남는다) — 브랜치는 빈 값(기본 브랜치)', () => {
  const before = [{ project_id: 'p-awb', branch: 'release' }];
  const after = addMissionProject(before, 'p-game');
  assert.deepEqual(after, [
    { project_id: 'p-awb', branch: 'release' },
    { project_id: 'p-game', branch: '' },
  ]);
  assert.deepEqual(before, [{ project_id: 'p-awb', branch: 'release' }], '입력 배열은 건드리지 않는다');
});

test('addMissionProject: 이미 고른 project 나 빈 id 는 같은 배열을 그대로 돌려준다', () => {
  const before = sel('p-awb', 'p-game');
  assert.equal(addMissionProject(before, 'p-game') === before, true, '중복 추가 없음 — 같은 참조');
  assert.equal(addMissionProject(before, '') === before, true, '"Select a project" 같은 빈 선택지는 무시');
  assert.deepEqual(addMissionProject([], 'p-awb'), [{ project_id: 'p-awb', branch: '' }], '첫 project 가 곧 primary');
});

test('makePrimaryProject: 맨 앞으로 옮기고 나머지 순서·브랜치는 유지한다', () => {
  const before = [
    { project_id: 'p-awb', branch: '' },
    { project_id: 'p-game', branch: 'develop' },
    { project_id: 'p-docs', branch: 'main' },
  ];
  assert.deepEqual(makePrimaryProject(before, 'p-docs'), [
    { project_id: 'p-docs', branch: 'main' },
    { project_id: 'p-awb', branch: '' },
    { project_id: 'p-game', branch: 'develop' },
  ]);
  assert.deepEqual(before.map((p) => p.project_id), ['p-awb', 'p-game', 'p-docs'], '입력 배열은 건드리지 않는다');
});

test('makePrimaryProject: 이미 primary 이거나 고르지 않은 project 면 같은 배열을 돌려준다', () => {
  const before = sel('p-awb', 'p-game');
  assert.equal(makePrimaryProject(before, 'p-awb') === before, true, '이미 primary');
  assert.equal(makePrimaryProject(before, 'p-docs') === before, true, '선택에 없는 project 를 끼워 넣지 않는다');
  const empty = [];
  assert.equal(makePrimaryProject(empty, 'p-awb') === empty, true, '빈 선택');
});

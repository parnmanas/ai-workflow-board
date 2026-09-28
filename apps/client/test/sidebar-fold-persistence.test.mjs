// 사이드바의 **모든** 메뉴·서브메뉴 접기 상태가 새로고침을 넘겨 살아남는다.
//
// 고치는 증상(사용자 보고): 폴드 저장이 절반만 구현돼 있었다. 섹션 헤더·SESSIONS·
// CHAT·세션 호스트는 저장됐지만 WORK 의 Teams/Orchestrations/Boards 와 호스트 아래
// 작업 폴더, "+N개 더 보기" 로 펼친 것들은 매 새로고침마다 원래대로 돌아왔다.
// 그리고 저장이 됐더라도, 지금 보고 있는 화면이 속한 그룹 하나는 마운트 때 도는
// 자동 펼침 효과가 도로 펴 버렸다 — Boards 를 접어 둔 채 보드에서 새로고침하면
// Boards 가 다시 열렸다.
//
// 저장 로직이 1000줄짜리 컴포넌트 안에 인라인이라 테스트가 하나도 없었던 것이
// 절반 구현이 지나간 이유다. 순수 모듈로 떼어 내고 여기서 목록을 고정한다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  EMPTY_SIDEBAR_FOLD,
  loadSidebarFold,
  normalizeSidebarFold,
  saveSidebarFold,
} from '../src/components/sidebarFold.ts';

/** 저장해야 하는 접기 지점 전부. 새 접기 지점이 생기면 여기에 더한다. */
const FOLD_KEYS = ['sessions', 'chats', 'sections', 'groups', 'hosts', 'hostCwds', 'olderCwds', 'olderHosts'];

function withStorage(run) {
  const store = new Map();
  const prevLocal = globalThis.localStorage;
  const prevDoc = globalThis.document;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let cookie = '';
  globalThis.document = {
    get cookie() { return cookie; },
    set cookie(v) {
      const [pair] = String(v).split(';');
      const [name, val] = pair.split('=');
      // max-age=0 → 삭제
      cookie = /max-age=0/.test(String(v))
        ? cookie.split(';').filter((c) => !c.trim().startsWith(`${name.trim()}=`)).join(';')
        : [cookie, `${name.trim()}=${val ?? ''}`].filter(Boolean).join('; ');
    },
  };
  try { return run({ store, setCookie: (raw) => { cookie = raw; } }); }
  finally { globalThis.localStorage = prevLocal; globalThis.document = prevDoc; }
}

// ─── 스냅샷 계약 ──────────────────────────────────────────────────────────

test('스냅샷이 접기 지점을 빠짐없이 갖는다', () => {
  assert.deepEqual(Object.keys(EMPTY_SIDEBAR_FOLD).sort(), [...FOLD_KEYS].sort());
});

test('아무것도 저장된 적 없으면 전부 펼친 기본값이다', () => {
  withStorage(() => {
    assert.deepEqual(loadSidebarFold(), EMPTY_SIDEBAR_FOLD);
  });
});

test('저장한 것이 그대로 돌아온다 — 새로고침 왕복', () => {
  withStorage(() => {
    const snap = {
      sessions: true,
      chats: false,
      sections: { WORK: true, AUTOMATION: true },
      groups: { boards: true, teams: true },
      hosts: ['mgr-rolf'],
      hostCwds: ['mgr-rolf::/srv/work'],
      olderCwds: ['mgr-ralf::D:\\repo'],
      olderHosts: ['mgr-ralf'],
    };
    saveSidebarFold(snap);
    assert.deepEqual(loadSidebarFold(), snap);
  });
});

test('예전 스냅샷(키가 적던 시절)도 그대로 읽힌다', () => {
  withStorage(({ store }) => {
    // 이 기능이 절반만 구현돼 있던 시절의 모양. 없는 키는 기본값이 되어야지
    // 통째로 버려지면 안 된다 — 사용자가 접어 둔 섹션까지 잃는다.
    store.set('awb_sidebar_fold', JSON.stringify({ sessions: true, sections: { WORK: true }, hosts: ['h1'] }));
    const loaded = loadSidebarFold();
    assert.equal(loaded.sessions, true);
    assert.deepEqual(loaded.sections, { WORK: true });
    assert.deepEqual(loaded.hosts, ['h1']);
    assert.deepEqual(loaded.groups, {});
    assert.deepEqual(loaded.hostCwds, []);
  });
});

test('손상된 저장본은 기본값으로 떨어진다 — 사이드바가 안 그려지면 안 된다', () => {
  withStorage(({ store }) => {
    store.set('awb_sidebar_fold', '{ not json');
    assert.deepEqual(loadSidebarFold(), EMPTY_SIDEBAR_FOLD);
  });
});

test('쓰레기 값이 섞여 있어도 타입을 지킨다', () => {
  const loaded = normalizeSidebarFold({
    sessions: 'yes',                       // 불리언 아님 → false
    sections: ['WORK'],                    // 배열 → 레코드 아님 → {}
    groups: { boards: true, teams: false },// false 는 기본값과 같아 버린다
    hosts: ['ok', 42, '', null],           // 문자열만
    hostCwds: 'nope',                      // 배열 아님 → []
  });
  assert.equal(loaded.sessions, false);
  assert.deepEqual(loaded.sections, {});
  assert.deepEqual(loaded.groups, { boards: true });
  assert.deepEqual(loaded.hosts, ['ok']);
  assert.deepEqual(loaded.hostCwds, []);
});

test('쿠키에 남은 예전 값은 한 번 옮겨 오고 지운다', () => {
  withStorage(({ setCookie, store }) => {
    // 예전 구현은 쿠키에 넣었다 — 그건 **모든 HTTP 요청에 실려 나간다**. 옮기되
    // 사용자가 접어 둔 상태는 잃지 않는다.
    setCookie(`awb_sidebar_fold=${encodeURIComponent(JSON.stringify({ sessions: true, sections: { WORK: true } }))}`);
    const loaded = loadSidebarFold();
    assert.equal(loaded.sessions, true);
    assert.deepEqual(loaded.sections, { WORK: true });
    assert.ok(store.has('awb_sidebar_fold'), 'localStorage 로 옮겨져야 한다');
    assert.doesNotMatch(globalThis.document.cookie, /awb_sidebar_fold=[^;]/, '쿠키는 지워져야 한다');
  });
});

// ─── 컴포넌트 배선 ────────────────────────────────────────────────────────

const sidebarSource = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');

test('모든 접기 state 가 저장본에서 복원된다', () => {
  // 하나라도 빠지면 그 메뉴만 새로고침마다 펼쳐져 돌아온다.
  for (const [state, from] of [
    ['sessionsCollapsed', 'foldInit.sessions'],
    ['chatsCollapsed', 'foldInit.chats'],
    ['sectionCollapsed', 'foldInit.sections'],
    ['collapsedHosts', 'foldInit.hosts'],
    ['collapsedHostCwds', 'foldInit.hostCwds'],
    ['expandedOlderCwds', 'foldInit.olderCwds'],
    ['expandedOlderHosts', 'foldInit.olderHosts'],
  ]) {
    const decl = sidebarSource.slice(sidebarSource.indexOf(`const [${state},`));
    assert.ok(
      decl.slice(0, decl.indexOf(';')).includes(from),
      `${state} 가 ${from} 에서 복원되지 않는다`,
    );
  }
  // WORK 최상위 메뉴(Teams/Orchestrations/Boards) — 사용자가 지적한 바로 그것.
  const groups = sidebarSource.slice(sidebarSource.indexOf('const [collapsedGroups,'));
  assert.ok(
    groups.slice(0, groups.indexOf('\n  const ')).includes('loadSidebarFold().groups'),
    'collapsedGroups 가 저장본에서 복원되지 않는다',
  );
});

test('모든 접기 state 가 저장 대상에 실린다', () => {
  const call = sidebarSource.slice(
    sidebarSource.indexOf('saveSidebarFold({'),
    sidebarSource.indexOf('});', sidebarSource.indexOf('saveSidebarFold({')),
  );
  for (const key of FOLD_KEYS) {
    assert.match(call, new RegExp(`\\b${key}:`), `saveSidebarFold 가 ${key} 를 안 싣는다`);
  }
});

test('같은 자리로 돌아온 것은 이동이 아니다 — 활성 그룹을 자동으로 펴지 않는다', () => {
  // 이게 없으면 저장을 아무리 잘 해도 "지금 보고 있는 화면이 속한 그룹" 하나는
  // 매 새로고침마다 다시 펼쳐진다.
  //
  // 판정 기준은 **경로**여야 한다. 효과 실행 횟수로 "첫 번째만 건너뛰기" 를 하면
  // 안 된다 — activeGroupKey 는 팀·미션·보드 목록이 늦게 도착하며 mount 이후에
  // null → 'boards' 로 채워지므로, 건너뛰기가 엉뚱한 실행에 쓰이고 정작 값이
  // 생겼을 때 펴 버린다(실측으로 확인한 실패 모드다).
  assert.match(sidebarSource, /mountedPathRef = React\.useRef\(location\.pathname\)/);
  assert.match(sidebarSource, /if \(location\.pathname === mountedPathRef\.current\) return;/);
  // 경로가 바뀌면(앱 안 이동) 다시 돌아야 하므로 의존성에 들어 있어야 한다.
  assert.match(sidebarSource, /\}, \[activeGroupKey, location\.pathname\]\);/);
  assert.doesNotMatch(sidebarSource, /navigatedOnceRef/);
});

test('폴드 상태를 쿠키에 쓰지 않는다 — 매 요청에 실려 나간다', () => {
  assert.doesNotMatch(sidebarSource, /document\.cookie/);
});

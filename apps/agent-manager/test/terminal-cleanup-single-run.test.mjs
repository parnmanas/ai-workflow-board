// terminal Git 정리의 단일 실행·단일 알림 회귀 (ticket 62407d4e).
//
// 실제로 일어난 일: Done 진입 직후 같은 "⚠️ Git 자동 정리를 보류했습니다" 코멘트가
// 1.3초 간격으로 두 번 쌓였다. 원인이 둘이었다.
//   1. `handleBoardUpdate` 가 `moved` 이벤트마다 정리를 fire-and-forget 으로 띄워,
//      같은 이동이 겹치거나 재전달되면(SSE 재연결 replay) 정리가 중복 실행됐다.
//   2. 한 번의 실행 안에서도 매니저가 관리하는 agent home 마다 코멘트를 따로 냈다.
//
// 그래서 이 파일은 **정리 호출 횟수**와 **알림 호출 횟수**를 직접 센다. 서버측
// dedupe_key 합치기는 별개의 방어선이고(apps/server/test/ 가 검증한다), 여기서는
// 매니저가 애초에 중복 요청을 만들지 않는 것을 고정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

const TICKET = 'cccccccc-1111-2222-3333-444444444444';
const ENTERED_AT = '2026-09-17T05:11:17.924Z';
const MOVED_EVENT = JSON.stringify({
  event_type: 'board_update', entity_type: 'ticket', action: 'moved', ticket_id: TICKET,
});

async function waitFor(pred, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return pred();
}

/** 매니저가 코멘트를 남기는 경로(MCP tools/call)와 티켓 재조회를 가로채는 fetch 스텁.
 *  `terminalEnteredAt` 은 매 조회마다 읽히므로 테스트 중 바꿀 수 있다. */
function installFetchStub(t, { comments, state }) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const json = (payload, init = {}) => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' }, ...init,
  });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/api/agent/tickets/')) {
      return json({
        terminal_entered_at: state.terminalEnteredAt,
        base_branch: 'main',
        base_repo: { id: 'repo-resource', default_branch: 'main' },
      });
    }
    if (href.endsWith('/mcp')) {
      if (init.method === 'DELETE') return new Response('', { status: 200 });
      let body = {};
      try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = {}; }
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: body.id, result: {} }, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' },
        });
      }
      if (body.method === 'tools/call') {
        if (body.params?.name === 'add_comment') comments.push(body.params.arguments);
        return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } });
      }
      return json({ jsonrpc: '2.0', result: {} });
    }
    return json({});
  };
}

function makeDispatcher({ cleanupTerminalTicketGit, workingDirs }) {
  const worktreeManager = {
    enabled: true,
    cleanupTerminalTicketGit,
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const managedAgentContexts = {
    list() { return workingDirs.map((working_dir) => ({ working_dir })); },
  };
  return new EventDispatcher(
    { url: 'http://awb.test', apiKey: 'test-key', delegation: {} },
    { worktreeManager, managedAgentContexts },
  );
}

function heldReport(branch) {
  return {
    removedWorktrees: 0,
    removedLocalBranches: [],
    removedRemoteBranches: [],
    remainingBranches: [branch],
    heldReasons: [`로컬 브랜치 삭제 실패: ${branch}`],
    benignHolds: [],
    benignHeldBranches: [],
  };
}

test('같은 terminal 이동이 겹치거나 다시 와도 정리는 한 번만 돌고 알림도 한 번만 나간다', async (t) => {
  const comments = [];
  const cleanupCalls = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  let releaseFirstCleanup;
  const firstCleanupGate = new Promise((resolve) => { releaseFirstCleanup = resolve; });

  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer'],
    async cleanupTerminalTicketGit(opts) {
      cleanupCalls.push(opts);
      // 첫 실행을 붙잡아 두 번째 이벤트가 **실행 중에** 도착하게 만든다 —
      // 원래 사건의 인터리빙 그대로다.
      if (cleanupCalls.length === 1) await firstCleanupGate;
      return heldReport(`ticket/${TICKET}-work`);
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => cleanupCalls.length === 1), true, '첫 정리가 시작돼야 한다');
  dispatcher.handleBoardUpdate(MOVED_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cleanupCalls.length, 1, '실행 중인 정리와 겹쳐 돌면 안 된다');

  releaseFirstCleanup();
  assert.equal(await waitFor(() => comments.length === 1), true, '알림이 한 번은 나가야 한다');

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cleanupCalls.length, 1, '완료된 (ticket, terminal_entered_at) 은 재실행하지 않는다');
  assert.equal(comments.length, 1, '중복 알림이 없어야 한다');
  assert.equal(comments[0].metadata.dedupe_key, `terminal-git-cleanup-held:${ENTERED_AT}`);
});

test('정리 도중 티켓이 다시 terminal 로 진입하면 그 진입도 정리한다', async (t) => {
  // 겹친 호출을 그냥 버리면 이 경우가 조용히 새어나간다 — 첫 실행이 도는 동안
  // 티켓이 reopen 후 다시 terminal 로 들어오면, 그 새 진입을 정리할 주체가 없어진다.
  const comments = [];
  const cleanupCalls = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  let releaseFirstCleanup;
  const firstCleanupGate = new Promise((resolve) => { releaseFirstCleanup = resolve; });

  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer'],
    async cleanupTerminalTicketGit(opts) {
      cleanupCalls.push(opts);
      if (cleanupCalls.length === 1) await firstCleanupGate;
      return heldReport(`ticket/${TICKET}-work`);
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => cleanupCalls.length === 1), true, '첫 정리가 시작돼야 한다');

  // 첫 실행이 아직 도는 중에 재진입이 일어나고 그 이동 이벤트가 도착한다.
  state.terminalEnteredAt = '2026-09-18T01:02:03.456Z';
  dispatcher.handleBoardUpdate(MOVED_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cleanupCalls.length, 1, '줄은 서되 겹쳐 돌지는 않는다');

  releaseFirstCleanup();
  assert.equal(await waitFor(() => cleanupCalls.length === 2), true,
    '새 terminal 진입은 앞 실행이 끝난 뒤 이어서 정리돼야 한다');
  assert.equal(await waitFor(() => comments.length === 2), true);
  assert.notEqual(comments[0].metadata.dedupe_key, comments[1].metadata.dedupe_key);
});

test('agent home 이 여러 개여도 알림은 한 건으로 합치고 사유는 모두 담는다', async (t) => {
  const comments = [];
  const seenDirs = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer', '/managed/awb.reviewer', '/managed/awb.programmer'],
    async cleanupTerminalTicketGit(opts) {
      seenDirs.push(opts.baseWorkingDir);
      const suffix = opts.baseWorkingDir.endsWith('reviewer') ? 'review' : 'work';
      return heldReport(`ticket/${TICKET}-${suffix}`);
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => comments.length > 0), true, '알림이 나가야 한다');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(seenDirs, ['/managed/awb.programmer', '/managed/awb.reviewer'],
    '같은 working_dir 는 한 번만, 서로 다른 home 은 각각 정리한다');
  assert.equal(comments.length, 1, 'home 수와 무관하게 알림은 한 건이다');
  assert.match(comments[0].content, /ticket\/[0-9a-f-]+-work/);
  assert.match(comments[0].content, /ticket\/[0-9a-f-]+-review/);
});

test('정상 보류만 남으면 알림을 내지 않는다', async (t) => {
  const comments = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  const branch = `ticket/${TICKET}-work`;
  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer'],
    async cleanupTerminalTicketGit() {
      return {
        removedWorktrees: 1,
        removedLocalBranches: [],
        removedRemoteBranches: [branch],
        remainingBranches: [branch],
        heldReasons: [],
        benignHolds: [`로컬 ref 보류(정상): ${branch} — 작업트리가 체크아웃 중이고 원격 ref 는 이미 없음`],
        benignHeldBranches: [branch],
      };
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(comments.length, 0,
    '정상 보류만 남은 상태를 "정리 실패" 로 알리면 절차를 지킨 담당자에게 잘못된 신호가 된다');
});

test('실제 오류가 있으면 알리되 정상 보류는 잔여 목록이 아니라 별도 절로 적는다', async (t) => {
  const comments = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  const benignBranch = `ticket/${TICKET}-work`;
  const errorBranch = `ticket/${TICKET}-other`;
  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer'],
    async cleanupTerminalTicketGit() {
      return {
        removedWorktrees: 0,
        removedLocalBranches: [],
        removedRemoteBranches: [],
        remainingBranches: [benignBranch, errorBranch],
        heldReasons: [`로컬 브랜치 삭제 실패: ${errorBranch}`],
        benignHolds: [`로컬 ref 보류(정상): ${benignBranch} — 작업트리가 체크아웃 중이고 원격 ref 는 이미 없음`],
        benignHeldBranches: [benignBranch],
      };
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => comments.length === 1), true, '실제 오류는 알려야 한다');
  const content = comments[0].content;
  assert.match(content, /사유:\n- 로컬 브랜치 삭제 실패/);
  assert.match(content, /정상 보류\(조치 불필요\)/);
  const remainingLine = content.split('\n').find((line) => line.startsWith('잔여 브랜치: '));
  assert.equal(remainingLine, `잔여 브랜치: ${errorBranch}`,
    '정상 보류로 설명되는 ref 는 잔여 목록에서 빠져야 한다');
});

test('terminal_entered_at 이 바뀌면(재진입) 정리를 다시 실행한다', async (t) => {
  const comments = [];
  const cleanupCalls = [];
  const state = { terminalEnteredAt: ENTERED_AT };
  installFetchStub(t, { comments, state });
  const dispatcher = makeDispatcher({
    workingDirs: ['/managed/awb.programmer'],
    async cleanupTerminalTicketGit(opts) {
      cleanupCalls.push(opts);
      return heldReport(`ticket/${TICKET}-work`);
    },
  });

  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => cleanupCalls.length === 1), true);
  dispatcher.handleBoardUpdate(MOVED_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cleanupCalls.length, 1, '같은 terminal 진입은 한 번만');

  state.terminalEnteredAt = '2026-09-18T01:02:03.456Z';
  dispatcher.handleBoardUpdate(MOVED_EVENT);
  assert.equal(await waitFor(() => cleanupCalls.length === 2), true,
    'reopen 후 다시 terminal 로 들어오면 새 진입이므로 정리가 다시 돌아야 한다');
  assert.equal(await waitFor(() => comments.length === 2), true);
  assert.notEqual(comments[0].metadata.dedupe_key, comments[1].metadata.dedupe_key,
    'terminal 진입마다 dedupe_key 가 달라야 서로 다른 알림으로 남는다');
});

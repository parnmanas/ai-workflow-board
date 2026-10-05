import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import {
  ensureOperationalFallbackTicket,
  ensureOrdinaryWorkFallbackTicket,
  parseOrdinaryWorkFallback,
  operationalDedupeKey,
  parseOperationalFallback,
} from '../dist/lib/operational-chat-fallback.js';
import { fetchOrdinaryWorkCandidates, fetchOrdinaryWorkBoardCandidates } from '../dist/lib/rest.js';
import { composeChatRoomPrompt } from '../dist/lib/prompts.js';
import { ordinaryWorkCandidatesForChat } from '../dist/lib/event-dispatcher.js';

const config = { url: 'https://awb.invalid', apiKey: 'key', account_id: 'workspace-1' };
const marker = (operation = 'deploy awb') =>
  `진행 수단을 확인했습니다.\nAWB_OPERATIONAL_FALLBACK: ${JSON.stringify({ operation, missing_capability: 'awb deploy mcp', original_request: 'AWB 올려줘' })}`;

test('persistent chat derives native MCP routing from the selected adapter', () => {
  assert.equal(new CodexCliAdapter().has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
});

test('non-native missing MCP output creates one capability ticket through REST boundary', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  const calls = [];
  const result = await ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'ticket-1', title: '[운영 자동화] deploy awb', reused: false }), { status: 201 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.room_id, 'room-1');
  assert.equal(result.id, 'ticket-1');
});

test('same and rephrased requests share the server dedupe key when normalized operation matches', () => {
  const first = parseOperationalFallback(marker('Deploy   AWB'));
  const rephrased = parseOperationalFallback(marker('deploy awb'));
  assert.ok(first && rephrased);
  assert.equal(operationalDedupeKey('workspace-1', first), operationalDedupeKey('workspace-1', rephrased));
});

test('fallback failure is observable to the caller', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  await assert.rejects(
    ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async () =>
      new Response('database unavailable', { status: 503 })),
    /operational fallback ticket failed: 503 database unavailable/,
  );
});

test('manager posts a later Action execution result without creating another capability ticket', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const manager = new SubagentManager({ ...config, delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 } });
    const actionResult = 'Action 재검색 결과 action-7을 찾았고 run-9를 1회 실행했습니다.';
    await manager._handleOneshotExit({
      pid: 99102, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-action', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-real', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: actionResult } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    assert.equal(calls.filter(c => c.url.endsWith('/operational-capability-ticket')).length, 0);
    assert.equal(calls.filter(c => c.url.includes('/chat-rooms/')).length, 1);
    assert.equal(calls.find(c => c.url.includes('/chat-rooms/')).body.content, actionResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manager oneshot exit replaces the marker with the server ticket result at the real REST/chat boundary', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/agent/operational-capability-ticket')) {
      return new Response(JSON.stringify({ id: 'ticket-actual', title: 'capability 추가', reused: false }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const manager = new SubagentManager({
      ...config,
      delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 },
    });
    await manager._handleOneshotExit({
      pid: 99101, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-real', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-real', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: marker() } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    assert.equal(calls.filter(c => c.url.endsWith('/operational-capability-ticket')).length, 1);
    const ticketCall = calls.find(c => c.url.endsWith('/operational-capability-ticket'));
    assert.equal(ticketCall.body.message_id, 'msg-real');
    const chatCall = calls.find(c => c.url.includes('/chat-rooms/'));
    assert.ok(chatCall, 'manager posted the replaced chat answer');
    assert.match(chatCall.body.content, /새 capability 티켓을 자동 생성.*ticket-actual/);
    assert.doesNotMatch(chatCall.body.content, /AWB_OPERATIONAL_FALLBACK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-native one-shot ordinary code change creates one focused ticket linked to the source room', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/agent/ordinary-work-ticket')) {
      return new Response(JSON.stringify({ id: 'ticket-focused', title: '로그인 오류 수정', reused: false }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const output = `처리하겠습니다.\nAWB_ORDINARY_WORK_FALLBACK: ${JSON.stringify({
      title: '로그인 오류 수정', description: '재현 테스트를 추가하고 오류를 수정한다.',
      tags: ['bug', 'auth'], project_id: 'project-web', original_request: '로그인 오류를 고쳐줘',
    })}`;
    assert.ok(parseOrdinaryWorkFallback(output));
    const manager = new SubagentManager({ ...config, delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 } });
    await manager._handleOneshotExit({
      pid: 99103, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-code-change', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-source', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    const ticketCalls = calls.filter(c => c.url.endsWith('/api/agent/ordinary-work-ticket'));
    assert.equal(ticketCalls.length, 1, 'focused ticket creation is requested exactly once');
    // board-less contract (docs/tickets.md): tags + project_id, no board_id.
    assert.deepEqual(ticketCalls[0].body.tags, ['bug', 'auth']);
    assert.equal(ticketCalls[0].body.project_id, 'project-web');
    assert.equal('board_id' in ticketCalls[0].body, false);
    assert.equal(ticketCalls[0].body.account_id, 'workspace-1');
    assert.ok(ticketCalls[0].body.dedupe_key);
    assert.equal(ticketCalls[0].body.room_id, 'room-source');
    assert.equal(ticketCalls[0].body.message_id, 'msg-code-change');
    const chatCall = calls.find(c => c.url.includes('/chat-rooms/'));
    assert.match(chatCall.body.content, /작업 티켓을 자동 생성하고 워크플로에 연결.*ticket-focused/);
    assert.doesNotMatch(chatCall.body.content, /AWB_ORDINARY_WORK_FALLBACK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-native prompt receives real project + tag candidates before filing a ticket', async () => {
  const calls = [];
  const candidates = await fetchOrdinaryWorkCandidates(config, async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      projects: [{ id: 'project-web', name: '웹 클라이언트', repo_url: 'https://github.com/acme/web.git' }],
      tags: [{ tag: 'bug', count: 4 }, { tag: 'auth', count: 1 }],
    }), { status: 200 });
  });
  assert.deepEqual(calls, ['https://awb.invalid/api/agent/ordinary-work-candidates?account_id=workspace-1']);
  const prompt = composeChatRoomPrompt(
    'room-1', [], { content: '로그인 오류를 고쳐줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', candidates,
  );
  assert.match(prompt, /웹 클라이언트 \| project-web \| https:\/\/github.com\/acme\/web.git/);
  assert.match(prompt, /use only these UUIDs as project_id/);
  assert.match(prompt, /Existing tags: bug \(4\), auth \(1\)/);
  assert.match(prompt, /AWB_ORDINARY_WORK_FALLBACK: \{"title"/);
  assert.match(prompt, /"tags":\["<tag>"\],"project_id"/);
  assert.doesNotMatch(prompt, /board_id|existing board/);
});

test('empty project list still files a ticket (tags only) instead of a direct-chat exception', async () => {
  const candidates = await fetchOrdinaryWorkCandidates(config, async () =>
    new Response(JSON.stringify({ projects: [], tags: [] }), { status: 200 }));
  const prompt = composeChatRoomPrompt(
    'room-1', [], { content: '작업해줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', candidates,
  );
  assert.match(prompt, /\(none; leave project_id null\)/);
  assert.match(prompt, /Existing tags: \(none yet\)/);
  assert.match(prompt, /AWB_ORDINARY_WORK_FALLBACK/);
});

test('ordinary-work candidate HTTP failure stops routing instead of becoming a direct-chat exception', async () => {
  await assert.rejects(
    fetchOrdinaryWorkCandidates(config, async () =>
      new Response('일시적 서버 오류', { status: 500 })),
    /HTTP 500/,
  );
  await assert.rejects(
    fetchOrdinaryWorkCandidates(config, async () =>
      new Response(JSON.stringify([{ id: 'board-1' }]), { status: 200 })),
    /projects/,
    'a non board-less shape is a failure, not an empty candidate list',
  );
});

test('ordinary-work candidate timeout stops routing instead of producing a marker or direct execution', async () => {
  const timeout = new Error('요청 시간 초과');
  timeout.name = 'TimeoutError';
  await assert.rejects(
    fetchOrdinaryWorkCandidates(config, async () => { throw timeout; }),
    error => error === timeout,
  );
});

// 구버전(board 모델) 서버: 새 후보 엔드포인트가 404 면 기존 보드 후보로 폴백하고
// 프롬프트/마커도 종전 board_id 형태를 유지한다(호스트별 업그레이드 시차 호환).
test('pre-board-less server (404) falls back to legacy board candidates and board_id marker', async () => {
  const calls = [];
  const candidates = await fetchOrdinaryWorkCandidates(config, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/ordinary-work-candidates')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify([{ id: 'board-real', name: '제품 개발', description: '제품 코드 변경' }]), { status: 200 });
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/api\/agent\/ordinary-work-board-candidates\?account_id=workspace-1$/);
  assert.deepEqual(candidates.boards, [{ id: 'board-real', name: '제품 개발', description: '제품 코드 변경' }]);
  const prompt = composeChatRoomPrompt(
    'room-1', [], { content: '로그인 오류를 고쳐줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', candidates,
  );
  assert.match(prompt, /제품 개발 \| board-real \| 제품 코드 변경/);
  assert.match(prompt, /use only these UUIDs\):/);
  assert.match(prompt, /"board_id":"<existing board UUID>"/);

  // A legacy board array passed straight through renders the same legacy block.
  const boards = await fetchOrdinaryWorkBoardCandidates(config, async () =>
    new Response(JSON.stringify([]), { status: 200 }));
  const empty = composeChatRoomPrompt(
    'room-1', [], { content: '작업해줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', boards,
  );
  assert.match(empty, /none; treat this as the no-suitable-existing-board direct-chat exception/);
});

for (const dispatchPath of ['Hermes', 'non-native one-shot']) {
  test(`${dispatchPath} Action room skips the failing ordinary-work candidate API and keeps direct execution`, async () => {
    const originalFetch = globalThis.fetch;
    let candidateFetches = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/ordinary-work-')) {
        candidateFetches += 1;
        throw new Error('후보 API 장애');
      }
      return new Response('{}', { status: 200 });
    };
    try {
      // Hermes와 non-native one-shot은 모두 native MCP가 아니지만, Action room이면
      // capability-first 실행이므로 후보 조회 실패에 노출되지 않아야 한다.
      const candidates = await ordinaryWorkCandidatesForChat(config, false, true);
      assert.equal(candidates, null);
      assert.equal(candidateFetches, 0, 'Action room에서는 후보 API를 호출하지 않는다');

      const prompt = composeChatRoomPrompt(
        'action-room', [], { content: '배포를 실행해줘', sender_name: '사용자', sender_id: 'user-1' },
        undefined, false, undefined, '', true, '', candidates,
      );
      assert.match(prompt, /executing an Action Run/);
      assert.match(prompt, /carry it out DIRECTLY/);
      assert.doesNotMatch(prompt, /AWB_ORDINARY_WORK_FALLBACK/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('ordinary fallback marker parses the board-less shape and keeps a legacy board_id', () => {
  const parsed = parseOrdinaryWorkFallback(`AWB_ORDINARY_WORK_FALLBACK: ${JSON.stringify({
    title: '  로그인 오류 수정 ', description: '회귀 테스트 포함', tags: ['bug', ' bug ', '', 7, 'auth'],
    project_id: 'project-web', original_request: '고쳐줘',
  })}`);
  assert.deepEqual(parsed, {
    title: '로그인 오류 수정', description: '회귀 테스트 포함', original_request: '고쳐줘',
    tags: ['bug', 'auth'], project_id: 'project-web',
  });
  const noProject = parseOrdinaryWorkFallback('AWB_ORDINARY_WORK_FALLBACK: {"title":"x","project_id":null}');
  assert.equal(noProject.project_id, null);
  const legacy = parseOrdinaryWorkFallback('AWB_ORDINARY_WORK_FALLBACK: {"board_id":"board-real","title":"x"}');
  assert.equal(legacy.board_id, 'board-real');
  assert.equal(parseOrdinaryWorkFallback('AWB_ORDINARY_WORK_FALLBACK: {"tags":["a"]}'), null, 'title is required');
});

test('ordinary fallback sends the selected tags + project exactly once (no board_id)', async () => {
  const calls = [];
  const request = { title: '로그인 오류 수정', description: '회귀 테스트 포함', tags: ['bug'], project_id: 'project-web' };
  await ensureOrdinaryWorkFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'ticket-1', title: request.title, reused: false }), { status: 201 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://awb.invalid/api/agent/ordinary-work-ticket');
  assert.deepEqual(calls[0].body.tags, ['bug']);
  assert.equal(calls[0].body.project_id, 'project-web');
  assert.equal('board_id' in calls[0].body, false);
  assert.equal(calls[0].body.room_id, 'room-1');
  assert.equal(calls[0].body.message_id, 'msg-1');
});

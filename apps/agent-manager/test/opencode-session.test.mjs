// opencode 를 Agent Session(CLI 직접 세션) 표면에 붙이는 경로.
//
// opencode 는 ACP 서버를 자기 안에 갖고 있고(`opencode acp`), 세션은 파일이 아니라
// SQLite 에 넣는다. 그 둘이 이 통합의 전부라 여기서 그 둘만 본다:
//   1) ACP 명령 해석 — 어댑터 사이드카가 아니라 `opencode acp` 여야 한다
//   2) 세션 목록 — opencode 자신의 db 도구가 준 JSON 을 SessionSummary 로 매핑

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME ??= mkdtempSync(join(tmpdir(), 'awb-opencode-test-'));

const { resolveAcpCommandForCli, detectAcpSessionClis } = await import(
  '../dist/lib/agent-session-runner.js'
);
const { AgentSessionStore } = await import('../dist/lib/agent-session-store.js');

test('opencode 의 ACP 명령은 사이드카가 아니라 `opencode acp` 다', async () => {
  const resolved = await resolveAcpCommandForCli('opencode');
  assert.deepEqual(resolved.args, ['acp'], 'ACP 서버는 opencode 자신이 띄운다');
  assert.match(resolved.command, /opencode/);
  // claude/codex 와 달리 npx 로 별도 패키지를 끌어오면 안 된다 — 어댑터와 코어의
  // 세대가 어긋나는 문제(codex-acp 전례)를 애초에 만들지 않는 것이 이 선택의 이유다.
  assert.notEqual(resolved.command, 'npx');
});

test('AWB_ACP_COMMAND_OPENCODE 로 덮어쓸 수 있다 (다른 CLI 와 같은 계약)', async () => {
  const prev = process.env.AWB_ACP_COMMAND_OPENCODE;
  process.env.AWB_ACP_COMMAND_OPENCODE = '/opt/my-opencode acp --flag';
  try {
    const resolved = await resolveAcpCommandForCli('opencode');
    assert.equal(resolved.command, '/opt/my-opencode');
    assert.deepEqual(resolved.args, ['acp', '--flag']);
  } finally {
    if (prev === undefined) delete process.env.AWB_ACP_COMMAND_OPENCODE;
    else process.env.AWB_ACP_COMMAND_OPENCODE = prev;
  }
});

test('opencode 가 PATH 에 있으면 세션 가능 CLI 로 보고된다', async () => {
  const clis = await detectAcpSessionClis({ AWB_ACP_COMMAND_OPENCODE: 'opencode acp' });
  assert.ok(clis.includes('opencode'), `보고 목록: ${clis.join(', ')}`);
});

/** opencode db 가 돌려주는 모양의 행. 시각은 epoch ms 정수다. */
const row = (over = {}) => ({
  id: 'ses_abc123',
  directory: '/home/parn/repo',
  title: 'Greeting exchange',
  time_created: 1758500000000,
  time_updated: 1758500600000,
  ...over,
});

function storeWith(response) {
  return new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-${Math.random().toString(16).slice(2)}.json`),
    opencodeQuery: async (sql) => {
      if (typeof response === 'function') return response(sql);
      return response;
    },
  });
}

test('opencode 세션 목록을 SessionSummary 로 매핑한다', async () => {
  let seenSql = '';
  const store = storeWith((sql) => {
    seenSql = sql;
    return JSON.stringify([row(), row({ id: 'ses_def456', title: '', directory: '/tmp/x' })]);
  });

  const rows = await store.listSessions('opencode');

  // 보관됐거나 하위(parent_id) 세션은 애초에 질의에서 뺀다 — 목록에 섞이면
  // 사용자가 열 수 없는 항목을 보게 된다.
  assert.match(seenSql, /time_archived IS NULL/);
  assert.match(seenSql, /parent_id IS NULL/);
  assert.match(seenSql, /ORDER BY time_updated DESC/);

  assert.equal(rows.length, 2);
  const first = rows.find((r) => r.session_id === 'ses_abc123');
  assert.equal(first.cli, 'opencode');
  assert.equal(first.cwd, '/home/parn/repo');
  assert.equal(first.title, 'Greeting exchange');
  assert.equal(first.source, 'cli');
  assert.equal(first.created_at, new Date(1758500000000).toISOString());
  assert.equal(first.updated_at, new Date(1758500600000).toISOString());
  // 제목이 비면 목록에서 빈 칸이 되지 않도록 대체 문구를 넣는다.
  assert.equal(rows.find((r) => r.session_id === 'ses_def456').title, '(제목 없음)');
});

test('opencode 가 없거나 질의가 실패해도 목록 조회 전체가 죽지 않는다', async () => {
  const exploding = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, 'idx-fail.json'),
    opencodeQuery: async () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(await exploding.listSessions('opencode'), []);

  // 스키마가 바뀌어 JSON 이 아닌 무언가가 와도 마찬가지다.
  const garbage = storeWith('not json at all');
  assert.deepEqual(await garbage.listSessions('opencode'), []);
});

test('id 나 directory 가 없는 행은 버리고 나머지는 살린다', async () => {
  const store = storeWith(
    JSON.stringify([row(), { id: '', directory: '/x' }, { id: 'ses_z', directory: '' }, row({ id: 'ses_ok' })]),
  );
  const rows = await store.listSessions('opencode');
  assert.deepEqual(rows.map((r) => r.session_id).sort(), ['ses_abc123', 'ses_ok']);
});

// 모델 열거 — 에이전트 생성 화면의 모델 드롭다운이 읽는 값.
//
// opencode 는 `listModels()` 가 없어 항상 빈 목록이었고, 그래서 그 CLI 를 고르면
// 드롭다운이 비어 자유 입력으로 떨어졌다. 여기서 보는 것은 (1) 이제 열거한다는 것과
// (2) 그 id 형식이 ACP config option 값과 같아서 두 화면이 같은 값을 쓴다는 것이다.
// opencode 가 설치돼 있지 않은 환경에서도 계약(빈 배열, throw 없음)은 지켜져야 한다.

const { createAdapter } = await import('../dist/lib/cli-adapters/index.js');

test('opencode 어댑터가 모델을 열거한다 (미설치 환경에서는 빈 배열, throw 없음)', async () => {
  const models = await createAdapter('opencode').listModels();
  assert.ok(Array.isArray(models), 'listModels 는 언제나 배열이다');
  for (const id of models) {
    // ACP `session/new` 의 model option 값과 같은 형식이어야 두 화면이 같은 값을 쓴다.
    assert.match(id, /^[^\s]+\/[^\s]+$/, `provider/model 형식이어야 한다: ${id}`);
  }
  if (models.length) {
    assert.equal(new Set(models).size, models.length, '중복이 없어야 한다');
  }
});

// ─── 기록(readHistory) ────────────────────────────────────────────────────
//
// opencode 는 기록도 파일이 아니라 DB 에 있다: `message`(역할) + `part`(내용).
// 예전엔 claude/codex 파일 경로만 있어서, 목록에는 뜨는 세션을 열면 트랜스크립트가
// 통째로 비어 있었다.

/** `opencode db` 응답을 SQL 로 갈라 주는 스텁. */
function historyStore({ session, count, rows }) {
  return new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-${Math.random().toString(16).slice(2)}.json`),
    opencodeQuery: async (sql) => {
      if (/FROM session/.test(sql)) return JSON.stringify(session ?? []);
      if (/count\(\*\)/.test(sql)) return JSON.stringify([{ n: count ?? 0 }]);
      return JSON.stringify(rows ?? []);
    },
  });
}

const partRow = (messageId, role, data, over = {}) => ({
  part_id: `prt_${Math.random().toString(16).slice(2)}`,
  message_id: messageId,
  part_time: 1758500000000,
  part_data: JSON.stringify(data),
  message_data: JSON.stringify({ role }),
  ...over,
});

test('opencode 기록을 트랜스크립트 이벤트로 매핑한다 (user_prompt / text / reasoning / tool)', async () => {
  const store = historyStore({
    session: [{ id: 'ses_abc123', directory: '/home/parn/repo', title: 'Greeting exchange', time_created: 1758500000000, time_updated: 1758500600000 }],
    count: 6,
    rows: [
      partRow('msg_1', 'user', { type: 'text', text: 'run the suite' }),
      partRow('msg_2', 'assistant', { type: 'step-start' }),
      partRow('msg_2', 'assistant', { type: 'reasoning', text: 'thinking about it' }),
      partRow('msg_2', 'assistant', {
        type: 'tool',
        tool: 'bash',
        callID: 'call_9',
        state: { status: 'completed', input: { command: 'npm test' }, output: '42 passing' },
      }),
      partRow('msg_2', 'assistant', { type: 'text', text: 'All green.' }),
      partRow('msg_2', 'assistant', { type: 'step-finish' }),
    ],
  });

  const history = await store.readHistory('opencode', 'ses_abc123');

  assert.equal(history.session.cli, 'opencode');
  assert.equal(history.session.cwd, '/home/parn/repo');
  assert.equal(history.session.title, 'Greeting exchange');
  assert.equal(history.truncated, false);

  assert.deepEqual(history.events.map((e) => e.type), [
    'user_prompt', 'reasoning', 'tool_call', 'tool_update', 'text',
  ], 'step-start / step-finish 는 그릴 것이 없으므로 버린다');
  assert.equal(history.events[0].payload.text, 'run the suite');
  assert.equal(history.events[0].turn_id, 'msg_1');
  // 같은 assistant 메시지의 행들은 한 턴으로 묶인다 — UI 가 turn_id 로 병합한다.
  assert.deepEqual([...new Set(history.events.slice(1).map((e) => e.turn_id))], ['msg_2']);
  assert.equal(history.events[2].payload.tool_call_id, 'call_9');
  assert.equal(history.events[2].payload.title, 'bash');
  assert.deepEqual(history.events[2].payload.input, { command: 'npm test' });
  assert.equal(history.events[3].payload.status, 'completed');
  assert.equal(history.events[3].payload.output, '42 passing');
  assert.equal(history.events[4].payload.text, 'All green.');
  // id/seq 는 part 의 절대 위치 기준 — 다시 읽어도 같은 이벤트가 같은 id 를 갖는다.
  assert.deepEqual(history.events.map((e) => e.id), ['ses_abc123:1', 'ses_abc123:2', 'ses_abc123:3', 'ses_abc123:4', 'ses_abc123:5']);
});

test('opencode 기록: 창을 넘긴 세션은 앞부분 생략 안내를 달고 seq 는 절대 위치를 유지한다', async () => {
  const store = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-${Math.random().toString(16).slice(2)}.json`),
    historyEventLimit: 2,
    opencodeQuery: async (sql) => {
      if (/FROM session/.test(sql)) return JSON.stringify([{ id: 'ses_long', directory: '/x', title: 'Long', time_created: 1, time_updated: 2 }]);
      if (/count\(\*\)/.test(sql)) return JSON.stringify([{ n: 10 }]);
      // 상한과 offset 이 질의에 실려야 한다 — 전부 읽어 와서 자르는 것이 아니다.
      assert.match(sql, /LIMIT 2 OFFSET 8/);
      return JSON.stringify([
        partRow('msg_9', 'assistant', { type: 'text', text: 'second to last' }),
        partRow('msg_9', 'assistant', { type: 'text', text: 'last' }),
      ]);
    },
  });

  const history = await store.readHistory('opencode', 'ses_long');
  assert.equal(history.truncated, true);
  assert.equal(history.events[0].type, 'system');
  assert.match(history.events[0].payload.text, /Earlier history omitted \(8 events\)/);
  assert.deepEqual(history.events.slice(1).map((e) => e.seq), [9, 10]);
});

test('opencode 기록: 질의가 실패해도 빈 기록으로 접는다 (세션 화면은 열려야 한다)', async () => {
  const exploding = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-${Math.random().toString(16).slice(2)}.json`),
    opencodeQuery: async () => { throw new Error('spawn opencode ENOENT'); },
  });
  const history = await exploding.readHistory('opencode', 'ses_abc123');
  assert.equal(history.session, null);
  assert.deepEqual(history.events, []);
});

test('opencode 기록: 세션 id 형식이 아니면 SQL 을 아예 던지지 않는다', async () => {
  let called = false;
  const store = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-${Math.random().toString(16).slice(2)}.json`),
    opencodeQuery: async () => { called = true; return '[]'; },
  });
  const history = await store.readHistory('opencode', "ses_abc' OR 1=1 --");
  assert.equal(called, false, 'id 는 SQL 에 문자열로 박히므로 형식 검사가 1차 방어선이다');
  assert.deepEqual(history.events, []);
});

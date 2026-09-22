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

// opencode 를 Agent Session(CLI 직접 세션) 표면에 붙이는 경로.
//
// opencode 는 ACP 서버를 자기 안에 갖고 있고(`opencode acp`), 세션은 파일이 아니라
// SQLite 에 넣는다. 그 둘이 이 통합의 전부라 여기서 그 둘만 본다:
//   1) ACP 명령 해석 — 어댑터 사이드카가 아니라 `opencode acp` 여야 한다
//   2) 세션 목록 — opencode 자신의 db 도구가 준 JSON 을 SessionSummary 로 매핑

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

test('opencode 기록: file 파트의 이미지는 image 이벤트가 된다 (data URL·파일 경로)', async (t) => {
  // 붙여넣은 그림은 data URL 로, `@` 로 참조한 그림은 파일 경로로 박힌다(1.18.34 실측).
  // 둘 다 보관 후 참조만 싣는다 — claude 스캐너의 pushImage 와 같은 통로다.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dir = await mkdtemp(join(tmpdir(), 'awb-opencode-filepart-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })));
  const shotPath = join(dir, 'shot.png');
  await writeFile(shotPath, Buffer.from(PNG_B64, 'base64'));
  await writeFile(join(dir, 'fake.png'), 'just text, not an image');
  const store = historyStore({
    session: [{ id: 'ses_abc123', directory: dir, title: 'pics', time_created: 1758500000000, time_updated: 1758500600000 }],
    count: 5,
    rows: [
      partRow('msg_1', 'user', { type: 'text', text: 'see these' }),
      partRow('msg_1', 'user', { type: 'file', mime: 'image/png', filename: 'pasted', url: `data:image/png;base64,${PNG_B64}` }),
      partRow('msg_1', 'user', { type: 'file', mime: 'image/png', filename: 'shot', url: `file://${shotPath}` }),
      partRow('msg_1', 'user', { type: 'file', mime: 'image/svg+xml', filename: 'v', url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }),
      partRow('msg_1', 'user', { type: 'file', mime: 'image/png', filename: 'fake', url: `file://${join(dir, 'fake.png')}` }),
    ],
  });
  const stored = [];
  store.setImageSink(async (cli, sessionId, base64) => {
    stored.push({ cli, sessionId, base64 });
    return { ref: `ref-${stored.length}`, size: base64.length };
  });
  const history = await store.readHistory('opencode', 'ses_abc123');
  // user_prompt + data URL 그림 + 파일 그림. SVG·가짜 PNG 는 조용히 빠진다.
  assert.deepEqual(history.events.map((e) => e.type), ['user_prompt', 'image', 'image']);
  assert.deepEqual(stored.map((s) => [s.cli, s.sessionId]), [['opencode', 'ses_abc123'], ['opencode', 'ses_abc123']]);
  assert.equal(stored[0].base64, PNG_B64, 'data URL 은 쉼표 뒤 base64 그대로 보관한다');
  assert.equal(history.events[1].payload.mime_type, 'image/png');
  assert.equal(history.events[1].payload.image_ref, 'ref-1');
  assert.equal(history.events[2].payload.image_ref, 'ref-2');
});

test('opencode 기록: 보관 통로가 없으면 file 파트는 건너뛴다', async () => {
  const store = historyStore({
    session: [{ id: 'ses_abc123', directory: '/x', title: 't', time_created: 1, time_updated: 2 }],
    count: 1,
    rows: [partRow('msg_1', 'user', { type: 'file', mime: 'image/png', filename: 'p', url: 'data:image/png;base64,AAAA' })],
  });
  const history = await store.readHistory('opencode', 'ses_abc123');
  assert.deepEqual(history.events, []);
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

// ─── 파이프 잘림 회귀: `opencode db` 출력이 파이프 버퍼를 넘기면 잘린다 ───────
//
// opencode 1.18.32 실측: `db` 결과가 파이프 버퍼(64KB)를 넘기면 stdout 플러시를
// 기다리지 않고 종료해 잘린 JSON 을 내놓고도 exit 0 으로 끝난다(파이프 5회 중 4회
// 잘림, 파일 리다이렉트는 항상 온전). 잘린 JSON 은 파싱이 깨져 `[]` 로 접히므로,
// 일 좀 시킨 세션(기록 수십 KB 이상)의 history 가 통째로 비어 보였다. 그래서 질의는
// temp 파일로 받는다(`runToFile`). 아래 가짜 `opencode` 는 그 동작을 그대로 흉내낸다
// (`process.stdout.write` 뒤 즉시 `process.exit(0)` — 파이프로는 잘리고 파일로는 온전).

test('opencode db: 큰 출력은 temp 파일로 받아야 온전하다 (파이프 잘림 회귀)', { skip: process.platform === 'win32' ? 'POSIX fake binary' : false }, async (t) => {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'awb-fake-opencode-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })));

  // 64KB를 훌쩍 넘는 유효 JSON 페이로드 세 가지(목록/개수/기록).
  const sessions = Array.from({ length: 400 }, (_, i) => row({ id: `ses_big${i}`, title: `Session ${i} ` + 't'.repeat(100) }));
  const parts = Array.from({ length: 100 }, (_, i) => partRow(
    i % 2 ? 'msg_even' : 'msg_odd',
    i % 2 ? 'assistant' : 'user',
    i % 2 ? { type: 'text', text: `answer ${i} ` + 'y'.repeat(2000) } : { type: 'text', text: `prompt ${i}` },
  ));
  await writeFile(join(dir, 'sessions.json'), JSON.stringify(sessions));
  await writeFile(join(dir, 'count.json'), JSON.stringify([{ n: parts.length }]));
  await writeFile(join(dir, 'parts.json'), JSON.stringify(parts));
  const stub = '#!/usr/bin/env node\n'
    + "const fs = require('fs');\n"
    + `const d = ${JSON.stringify(dir)};\n`
    + 'const sql = process.argv[3] || ""; // [node, script, "db", <sql>, ...]\n'
    + 'const file = /count\\(\\*\\)/.test(sql) ? "count.json" : /FROM session/.test(sql) ? "sessions.json" : "parts.json";\n'
    + 'const full = fs.readFileSync(require("path").join(d, file), "utf8");\n'
    // opencode 실측 그대로: stdout 이 파일이면 온전, 파이프면 64KB에서 잘라먹고 exit 0.
    // (`write` + 즉시 `exit` 의 플러시 레이스는 비결정적이라, 스텁은 파이프를 감지해
    // 결정적으로 64KB까지만 쓴다 — 받는 쪽이 보는 모양은 같다: 잘린 JSON + exit 0.)
    + 'const isFile = (() => { try { return fs.fstatSync(1).isFile(); } catch { return false; } })();\n'
    + 'process.stdout.write(isFile ? full : full.slice(0, 65536));\n'
    + 'process.exit(0);\n';
  await writeFile(join(dir, 'opencode'), stub, { mode: 0o755 });
  await chmod(join(dir, 'opencode'), 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${prevPath ? (await import('node:path')).delimiter + prevPath : ''}`;
  t.after(() => { process.env.PATH = prevPath; });

  // 전제 확인: 같은 스텁을 파이프로 받으면 잘린다(opencode 실측과 같은 메커니즘).
  const piped = await execFileAsync('opencode', ['db', 'SELECT 1', '--format', 'json'], { maxBuffer: 32 * 1024 * 1024 })
    .then(({ stdout }) => stdout, (err) => { throw new Error('stub must exit 0, like opencode: ' + err.message); });
  assert.throws(() => JSON.parse(piped), '파이프 캡처는 잘린 JSON 이어야 이 테스트가 버그를 재현한다');

  // 주입 없는 운영 경로(default runToFile)로는 목록·기록이 모두 온전해야 한다.
  const store = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-pipe-${Math.random().toString(16).slice(2)}.json`),
    listLimit: 500,
  });
  const list = await store.listSessions('opencode');
  assert.equal(list.length, 400, '목록 400건이 잘림 없이 와야 한다');

  const history = await store.readHistory('opencode', 'ses_big0');
  assert.ok(history.events.length > 0, '기록이 비어 있으면 안 된다');
  assert.equal(history.truncated, false);
  assert.ok(history.events.some((e) => e.type === 'user_prompt' && e.payload.text === 'prompt 0'));
  assert.ok(history.events.some((e) => e.type === 'text' && String(e.payload.text).startsWith('answer 1')));
});

test('opencode 질의는 runToFile 을 우선하고, 없으면 exec 로 떨어진다', async () => {
  const good = JSON.stringify([row()]);
  // runToFile 가짜가 있으면 exec 가짜(실패)는 타지 않아야 한다.
  const preferred = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-pref-${Math.random().toString(16).slice(2)}.json`),
    exec: async () => { throw new Error('exec must not be used when runToFile is present'); },
    runToFile: async () => good,
  });
  assert.equal((await preferred.listSessions('opencode')).length, 1);

  // runToFile 주입이 없으면 exec 가짜를 그대로 쓴다(기존 테스트 경로).
  const fallback = new AgentSessionStore({
    indexPath: join(process.env.AWB_AGENT_MANAGER_HOME, `idx-fb-${Math.random().toString(16).slice(2)}.json`),
    exec: async () => good,
  });
  assert.equal((await fallback.listSessions('opencode')).length, 1);
});

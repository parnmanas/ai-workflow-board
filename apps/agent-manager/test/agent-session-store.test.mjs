// Agent Session(CLI 직접 세션) 저장소 리더 — 합성 Claude Code / Codex 세션 파일로
// 목록·기록 파싱을 고정한다(docs/agent-sessions.md). 실제 홈은 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionStore, boundHistoryPayload, claudeToolKind, fitHistoryBytes } from '../dist/lib/agent-session-store.js';

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CODEX_ID = '019d5d74-427c-7d13-b1c4-a54e0081374a';

async function seedHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'awb-session-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  const projectDir = join(claudeHome, 'projects', '-tmp-work-repo');
  await mkdir(projectDir, { recursive: true });
  const ts = (s) => `2026-09-17T00:00:${String(s).padStart(2, '0')}.000Z`;
  await writeFile(join(projectDir, `${CLAUDE_ID}.jsonl`), jsonl([
    { type: 'queue-operation', operation: 'enqueue', sessionId: CLAUDE_ID, timestamp: ts(0) },
    { type: 'user', uuid: 'u1', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(1), message: { role: 'user', content: 'Fix the failing login test' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'look at the throttle' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the service first.' }] } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'auth.service.ts' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a3', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export class AuthService {}' }] } },
    { type: 'user', uuid: 'side', isSidechain: true, sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(6), message: { role: 'user', content: 'subagent internal prompt' } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u2', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(7), message: { role: 'assistant', content: [{ type: 'text', text: 'The bucket is keyed by email.' }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a4', sessionId: CLAUDE_ID, cwd: '/tmp/work/repo', timestamp: ts(8), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'custom-title', sessionId: CLAUDE_ID, customTitle: 'Login throttle fix' },
  ]));
  // 서브에이전트 파일과 프롬프트 없는 빈 세션은 목록에서 빠진다
  await writeFile(join(projectDir, 'agent-abc.jsonl'), jsonl([{ type: 'user', isSidechain: true, sessionId: 'agent-abc', cwd: '/tmp/work/repo', message: { role: 'user', content: 'x' } }]));
  await writeFile(join(projectDir, 'aaaaaaaa-0000-4000-8000-000000000000.jsonl'), jsonl([{ type: 'queue-operation', operation: 'enqueue', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' }]));
  // 더 오래된 두 번째 세션(정렬 검증)
  const older = 'bbbbbbbb-0000-4000-8000-000000000000';
  const olderPath = join(projectDir, `${older}.jsonl`);
  await writeFile(olderPath, jsonl([
    { type: 'user', uuid: 'o1', sessionId: older, cwd: '/tmp/work/repo', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'older session prompt' } },
  ]));
  await utimes(olderPath, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));

  const codexDir = join(codexHome, 'sessions', '2026', '09', '17');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, `rollout-2026-09-17T10-00-00-${CODEX_ID}.jsonl`), jsonl([
    { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_ID, timestamp: ts(0), cwd: '/tmp/work/codex', originator: 'codex_cli_rs' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system-ish' }] } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }] } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the diff and list risks' }] } },
    { timestamp: ts(3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need the diff first' }], content: null } },
    { timestamp: ts(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":["git","diff","--stat"]}' } },
    { timestamp: ts(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '3 files changed' } },
    { timestamp: ts(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two risks stand out.' }] } },
    { timestamp: ts(7), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Two risks stand out.' } },
  ]));
  return { root, claudeHome, codexHome, indexPath: join(root, 'index.json') };
}

test('claude: lists sessions newest-first with custom titles, skipping subagent files, empty sessions and sidechains', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const list = await store.listSessions('claude');
  assert.deepEqual(list.map((s) => s.session_id), [CLAUDE_ID, 'bbbbbbbb-0000-4000-8000-000000000000']);
  assert.equal(list[0].title, 'Login throttle fix', 'custom-title wins over the first prompt');
  assert.equal(list[0].cwd, '/tmp/work/repo');
  assert.equal(list[0].source, 'cli');
  assert.equal(list[0].created_at, '2026-09-17T00:00:00.000Z');
  assert.equal(list[1].title, 'older session prompt');
  assert.equal(await store.findSessionFile('claude', CLAUDE_ID), join(home.claudeHome, 'projects', '-tmp-work-repo', `${CLAUDE_ID}.jsonl`));
  assert.equal(await store.findSessionFile('claude', 'nope'), null);
});

test('claude: history folds records into transcript events (prompt, reasoning, text, tool call/result), skipping sidechain + command markup', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const history = await store.readHistory('claude', CLAUDE_ID);
  assert.equal(history.session.title, 'Login throttle fix');
  assert.equal(history.session.cwd, '/tmp/work/repo');
  assert.deepEqual(history.events.map((e) => e.type), ['user_prompt', 'reasoning', 'text', 'tool_call', 'tool_update', 'text']);
  assert.deepEqual(history.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.ok(history.events.every((e) => e.turn_id === 'u1'), 'all events belong to the first prompt turn');
  assert.equal(history.events[3].payload.tool_call_id, 'toolu_1');
  assert.equal(history.events[3].payload.kind, 'read');
  assert.equal(history.events[4].payload.status, 'completed');
  assert.equal(history.events[4].payload.output, 'export class AuthService {}');
  assert.equal(history.events[0].payload.text, 'Fix the failing login test');
  assert.equal(history.truncated, false);
  assert.equal(claudeToolKind('Bash'), 'execute');
  assert.equal(claudeToolKind('Edit'), 'edit');
});

test('codex: lists rollouts with the first real user prompt and parses function calls / outputs / reasoning', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  const list = await store.listSessions('codex');
  assert.equal(list.length, 1);
  assert.equal(list[0].session_id, CODEX_ID);
  assert.equal(list[0].cwd, '/tmp/work/codex');
  assert.equal(list[0].title, 'Review the diff and list risks', 'environment_context / developer messages are not titles');
  const history = await store.readHistory('codex', CODEX_ID);
  assert.deepEqual(history.events.map((e) => e.type), ['user_prompt', 'reasoning', 'tool_call', 'tool_update', 'text', 'turn']);
  assert.equal(history.events[2].payload.kind, 'execute');
  assert.deepEqual(history.events[2].payload.input, { command: ['git', 'diff', '--stat'] });
  assert.equal(history.events[3].payload.output, '3 files changed');
  assert.equal(history.events[5].payload.stop_reason, 'end_turn');
  assert.equal(history.events[0].turn_id, 'turn-1');
});

test('awb index: hermes sessions only exist in the index; an indexed claude session keeps its AWB title and source', async (t) => {
  const home = await seedHome(t);
  const store = new AgentSessionStore(home);
  await store.recordAwbSession({ cli: 'hermes', session_id: 'hermes-1', cwd: '/tmp/work/hermes', title: 'Plan the migration' });
  const hermes = await store.listSessions('hermes');
  assert.equal(hermes.length, 1);
  assert.equal(hermes[0].source, 'awb');
  assert.equal(hermes[0].title, 'Plan the migration');
  const hermesHistory = await store.readHistory('hermes', 'hermes-1');
  assert.equal(hermesHistory.session.cwd, '/tmp/work/hermes');
  assert.deepEqual(hermesHistory.events, []);

  await store.recordAwbSession({ cli: 'claude', session_id: CLAUDE_ID, cwd: '/tmp/work/repo', title: 'AWB-given title' });
  const claude = await store.listSessions('claude');
  assert.equal(claude[0].session_id, CLAUDE_ID);
  assert.equal(claude[0].source, 'awb');
  assert.equal(claude[0].title, 'AWB-given title');
  await store.touchAwbSession('claude', CLAUDE_ID, { title: 'Renamed' });
  assert.equal((await store.readHistory('claude', CLAUDE_ID)).session.title, 'Renamed');
  assert.equal((await store.listSessions('claude')).find((s) => s.session_id === CLAUDE_ID).source, 'awb');
  assert.equal((await store.readHistory('claude', 'missing')).session, null);
});

// 긴 세션이 화면에서 "로딩하다 에러" 로 끝나던 사고 (실측: ralf 의 codex 세션 기록 응답이 21.16MiB →
// 서버 JSON 본문 상한 10MB 초과 → 413 → RPC 가 풀리지 않고 40s 뒤 타임아웃).
// 원인은 codex 의 tool 출력이 **문자열이 아니라 content block 배열**로 와서 자르는 갈래를 비껴간 것.
// 자르기는 CLI 별 파서가 아니라 readHistory 한 곳에서 하고, 바이트 상한을 마지막 방어선으로 둔다.
test('history: a codex tool output shaped as an array is bounded like a string one, so one event cannot blow the response', async (t) => {
  const home = await seedHome(t);
  const bigBlocks = Array.from({ length: 400 }, (_, i) => ({ type: 'input_text', text: `line ${i} ` + 'y'.repeat(4000) }));
  const codexDir = join(home.codexHome, 'sessions', '2026', '09', '18');
  const id = '019d5d74-427c-7d13-b1c4-a54e0081374b';
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, `rollout-2026-09-18T10-00-00-${id}.jsonl`), jsonl([
    { timestamp: '2026-09-18T00:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-09-18T00:00:00.000Z', cwd: '/tmp/work/codex' } },
    { timestamp: '2026-09-18T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read everything' }] } },
    { timestamp: '2026-09-18T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_big', input: 'text(await tools.exec_command({cmd:"cat huge"}))', status: 'completed' } },
    { timestamp: '2026-09-18T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_big', output: bigBlocks } },
    { timestamp: '2026-09-18T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ]));
  const store = new AgentSessionStore(home);
  const history = await store.readHistory('codex', id);
  const update = history.events.find((e) => e.type === 'tool_update');
  assert.ok(update, 'the tool result is still relayed');
  const bytes = Buffer.byteLength(JSON.stringify(update));
  assert.ok(bytes < 64_000, `the array-shaped output is bounded, not passed through raw: ${bytes} bytes`);
  const whole = Buffer.byteLength(JSON.stringify(history.events));
  assert.ok(whole < 200_000, `the whole response stays small: ${whole} bytes`);
  assert.ok(history.events.some((e) => e.type === 'text' && e.payload.text === 'done'), 'later events survive');
});

test('boundHistoryPayload folds long strings and wide arrays, and falls back to a preview when the shape is still too big', () => {
  const bounded = boundHistoryPayload({ output: 'z'.repeat(50_000), keep: 'short' });
  assert.equal(bounded.keep, 'short');
  assert.ok(String(bounded.output).length < 20_000, 'long strings are truncated');
  assert.match(String(bounded.output), /truncated/);

  const wide = boundHistoryPayload({ blocks: Array.from({ length: 5_000 }, (_, i) => ({ text: `row ${i}` })) });
  assert.ok(Array.isArray(wide.blocks) && wide.blocks.length <= 100, 'wide arrays are capped');

  // 접어도 큰 경우 — 미리보기로 대체하되 내용을 완전히 잃지는 않는다
  const huge = boundHistoryPayload({ blocks: Array.from({ length: 100 }, () => ({ text: 'q'.repeat(2_000) })) });
  assert.equal(huge.truncated, true);
  assert.ok(String(huge.preview).length <= 4_000);
});

test('fitHistoryBytes keeps the newest events within the byte budget and never returns nothing', () => {
  const ev = (i, size) => ({ id: `e${i}`, seq: i, type: 'text', payload: { text: 'x'.repeat(size) } });
  const events = [ev(1, 1000), ev(2, 1000), ev(3, 1000), ev(4, 1000)];
  const kept = fitHistoryBytes(events, 2600);
  assert.ok(kept.length < events.length, 'oldest events are dropped');
  assert.equal(kept.at(-1).id, 'e4', 'the newest event is always kept');
  assert.deepEqual(kept.map((e) => e.id), events.slice(events.length - kept.length).map((e) => e.id), 'the kept window is contiguous and at the end');

  assert.deepEqual(fitHistoryBytes(events, 10_000).map((e) => e.id), ['e1', 'e2', 'e3', 'e4'], 'a generous budget keeps everything');
  const single = fitHistoryBytes([ev(1, 50_000)], 1_000);
  assert.equal(single.length, 1, 'one oversized event still comes through rather than an empty transcript');
});

// ─── 큰 세션: 최근 창만 들고 온다 (BoundedHistory) ─────────────────────────────
//
// 기록 파일은 수백 MB 까지 자란다(실측: codex rollout 353MB). 전부 배열에 쌓은 뒤 잘라내면
// 파일 크기에 비례해 메모리를 먹었다(최대 RSS 586MB). 파싱하면서 창 밖으로 나간 건 즉시 버리고,
// payload 크기도 담는 시점에 자른다. seq/id 는 절대 위치를 유지해야 앞부분이 그대로인 한
// 같은 이벤트가 같은 id 를 갖는다(화면이 라이브 행과 중복을 거르는 근거).
test('BoundedHistory keeps the newest N, counts what it dropped, and reports the absolute offset', async () => {
  const { BoundedHistory } = await import('../dist/lib/agent-session-store.js');
  const window = new BoundedHistory(3);
  assert.deepEqual(window.items(), []);
  assert.equal(window.total, 0);
  for (let i = 1; i <= 10; i += 1) window.push(i);
  assert.deepEqual(window.items(), [8, 9, 10], 'the newest survive');
  assert.equal(window.total, 10, 'everything pushed is counted');
  assert.equal(window.offset, 7, 'the first kept item sat at absolute index 7 (0-based)');

  const unbounded = new BoundedHistory(0);
  unbounded.push('a');
  assert.deepEqual(unbounded.items(), [], 'a zero window keeps nothing');
  assert.equal(unbounded.total, 1, 'but still counts');

  const roomy = new BoundedHistory(100);
  for (let i = 0; i < 5; i += 1) roomy.push(i);
  assert.deepEqual(roomy.items(), [0, 1, 2, 3, 4]);
  assert.equal(roomy.offset, 0, 'nothing dropped → offset 0');
});

test('a long codex session returns only the newest events, numbered by absolute position, with an omission note', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-store-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'codex', 'sessions', '2026', '09', '20');
  await mkdir(dir, { recursive: true });
  const sessionId = '01a0aaaa-1111-7000-8000-222233334444';
  const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-09-20T00:00:00.000Z', payload: { id: sessionId, cwd: root, timestamp: '2026-09-20T00:00:00.000Z' } })];
  // 300 턴 — 창(10)보다 훨씬 많다. 덩치 큰 tool 출력도 섞어 payload 자르기를 함께 태운다.
  for (let i = 0; i < 300; i += 1) {
    lines.push(JSON.stringify({ type: 'response_item', timestamp: '2026-09-20T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `prompt ${i}` }] } }));
    lines.push(JSON.stringify({ type: 'response_item', timestamp: '2026-09-20T00:00:02.000Z', payload: { type: 'custom_tool_call', call_id: `c${i}`, name: 'exec', status: 'completed', input: 'x'.repeat(50_000) } }));
    lines.push(JSON.stringify({ type: 'response_item', timestamp: '2026-09-20T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${i}` }] } }));
  }
  await writeFile(join(dir, `rollout-2026-09-20T00-00-00-${sessionId}.jsonl`), lines.join('\n') + '\n');

  const store = new AgentSessionStore({ claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), indexPath: join(root, 'index.json'), historyEventLimit: 10 });
  const history = await store.readHistory('codex', sessionId);
  assert.equal(history.truncated, true);
  const note = history.events[0];
  assert.equal(note.type, 'system');
  assert.match(note.payload.text, /Earlier history omitted \(\d+ events\)/);

  const rows = history.events.slice(1);
  assert.equal(rows.length, 10, 'only the window is returned');
  assert.equal(rows.at(-1).payload.text, 'answer 299', 'the newest row is the end of the file');
  assert.equal(rows.at(-1).seq, 900, 'seq is the absolute position, not the position within the window');
  assert.equal(rows.at(-1).id, `${sessionId}:900`);
  assert.ok(rows.every((e, i) => e.seq === rows[0].seq + i), 'seq is contiguous across the window');
  const omitted = Number(/\((\d+) events\)/.exec(note.payload.text)[1]);
  assert.equal(omitted, 900 - rows.length, 'the note counts everything that was dropped, not just the tail');

  const big = rows.find((e) => e.type === 'tool_call');
  assert.ok(big, 'the window still carries tool calls');
  assert.ok(JSON.stringify(big.payload).length < 40_000, 'oversized payloads are cut as they enter the window');
});

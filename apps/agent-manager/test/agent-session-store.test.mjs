// Agent Session(CLI 직접 세션) 저장소 리더 — 합성 Claude Code / Codex 세션 파일로
// 목록·기록 파싱을 고정한다(docs/agent-sessions.md). 실제 홈은 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionStore, claudeToolKind } from '../dist/lib/agent-session-store.js';

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

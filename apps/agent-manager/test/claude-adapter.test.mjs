// 유닛 테스트 — Claude CLI 어댑터 argv shape (ticket 3feaf80f).
//
// commentSent가 절대 true가 되지 않던 버그의 회귀 가드: Claude one-shot
// 티켓-멘션 dispatch가 `--print --output-format json`(배치, result-only 모드)을
// 써서 매니저의 #wireStdioCapture가 turn별 `assistant`/tool_use 이벤트를 전혀
// 보지 못했고, add_comment/move_ticket이 실제로 성공해도 `_scanForCommentTool`이
// record.commentSent를 절대 켤 수 없었다. 그 결과 클린 실행마다 "exited without
// leaving a ticket comment" 오탐 경고가 붙었고, circuit breaker의
// recordSuccess() 게이트에도 같은 오신호가 들어갔다. 수정은
// `--output-format stream-json`(+ --print 모드에서 CLI가 함께 요구하는
// `--verbose`)으로 전환해, 영속 세션이 이미 내던 것과 동일한 turn별 shape을
// oneshot도 내게 만드는 것이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';

test('Claude declares NATIVE_MCP + PERSISTENT_SESSION', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION), true);
});

test('buildOneshotSpawn requests stream-json (not the batch json mode)', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  const idx = descriptor.args.indexOf('--output-format');
  assert.ok(idx >= 0, '--output-format must be present');
  assert.equal(
    descriptor.args[idx + 1],
    'stream-json',
    'oneshot must stream per-turn events, not the single end-of-run json blob — ' +
      'otherwise _scanForCommentTool never observes a tool_use and commentSent stays false forever',
  );
});

test('buildOneshotSpawn pairs stream-json with --verbose (CLI hard-requirement in --print mode)', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(
    descriptor.args.includes('--verbose'),
    '`claude --print --output-format stream-json` without --verbose exits immediately with ' +
      '"Error: When using --print, --output-format=stream-json requires --verbose"',
  );
});

test('buildOneshotSpawn still runs single-turn (--print, no --input-format) — only the OUTPUT side streams', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'the actual task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(descriptor.args.includes('--print'));
  assert.equal(descriptor.args.includes('--input-format'), false, 'oneshot has no follow-up turn to stream in');
  assert.equal(descriptor.args.at(-1), 'the actual task', 'prompt stays a positional arg, not piped via stdin');
});

test('buildSessionSpawn is unaffected — persistent sessions already used stream-json both ways', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildSessionSpawn({
    rolePrompt: 'role',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(descriptor.args.includes('--verbose'));
  assert.deepEqual(
    [descriptor.args[descriptor.args.indexOf('--input-format') + 1], descriptor.args[descriptor.args.indexOf('--output-format') + 1]],
    ['stream-json', 'stream-json'],
  );
});

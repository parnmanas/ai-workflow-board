import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AcpClient,
  AcpProtocolError,
} from '../dist/lib/runtime/acp/acp-client.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

async function createClient(options = {}) {
  const events = [];
  const stderr = [];
  const client = await AcpClient.spawn({
    command: process.execPath,
    args: [fixture],
    // 타임아웃 자체를 검증하는 케이스만 아래에서 짧은 값을 명시로 넘긴다. 나머지
    // 케이스는 fixture 서브프로세스와 실제 round-trip 을 도는데, 여기에 임의로
    // 짧은 상한(예전 500ms)을 걸면 부하가 높은 러너에서 콜드 스타트만으로
    // initialize 가 넘어가 red 가 됐다(main CI windows, run 33743009098). 상한은
    // 성능 단언이 아니라 hang 진단용이므로 제품 기본값(30s)을 그대로 쓴다.
    onEvent: (event) => events.push(event),
    onStderr: (line) => stderr.push(line),
    onPermissionRequest: async (request) => {
      assert.equal(request.sessionId, 'session-1');
      return { outcome: 'selected', optionId: 'allow-once' };
    },
    ...options,
  });
  return { client, events, stderr };
}

test('ACP lifecycle correlates requests and normalizes updates', async (t) => {
  const { client, events, stderr } = await createClient();
  t.after(() => client.close());

  const initialized = await client.initialize({
    clientInfo: { name: 'awb-runtime-host', version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo.name, 'fake-hermes');

  const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
  assert.equal(session.sessionId, 'session-1');
  await client.loadSession({
    sessionId: session.sessionId,
    cwd: process.cwd(),
    mcpServers: [],
  });

  const response = await client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'work' }],
  });
  assert.equal(response.stopReason, 'end_turn');
  assert.deepEqual(
    events.map((event) => event.type),
    ['reasoning_delta', 'message_delta', 'tool_started', 'tool_completed', 'usage'],
  );
  assert.equal(events[1].text, 'hello');
  assert.equal(events[2].toolCallId, 'tool-1');
  assert.equal(events[4].totalTokens, 21);

  await client.cancel(session.sessionId);
  await client.closeSession(session.sessionId);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    events.some((event) => event.type === 'diagnostic'
      && event.method === 'test/cancelled'),
    true,
  );
  assert.equal(stderr.some((line) => line.includes('super-secret')), false);
  assert.equal(stderr.some((line) => line.includes('[REDACTED]')), true);
});

test('ACP request timeout rejects with a typed protocol error', async (t) => {
  const { client } = await createClient({ requestTimeoutMs: 30 });
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/hang', {}),
    (error) => error instanceof AcpProtocolError && error.code === 'acp_timeout',
  );
});

test('malformed stdout is a fatal protocol error and rejects pending requests', async (t) => {
  const { client } = await createClient();
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/malformed', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_malformed_message',
  );
  await assert.rejects(
    client.request('initialize', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_malformed_message',
  );
});

test('EOF rejects all pending requests and records process exit', async (t) => {
  const { client } = await createClient();
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/exit', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_process_exited'
      && error.exitCode === 17,
  );
});

// 한 줄이 상한을 넘는 경우 (ticket: codex 세션이 "ACP stdout line exceeds the configured byte
// limit" 뒤 SIGTERM 으로 죽던 사고). 큰 파일 읽기나 긴 명령 출력이 알림 한 줄로 오면 그 줄
// 하나가 세션 전체를 죽였다. 개행이 곧 재동기화 지점이므로 그 줄만 버리면 스트림은 살아 있다.
test('an oversized stdout line is fatal by default — the strict contract other runtimes rely on', async (t) => {
  const { client } = await createClient({ maxLineBytes: 1024 });
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/oversized', { bytes: 4096 }),
    (error) => error instanceof AcpProtocolError && error.code === 'acp_message_too_large',
  );
});

test('with skipOversizedLines the huge line is dropped, reported, and the stream resynchronizes', async (t) => {
  const oversized = [];
  const { client, events } = await createClient({
    maxLineBytes: 1024,
    skipOversizedLines: true,
    onOversizedLine: (bytes) => oversized.push(bytes),
  });
  t.after(() => client.close());

  const response = await client.request('test/oversized', { bytes: 4096 });
  assert.deepEqual(response, { survived: true }, 'the response that follows the dropped line still arrives');
  assert.equal(oversized.length, 1, 'the drop is reported exactly once');
  assert.ok(oversized[0] >= 4096, `the reported size covers the whole line: ${oversized[0]}`);
  assert.ok(
    events.some((e) => e.type === 'diagnostic' && e.method === 'test/after-oversized'),
    'the notification sent right after the oversized line is parsed normally',
  );
  // 세션은 계속 쓸 수 있다
  const initialized = await client.initialize({ clientInfo: { name: 'awb-runtime-host', version: '1.0.0' } });
  assert.equal(initialized.protocolVersion, 1);
});

test('an oversized line split across chunks is still skipped in one piece', async (t) => {
  const oversized = [];
  const { client } = await createClient({
    maxLineBytes: 512,
    skipOversizedLines: true,
    onOversizedLine: (bytes) => oversized.push(bytes),
  });
  t.after(() => client.close());
  // 512B 상한에 512KiB 한 줄 — 여러 chunk 로 쪼개져 도착한다(부분 버퍼 경로).
  const response = await client.request('test/oversized', { bytes: 512 * 1024 });
  assert.deepEqual(response, { survived: true });
  assert.equal(oversized.length, 1, 'the chunked line is reported once, not per chunk');
  assert.ok(oversized[0] >= 512 * 1024, `all discarded bytes are counted: ${oversized[0]}`);
});

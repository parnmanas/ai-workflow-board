import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let nextSession = 1;
let pendingPrompt = null;
let lastNewSessionParams = null;
// Agent Session 테스트용 — ACP session config options / slash commands / plan / elicitation.
// 다른 테스트(hermes 등)는 이 필드를 무시한다(추가 필드일 뿐).
// 실제 어댑터(codex-acp 1.12 / claude-agent-acp 0.79)는 SDK 1.x 스키마의 `id` 키로 보낸다 — `configId` 가 아니다.
const configOptions = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-fast',
    options: [
      { value: 'fake-fast', name: 'Fake Fast', description: 'cheap' },
      { value: 'fake-smart', name: 'Fake Smart', description: 'better' },
    ],
  },
  { id: 'fast_mode', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: false },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'read-only', name: 'Ask for approval' }, { value: 'agent', name: 'Approve for me' }] },
];
let pendingElicitPrompt = null;
// initialize 에서 client 가 광고한 capabilities — 실제 어댑터처럼 slash command 알림은
// 세션 설정(configOptions) 을 이해하는 client 에게만 보낸다(다른 테스트의 이벤트 순서를 건드리지 않게).
let clientCapabilities = {};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function invalidParams(id, detail) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32602, message: 'Invalid params', data: detail },
  });
}

// 실제 hermes-agent(acp.schema)는 mcpServers를 http/sse/stdio 판별 유니온으로
// 검증한다. transport 판별자가 빠진 서버 항목은 어떤 variant에도 매칭되지 않아
// session/new가 -32602로 실패한다. fixture가 무조건 성공을 돌려주면 이 계약
// 위반이 테스트를 통과해버리므로(무-transport 사고), 동일하게 검증한다.
function validateMcpServers(servers) {
  if (!Array.isArray(servers)) return 'mcpServers must be an array';
  for (const server of servers) {
    if (!server || typeof server.name !== 'string') {
      return 'mcpServers[].name is required';
    }
    if (server.type === 'http' || server.type === 'sse') {
      if (typeof server.url !== 'string') return `${server.name}: url is required`;
      if (!Array.isArray(server.headers)) return `${server.name}: headers is required`;
      continue;
    }
    if (server.type !== undefined) {
      return `${server.name}: unknown transport ${server.type}`;
    }
    // type이 없으면 stdio variant로만 해석된다.
    if (typeof server.command !== 'string'
      || !Array.isArray(server.args)
      || !Array.isArray(server.env)) {
      return `${server.name}: no matching transport variant`;
    }
  }
  return null;
}

// HermesProcess의 argv/env 구성(프로파일 전달 경로)을 검증하는 테스트를 위한
// opt-in spawn 캡처. 캡처는 아래 argv 검증보다 **먼저** 해야 한다 — exit(2)로
// 죽는 경우에도 테스트가 무엇이 넘어왔는지 볼 수 있어야 한다.
if (process.env.FAKE_ACP_CAPTURE_FILE) {
  writeFileSync(process.env.FAKE_ACP_CAPTURE_FILE, JSON.stringify({
    argv: process.argv.slice(2),
    HERMES_HOME: process.env.HERMES_HOME ?? null,
    HERMES_PROFILE: process.env.HERMES_PROFILE ?? null,
    // Agent Session credential 적용 검증용(agent-session-runner.test.mjs) — 다른 테스트는 읽지 않는다.
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    // opencode credential 적용 검증용 — 키는 env 로 주입되고 설정 홈은 XDG 로 고정된다.
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? null,
    OPENCODE_AUTH_CONTENT: process.env.OPENCODE_AUTH_CONTENT ?? null,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
    HOME: process.env.HOME ?? null,
    AWB_API_KEY: process.env.AWB_API_KEY ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? null,
    cwd: process.cwd(),
  }));
}

// 실제 `hermes-acp`(acp_adapter/entry.py)의 argparse가 받는 플래그 전량.
// 이 목록 밖의 인자가 오면 argparse는 usage를 찍고 exit(2)로 즉사한다.
// 픽스처가 아무 argv나 조용히 받아주면, 운영에서 100% 죽는 spawn이 테스트에서는
// green으로 통과한다 — 실제로 `--profile claude_opus`가 그렇게 새어나갔다.
const HERMES_ACP_ALLOWED_FLAGS = new Set([
  '-h',
  '--help',
  '--version',
  '--check',
  '--setup',
  '--setup-browser',
  '--yes',
]);

for (const arg of process.argv.slice(2)) {
  if (!HERMES_ACP_ALLOWED_FLAGS.has(arg)) {
    process.stderr.write(
      'usage: hermes-acp [-h] [--version] [--check] [--setup] [--setup-browser]\n'
      + '                  [--yes]\n'
      + `hermes-acp: error: unrecognized arguments: ${process.argv.slice(2).join(' ')}\n`,
    );
    process.exit(2);
  }
}

process.stderr.write('fake ACP ready; Authorization: Bearer super-secret\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);

  if (!Object.hasOwn(message, 'method')) {
    if (message.id === 'elicit-1' && pendingElicitPrompt) {
      // 질문(폼)에 대한 답 — accept 면 답 내용을 echo 하고 턴을 끝낸다
      const action = message.result?.action;
      if (action === 'accept') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Deploying to ${message.result?.content?.env ?? '?'}` } } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'session-1', update: { sessionUpdate: 'plan', entries: [{ content: 'Ask the user', priority: 'high', status: 'completed' }, { content: 'Deploy', priority: 'medium', status: 'in_progress' }] } },
        });
      }
      result(pendingElicitPrompt, { stopReason: action === 'accept' ? 'end_turn' : 'refusal' });
      pendingElicitPrompt = null;
      return;
    }
    if (message.id === 'permission-1' && pendingPrompt) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'usage_update',
            used: 21,
            size: 100,
            usage: { inputTokens: 10, outputTokens: 11, totalTokens: 21 },
          },
        },
      });
      result(pendingPrompt, {
        stopReason: message.result?.outcome?.outcome === 'selected'
          ? 'end_turn'
          : 'refusal',
        usage: { inputTokens: 10, outputTokens: 11, totalTokens: 21 },
      });
      pendingPrompt = null;
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      clientCapabilities = message.params?.clientCapabilities ?? {};
      // 실제 어댑터(claude-agent-acp · codex-acp)는 initialize 뒤 자기 로그인 신원을 push 한다.
      // 요청 경로가 없는 알림이고, 클라이언트가 모르면 그냥 버린다.
      setTimeout(() => send({
        jsonrpc: '2.0',
        method: '_auth/status_update',
        params: { authStatus: { kind: 'account', label: 'Fake Max', account: { email: 'probe@example.com', organization: 'Fake Org', plan: 'max' } } },
      }), 5);
      result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-hermes', version: '0.1.0' },
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
      break;
    case 'session/new': {
      const invalid = validateMcpServers(message.params?.mcpServers);
      if (invalid) {
        invalidParams(message.id, invalid);
        break;
      }
      lastNewSessionParams = message.params;
      if (process.env.FAKE_ACP_SESSION_CAPTURE_FILE) {
        writeFileSync(
          process.env.FAKE_ACP_SESSION_CAPTURE_FILE,
          JSON.stringify(message.params),
        );
      }
      const sessionId = `session-${nextSession++}`;
      // codex-acp 는 session/new **응답 전에** MCP 서버 연결을 update 없는 한 번짜리 tool_call 로 알린다
      // (status 가 곧 결과다). 이 시점에는 클라이언트가 아직 세션 id 를 모른다 — 실제 순서를 그대로 재현한다.
      if (clientCapabilities?.session?.configOptions) send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'mcp_startup.awb', title: 'mcp__awb__startup', kind: 'other', status: process.env.FAKE_ACP_MCP_STARTUP_STATUS || 'completed' } },
      });
      result(message.id, { sessionId, configOptions });
      // 어댑터들은 session/new 직후 slash command 목록을 알린다 — 세션 설정을 이해하는 client 에게만
      if (clientCapabilities?.session?.configOptions) send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'review', description: 'Review the working tree', input: { type: 'text', hint: 'optional focus' } },
              { name: 'compact', description: 'Compact the context' },
            ],
          },
        },
      });
      break;
    }
    case 'session/load': {
      const invalid = validateMcpServers(message.params?.mcpServers);
      if (invalid) {
        invalidParams(message.id, invalid);
        break;
      }
      result(message.id, { configOptions });
      break;
    }
    case 'session/set_mode': {
      // 실제 어댑터처럼 빈 결과 + current_mode_update 알림
      result(message.id, {});
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: message.params?.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: message.params?.modeId } },
      });
      break;
    }
    case 'session/set_config_option': {
      const option = configOptions.find((o) => o.id === message.params?.configId);
      if (!option) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown config option ${message.params?.configId}` } });
        break;
      }
      option.currentValue = message.params.value;
      result(message.id, { configOptions });
      break;
    }
    case 'test/last-new-session':
      result(message.id, lastNewSessionParams);
      break;
    case 'session/prompt':
      if (JSON.stringify(message.params.prompt).includes('OVERSIZED_TEST')) {
        // 거대한 tool 출력이 알림 한 줄로 오는 상황 — 그 줄 뒤의 스트림이 멀쩡해야 한다.
        process.stdout.write(`${'x'.repeat(8192)}\n`);
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } } },
        });
        result(message.id, { stopReason: 'end_turn' });
        break;
      }
      if (JSON.stringify(message.params.prompt).includes('ELICIT_TEST')) {
        // plan 을 알린 뒤 폼 질문을 던지고, 답이 올 때까지 턴을 연다 (Agent Session elicitation 테스트)
        pendingElicitPrompt = message.id;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'Ask the user', priority: 'high', status: 'in_progress' }, { content: 'Deploy', priority: 'medium', status: 'pending' }] } },
        });
        send({
          jsonrpc: '2.0',
          id: 'elicit-1',
          method: 'elicitation/create',
          params: {
            sessionId: message.params.sessionId,
            mode: 'form',
            message: 'Which environment should I deploy to?',
            requestedSchema: {
              type: 'object',
              title: 'Deployment target',
              properties: {
                env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] },
                notes: { type: 'string', title: 'Notes', maxLength: 200 },
              },
              required: ['env'],
            },
          },
        });
        break;
      }
      pendingPrompt = message.id;
      if (JSON.stringify(message.params.prompt).includes('CHILD_EVENT_TEST')) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'child-1',
              title: 'Delegate research subagent',
              kind: 'delegate',
              status: 'in_progress',
              rawInput: {
                depth: 1,
                tools: ['read'],
                skills: ['review'],
              },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'child-1',
              status: 'completed',
              rawOutput: { summary: 'research complete' },
            },
          },
        });
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read file',
            kind: 'read',
            status: 'in_progress',
            rawInput: { path: 'README.md' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: { text: 'done' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: 'tool-2', title: 'Run command', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      break;
    case 'session/cancel':
      send({
        jsonrpc: '2.0',
        method: 'test/cancelled',
        params: { sessionId: message.params.sessionId },
      });
      if (Object.hasOwn(message, 'id')) result(message.id, null);
      break;
    case 'session/close':
      if (process.env.FAKE_ACP_NO_CLOSE === '1') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unknown method: session/close' },
        });
      } else {
        result(message.id, {});
      }
      break;
    case 'test/oversized': {
      // 한도를 넘는 줄 하나를 뱉고, 곧바로 정상 알림과 응답을 잇는다. 줄을 건너뛰고
      // 재동기화하는 클라이언트라면 뒤의 둘이 멀쩡히 도착해야 한다.
      const bytes = Number(message.params?.bytes) || 8192;
      process.stdout.write(`${'x'.repeat(bytes)}\n`);
      send({ jsonrpc: '2.0', method: 'test/after-oversized', params: { ok: true } });
      result(message.id, { survived: true });
      break;
    }
    case 'test/hang':
      break;
    case 'test/malformed':
      process.stdout.write('not-json\n');
      break;
    case 'test/exit':
      process.exit(17);
      break;
    default:
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${message.method}` },
      });
  }
});

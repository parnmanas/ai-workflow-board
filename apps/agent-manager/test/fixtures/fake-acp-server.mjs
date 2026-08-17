import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let nextSession = 1;
let pendingPrompt = null;
let lastNewSessionParams = null;

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

// HermesProcess의 argv/env 구성(버그 A/B: --profile 인자 + 조건부 HERMES_HOME)을
// 검증하는 테스트를 위한 opt-in spawn 캡처.
if (process.env.FAKE_ACP_CAPTURE_FILE) {
  writeFileSync(process.env.FAKE_ACP_CAPTURE_FILE, JSON.stringify({
    argv: process.argv.slice(2),
    HERMES_HOME: process.env.HERMES_HOME ?? null,
    HERMES_PROFILE: process.env.HERMES_PROFILE ?? null,
  }));
}

process.stderr.write('fake ACP ready; Authorization: Bearer super-secret\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);

  if (!Object.hasOwn(message, 'method')) {
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
      result(message.id, { sessionId: `session-${nextSession++}` });
      break;
    }
    case 'session/load': {
      const invalid = validateMcpServers(message.params?.mcpServers);
      if (invalid) {
        invalidParams(message.id, invalid);
        break;
      }
      result(message.id, {});
      break;
    }
    case 'test/last-new-session':
      result(message.id, lastNewSessionParams);
      break;
    case 'session/prompt':
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

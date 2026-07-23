// Opt-in live regression for ticket 68cda8eb.
//
// Run with:
//   PI_E2E_BIN=/absolute/path/to/pi npm run build &&
//     PI_E2E_BIN=/absolute/path/to/pi node --test test/pi-ticket-dispatch.e2e.test.mjs
//
// This deliberately executes the real pi binary. The only fakes are local
// protocol peers: an OpenAI-compatible model which deterministically asks for
// add_comment, and the AWB HTTP/MCP endpoint which persists that comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { PiCliAdapter } from '../dist/lib/cli-adapters/pi.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';

const piBin = process.env.PI_E2E_BIN;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function record(overrides = {}) {
  return {
    pid: 91001,
    kind: 'trigger',
    cli_type: 'pi',
    trigger_id: 'pi-live-e2e',
    chat_request_id: null,
    ticket_id: 'ticket-pi-live',
    agent_id: 'agent-pi-live',
    role: 'assignee',
    room_id: null,
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

test(
  'live pi ticket dispatch: one comment, no silent-exit fallback, breaker success reset',
  { skip: !piBin && 'set PI_E2E_BIN to a pi 0.81.1+ executable' },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'awb-pi-ticket-e2e-'));
    const comments = [];
    const restCalls = [];
    const mcpCalls = [];
    let modelTurns = 0;

    const server = createServer(async (req, res) => {
      if (req.url === '/v1/chat/completions') {
        await body(req);
        modelTurns += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (modelTurns === 1) {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-tool',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fake-model',
              choices: [{
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    index: 0,
                    id: 'call-add-comment',
                    type: 'function',
                    function: {
                      name: 'add_comment',
                      arguments: JSON.stringify({
                        ticket_id: 'ticket-pi-live',
                        content: 'pi live e2e comment',
                      }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-final',
              object: 'chat.completion.chunk',
              created: 2,
              model: 'fake-model',
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: '작업을 완료했습니다.' },
                finish_reason: 'stop',
              }],
            })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }

      if (req.url === '/mcp') {
        const payload = await body(req);
        if (payload.method === 'initialize') {
          json(
            res,
            200,
            { jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-awb', version: '1' } } },
            { 'mcp-session-id': 'pi-live-session' },
          );
          return;
        }
        if (payload.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        if (payload.method === 'tools/list') {
          json(res, 200, {
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              tools: [{
                name: 'add_comment',
                description: 'Add one ticket comment',
                inputSchema: {
                  type: 'object',
                  properties: {
                    ticket_id: { type: 'string' },
                    content: { type: 'string' },
                  },
                  required: ['ticket_id', 'content'],
                },
              }],
            },
          });
          return;
        }
        if (payload.method === 'tools/call') {
          mcpCalls.push(payload.params.name);
          if (payload.params.name === 'add_comment') comments.push(payload.params.arguments);
          json(res, 200, {
            jsonrpc: '2.0',
            id: payload.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
          });
          return;
        }
      }

      restCalls.push({ method: req.method, url: req.url, payload: await body(req) });
      json(res, req.method === 'GET' ? 200 : 201, { comments });
    });

    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const home = join(scratch, 'home');
    const agentDir = join(home, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'local-openai': {
            baseUrl: `${baseUrl}/v1`,
            api: 'openai-completions',
            apiKey: 'local-test-key',
            models: [{ id: 'fake-model', reasoning: false }],
          },
        },
      }),
    );

    const adapter = new PiCliAdapter();
    await adapter.prepareCliHome(home, null, { url: baseUrl });
    const spec = adapter.buildOneshotSpawn({
      rolePrompt: '',
      taskText: 'Call add_comment exactly once, then finish.',
      model: 'local-openai/fake-model',
    });

    const breaker = new CircuitBreaker();
    const manager = new SubagentManager({
      url: baseUrl,
      apiKey: 'test-key',
      silentExitVerifyDelayMs: 0,
      delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
    }, breaker);
    const key = CircuitBreaker.key('agent-pi-live', 'ticket-pi-live', 'assignee');
    await manager._handleOneshotExit(record({ pid: 90991 }), 0);
    await manager._handleOneshotExit(record({ pid: 90992 }), 0);
    assert.equal(breaker.size, 1, 'precondition: two silent exits created a failure streak');
    restCalls.length = 0;

    const child = spawn(piBin, spec.args, {
      cwd: scratch,
      env: { ...process.env, HOME: home, AWB_API_KEY: 'test-key' },
      stdio: spec.stdio,
    });
    child.stdin.end();
    let rawStdout = '';
    let rawStderr = '';
    child.stdout.on('data', (chunk) => { rawStdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { rawStderr += chunk.toString('utf8'); });
    const rec = record({ pid: child.pid, process_handle: child });
    manager._wireStdioForTest(rec);
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await manager._handleOneshotExit(rec, exitCode);

    assert.equal(exitCode, 0);
    assert.match(rawStdout, /작업을 완료했습니다\./);
    assert.doesNotMatch(rawStdout, /awb_mcp_bridge_tool_call/);
    assert.match(rawStderr, /"type":"awb_mcp_bridge_tool_call".*"tool":"add_comment"/);
    assert.equal(comments.length, 1, 'the real bridge persisted exactly one comment');
    assert.deepEqual(mcpCalls, ['add_comment']);
    assert.equal(rec.commentSent, true, 'manager observed the real pi stderr sentinel');
    assert.equal(
      restCalls.some((call) => call.url.endsWith('/silent-exit-comment')),
      false,
      'no false exited-without-comment fallback',
    );
    assert.equal(breaker.shouldBlock(key), null, 'recordSuccess reset the failure streak');
    assert.equal(mcpCalls.includes('pend_ticket'), false);

    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  },
);

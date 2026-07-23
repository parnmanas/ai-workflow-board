// Pi CLI adapter — stateless one-shot, credential-free (ticket d72282ad),
// now with a first-party AWB MCP bridge (ticket d5a6100d).
// Pi (`pi`, https://pi.dev, npm `@earendil-works/pi-coding-agent`) is a
// terminal coding agent in the same family as Claude Code / Codex /
// Antigravity. Its README states an explicit design philosophy: "No MCP.
// Build CLI tools with READMEs (see Skills), or build an extension that adds
// MCP support." — confirmed (through v0.81.1, 2026-07-21) that pi itself has
// no native MCP client and no `--mcp-config`-style flag. But pi's own
// extension API (`docs/extensions.md`) is exactly what that README line
// points at: `pi.registerTool()` takes a plain JSON-schema `parameters`
// object (no typebox construction required — verified directly against an
// installed 0.81.1), extensions auto-load from `~/.pi/agent/extensions/*.ts`
// with ZERO project-trust gate (global scope, unlike `.pi/extensions/`), and
// Node's built-in `fetch` is available inside them. That's the complete
// surface needed to hand-roll an MCP client — no `@modelcontextprotocol/sdk`
// or any other npm dependency required, so there is no extension-local
// `npm install` step (and no per-spawn network-fetch failure mode from a
// third-party package — the exact risk that made this ticket avoid guessing
// a schema for the community `pi-mcp-adapter` extension, which exists and is
// maintained but has unverified Streamable HTTP support).
//
// prepareCliHome now writes `<piAgentDir>/extensions/awb-mcp-bridge.ts`
// (regenerated every call — see #writeMcpBridgeExtension) whenever the
// manager has an AWB endpoint. That extension performs the MCP
// initialize/tools-list/tools-call handshake itself against AWB's real
// Streamable HTTP transport, verified directly (not guessed) against
// apps/server's actual behavior:
//   - responses are plain `application/json` (enableJsonResponse: true on
//     the server transport) — no SSE parsing needed in the client.
//   - `X-AWB-Client-Type: managed-subagent` bypasses the `awb/schemaVersion`
//     initialize gate (mcp.controller.ts), so no experimental-capability
//     dance is required, matching antigravity/codex's own header.
//   - the per-agent `AWB_API_KEY` env var (injected on every spawn by
//     subagent-manager.ts / base-session-manager.ts, same as codex's
//     `bearer_token_env_var` reference) is read at request time, never
//     baked into the generated file — only the URL is a spawn_agent-time
//     constant, mirroring codex's own "gate on url only" reasoning.
// End-to-end verified manually against a live local AWB instance: a real
// spawned `pi` process (driven through a deterministic local test model so
// the tool-calling decision itself didn't need a paid provider) called
// get_ticket → add_comment → move_ticket, and get_ticket afterward confirmed
// both the comment and the column move actually persisted. See the ticket
// comment on d5a6100d for the full transcript. Because of this, `capabilities`
// below now includes NATIVE_MCP — same meaning as claude/codex: the spawned
// process calls AWB MCP tools itself, so the manager stops treating pi's
// stdout as the deliverable (captureOutput flips off, chat replies switch to
// `send_chat_room_message`, exactly like claude/codex already do).
//
// Review regression fix (ticket d5a6100d, round 2): flipping on NATIVE_MCP
// sets `captureOutput: false` (subagent-manager.ts), which is fine for the
// answer-aggregation path but ALSO starves `_scanForCommentTool` — the scan
// that flips `record.commentSent` and is what suppresses the silent-exit
// fallback comment and resets the circuit-breaker. codex gets this for free
// because `codex exec --json` prints structured `item.completed`/
// `mcp_tool_call` events pi's own `-p` mode never does (pi prints plain
// prose — see `parseStdoutLine` below). Without a stdout signal, EVERY
// successful pi ticket dispatch was misread as silent: the "exited without
// leaving a ticket comment" system comment fired despite a real comment
// having been posted, and the breaker never saw a recordSuccess() reset —
// eventually pending the ticket and defeating this ticket's entire goal. The
// initial fix: the bridge's `execute()` prints one `awb_mcp_bridge_tool_call`
// JSON line with console.log on every successful AWB tool call, and
// `_scanForCommentTool` gained a matching branch.
//
// Runtime correction (ticket 68cda8eb): real pi 0.81.1 `-p` runs with shell
// fd 1/2 separated proved that pi routes extension console.log output to
// stderr; stdout contains only the final answer. #wireStdioCapture therefore
// scans pi stderr as well as stdout for the sentinel. The scan is pi-only so
// diagnostics from other CLIs cannot affect their comment accounting.
//
// Pi also has no credential concept AWB manages — no per-agent credential
// kind exists to select in the UI. Its own provider auth (API key / OAuth /
// a local llama.cpp server, pi's only genuinely key-free provider) lives in
// the operator's real `~/.pi/agent/{auth.json,settings.json}`.
// prepareCliHome symlinks those two files into the per-agent home (mirrors
// codex's operator-HOME fallback — the ONLY path here, since pi never has a
// per-agent override to prefer) so a spawned agent inherits whatever the
// operator already set up via `pi /login`, without AWB ever touching a
// secret.
//
// configDirEnv() returns 'HOME' (like antigravity) because pi has no
// dedicated config-dir env var of its own — paths always resolve under
// `~/.pi/agent/` (docs/settings.md).
//
// pi chat E2E 검증 (ticket 2a912376): send_chat_room_message가 실제로 방에
// 도착하는지 별도로 라이브 검증했다 — 로컬 샌드박스 AWB 서버 + 로컬 fake
// OpenAI-호환 LLM provider(pi 확장으로 등록) + 실제 pi 0.81.1 바이너리로,
// event-dispatcher.ts#handleChatRequest의 legacy one-shot 경로가 실제로
// 호출하는 것과 동일한 프로덕션 함수(prepareCliHome / composeChatPrompt /
// buildOneshotSpawn)를 그대로 태웠다. 결과: fake LLM이 send_chat_room_message
// 호출을 지시하면 실제로 방에 메시지가 도착함을 별도 get_chat_room_messages
// 호출로 독립 확인했고, fake LLM이 tool을 전혀 호출하지 않으면 방에 아무
// 메시지도 도착하지 않음(REST relay 안전망 부재가 설계대로 동작 — round-2가
// codex 패리티로 수용한 바로 그 트레이드오프)도 확인했다.
//
// 이 검증 중 별개의 버그를 하나 발견했다(ticket 68cda8eb로 추적): 브릿지의
// tool-call-success sentinel은 console.log()로 작성돼 있지만, 실제 pi
// 런타임을 거치면 자식 프로세스의 stdout이 아니라 stderr로 나간다(순수 셸
// 1>/2> 리다이렉션으로 확인 — pi의 -p 모드가 최종 응답 텍스트만 stdout에
// 남기고 확장의 로그 출력은 전부 stderr로 합치는 것으로 보인다). child.stdout
// 만 읽는 _scanForCommentTool은 그 sentinel을 볼 수 없어, 위 "Review
// regression fix" 문단이 고쳐졌다고 서술한 ticket-dispatch 경로의
// commentSent/서킷브레이커 회계는 실제로는 고쳐지지 않았을 가능성이 높다.
// chat 경로(send_chat_room_message)의 메시지 전달 자체는 이 버그와 무관하게
// 정상 동작한다 — 영향 범위는 sentinel을 관측해 commentSent를 세팅하는 회계
// 로직으로 한정된다.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCredential,
  type AdapterMcpContext,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

// Files the operator's real ~/.pi/agent/ home must lend a fresh per-agent
// HOME so pi can actually authenticate — mirrors codex's
// SHARED_FROM_MAIN_HOME. `auth.json` carries the resolved provider
// credential (API key or OAuth token); `settings.json` carries
// `defaultProvider`/`defaultModel` (including a llama.cpp local-server
// setup). Session history / project state intentionally stay isolated.
const SHARED_FROM_MAIN_HOME = ['auth.json', 'settings.json'];

export class PiCliAdapter extends CliAdapter {
  static cliType = 'pi';

  constructor() {
    super();
    // Stateless one-shot — pi has no stream-json-style persistent session
    // protocol to drive, so PERSISTENT_SESSION stays off. NATIVE_MCP is now
    // on (see file banner): the awb-mcp-bridge extension prepareCliHome
    // writes gives the spawned pi process real get_ticket/add_comment/
    // move_ticket/etc. tools, so it calls AWB itself instead of the manager
    // capturing stdout on its behalf.
    this.capabilities = new Set([ADAPTER_CAPABILITIES.NATIVE_MCP]);
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('pi', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText, model }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    // `pi -p "<prompt>"` prints the response and exits — pi's documented
    // automation entry point. Non-interactive modes (-p / --mode json /
    // --mode rpc) never show the interactive project-trust prompt, so this
    // cannot hang waiting on a human; `--approve` additionally auto-trusts
    // whatever project-local `.pi/` the target repo happens to ship for
    // this run instead of silently skipping it (mirrors codex/antigravity's
    // own approval-bypass flags — the spawn already runs in a per-agent
    // sandbox, so an interactive approval would be redundant even if one
    // were possible here). `--no-session` keeps one-shot ticket dispatches
    // from accumulating unbounded session history in the per-agent home.
    // Per-agent default model (Agent.model) is omitted when unset so pi
    // keeps its own configured default — same as codex/antigravity.
    return {
      args: ['-p', fullPrompt, ...(model ? ['--model', model] : []), '--approve', '--no-session'],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: undefined,
    };
  }

  parseStdoutLine(line: string): ParseResult {
    // `-p` mode prints plain text, not structured events (pi's `--mode
    // json`/`--mode rpc` exist but their event schema isn't documented
    // anywhere we could verify, so we don't parse against a guess — see
    // file banner). Treat any non-empty line as composing-stage progress,
    // mirroring antigravity.
    const trimmed = String(line || '').trim();
    return {
      stage: trimmed ? PARSE_STAGE.COMPOSING : null,
      isResult: false,
      isError: false,
      raw: line,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Plain-text mode: concatenate all non-empty lines (mirrors antigravity).
    const raw = (Array.isArray(lines) ? lines : [])
      .filter((l) => {
        const s = String(l || '').trim();
        if (!s) return false;
        if (s.startsWith('Warning:')) return false;
        return true;
      })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '') // Strip ANSI escape sequences
      .replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  configDirEnv(): string {
    return 'HOME';
  }

  async prepareCliHome(
    cliHomeDir: string,
    _credential?: AdapterCredential | null,
    mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    const piAgentDir = join(cliHomeDir, '.pi', 'agent');
    await fsp.mkdir(piAgentDir, { recursive: true, mode: 0o700 });

    // Pi has no per-agent credential AWB manages (see file banner) — always
    // inherit the operator's own already-authenticated ~/.pi/agent/ files,
    // whatever provider they configured via `pi /login` (including a
    // credential-free llama.cpp local server), instead of branching on a
    // credential kind the way codex/antigravity do.
    const mainAgentDir = join(homedir(), '.pi', 'agent');
    for (const name of SHARED_FROM_MAIN_HOME) {
      const src = join(mainAgentDir, name);
      const dst = join(piAgentDir, name);
      try {
        await fsp.access(src);
      } catch {
        continue;
      }
      try {
        await fsp.unlink(dst);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        await fsp.symlink(src, dst);
      } catch (err: any) {
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          await fsp.copyFile(src, dst);
        } else {
          throw err;
        }
      }
    }

    // Gate on url only (mirrors codex's #prepareConfig reasoning) — the
    // per-agent apiKey rides the AWB_API_KEY env var subagent-manager.ts /
    // base-session-manager.ts already inject on every spawn, so a missing
    // apiKey here is never a reason to skip wiring the endpoint.
    if (mcp?.url) {
      await this.#writeMcpBridgeExtension(piAgentDir, mcp.url);
    }

    return { extraEnv: {} };
  }

  /**
   * Write `<piAgentDir>/extensions/awb-mcp-bridge.ts` — a dependency-free pi
   * extension that hand-rolls the minimal MCP client surface pi needs
   * (initialize / tools-list / tools-call) against AWB's Streamable HTTP
   * `/mcp` endpoint, using only Node's built-in `fetch` (verified available
   * inside pi extensions — see file banner). Auto-discovered from
   * `~/.pi/agent/extensions/*.ts` on every pi invocation once `configDirEnv`
   * points HOME at `cliHomeDir` — no `-e` flag or trust prompt needed (global
   * scope, unlike project-local `.pi/extensions/`).
   *
   * Regenerated unconditionally on every prepareCliHome call (spawn_agent) —
   * not meant to be hand-edited, mirrors antigravity's #writeMcpConfig.
   */
  async #writeMcpBridgeExtension(piAgentDir: string, awbUrl: string): Promise<void> {
    const extensionsDir = join(piAgentDir, 'extensions');
    await fsp.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
    const mcpUrl = `${awbUrl.replace(/\/$/, '')}/mcp`;
    const content = buildAwbMcpBridgeSource(mcpUrl);
    await fsp.writeFile(join(extensionsDir, 'awb-mcp-bridge.ts'), content, { mode: 0o600 });
  }
}

/**
 * Build the awb-mcp-bridge.ts source (see #writeMcpBridgeExtension). Kept as
 * a plain string template rather than a checked-in template file — same
 * reasoning as antigravity's inline `mcpServers` object literal: the only
 * variable is the URL, and generating it here keeps the single source of
 * truth for "what pi actually needs" next to the adapter that verified it.
 *
 * Wire details verified directly against apps/server (not guessed):
 *   - AWB's Streamable HTTP transport responds with plain `application/json`
 *     (enableJsonResponse: true — see mcp.controller.ts), never SSE, so this
 *     client never needs an event-stream parser.
 *   - `X-AWB-Client-Type: managed-subagent` bypasses the `awb/schemaVersion`
 *     experimental-capability gate on `initialize` (mcp.controller.ts) — the
 *     same header antigravity/codex already send.
 *   - The session id AWB returns on `initialize` (`Mcp-Session-Id` response
 *     header) must ride every subsequent request on the SAME header name, or
 *     the server responds 404 "Session not found. Please re-initialize."
 */
function buildAwbMcpBridgeSource(mcpUrl: string): string {
  return `// AUTO-GENERATED by apps/agent-manager's pi CLI adapter (ticket d5a6100d) —
// regenerated on every spawn_agent. Do not hand-edit; edit
// apps/agent-manager/src/lib/cli-adapters/pi.ts#buildAwbMcpBridgeSource instead.
//
// Bridges AWB's Streamable HTTP MCP server into pi's own tool system. pi has
// no native MCP client, so this hand-rolls the minimal client surface pi
// needs (initialize, tools/list, tools/call) using only Node's built-in
// fetch — no extension-local npm install (and its per-spawn network-failure
// risk) required.

const AWB_MCP_URL = ${JSON.stringify(mcpUrl)};

let sessionId = null;
let nextId = 1;

async function mcpRequest(method, params) {
  const apiKey = process.env.AWB_API_KEY || '';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-AWB-Client-Type': 'managed-subagent',
  };
  if (apiKey) headers.Authorization = \`Bearer \${apiKey}\`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const isNotification = method.startsWith('notifications/');
  const body = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const res = await fetch(AWB_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (isNotification) return null;

  if (!res.ok) throw new Error(\`AWB MCP \${method} failed: HTTP \${res.status}\`);
  const json = await res.json();
  if (json.error) {
    throw new Error(\`AWB MCP \${method} error: \${json.error.message || JSON.stringify(json.error)}\`);
  }
  return json.result;
}

export default async function (pi) {
  let tools = [];
  try {
    await mcpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'awb-pi-mcp-bridge', version: '1.0.0' },
    });
    await mcpRequest('notifications/initialized', {});
    const listResult = await mcpRequest('tools/list', {});
    tools = Array.isArray(listResult && listResult.tools) ? listResult.tools : [];
  } catch (err) {
    console.error(\`[awb-mcp-bridge] failed to connect to AWB MCP server: \${(err && err.message) || err}\`);
    return;
  }

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      async execute(_toolCallId, params) {
        const result = await mcpRequest('tools/call', { name: tool.name, arguments: params || {} });
        const content =
          Array.isArray(result && result.content) && result.content.length
            ? result.content
            : [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }];
        if (result && result.isError) {
          throw new Error(content.map((c) => c.text || '').join('\\n') || \`\${tool.name} failed\`);
        }
        // Sentinel after a successful tool call. pi's -p runtime routes
        // extension console output to stderr even when the extension uses
        // console.log; subagent-manager scans pi's stderr for this exact JSON
        // shape (ticket 68cda8eb).
        console.log(JSON.stringify({ type: 'awb_mcp_bridge_tool_call', server: 'awb', tool: tool.name, error: null }));
        return { content, details: {} };
      },
    });
  }

  console.error(\`[awb-mcp-bridge] registered \${tools.length} AWB MCP tool(s)\`);
}
`;
}

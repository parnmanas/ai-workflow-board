// Codex CLI adapter — stateless one-shot, mirrors the Antigravity path.
// Codex loads AWB MCP natively from the per-agent CODEX_HOME/config.toml.
// JSONL stdout remains available for progress/error monitoring, while
// deliverables go through AWB MCP tools.
//
// configDirEnv returns CODEX_HOME so per-agent isolation puts codex's
// settings / auth / history under <MANAGER_HOME>/agents/<id>/cli-home/
// rather than sharing the operator's $HOME.

import { promises as fsp, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { resolveCliBin } from '../cli-resolver.js';
import { resolveSelfCommand } from '../self-path.js';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCredential,
  type AdapterMcpContext,
  CliAdapter,
  type CliProgressEvent,
  type CliUsageSnapshot,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';
import {
  type EffectivePermissionPolicy,
  type PermissionCapabilities,
  FULL_PERMISSION_CAPABILITIES,
  permissionPolicyOrDefault,
} from '../permission-policy.js';

// Files the per-agent codex home must inherit from the operator's main home
// for spawned children to authenticate and pick up the operator's model /
// provider preferences. Sessions / history / caches stay isolated.
const SHARED_FROM_MAIN_HOME = ['auth.json', 'config.toml'];

// 임의의 JS 값을 inline TOML 값으로 직렬화한다 — `mcp_servers.awb` 테이블
// 전체(문자열, 불리언, 중첩된 `http_headers` 테이블까지)를 `-c key=<inline>`
// 한 번에 넘길 수 있도록 한다. attribution 헤더만 다루던 기존의 flat한
// string map 으로는 부족하다.
function inlineTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[ ${value.map(inlineTomlValue).join(', ')} ]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => `${JSON.stringify(key)} = ${inlineTomlValue(v)}`)
      .join(', ')} }`;
  }
  return 'null';
}

/**
 * effective permission policy → codex 실행 권한 플래그 (ticket 5851e435).
 *
 * 세 등급 모두 codex 자체 옵션으로 표현된다. `approval_policy="never"` 는
 * 어느 등급에서도 유지한다 — codex 를 비대화형(`exec`)으로 스폰하므로
 * 승인 프롬프트가 뜨면 답할 사람이 없어 그대로 멈춘다. 즉 `strict` 는
 * "물어본다"가 아니라 "read-only sandbox 밖의 일은 그냥 거부된다"이고,
 * `approve` 는 workspace-write 로 제한된 상태에서 그 밖의 escalation 이
 * 거부되는 경로다.
 *
 * 등급별 argv 는 이 티켓 이전의 harness 문자열 매핑과 정확히 같은 것을
 * 재사용한다(plan→read-only, acceptEdits/auto/dontAsk/default/manual→
 * workspace-write, bypassPermissions/미설정→bypass). 달라진 건 "무엇이
 * 등급을 정하는가"뿐이다 — 이제 Agent trust 가 기준이다.
 */
function codexPermissionArgs(
  policy: EffectivePermissionPolicy | null | undefined,
  harness: { permission_mode?: string } | null | undefined,
): string[] {
  const effective = permissionPolicyOrDefault(policy, harness?.permission_mode);
  switch (effective.tier) {
    case 'strict':
      return ['--sandbox', 'read-only', '-c', 'approval_policy="never"'];
    case 'approve':
      return ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'];
    case 'trusted':
    default:
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

// ── MCP transport 검증 (ticket 40d18474) ────────────────────────────────────
//
// codex 는 각 `mcp_servers.<name>` 엔트리의 transport 를 모양으로 해석한다 —
// `url` 이면 streamable-HTTP, `command` 이면 stdio 서버. 둘 중 어느 것으로도
// 해석되지 않는 엔트리는 codex 가 에이전트 실행 전에 *config 로드 자체*를
//   Error loading config.toml: invalid transport in `mcp_servers.<name>`
// (exit 1) 로 중단시키는데, 이는 오직 silent subagent exit 로만 드러났다
// (인시던트 26a92722: managed codex 리뷰어가 이 오류로 두 번 즉사해 리뷰 지연).
// 함정은 `buildOneshotSpawn` 이 항상 attribution 헤더를 담은 `-c
// mcp_servers.awb=…` 오버라이드를 주입한다는 점이다(ticket 702d0ebe 이전엔
// `-c mcp_servers.awb.http_headers=…` 로 부분 경로만 오버라이드했는데, 이는
// codex-cli 버전에 따라 병합/치환 시맨틱이 갈려 치환 시맨틱(구버전 snap
// 0.114.0)에서 `url` 이 사라지는 결함이 있었다 — 지금은 항상 자기완결형
// 전체 테이블을 넘긴다) — config.toml 에 완전한 `awb` 서버가 없으면 이
// 오버라이드가 header 만 있고 transport 없는 `awb` 가 되어 codex 가 로드를
// 거부한다. codex 에 넘기기 직전의 config 를 검증해, 잘못된/누락된
// transport 를 애매한 crash 대신 정확한 키와 허용 스키마를 담은 spawn 이전
// 매니저 오류로 바꾼다.
export const CODEX_MCP_TRANSPORTS = Object.freeze(['stdio', 'streamable_http'] as const);

export class InvalidMcpTransportError extends Error {
  /** The offending `mcp_servers.<name>` table's bare `name` (never the full
   *  `mcp_servers.` prefix) — kept structured so callers building an operator
   *  notification don't have to parse it back out of `message` (ticket
   *  da4358ee review round 2: a hardcoded `mcp_servers.awb` in the
   *  notification text was wrong for every non-`awb` server key). */
  readonly serverKey: string;

  constructor(message: string, serverKey: string) {
    super(message);
    this.name = 'InvalidMcpTransportError';
    this.serverKey = serverKey;
  }
}

/**
 * `config` 의 어떤 `mcp_servers.<name>` 엔트리든 codex 가 해석할 수 있는
 * transport 가 없으면 {@link InvalidMcpTransportError} 를 던진다 — 명시 `transport`
 * 가 {@link CODEX_MCP_TRANSPORTS} 밖이거나, `url`(streamable_http) 도 `command`
 * (stdio) 도 없는 경우. 오퍼레이터가 어느 파일·키를 고쳐야 하는지 보이도록
 * `configPath` 를 메시지에 녹인다. `mcp_servers` 테이블이 없는 config 는 공허하게
 * 유효하다.
 */
export function validateCodexMcpServers(config: unknown, configPath: string): void {
  const servers = (config as { mcp_servers?: unknown } | null | undefined)?.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  const allowed = CODEX_MCP_TRANSPORTS.join(', ');
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const where = `mcp_servers.${name}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidMcpTransportError(
        `Refusing to launch subagent: ${where} in ${configPath} is not a valid MCP server table — ` +
          `define a "url" (streamable_http) or a "command" (stdio). Allowed transports: ${allowed}.`,
        name,
      );
    }
    const entry = raw as Record<string, unknown>;
    const declared = entry.transport;
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== '';
    const hasCommand = typeof entry.command === 'string' && entry.command.trim() !== '';
    if (declared !== undefined) {
      if (typeof declared !== 'string' || !CODEX_MCP_TRANSPORTS.includes(declared as any)) {
        throw new InvalidMcpTransportError(
          `Refusing to launch subagent: ${where}.transport = ${JSON.stringify(declared)} in ${configPath} ` +
            `is not a supported MCP transport. Allowed transports: ${allowed}.`,
          name,
        );
      }
      if (declared === 'streamable_http' && !hasUrl) {
        throw new InvalidMcpTransportError(
          `Refusing to launch subagent: ${where}.transport = "streamable_http" in ${configPath} requires a "url". ` +
            `Allowed transports: ${allowed}.`,
          name,
        );
      }
      if (declared === 'stdio' && !hasCommand) {
        throw new InvalidMcpTransportError(
          `Refusing to launch subagent: ${where}.transport = "stdio" in ${configPath} requires a "command". ` +
            `Allowed transports: ${allowed}.`,
          name,
        );
      }
    } else if (!hasUrl && !hasCommand) {
      throw new InvalidMcpTransportError(
        `Refusing to launch subagent: ${where} in ${configPath} has no resolvable transport — ` +
          `set a "url" (streamable_http) or a "command" (stdio). Allowed transports: ${allowed}.`,
        name,
      );
    }
  }
}

export class CodexCliAdapter extends CliAdapter {
  static cliType = 'codex';

  constructor() {
    super();
    this.capabilities = new Set([ADAPTER_CAPABILITIES.NATIVE_MCP]);
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('codex', configured);
  }

  harnessKeys(): ReadonlyArray<'system_prompt_append' | 'model' | 'permission_mode'> {
    return ['system_prompt_append', 'model', 'permission_mode'];
  }

  /** Codex 는 세 등급을 모두 전용 옵션으로 표현한다 (ticket 5851e435). */
  permissionCapabilities(): PermissionCapabilities {
    return FULL_PERMISSION_CAPABILITIES;
  }

  buildOneshotSpawn({
    rolePrompt,
    taskText,
    model,
    mcpAttribution,
    cwd,
    cliHomeDir,
    harness,
    permission,
  }: OneshotSpec): SpawnDescriptor {
    const promptParts: string[] = [];
    if (harness?.system_prompt_append?.trim()) {
      promptParts.push(
        `AWB managed policy:\n${harness.system_prompt_append.trim()}\nEnd AWB managed policy.`,
      );
    }
    if (rolePrompt?.trim()) promptParts.push(rolePrompt);
    if (taskText?.trim()) promptParts.push(taskText);
    const fullPrompt = promptParts.join('\n\n');
    const hasAttribution = !!(
      mcpAttribution?.ticketId ||
      mcpAttribution?.role ||
      mcpAttribution?.triggerSource ||
      mcpAttribution?.triggerId ||
      mcpAttribution?.sessionId
    );
    const attributionArgs: string[] = [];
    if (hasAttribution) {
      const headers: Record<string, string> = {
        'X-AWB-Client-Type': mcpAttribution?.clientType ?? 'managed-subagent',
      };
      if (mcpAttribution?.ticketId) {
        headers['X-AWB-Subagent-Ticket-Id'] = mcpAttribution.ticketId;
      }
      if (mcpAttribution?.role) headers['X-AWB-Subagent-Role'] = mcpAttribution.role;
      if (mcpAttribution?.triggerSource) {
        headers['X-AWB-Subagent-Trigger-Source'] = mcpAttribution.triggerSource;
      }
      if (mcpAttribution?.triggerId) {
        headers['X-AWB-Subagent-Trigger-Id'] = mcpAttribution.triggerId;
      }
      if (mcpAttribution?.sessionId) {
        headers['X-AWB-Subagent-Session-Id'] = mcpAttribution.sessionId;
      }

      // 이전에 준비해 둔 파일만이 아니라 Codex 가 실제로 로드할 내용을
      // 읽어, 아래 오버라이드가 *자기완결형* 테이블이 되도록 한다.
      const configPath = join(
        cliHomeDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        'config.toml',
      );
      let effectiveConfig: Record<string, any> = {};
      try {
        const text = readFileSync(configPath, 'utf8');
        effectiveConfig = text.trim() ? (parse(text) as Record<string, any>) : {};
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      const servers = effectiveConfig.mcp_servers;
      effectiveConfig.mcp_servers =
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? { ...servers }
          : {};
      const awb = effectiveConfig.mcp_servers.awb;

      // ticket 702d0ebe: `-c mcp_servers.awb.http_headers=…` (dotted-path
      // 오버라이드)는 Codex 가 오버라이드를 파일의 `awb` 엔트리에 테이블
      // 병합(merge)한다고 가정한다 — npm codex-cli 0.146.0 에서는 맞지만,
      // 일부 호스트에서 PATH lookup 을 이기는 구버전 snap codex-cli
      // 0.114.0 은 대신 `mcp_servers.awb` 를 header 만 있는 테이블로
      // *통째로 치환*해 `url` 이 사라지고 config 로드가 죽는다(`invalid
      // transport in mcp_servers.awb`, exit 1 — silent subagent death).
      // 오버라이드를 FULL 테이블(기존 url/bearer_token_env_var/required +
      // 새 헤더)로 구성해, 설치된 CLI 버전과 무관하게 병합이든 치환이든
      // 어느 시맨틱에서도 유효하도록 한다.
      const overrideTable: Record<string, unknown> = {
        ...(awb && typeof awb === 'object' && !Array.isArray(awb) ? awb : {}),
        http_headers: headers,
      };
      effectiveConfig.mcp_servers.awb = overrideTable;
      // spawn 전에 Codex 가 실제로 보게 될 config 를 검증한다 — 위의
      // headers-only 케이스(파일에 완전한 `awb` 가 없는 경우)는 여전히
      // 해석 가능한 transport 가 없으므로, 원인 모를 exit 1 대신 즉시
      // 실패해야 한다.
      validateCodexMcpServers(effectiveConfig, configPath);

      attributionArgs.push('-c', `mcp_servers.awb=${inlineTomlValue(overrideTable)}`);
    }
    // `codex` with no subcommand is the interactive TUI and refuses piped
    // stdin ("stdin is not a terminal"). `codex exec` is the non-interactive
    // counterpart and reads the prompt from stdin when none is passed as
    // argv. --json gives us structured events (thread/turn/item) instead of
    // ANSI-decorated TUI output, so collectOneshotResult can extract just
    // the agent's reply. --skip-git-repo-check lets the agent run in cwd
    // that may not be a git worktree, and the bypass flag mirrors how the
    // managed-agent harness already runs claude (the manager spawns under
    // the operator's identity in a sandboxed agent home, so external
    // approvals are redundant).
    return {
      args: [
        'exec',
        ...attributionArgs,
        // Keep Codex's own workspace root identical to the OS process cwd.
        // Relying on child_process.cwd alone lets Codex re-resolve a different
        // project root, after which an assigned `.awb/wt/...` path appears to
        // be missing even though the manager created and spawned inside it.
        ...(cwd ? ['--cd', cwd] : []),
        // Per-agent default model (Agent.model). Omitted when unset so codex
        // keeps its configured default — preserves prior behaviour.
        ...(model ? ['--model', model] : []),
        '--skip-git-repo-check',
        '--json',
        ...codexPermissionArgs(permission, harness),
      ],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: (child) => {
        try {
          child.stdin?.write(fullPrompt);
          child.stdin?.end();
        } catch {
          /* spawn already failed; manager's error handler logs it */
        }
      },
    };
  }

  parseStdoutLine(line: string): ParseResult {
    // `codex exec --json` emits one JSON object per line. Common types:
    //   thread.started / turn.started / item.started — progress
    //   item.completed — a step finished; agent_message carries the reply
    //   turn.completed — the whole turn ended successfully
    //   turn.failed / error — terminal failure for this turn
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      // Non-JSON lines (codex's own startup banner like
      // "Reading prompt from stdin...", or stray rust tracing output) —
      // treat as composing-stage progress so the watchdog sees activity.
      const trimmed = String(line || '').trim();
      return {
        stage: trimmed ? PARSE_STAGE.COMPOSING : null,
        isResult: false,
        isError: false,
        raw: line,
      };
    }
    const t = obj?.type;
    const isComposing = t === 'item.completed';
    const isResult = t === 'turn.completed';
    const isError = t === 'turn.failed' || t === 'error';
    return {
      stage: isComposing ? PARSE_STAGE.COMPOSING : t ? PARSE_STAGE.THINKING : null,
      isResult,
      isError,
      raw: obj,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Walk the JSONL stream and pull out the assistant's textual replies
    // from `item.completed` events of type `agent_message`. Concatenate
    // multiple messages with blank lines between (rare, but `codex exec`
    // can emit several when the model breaks its reply into parts).
    const parts: string[] = [];
    let lastError: string | null = null;
    for (const line of Array.isArray(lines) ? lines : []) {
      let obj: any = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        const text = String(obj.item.text ?? '').trim();
        if (text) parts.push(text);
      } else if (obj.type === 'turn.failed') {
        lastError = String(obj.error?.message ?? 'codex turn failed');
      } else if (obj.type === 'error' && typeof obj.message === 'string') {
        lastError = obj.message;
      }
    }
    if (parts.length > 0) return parts.join('\n\n').replace(/^\s+|\s+$/g, '');
    if (lastError) return `[codex error] ${lastError}`;
    // Fallback: if codex emitted nothing JSON-parseable (older version,
    // unexpected output), surface raw stdout so the operator can see what
    // happened on the ticket instead of silently posting nothing.
    const raw = (Array.isArray(lines) ? lines : []).join('\n').replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  /**
   * Map a single `codex exec --json` thread event onto a normalized progress
   * signal so the subagent manager can surface a Codex chat one-shot's in-flight
   * work as `type='progress'` chat heartbeats (ticket c47194d9). Recognized:
   *   - item.started  <substantive item>          → 'start'   (작업 중)
   *   - item.completed <substantive item> ok        → 'success' (완료)
   *   - item.completed <substantive item> failed    → 'error'   (실패)
   *   - turn.failed / error                        → 'error'   (실패)
   * The reply itself (`agent_message`, and the `send_chat_room_message` MCP call
   * that delivers it) plus pure reasoning / todo noise return null so the
   * heartbeat stream never echoes the final answer. Defensive on field names
   * (Codex's item schema varies across builds) and never throws.
   */
  parseProgressEvent(raw: any): CliProgressEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw.type;
    if (t === 'turn.failed' || t === 'error') {
      const msg =
        (raw.error && typeof raw.error.message === 'string' && raw.error.message) ||
        (typeof raw.message === 'string' && raw.message) ||
        '';
      return { kind: 'other', label: '작업', detail: msg, status: 'error' };
    }
    if (t !== 'item.started' && t !== 'item.completed') return null;
    const item = raw.item;
    if (!item || typeof item !== 'object') return null;
    const itemType = typeof item.type === 'string' ? item.type : '';
    // The reply text and pure thinking / planning items are not "progress".
    if (itemType === 'agent_message' || itemType === 'reasoning' || itemType === 'todo_list') {
      return null;
    }
    // The final answer is delivered via the send_chat_room_message MCP tool —
    // that's the reply, not progress (mirrors ChatSessionManager's exclusion of
    // send_chat_room_message from Claude tool_use progress). Drop it for both
    // success and failure; a failed reply is surfaced by the manager's own
    // "응답하지 못했습니다" fallback instead.
    if (itemType === 'mcp_tool_call' && this.#isReplyTool(item)) return null;

    const failed = this.#codexItemFailed(item);
    const status: CliProgressEvent['status'] =
      t === 'item.started' ? 'start' : failed ? 'error' : 'success';
    const shaped = this.#codexProgressShape(itemType, item);
    if (!shaped) {
      // Unknown / unlabelable item type: surface only a failure, skip
      // start/success noise for shapes we can't describe meaningfully.
      return failed ? { kind: 'other', label: itemType || 'step', detail: '', status } : null;
    }
    return { ...shaped, status };
  }

  #isReplyTool(item: any): boolean {
    const name =
      (typeof item.tool === 'string' && item.tool) ||
      (typeof item.name === 'string' && item.name) ||
      '';
    return name.includes('send_chat_room_message');
  }

  #codexItemFailed(item: any): boolean {
    if (item.error != null) return true;
    if (typeof item.status === 'string' && item.status.toLowerCase() === 'failed') return true;
    if (typeof item.exit_code === 'number' && item.exit_code !== 0) return true;
    return false;
  }

  #codexProgressShape(
    itemType: string,
    item: any,
  ): { kind: CliProgressEvent['kind']; label: string; detail: string } | null {
    switch (itemType) {
      case 'command_execution': {
        const cmd =
          typeof item.command === 'string'
            ? item.command
            : Array.isArray(item.command)
              ? item.command.join(' ')
              : '';
        return { kind: 'command', label: '명령', detail: cmd };
      }
      case 'mcp_tool_call': {
        const server = typeof item.server === 'string' ? item.server : '';
        const tool =
          typeof item.tool === 'string'
            ? item.tool
            : typeof item.name === 'string'
              ? item.name
              : '';
        const label = server && tool ? `${server}:${tool}` : tool || server || 'MCP';
        return { kind: 'tool', label, detail: '' };
      }
      case 'file_change':
      case 'patch_apply': {
        return { kind: 'file', label: '파일 변경', detail: this.#codexFileDetail(item) };
      }
      case 'web_search': {
        const q = typeof item.query === 'string' ? item.query : '';
        return { kind: 'search', label: '웹 검색', detail: q };
      }
      default:
        return null;
    }
  }

  /**
   * Extract usage from a `codex exec --json` `turn.completed` event. Real
   * captured shape (ticket 6dd3f968):
   *   {"type":"turn.completed","usage":{"input_tokens":12437,
   *    "cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}
   * `cached_input_tokens` is Codex's name for what Claude calls
   * `cache_read_input_tokens` — Codex has no cache-WRITE concept, so
   * `cache_creation_input_tokens` is always null. Codex never reports a
   * dollar cost, so `total_cost_usd` is always null (v1 accepted limitation —
   * see ticket plan). `reasoning_output_tokens` is a breakdown of
   * `output_tokens`, not additive — only `output_tokens` is recorded.
   */
  extractUsage(raw: any): CliUsageSnapshot | null {
    if (!raw || typeof raw !== 'object' || raw.type !== 'turn.completed') return null;
    const usage = raw.usage;
    if (!usage || typeof usage !== 'object') return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_input_tokens: num(usage.cached_input_tokens),
      cache_creation_input_tokens: null,
      total_cost_usd: null,
    };
  }

  #codexFileDetail(item: any): string {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((c: any) => (c && typeof c.path === 'string' ? c.path : ''))
      .filter((p: string) => !!p);
    if (paths.length === 0) return typeof item.path === 'string' ? item.path : '';
    if (paths.length === 1) return paths[0];
    return `${paths[0]} 외 ${paths.length - 1}건`;
  }

  /**
   * Codex has no public `codex models` CLI command, but its official app-server
   * protocol exposes `model/list` and persists the account-aware result in
   * `$CODEX_HOME/models_cache.json`. Read that CLI-owned cache so the manager
   * can report exactly the same visible model ids as Codex's own picker,
   * without hardcoding a catalog or starting an interactive session at boot.
   */
  async listModels(): Promise<string[]> {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    try {
      const raw = await fsp.readFile(join(codexHome, 'models_cache.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.models)) return [];
      const models: string[] = parsed.models
        .filter((entry: any) => entry?.visibility !== 'hide')
        .map((entry: any) => String(entry?.slug || entry?.model || '').trim())
        .filter((model: string) => !!model);
      return [...new Set<string>(models)];
    } catch {
      return [];
    }
  }

  configDirEnv(): string {
    return 'CODEX_HOME';
  }

  authEnvKeys(): string[] {
    // OPENAI_API_KEY is what codex consults for direct-key auth; when the
    // operator set it in their shell it would shadow the per-agent
    // auth.json (subscription) or per-agent OPENAI_API_KEY (api_key kind).
    return ['OPENAI_API_KEY'];
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
    mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    const mainHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');

    // Always start from a clean slate so credential mode changes
    // (operator-default → subscription → api_key) take effect on the
    // next spawn without a leftover from the previous mode winning.
    await this.#unlinkIfPresent(join(cliHomeDir, 'auth.json'));

    if (credential && credential.provider === 'codex_subscription') {
      // Operator pasted the literal `auth.json` (and optionally `config.toml`)
      // content into the AWB UI; replay verbatim. config.toml is optional —
      // when missing we leave it absent so codex uses its compiled defaults.
      const authJson = credential.fields?.auth_json ?? '';
      const configToml = credential.fields?.config_toml ?? '';
      if (authJson) {
        await fsp.writeFile(join(cliHomeDir, 'auth.json'), authJson, { mode: 0o600 });
      }
      await this.#prepareConfig(cliHomeDir, mainHome, configToml, 'replace', mcp);
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'codex_api_key') {
      // OPENAI_API_KEY is the standard env var the codex CLI consults for
      // direct-key auth. We deliberately skip the auth.json symlink so the
      // env var path is unambiguous; config.toml stays clean too because
      // the API-key-mode operator probably doesn't want operator-side
      // model/provider tweaks bleeding into this agent.
      const apiKey = credential.fields?.api_key ?? '';
      await this.#prepareConfig(cliHomeDir, mainHome, '', 'replace', mcp);
      return { extraEnv: apiKey ? { OPENAI_API_KEY: apiKey } : {} };
    }

    // No per-agent credential — fall back to operator HOME (legacy behaviour).
    for (const name of SHARED_FROM_MAIN_HOME.filter((entry) => entry !== 'config.toml')) {
      const src = join(mainHome, name);
      const dst = join(cliHomeDir, name);
      try {
        await fsp.access(src);
      } catch {
        continue;
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
    await this.#prepareConfig(cliHomeDir, mainHome, '', 'inherit', mcp);
    return { extraEnv: {} };
  }

  async #prepareConfig(
    cliHomeDir: string,
    mainHome: string,
    providedConfig: string,
    mode: 'replace' | 'inherit',
    mcp?: AdapterMcpContext | null,
  ): Promise<void> {
    const dst = join(cliHomeDir, 'config.toml');
    const mainConfig = join(mainHome, 'config.toml');

    // awb 서버 블록은 per-agent AWB 키를 임베드하지 않는다(spawn env 의
    // `bearer_token_env_var = "AWB_API_KEY"` 에서 읽음). 따라서 apiKey 누락은
    // awb 생성을 건너뛸 이유가 못 된다 — 오직 URL 로만 게이트해야 매니저에
    // AWB 엔드포인트가 있는 한 config.toml 이 항상 완전한 awb 를 갖는다. 그렇지
    // 않으면 항상 주입되는 `-c mcp_servers.awb=…` spawn 오버라이드(ticket 702d0ebe
    // 이전엔 `-c mcp_servers.awb.http_headers`)가 transport 없는 awb 를 만들어
    // codex 가 config 로드를 중단한다(ticket 40d18474).
    // 아래 verbatim 분기는 매니저에 AWB URL 이 아예 없을 때만 실행된다.
    if (!mcp?.url) {
      await this.#unlinkIfPresent(dst);
      if (mode === 'replace') {
        if (providedConfig) {
          // verbatim 오퍼레이터 config 도 검증한다 — transport 미해결은 codex
          // config 로드를 exit 1 로 중단시키는 silent subagent exit 이다.
          validateCodexMcpServers(providedConfig.trim() ? parse(providedConfig) : {}, dst);
          await fsp.writeFile(dst, providedConfig, { mode: 0o600 });
        }
        return;
      }
      // 심링크 전에 오퍼레이터 config 텍스트를 읽어 transport 를 검증한다(원본은
      // 건드리지 않음). 파일이 없으면 배치할 config 도 없으니 그대로 반환.
      const inheritedText = await this.#readIfPresent(mainConfig);
      if (!inheritedText) return;
      validateCodexMcpServers(inheritedText.trim() ? parse(inheritedText) : {}, dst);
      try {
        await fsp.symlink(mainConfig, dst);
      } catch (err: any) {
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          await fsp.copyFile(mainConfig, dst);
        } else {
          throw err;
        }
      }
      return;
    }

    let sourceText = providedConfig;
    if (mode === 'inherit') {
      sourceText = await this.#readIfPresent(dst);
      if (!sourceText) sourceText = await this.#readIfPresent(mainConfig);
    }

    // Parse before touching dst. Invalid operator TOML remains intact and the
    // preparation error reaches the caller instead of silently losing config.
    const parsed = sourceText.trim() ? parse(sourceText) : {};
    const config: Record<string, any> = { ...parsed };
    const existingServers = config.mcp_servers;
    const mcpServers: Record<string, any> =
      existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers)
        ? { ...existingServers }
        : {};
    mcpServers.awb = {
      url: `${mcp.url.replace(/\/$/, '')}/mcp`,
      bearer_token_env_var: 'AWB_API_KEY',
      http_headers: { 'X-AWB-Client-Type': 'managed-subagent' },
      required: true,
    };
    const self = resolveSelfCommand();
    mcpServers.host = {
      command: self.command,
      args: [...self.prefixArgs, 'mcp-host'],
    };
    config.mcp_servers = mcpServers;

    // codex 가 해석 못 하는 transport 를 넘기지 않는다 — 애매한 `invalid transport`
    // config 로드 중단(silent subagent exit)을 spawn 이전의 명확한 매니저 오류로
    // 바꾼다(ticket 40d18474). dst 를 건드리기 전에 실행해, 보존된 잘못된 오퍼레이터
    // 서버가 준비된 파일을 덮어쓰지 못하게 한다.
    validateCodexMcpServers(config, dst);

    // dst may point at the operator's global config. Replace only the agent
    // path with a private regular file so managed MCP state cannot leak out.
    await this.#unlinkIfPresent(dst);
    await fsp.writeFile(dst, stringify(config), { mode: 0o600 });
  }

  async #readIfPresent(path: string): Promise<string> {
    try {
      return await fsp.readFile(path, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return '';
      throw err;
    }
  }

  async #unlinkIfPresent(path: string): Promise<void> {
    try {
      await fsp.unlink(path);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

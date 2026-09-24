// Opencode CLI adapter — stateless one-shot, credential-free, native MCP via
// per-agent `opencode.json` (opencode, https://opencode.ai, `opencode run`).
//
// Non-interactive entry point is `opencode run [message..] --format json`,
// which prints one JSON object per line (JSONL): `step_start` / `tool_use` /
// `text` / `step_finish` / `error` (event shapes verified against the
// takopi `run --format json` cheatsheet, not guessed from another CLI).
// `--model provider/model` selects the model, `--dir <cwd>` pins the project
// root (like codex `--cd`, so CLI-side root discovery cannot diverge from the
// spawn cwd), and `--auto` auto-approves permissions that are not explicitly
// denied (the trusted-tier mapping; approve/strict omit it — see below).
//
// MCP wiring is file-based: opencode reads `~/.config/opencode/opencode.json`
// (`mcp.<name>` = `{type:'remote', url, headers}` or `{type:'local',
// command}`) with MERGE semantics across global/custom/project configs, so the
// per-agent file prepareCliHome writes survives an operator-level
// OPENCODE_CONFIG overlay. Auth rides `{env:AWB_API_KEY}` header
// interpolation (the same pattern as the documented Context7 API-key example),
// never a baked secret — mirroring codex's `bearer_token_env_var` reasoning.
// The `host` local server is forked from this same manager binary
// (`mcp-host`, like codex/antigravity).
//
// Credential-free like pi: opencode provider auth (`opencode auth login` →
// `~/.local/share/opencode/auth.json`, or provider env keys) lives in the
// operator's real home. prepareCliHome symlinks that auth file into the
// per-agent HOME so a spawned agent inherits whatever the operator set up,
// without AWB ever touching a secret. There is no `opencode_*` credential
// provider and none is needed for v1.
//
// Per-dispatch MCP attribution (X-AWB-Subagent-Ticket-Id/Role, ticket
// 702d0ebe for codex) is DELIBERATELY absent: opencode has no `-c`-style
// per-spawn config override, and rewriting the per-agent file per dispatch
// would race concurrent spawns of the same agent. Static per-agent headers
// only (same posture as pi's bridge) — the server's resolveAuthorRole falls
// back to the agent's role list, exactly as it already does for pi.
//
// Permissions (ticket 5851e435): opencode has no per-tier flag — `--auto` is
// the only privilege-relevant switch. `trusted` passes `--auto`;
// `approve`/`strict` omit it (approximated: non-interactive `run` cannot
// prompt, so unapproved tool calls abort instead of hanging — restriction,
// not silence). `approve` additionally never reaches spawn: the shared
// decideApproveDispatch gate refuses it upstream (native_approvals=false).
//
// Sessions: oneshot-only for v1 (no PERSISTENT_SESSION — same as
// codex/pi/antigravity, so ticket/chat persistent managers decline and chat
// falls through to the legacy one-shot path with full history composed into
// the prompt). `buildSessionSpawn` + `hasPersistedSession` exist as the
// tested argv-level resume surface (`opencode run --session <ses_id>`):
// a `ses_`-shaped id resumes, anything else starts fresh (AWB session keys
// are NOT opencode session ids — a manager-side ses_id mapping store is the
// missing piece before persistent managers can route here, hence the
// capability stays off).

import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  type HarnessSpec,
  type OneshotSpec,
  type ParseResult,
  type SessionSpec,
  type SpawnDescriptor,
} from './base.js';
import {
  BYPASS_ONLY_PERMISSION_CAPABILITIES,
  type EffectivePermissionPolicy,
  type PermissionCapabilities,
  permissionPolicyOrDefault,
} from '../permission-policy.js';

/** `opencode run --session` ids look like `ses_...` (server-generated). An
 *  AWB session key (room/ticket composite) must NEVER be passed as-is — the
 *  CLI would reject it and the resume would fail confusingly. */
export const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

/** `opencode session list --format json` probe timeout — local DB read, so a
 *  slow response means a wedged binary, not a large result. */
const SESSION_LIST_TIMEOUT_MS = 10_000;

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * effective permission policy → opencode run flags (ticket 5851e435).
 * `--auto` auto-approves permissions that are not explicitly denied — the
 * trusted mapping. approve/strict omit it (approximated): `run` is
 * non-interactive, so there is nobody to answer an approval prompt and the
 * turn aborts on the first gated tool call instead of hanging.
 */
function opencodePermissionArgs(
  policy: EffectivePermissionPolicy | null | undefined,
  harness: { permission_mode?: string } | null | undefined,
): string[] {
  const effective = permissionPolicyOrDefault(policy, harness?.permission_mode);
  return effective.tier === 'trusted' ? ['--auto'] : [];
}

/** Role prompt + harness system_prompt_append, folded into the run message
 *  (opencode has no --append-system-prompt flag — same fold as codex). */
function composePrompt(
  rolePrompt: string,
  taskText: string,
  harness?: HarnessSpec | null,
): string {
  const parts: string[] = [];
  if (harness?.system_prompt_append?.trim()) {
    parts.push(
      `AWB managed policy:\n${harness.system_prompt_append.trim()}\nEnd AWB managed policy.`,
    );
  }
  if (rolePrompt?.trim()) parts.push(rolePrompt);
  if (taskText?.trim()) parts.push(taskText);
  return parts.join('\n\n');
}

/** `opencode models` 는 provider 조회가 붙어 느릴 수 있다 — 열거 하나가 부팅을 붙잡지 않게 한다. */
const MODEL_LIST_TIMEOUT_MS = 15_000;

export class OpencodeCliAdapter extends CliAdapter {
  static cliType = 'opencode';

  constructor() {
    super();
    // Stateless one-shot with native MCP (calls AWB itself, so the manager
    // never treats stdout as the deliverable). No PERSISTENT_SESSION:
    // `opencode run` exits after answering — there is no stdin-driven
    // stream-json session protocol to keep alive.
    this.capabilities = new Set([ADAPTER_CAPABILITIES.NATIVE_MCP]);
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('opencode', configured);
  }

  /** `opencode upgrade` — "Updates opencode to the latest version or a specific
   *  version" (opencode.ai/docs/cli). `update` 가 아니라 `upgrade` 다 —
   *  claude/codex 와 서브커맨드 이름이 갈리므로 어댑터가 알려 주는 이유 그 자체. */
  cliUpdate(): { args: string[]; label: string } | null {
    return { args: ['upgrade'], label: 'opencode upgrade' };
  }

  /**
   * `opencode models` — 한 줄에 하나씩 `provider/model` 을 찍는다. 다른 어댑터처럼
   * 설정 파일을 추측해 읽지 않고 CLI 에게 직접 묻는 이유는, opencode 의 모델 목록이
   * 로그인한 provider 에 따라 달라지고 그 계산을 아는 건 opencode 자신뿐이기 때문이다.
   *
   * 여기서 돌려주는 id 는 ACP `session/new` 의 model config option 값과 **같은 형식**이다
   * (rolf 실측: 양쪽 다 `opencode/big-pickle`). 그래서 에이전트 생성 화면에서 고른 모델을
   * 세션에도 그대로 쓸 수 있다.
   *
   * 실패(미설치·네트워크·형식 변경)는 빈 배열 — 열거는 best-effort 라 한 CLI 의 실패가
   * 다른 CLI 의 목록까지 없애면 안 된다(gatherAvailableModels 계약).
   */
  async listModels(): Promise<string[]> {
    try {
      const out = execFileSync(this.resolveBin(), ['models'], {
        encoding: 'utf8',
        timeout: MODEL_LIST_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ids = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        // 배너/빈 줄/경고를 걸러낸다 — 실제 id 는 공백 없는 `provider/model` 이다.
        .filter((line) => !!line && !/\s/.test(line) && line.includes('/'));
      return [...new Set(ids)];
    } catch {
      return [];
    }
  }

  /** model + permission_mode map onto argv; system_prompt_append folds into
   *  the run message (codex parity). allowed/disallowed_tools have no
   *  opencode flag and are warn-skipped by partitionHarness(). */
  harnessKeys(): ReadonlyArray<keyof HarnessSpec> {
    return ['system_prompt_append', 'model', 'permission_mode'];
  }

  /** opencode has a single privilege switch (`--auto`), no per-tier option —
   *  {@link BYPASS_ONLY_PERMISSION_CAPABILITIES} (ticket 5851e435). */
  permissionCapabilities(): PermissionCapabilities {
    return BYPASS_ONLY_PERMISSION_CAPABILITIES;
  }

  buildOneshotSpawn({
    rolePrompt,
    taskText,
    model,
    cwd,
    harness,
    permission,
  }: OneshotSpec): SpawnDescriptor {
    // `opencode run [message..]`: the prompt is a positional message; flags
    // first, message last (claude/codex argv order precedent). `--format
    // json` is what makes stdout machine-readable JSONL — without it the
    // output is human-formatted prose the manager cannot parse.
    return {
      args: [
        'run',
        '--format',
        'json',
        // Per-agent default model (Agent.model) in provider/model form.
        // Omitted when unset so opencode keeps its configured default.
        ...(model ? ['--model', model] : []),
        // Keep opencode's own project root identical to the OS process cwd
        // (codex `--cd` reasoning — same divergence hazard).
        ...(cwd ? ['--dir', cwd] : []),
        ...opencodePermissionArgs(permission, harness),
        composePrompt(rolePrompt, taskText, harness),
      ],
      stdio: ['ignore', 'pipe', 'pipe'],
      needsMcpConfig: false,
    };
  }

  /**
   * Argv-level session resume surface (`opencode run --session <ses_id>`).
   * Forward-compat only for v1: the adapter does NOT claim
   * PERSISTENT_SESSION, so no manager routes here yet (a manager-side store
   * mapping AWB session keys → opencode `ses_` ids is the missing piece).
   * A `ses_`-shaped id resumes; anything else (AWB composite keys included)
   * starts a FRESH session rather than failing on a foreign id.
   */
  buildSessionSpawn({
    rolePrompt,
    model,
    harness,
    permission,
    sessionMode,
    sessionId,
  }: SessionSpec): SpawnDescriptor {
    const resumeId =
      sessionMode === 'resume' && sessionId && OPENCODE_SESSION_ID_RE.test(sessionId)
        ? sessionId
        : null;
    return {
      args: [
        'run',
        '--format',
        'json',
        ...(resumeId ? ['--session', resumeId] : []),
        ...(model ? ['--model', model] : []),
        ...opencodePermissionArgs(permission, harness),
        composePrompt(rolePrompt, '', harness),
      ],
      stdio: ['ignore', 'pipe', 'pipe'],
      needsMcpConfig: false,
    };
  }

  /**
   * Best-effort `opencode session list --format json` probe. Never throws —
   * an unresolvable binary, a timeout, or an unrecognized shape all mean
   * "can't tell", i.e. false (the spawn then proceeds as a fresh session,
   * matching every other ambiguous-probe convention in this codebase).
   */
  async hasPersistedSession(
    _cliHomeDir: string | null | undefined,
    sessionId: string,
  ): Promise<boolean> {
    if (!sessionId || !OPENCODE_SESSION_ID_RE.test(sessionId)) return false;
    let bin: string;
    try {
      bin = this.resolveBin();
    } catch {
      return false;
    }
    try {
      const out = execFileSync(bin, ['session', 'list', '--format', 'json'], {
        encoding: 'utf8',
        timeout: SESSION_LIST_TIMEOUT_MS,
      });
      const parsed: unknown = JSON.parse(String(out ?? ''));
      const rows: unknown[] = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).sessions)
          ? ((parsed as Record<string, unknown>).sessions as unknown[])
          : [];
      return rows.some((row) => {
        if (!isRecord(row)) return false;
        const id = row.id ?? row.sessionID ?? row.session_id;
        return id === sessionId;
      });
    } catch {
      return false;
    }
  }

  parseStdoutLine(line: string): ParseResult {
    // `opencode run --format json` emits one JSON object per line:
    // step_start (step begins) / tool_use (a finished tool call) / text
    // (model prose) / step_finish (reason 'stop' = final, 'tool-calls' =
    // continuing) / error (terminal failure).
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      const trimmed = String(line || '').trim();
      return {
        stage: trimmed ? PARSE_STAGE.COMPOSING : null,
        isResult: false,
        isError: false,
        raw: line,
      };
    }
    if (!isRecord(obj)) {
      return { stage: null, isResult: false, isError: false, raw: obj };
    }
    const t = obj.type;
    if (t === 'error') {
      return { stage: null, isResult: false, isError: true, raw: obj };
    }
    if (t === 'step_finish') {
      // 'tool-calls' means "continuing with tool calls" — only 'stop' (or a
      // reason-less finish, treated as final like takopi does) ends the turn.
      const reason = obj.part?.reason;
      return {
        stage: null,
        isResult: reason !== 'tool-calls',
        isError: false,
        raw: obj,
      };
    }
    if (t === 'tool_use' || t === 'text') {
      return { stage: PARSE_STAGE.COMPOSING, isResult: false, isError: false, raw: obj };
    }
    if (t === 'step_start') {
      return { stage: PARSE_STAGE.THINKING, isResult: false, isError: false, raw: obj };
    }
    return { stage: null, isResult: false, isError: false, raw: obj };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Concatenate the model's `text` event prose (opencode's answer). With
    // NATIVE_MCP the manager ignores this for delivery (the CLI calls AWB
    // itself), but the same aggregation contract as codex/antigravity/pi
    // applies for diagnostics and non-native fallbacks.
    const parts: string[] = [];
    let lastError: string | null = null;
    for (const line of Array.isArray(lines) ? lines : []) {
      let obj: any = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      if (obj.type === 'text') {
        const text = str(obj.part?.text).trim();
        if (text) parts.push(text);
      } else if (obj.type === 'error') {
        const msg =
          str(obj.error?.data?.message) || str(obj.error?.message) || str(obj.message);
        lastError = msg || 'opencode run failed';
      }
    }
    if (parts.length > 0) return parts.join('\n\n').replace(/^\s+|\s+$/g, '');
    if (lastError) return `[opencode error] ${lastError}`;
    const raw = (Array.isArray(lines) ? lines : []).join('\n').replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  /**
   * Map a single `run --format json` event onto a normalized progress signal
   * (the one-shot twin of Claude's persistent tool_use progress, ticket
   * c47194d9 precedent). The CLI only emits COMPLETED tool states, so every
   * recognized tool_use is a 'success' heartbeat; step_start opens the
   * 'start' side; error closes with 'error'. The answer prose (`text`) and
   * intermediate `step_finish` (reason tool-calls) return null — heartbeat
   * noise otherwise.
   */
  parseProgressEvent(raw: any): CliProgressEvent | null {
    if (!isRecord(raw)) return null;
    if (raw.type === 'error') {
      const msg =
        str(raw.error?.data?.message) || str(raw.error?.message) || str(raw.message);
      return { kind: 'other', label: '작업', detail: msg, status: 'error' };
    }
    if (raw.type === 'step_start') {
      return { kind: 'other', label: '작업', detail: '', status: 'start' };
    }
    if (raw.type !== 'tool_use') return null;
    const part = isRecord(raw.part) ? raw.part : {};
    const tool = str(part.tool);
    if (!tool) return null;
    // The final answer is delivered via the send_chat_room_message MCP tool —
    // that's the reply, not progress (codex parity: reply-tool exclusion).
    if (tool.includes('send_chat_room_message')) return null;
    const state = isRecord(part.state) ? part.state : {};
    const failed =
      state.status === 'failed' ||
      state.status === 'error' ||
      state.error != null ||
      state.isError === true;
    const status: CliProgressEvent['status'] = failed ? 'error' : 'success';
    const shaped = this.#progressShape(tool, isRecord(state.input) ? state.input : {});
    if (!shaped) {
      return failed ? { kind: 'other', label: tool, detail: '', status } : null;
    }
    return { ...shaped, status };
  }

  #progressShape(
    tool: string,
    input: Record<string, any>,
  ): { kind: CliProgressEvent['kind']; label: string; detail: string } | null {
    const bare = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool;
    switch (bare) {
      case 'bash':
        return { kind: 'command', label: '명령', detail: str(input.command) };
      case 'read':
      case 'write':
      case 'edit':
        return {
          kind: 'file',
          label: '파일 변경',
          detail: str(input.path) || str(input.file) || str(input.filePath),
        };
      case 'glob':
        return { kind: 'search', label: '파일 검색', detail: str(input.pattern) };
      case 'grep':
        return { kind: 'search', label: '내용 검색', detail: str(input.pattern) };
      case 'webfetch':
        return { kind: 'search', label: '웹 조회', detail: str(input.url) };
      case 'websearch':
        return { kind: 'search', label: '웹 검색', detail: str(input.query) };
      case 'task':
        return { kind: 'task', label: '서브태스크', detail: str(input.description) };
      default: {
        // MCP tools (awb_* / mcp__awb__*) and anything else with a name:
        // surface server:tool so the heartbeat names the integration.
        if (/^[A-Za-z0-9_.-]+$/.test(tool)) {
          return { kind: 'tool', label: tool, detail: str(input.title) };
        }
        return null;
      }
    }
  }

  /**
   * Extract usage from a `step_finish` event. Shape (per the JSONL
   * cheatsheet): part.cost (USD) + part.tokens {input, output, reasoning,
   * cache:{read, write}}. Reasoning tokens are a breakdown of output, not
   * additive — only output_tokens is recorded (codex precedent).
   */
  extractUsage(raw: any): CliUsageSnapshot | null {
    if (!isRecord(raw) || raw.type !== 'step_finish') return null;
    const part = isRecord(raw.part) ? raw.part : null;
    if (!part) return null;
    const tokens = isRecord(part.tokens) ? part.tokens : null;
    if (!tokens) return null;
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    return {
      input_tokens: num(tokens.input),
      output_tokens: num(tokens.output),
      cache_read_input_tokens: num(cache.read),
      cache_creation_input_tokens: num(cache.write),
      total_cost_usd: num(part.cost),
    };
  }

  configDirEnv(): string {
    // opencode exposes OPENCODE_CONFIG/OPENCODE_CONFIG_DIR overrides, but
    // neither is a plain "config home" redirect with documented file
    // semantics — and provider auth (auth.json) lives outside both. HOME
    // isolation (pi/antigravity precedent) covers config
    // (~/.config/opencode/opencode.json), auth
    // (~/.local/share/opencode/auth.json) and session/data state at once.
    return 'HOME';
  }

  async prepareCliHome(
    cliHomeDir: string,
    _credential?: AdapterCredential | null,
    mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Opencode is credential-free (see file banner): always inherit the
    // operator's own `opencode auth login` state, whatever provider it was
    // set up for — never branch on a per-agent credential kind.
    const opencodeConfigDir = join(cliHomeDir, '.config', 'opencode');
    await fsp.mkdir(opencodeConfigDir, { recursive: true, mode: 0o700 });

    // Operator's real home (homedir() reads the MANAGER process identity —
    // the per-agent HOME redirect only applies to spawned children).
    const operatorHome = homedir();
    const operatorConfigPath = join(operatorHome, '.config', 'opencode', 'opencode.json');
    const operatorAuthPath = join(operatorHome, '.local', 'share', 'opencode', 'auth.json');

    // Inherit provider auth (any `opencode auth login` provider, including
    // env-key setups whose keys live outside this file — the symlink only
    // carries what the file carries, same best-effort posture as pi).
    const agentDataDir = join(cliHomeDir, '.local', 'share', 'opencode');
    await fsp.mkdir(agentDataDir, { recursive: true, mode: 0o700 });
    await this.#linkIfPresent(operatorAuthPath, join(agentDataDir, 'auth.json'));

    // Merge operator config (provider/model preferences) with the AWB MCP
    // servers. Gate the awb/host injection on url only (codex #prepareConfig
    // reasoning): the per-agent apiKey rides AWB_API_KEY env (injected on
    // every spawn by subagent/base-session managers), referenced here via
    // opencode's `{env:VAR}` header interpolation so no secret is baked.
    let config: Record<string, any> = {};
    try {
      const text = await fsp.readFile(operatorConfigPath, 'utf8');
      const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
      if (isRecord(parsed)) config = { ...parsed };
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (mcp?.url) {
      const mcpUrl = `${mcp.url.replace(/\/$/, '')}/mcp`;
      const servers: Record<string, any> = isRecord(config.mcp) ? { ...config.mcp } : {};
      servers.awb = {
        type: 'remote',
        url: mcpUrl,
        headers: {
          Authorization: 'Bearer {env:AWB_API_KEY}',
          'X-AWB-Client-Type': 'managed-subagent',
        },
        oauth: false,
        enabled: true,
      };
      const self = resolveSelfCommand();
      servers.host = {
        type: 'local',
        command: [self.command, ...self.prefixArgs, 'mcp-host'],
        enabled: true,
      };
      config.mcp = servers;
    }
    await fsp.writeFile(join(opencodeConfigDir, 'opencode.json'), JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    return { extraEnv: {} };
  }

  async #linkIfPresent(src: string, dst: string): Promise<void> {
    try {
      await fsp.access(src);
    } catch {
      return;
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
}

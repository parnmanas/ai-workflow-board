// Claude CLI adapter — argv/format/parse logic for `claude --print` and
// `claude --input-format stream-json --output-format stream-json`.

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import { scanBinaryStrings, latestPerFamily, dedupe } from './model-introspect.js';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCredential,
  type AgentCredentialMeta,
  CliAdapter,
  type CliTrustMeta,
  type CliUsageSnapshot,
  HARNESS_SPEC_KEYS,
  type HarnessSpec,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SessionSpec,
  type SpawnDescriptor,
  type TurnImage,
} from './base.js';

const { PERSISTENT_SESSION, NATIVE_MCP } = ADAPTER_CAPABILITIES;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const CLAUDE_SESSION_ID: unique symbol;
export type ClaudeSessionId = string & { readonly [CLAUDE_SESSION_ID]: true };

/**
 * Claude CLI의 `--session-id`/`--resume` 경계는 UUID만 허용한다. AWB의 room
 * key나 ticket/role 복합 key는 대화 식별자로는 유효하지만 provider session
 * id가 아니다. 기존 key는 안정적인 UUID로 변환해 재시작·동시 dispatch에서도
 * 같은 대화는 같은 provider session을, 다른 대화는 다른 session을 사용한다.
 */
export function resolveClaudeSessionId(value: string): ClaudeSessionId {
  if (UUID_PATTERN.test(value)) return value.toLowerCase() as ClaudeSessionId;

  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update('awb:claude-session:v1\0', 'utf8')
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ClaudeSessionId;
}

/** Baseline --allowedTools every AWB subagent needs to talk to the board.
 *  Harness allowed_tools entries are APPENDED — replacing the baseline would
 *  cut the spawned CLI off from the AWB MCP surface it reports through. */
const BASE_ALLOWED_TOOLS = 'mcp__awb__*,mcp__host__*';

/** Role prompt + harness system_prompt_append, joined for
 *  --append-system-prompt. Append-only: the role prompt always survives. */
function composeSystemPrompt(rolePrompt: string, harness?: HarnessSpec | null): string {
  return [rolePrompt || '', harness?.system_prompt_append || '']
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
}

function composeAllowedTools(harness?: HarnessSpec | null): string {
  const extra = (harness?.allowed_tools ?? []).filter(
    (t) => typeof t === 'string' && t.trim().length > 0,
  );
  return [BASE_ALLOWED_TOOLS, ...extra].join(',');
}

function disallowedToolsArgs(harness?: HarnessSpec | null): string[] {
  const list = (harness?.disallowed_tools ?? []).filter(
    (t) => typeof t === 'string' && t.trim().length > 0,
  );
  return list.length > 0 ? ['--disallowedTools', list.join(',')] : [];
}

/** A harness permission_mode REPLACES --dangerously-skip-permissions: the
 *  skip flag pins bypassPermissions, so passing both would make the
 *  configured mode a no-op. No permission_mode → the skip flag, exactly as
 *  before. */
function permissionArgs(harness?: HarnessSpec | null): string[] {
  const raw = harness?.permission_mode?.trim();
  const normalized = raw === 'default'
    ? 'auto'
    : raw && new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).has(raw)
      ? raw
      : null;
  return normalized
    ? ['--permission-mode', normalized]
    : ['--dangerously-skip-permissions'];
}

// Fallback ids used only when binary introspection can't read the installed
// claude executable. Kept minimal (one current id per family); the live
// per-install list from scanBinaryStrings() supersedes this whenever available.
const CLAUDE_CURATED_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
];

// Claude Code 2.1.220 embeds the newest opus/sonnet ids as major-only
// (`claude-opus-5`), while older ids may still carry a minor
// (`claude-opus-4-8`). Keep each numeric component short and require a clean
// boundary so dated ids and suffixed variants never enter latestPerFamily().
export const CLAUDE_MODEL_SCAN_PATTERN =
  /claude-(?:(?:opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?|fable-\d{1,2})(?![\w-])/g;

// Claude `--effort` accepts a fixed tier set that has shifted across CLI
// releases — the top tier used to be `xhigh`, now it's `max`. Passing a value
// the installed CLI no longer knows hard-fails the spawn outright
// (`option '--effort <level>' argument 'xhigh' is invalid`), which is exactly
// how a stale board preset took down every dispatch on a board (ticket
// 3188fd1b). So clamp before emitting the flag: known levels pass through, the
// retired `xhigh` remaps to its nearest live tier, and anything unrecognized is
// omitted so the CLI keeps its default rather than crashing the process. This
// mirrors the best-effort model handling — the CLI's option set is the moving
// target, so its churn must never hard-fail a dispatch.
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);
const CLAUDE_EFFORT_ALIASES: Record<string, string> = { xhigh: 'max' };

/** Clamp a preset effort onto what this claude CLI accepts, or null to omit
 *  `--effort` entirely (unknown/retired value → CLI default, never a spawn
 *  hard-fail). */
function normalizeEffort(effort?: string | null): string | null {
  if (!effort) return null;
  const v = String(effort).trim().toLowerCase();
  if (!v) return null;
  const mapped = CLAUDE_EFFORT_ALIASES[v] ?? v;
  return CLAUDE_EFFORT_LEVELS.has(mapped) ? mapped : null;
}

// cli_home_dir별 `.claude.json` read-modify-write 뮤텍스(아래 ensureWorkspaceTrust
// 용) — 같은 에이전트 밑에서 서로 다른 cwd로 향하는 두 동시 디스패치가 이 뮤텍스
// 없이는 공유 파일에 대한 read-modify-write를 레이스해 한쪽이 심은 entry를
// 잃어버릴 수 있다. run-provisioner.ts의 withFolderLock / WorktreeManager의
// #withPoolLock과 동일한 chained-promise 뮤텍스 모양을 그대로 따온 것 — 이
// 파일이 지키는 자원(cli-home당 JSON 파일 하나)이 claude 어댑터 로컬이라 여기에
// 별도로 둔다.
const trustSeedLocks = new Map<string, Promise<void>>();

async function withTrustSeedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = trustSeedLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const composed = prev.then(() => mine);
  trustSeedLocks.set(key, composed);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (trustSeedLocks.get(key) === composed) trustSeedLocks.delete(key);
  }
}

/**
 * 테스트 전용 드레인 훅(ticket 152e3606 리뷰 반영) — 호출 시점 기준으로
 * 대기 중이거나 진행 중인 `ensureWorkspaceTrust` 호출을 전부 기다린다.
 * event-dispatcher.ts는 bypassPermissions 티켓 디스패치에서 이 시딩을
 * 의도적으로 fire-and-forget(await 없이)으로 던진다 — await를 걸면 동시
 * 디스패치 처리 순서를 흔들기 때문이다(dispatch-inflight-guard.test.mjs
 * 참고). 그런데 그 결과로 `handleTrigger`가 resolve된 뒤에도 이 백그라운드
 * 쓰기가 남아있을 수 있어서, `afterEach`가 곧바로 cli-home 임시 디렉터리를
 * `fs.rm(recursive)`로 지우는 테스트에서는 그 삭제와 이 쓰기가 레이스해
 * `ENOTEMPTY`가 날 수 있다. 그런 테스트의 `afterEach`는 임시 디렉터리를
 * 지우기 전에 이 함수를 호출해야 한다. 실제 운영 코드는 호출하지 않는다 —
 * cli-home은 에이전트 전체 수명 동안 유지되므로 이 레이스가 사실상
 * 발생하지 않는다.
 */
export async function _drainTrustSeedLocksForTests(): Promise<void> {
  await Promise.allSettled([...trustSeedLocks.values()]);
}

export class ClaudeCliAdapter extends CliAdapter {
  static cliType = 'claude';

  constructor() {
    super();
    this.capabilities = new Set([PERSISTENT_SESSION, NATIVE_MCP]);
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('claude', configured);
  }

  /** Claude maps the full harness surface onto CLI flags. */
  harnessKeys(): ReadonlyArray<keyof HarnessSpec> {
    return HARNESS_SPEC_KEYS;
  }

  buildOneshotSpawn({ rolePrompt, taskText, mcpConfigPath, model, harness, effort, ultracode }: OneshotSpec): SpawnDescriptor {
    // Ticket-level effort preset → claude `--effort` (session-level flag).
    // Omitted when unset so the CLI keeps its default. `ultracode` is NOT a
    // flag — it's a prompt keyword: appending the literal word opts the
    // spawned Claude Code subagent into multi-agent orchestration, so it goes
    // onto the task text rather than argv.
    const finalTaskText = ultracode ? `${taskText}\n\nultracode` : taskText;
    const effortArg = normalizeEffort(effort);
    return {
      args: [
        // Per-agent default model (Agent.model) or harness/effort override —
        // spawn sites fold the precedence into `model`. Omitted when unset
        // so the CLI keeps its own default — preserves prior behaviour.
        ...(model ? ['--model', model] : []),
        ...(effortArg ? ['--effort', effortArg] : []),
        '--print',
        // 배치 전용 `json` 모드가 아니라 stream-json — 매니저의 #wireStdioCapture가
        // 실행 중에 turn별 `assistant`/tool_use 이벤트를 보게 하기 위함이다.
        // _scanForCommentTool은 그 shape만 인식하는데, NATIVE_MCP라 배치 모드의
        // 단일 종료 시점 블롭이 유일한 대안 소스이고 그마저도 exit 핸들러가 이미
        // 답을 필요로 하는 시점 이후에나 도착한다(ticket 3feaf80f). --print와
        // --output-format=stream-json을 같이 쓸 때는 CLI가 --verbose를 요구한다.
        '--verbose',
        '--output-format',
        'stream-json',
        '--mcp-config',
        mcpConfigPath ?? '',
        '--strict-mcp-config',
        '--allowedTools',
        composeAllowedTools(harness),
        '--append-system-prompt',
        composeSystemPrompt(rolePrompt, harness),
        ...disallowedToolsArgs(harness),
        ...permissionArgs(harness),
        finalTaskText,
      ],
      stdio: ['ignore', 'pipe', 'pipe'],
      needsMcpConfig: true,
    };
  }

  buildSessionSpawn({ rolePrompt, mcpConfigPath, model, harness, effort, ultracode, sessionMode, sessionId }: SessionSpec): SpawnDescriptor {
    // Session ultracode is best-effort and applied at SESSION CREATION only:
    // a persistent session has no single "task text" arg, so we fold the
    // `ultracode` keyword into the composed system prompt here. Follow-up
    // turns into the live child can't re-arm it (the flag/keyword are fixed at
    // spawn, same as harness).
    const systemPrompt = composeSystemPrompt(rolePrompt, harness);
    const finalSystemPrompt = ultracode
      ? `${systemPrompt}${systemPrompt ? '\n\n' : ''}ultracode`
      : systemPrompt;
    const effortArg = normalizeEffort(effort);
    const claudeSessionId = sessionId ? resolveClaudeSessionId(sessionId) : null;
    return {
      args: [
        ...(claudeSessionId && sessionMode === 'resume' ? ['--resume', claudeSessionId] : []),
        ...(claudeSessionId && sessionMode === 'persistent' ? ['--session-id', claudeSessionId] : []),
        ...(model ? ['--model', model] : []),
        ...(effortArg ? ['--effort', effortArg] : []),
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--mcp-config',
        mcpConfigPath ?? '',
        '--strict-mcp-config',
        '--allowedTools',
        composeAllowedTools(harness),
        '--append-system-prompt',
        finalSystemPrompt,
        ...disallowedToolsArgs(harness),
        ...permissionArgs(harness),
      ],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: true,
    };
  }

  formatTurn(text: string, images?: TurnImage[]): string {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: String(text) }];
    if (Array.isArray(images)) {
      for (const img of images) {
        if (!img || typeof img.data !== 'string' || !img.data) continue;
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type || 'image/png',
            data: img.data,
          },
        });
      }
    }
    const obj = {
      type: 'user',
      message: { role: 'user', content },
    };
    return JSON.stringify(obj);
  }

  parseStdoutLine(line: string): ParseResult {
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      /* non-JSON; manager treats as null */
    }
    if (!obj) {
      return { stage: null, isResult: false, isError: false, raw: null };
    }
    return {
      stage: obj.type === 'assistant' ? PARSE_STAGE.COMPOSING : PARSE_STAGE.THINKING,
      isResult: obj.type === 'result',
      isError: obj.is_error === true,
      raw: obj,
    };
  }

  collectOneshotResult(_lines: string[]): string | null {
    return null;
  }

  /**
   * Extract usage from a Claude `result` event — the SAME shape whether it
   * came from `--output-format json` (one-shot) or the final event of a
   * `stream-json` turn (persistent session; ticket 6dd3f968 confirmed this
   * fires once per TURN, not once per process — `base-session-manager.ts`'s
   * turn-end detection already keys off `isResult` for exactly this reason).
   * Real captured shape (auth-failure sample, all-zero but structurally
   * identical to a priced success):
   *   {"type":"result",...,"total_cost_usd":0,"usage":{"input_tokens":0,
   *    "cache_creation_input_tokens":0,"cache_read_input_tokens":0,
   *    "output_tokens":0,...}}
   * `total_cost_usd` lives at the TOP level of the event, not inside `usage`.
   */
  extractUsage(raw: any): CliUsageSnapshot | null {
    if (!raw || typeof raw !== 'object' || raw.type !== 'result') return null;
    const usage = raw.usage;
    if (!usage || typeof usage !== 'object') return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
      total_cost_usd: num(raw.total_cost_usd),
    };
  }

  /**
   * Enumerate the models this claude install accepts for `--model`. Two parts:
   *   - aliases (opus/sonnet/haiku/fable) — stable, friendly, auto-track the
   *     latest of each family; always offered.
   *   - concrete ids — extracted from the installed binary's embedded model
   *     list (per-install dynamic), reduced to the newest of each family.
   * If binary introspection yields nothing (resolution failed / unusual
   * build), fall back to a curated id set so the dropdown is still useful.
   * The returned ids are accepted by `--model` but may exceed what the
   * agent's *account* can access — the UI keeps a free-text escape hatch.
   */
  async listModels(): Promise<string[]> {
    const aliases = ['opus', 'sonnet', 'haiku', 'fable'];
    let dynamic: string[] = [];
    try {
      const bin = this.resolveBin();
      // Accept clean `family-major` and `family-major-minor` forms. Numeric
      // components are capped at 1-2 digits so dated build ids are rejected;
      // the trailing lookahead also drops -v1/-fast and compound variants.
      dynamic = latestPerFamily(await scanBinaryStrings(bin, CLAUDE_MODEL_SCAN_PATTERN));
    } catch {
      dynamic = [];
    }
    const fullNames = dynamic.length ? dynamic : CLAUDE_CURATED_MODELS;
    return dedupe([...aliases, ...fullNames]);
  }

  configDirEnv(): string {
    // Claude CLI honors CLAUDE_CONFIG_DIR; setting it redirects ~/.claude
    // (settings, plugins, projects, sessions) to the per-agent dir so
    // multi-tenant managers don't cross-contaminate state.
    return 'CLAUDE_CONFIG_DIR';
  }

  authEnvKeys(): string[] {
    // ANTHROPIC_API_KEY overrides the .credentials.json the adapter wrote
    // into the per-agent cli-home; ANTHROPIC_AUTH_TOKEN is the OAuth-bearer
    // counterpart used by some claude integrations. Both are stripped from
    // the child env when a per-agent credential is configured so the
    // operator's shell-level auth doesn't silently win.
    return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  }

  /**
   * Read `<cliHomeDir>/.credentials.json` and surface enough metadata for
   * AWB to flag agents whose OAuth token is about to expire. The file
   * shape claude writes:
   *
   *   { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
   *                        "expiresAt": <unix-ms>, ... } }
   *
   * `expiresAt` ticks forward whenever the CLI silently rotates the
   * access token (refreshToken roundtrip), so re-reading on every
   * heartbeat gives AWB a live view rather than a stale "spawn-time"
   * snapshot.
   *
   * Return values:
   *   - file present + parses + has claudeAiOauth → kind:'subscription'
   *     with `expires_at_ms` and `refresh_token_present` from the file.
   *     refresh_token absence is the more dangerous case (any expiry =
   *     hard re-auth) so we surface it explicitly.
   *   - file present + does NOT match expected shape → kind:'unknown'.
   *     Surfaces "you've pointed me at something I don't recognize"
   *     instead of silently appearing healthy.
   *   - file absent → null. Caller treats this as "api_key mode" or
   *     "operator HOME unavailable" depending on context the heartbeat
   *     provider has access to.
   *
   * Errors never throw — best-effort read; any I/O / parse failure
   * collapses to `null` so the heartbeat never wedges on credential
   * inspection.
   */
  async readCredentialMeta(cliHomeDir: string): Promise<AgentCredentialMeta | null> {
    const path = join(cliHomeDir, '.credentials.json');
    let raw: string;
    try {
      raw = await fsp.readFile(path, 'utf8');
    } catch (err: any) {
      // ENOENT is the normal "no subscription file here" case (api_key
      // mode, or operator HOME never had `claude login` run). Anything
      // else (EACCES on a permission-tightened dir, etc.) collapses
      // identically — the admin UI just sees no metadata and falls
      // through to the existing legacy display.
      if (err?.code === 'ENOENT') return null;
      return null;
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Present-but-corrupt — surface as unknown so an operator notices
      // the file exists but the manager can't read it (rather than
      // letting it look "healthy with no expiry data").
      return { kind: 'unknown', expires_at_ms: null, refresh_token_present: false };
    }
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      return { kind: 'unknown', expires_at_ms: null, refresh_token_present: false };
    }
    const expires =
      typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
        ? oauth.expiresAt
        : null;
    const refresh_token_present = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
    return { kind: 'subscription', expires_at_ms: expires, refresh_token_present };
  }

  /**
   * `permissionArgs()` above emits `--dangerously-skip-permissions` whenever
   * no harness `permission_mode` is configured, which also bypasses the
   * interactive trust dialog — Claude Code merely WARNS "this workspace has
   * not been trusted" and proceeds (observed on ticket b2e88390: a run that
   * completed 44 turns despite the warning). Any OTHER `permission_mode`
   * drops the skip flag, and the dialog becomes load-bearing — a
   * non-interactive spawn can never satisfy it, so it hangs/fails instead.
   * Mirrors `permissionArgs()`'s own branch so the two can never disagree
   * about which mode is actually active.
   */
  requiresWorkspaceTrust(harness?: HarnessSpec | null): boolean {
    return !!harness?.permission_mode && harness.permission_mode !== 'bypassPermissions';
  }

  /**
   * Read `<cliHomeDir>/.claude.json` → `projects[cwd].hasTrustDialogAccepted`
   * — the exact file/key Claude Code's own stderr names as the non-interactive
   * fix (`Run Claude Code interactively here once and accept the trust
   * dialog, or set projects["<cwd>"].hasTrustDialogAccepted: true in
   * <cli-home>/.claude.json`).
   *
   * ENOENT is a CONFIDENT negative: no config file means the CLI has never
   * recorded a trust decision for anything in this cli-home, so `cwd` is
   * certainly not trusted. Any other read/parse failure is ambiguous and
   * returns null (fail open), matching readCredentialMeta's own contract.
   */
  async readTrustMeta(cliHomeDir: string, cwd: string): Promise<CliTrustMeta | null> {
    const path = join(cliHomeDir, '.claude.json');
    let raw: string;
    try {
      raw = await fsp.readFile(path, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { trusted: false };
      return null;
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const entry = parsed?.projects?.[cwd];
    return { trusted: entry?.hasTrustDialogAccepted === true };
  }

  /**
   * `<cliHomeDir>/.claude.json`의 `projects[cwd].hasTrustDialogAccepted`를
   * 멱등하게 `true`로 설정한다(ticket 152e3606) — 근거는
   * {@link CliAdapter.ensureWorkspaceTrust} 참고. 파일의 다른 모든 키(onboarding
   * 상태, 다른 project들, MCP 설정 등)는 그대로 보존하며, 이 boolean 하나만
   * 추가하거나 뒤집는다.
   *
   * 파일이 없으면 새로 만든다(ENOENT는 readTrustMeta와 마찬가지로 "아직 보존할
   * 게 없다"는 확실한 신호). 파일은 있지만 손상된 경우엔 손대지 않고 시딩 자체를
   * 조용히 건너뛴다 — 파싱 불가능한 파일이 원래 어떤 모양이어야 했는지 알 수
   * 없으므로, 덮어쓰면 이 함수가 건드릴 이유가 없는 실제 CLI 상태(onboarding
   * 플래그, 다른 project들의 trust, MCP 서버 항목)를 파괴할 위험이 있다.
   * read-modify-write 전체가 cliHomeDir별 락 안에서 돌아가므로, 같은 에이전트의
   * 다른 cwd를 시딩하는 동시 호출이 이 쓰기를 절대 덮어쓸 수 없다.
   */
  async ensureWorkspaceTrust(cliHomeDir: string, cwd: string): Promise<void> {
    await withTrustSeedLock(cliHomeDir, async () => {
      const path = join(cliHomeDir, '.claude.json');
      let parsed: any = {};
      try {
        const raw = await fsp.readFile(path, 'utf8');
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
        parsed = {};
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
      if (!parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
        parsed.projects = {};
      }
      const existing = parsed.projects[cwd];
      const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      if (entry.hasTrustDialogAccepted === true) return;
      entry.hasTrustDialogAccepted = true;
      parsed.projects[cwd] = entry;
      // 원자적 교체(ticket 152e3606 리뷰 반영): 같은 디렉터리에 임시 파일을
      // 쓴 뒤 rename한다 — 실제 Claude CLI 프로세스도 이 파일을 자체적으로
      // 갱신할 수 있는데, in-place truncate 쓰기(`writeFile(path, ...)`)는
      // CLI의 쓰기와 겹치면 최소한 손상되거나 잘린 JSON을 읽는 리더를 만들
      // 수 있다. 같은 파일시스템 내 rename은 POSIX/Windows 모두 원자적이라
      // 어떤 리더도 완전한 이전 내용이나 완전한 새 내용만 보게 된다 — "부분
      // JSON 노출"은 이걸로 막힌다. 단, 이 in-process 뮤텍스 + rename
      // 조합으로도 진짜 lost-update까지는 못 막는다: 우리가 파일을 읽은
      // 시점과 rename하는 시점 사이에 CLI 프로세스가 같은 파일에 자체
      // 쓰기를 끼워넣으면 그 변경은 이 rename에 덮여 유실될 수 있다(진짜
      // 방지엔 flock류 OS 레벨 파일 락이 필요한데 이 용도엔 과하고 Node
      // 표준 fs만으로는 이식성 있게 구현하기도 어렵다). 이 함수는 매
      // 디스패치마다 멱등하게 재호출되므로, 그런 드문 lost-update는 다음
      // 호출에서 스스로 복구된다 — 그래서 별도 재시도 로직을 두지 않았다.
      const tmpPath = join(cliHomeDir, `.claude.json.tmp-${process.pid}`);
      try {
        await fsp.writeFile(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
        await fsp.rename(tmpPath, path);
      } catch (err) {
        await fsp.unlink(tmpPath).catch(() => {});
        throw err;
      }
    });
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Always start from a clean slate so a switch between
    // operator-default → subscription → api_key takes effect on the
    // next spawn (the previous mode's file would otherwise win).
    const dst = join(cliHomeDir, '.credentials.json');
    try {
      await fsp.unlink(dst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (credential && credential.provider === 'claude_subscription') {
      // Operator pasted the literal `.credentials.json` content into the
      // AWB UI; replay it verbatim. Mode 0600 because OAuth tokens are
      // bearer credentials at rest.
      const body = credential.fields?.credentials_json ?? '';
      if (body) {
        await fsp.writeFile(dst, body, { mode: 0o600 });
      }
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'claude_oauth_token') {
      // `claude setup-token` output — a non-rotating, ~1-year OAuth token
      // (sk-ant-oat...). Injected as CLAUDE_CODE_OAUTH_TOKEN, which the CLI
      // honors directly (auth precedence #5) WITHOUT touching the rotating
      // .credentials.json (#6) — so a single shared token registered once in
      // AWB feeds every agent-manager with no per-machine daily re-login. The
      // stale-file unlink above guarantees no .credentials.json lingers, and
      // the operator-auth strip (authEnvKeys: ANTHROPIC_API_KEY/_AUTH_TOKEN,
      // both higher precedence) runs whenever a credential is set, so the
      // OAuth token is never shadowed. Don't add CLAUDE_CODE_OAUTH_TOKEN to
      // authEnvKeys — it's the key we inject, not an operator override.
      const token = credential.fields?.oauth_token ?? '';
      return { extraEnv: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {} };
    }

    if (credential && credential.provider === 'claude_api_key') {
      // ANTHROPIC_API_KEY overrides the credentials.json path inside the
      // claude CLI; skipping the operator-HOME symlink keeps the env-var
      // path unambiguous so an operator-side `claude login` change can't
      // accidentally take precedence.
      const apiKey = credential.fields?.api_key ?? '';
      return { extraEnv: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {} };
    }

    // No per-agent credential — fall back to the operator's main HOME
    // (legacy behaviour). Source resolution mirrors constants.ts:
    // $CLAUDE_CONFIG_DIR if the operator has redirected the manager's
    // main claude home, else ~/.claude. Skip silently when the source
    // doesn't exist — the operator simply hasn't `claude login`-ed yet,
    // and claude itself will surface a clearer "not authenticated" error.
    const mainHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const src = join(mainHome, '.credentials.json');
    try {
      await fsp.access(src);
    } catch {
      return { extraEnv: {} };
    }
    try {
      await fsp.symlink(src, dst);
    } catch (err: any) {
      // Windows CreateSymbolicLink requires admin or Developer Mode;
      // without that privilege fs.symlink fails with EPERM. Fall back
      // to a plain copy — this hook reruns on every spawn, so the
      // operator's next `claude login` propagates on the next restart.
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        await fsp.copyFile(src, dst);
      } else {
        throw err;
      }
    }
    return { extraEnv: {} };
  }
}

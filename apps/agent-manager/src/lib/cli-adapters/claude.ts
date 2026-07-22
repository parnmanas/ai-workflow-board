// Claude CLI adapter — argv/format/parse logic for `claude --print` and
// `claude --input-format stream-json --output-format stream-json`.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import { scanBinaryStrings, latestPerFamily, dedupe } from './model-introspect.js';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCredential,
  type AgentCredentialMeta,
  CliAdapter,
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
  return harness?.permission_mode
    ? ['--permission-mode', harness.permission_mode]
    : ['--dangerously-skip-permissions'];
}

// Fallback ids used only when binary introspection can't read the installed
// claude executable. Kept minimal (one current id per family); the live
// per-install list from scanBinaryStrings() supersedes this whenever available.
const CLAUDE_CURATED_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
];

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

  buildSessionSpawn({ rolePrompt, mcpConfigPath, model, harness, effort, ultracode }: SessionSpec): SpawnDescriptor {
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
    return {
      args: [
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
      // Clean `family-major-minor` (opus/sonnet/haiku) or `fable-major` forms
      // only. Versions are capped at 1-2 digits so a dated build id like
      // `claude-opus-4-20250514` is rejected outright (its 8-digit "minor"
      // would otherwise sort as the newest and beat `claude-opus-4-8`). The
      // trailing lookahead also drops -v1/-fast variants.
      const pattern = /claude-(?:(?:opus|sonnet|haiku)-\d{1,2}-\d{1,2}|fable-\d{1,2})(?![\w-])/g;
      dynamic = latestPerFamily(await scanBinaryStrings(bin, pattern));
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

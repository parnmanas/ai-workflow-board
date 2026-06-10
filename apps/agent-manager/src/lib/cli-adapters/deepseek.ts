// DeepSeek adapter — runs through the SAME `claude` binary as the Claude
// adapter, but points Claude Code at DeepSeek's Anthropic-compatible
// endpoint via env vars. DeepSeek publishes an Anthropic-shaped API at
// https://api.deepseek.com/anthropic, so Claude Code drives it unchanged:
// argv, stream-json persistent sessions, and native MCP all behave exactly
// like a real Claude agent — only the backend model + auth differ.
//
// Because of that, everything except credential/env prep is inherited from
// ClaudeCliAdapter (bin resolution → `claude`, oneshot/session argv,
// formatTurn, parseStdoutLine, configDirEnv → CLAUDE_CONFIG_DIR). We only
// override how auth reaches the child:
//   - ANTHROPIC_BASE_URL  → DeepSeek's Anthropic endpoint
//   - ANTHROPIC_AUTH_TOKEN → the DeepSeek API key (NOT a .credentials.json
//                            OAuth file — DeepSeek auth is a bearer key)
//   - ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL → DeepSeek model ids

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCliAdapter } from './claude.js';
import type { AdapterCredential, AdapterMcpContext, AgentCredentialMeta } from './base.js';

/** DeepSeek's Anthropic-compatible base URL (override per-credential). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
/** Default chat model. `deepseek-reasoner` is the alternative an operator can
 *  select via the credential's `model` field. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
/** Background/"haiku-class" model Claude Code uses for cheap side tasks. */
export const DEEPSEEK_SMALL_FAST_MODEL = 'deepseek-chat';

export class DeepSeekCliAdapter extends ClaudeCliAdapter {
  static cliType = 'deepseek';

  authEnvKeys(): string[] {
    // When a per-agent deepseek credential is configured, strip ALL the
    // operator-inherited Anthropic env vars before re-injecting ours. Without
    // this, an operator-side `claude login` (ANTHROPIC_AUTH_TOKEN) or a stray
    // ANTHROPIC_BASE_URL/ANTHROPIC_MODEL would silently override the DeepSeek
    // values prepareCliHome returns, pointing the agent at the wrong backend.
    return [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
    ];
  }

  /**
   * DeepSeek auth is always an API key (bearer), never a Claude OAuth
   * `.credentials.json`. There's nothing with an expiry to surface, and the
   * inherited Claude reader would mis-report a stale file, so always return
   * the api_key shape.
   */
  async readCredentialMeta(_cliHomeDir: string): Promise<AgentCredentialMeta | null> {
    return { kind: 'api_key', expires_at_ms: null, refresh_token_present: false };
  }

  /**
   * DeepSeek runs through the claude binary but talks to DeepSeek's backend,
   * so the claude model list is meaningless here. DeepSeek publishes exactly
   * two Anthropic-compatible models; offer those instead. (Selected value is
   * injected via ANTHROPIC_MODEL, not `--model` — see prepareCliHome.)
   */
  async listModels(): Promise<string[]> {
    return [DEEPSEEK_DEFAULT_MODEL, 'deepseek-reasoner'];
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
    _mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Drop any stale Claude OAuth file a previous claude-mode spawn (or a
    // CLI switch) may have left in this cli-home — otherwise Claude Code
    // would try OAuth against the DeepSeek endpoint and fail confusingly.
    const stale = join(cliHomeDir, '.credentials.json');
    try {
      await fsp.unlink(stale);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const extraEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
      ANTHROPIC_MODEL: DEEPSEEK_DEFAULT_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: DEEPSEEK_SMALL_FAST_MODEL,
    };

    if (credential && credential.provider === 'deepseek_api_key') {
      const apiKey = credential.fields?.api_key?.trim();
      if (apiKey) extraEnv.ANTHROPIC_AUTH_TOKEN = apiKey;
      const baseUrl = credential.fields?.base_url?.trim();
      if (baseUrl) extraEnv.ANTHROPIC_BASE_URL = baseUrl;
      const model = credential.fields?.model?.trim();
      if (model) extraEnv.ANTHROPIC_MODEL = model;
    } else {
      // No per-agent credential — let an operator-level DEEPSEEK_API_KEY (or
      // DEEPSEEK_MODEL / DEEPSEEK_BASE_URL) shell var stand in. The operator's
      // ANTHROPIC_* env is NOT stripped in this branch (strip only runs when a
      // credential is set), but our base_url/model still win because extraEnv
      // is merged last into the spawn env.
      const envKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (envKey) extraEnv.ANTHROPIC_AUTH_TOKEN = envKey;
      const envBase = process.env.DEEPSEEK_BASE_URL?.trim();
      if (envBase) extraEnv.ANTHROPIC_BASE_URL = envBase;
      const envModel = process.env.DEEPSEEK_MODEL?.trim();
      if (envModel) extraEnv.ANTHROPIC_MODEL = envModel;
    }

    return { extraEnv };
  }
}

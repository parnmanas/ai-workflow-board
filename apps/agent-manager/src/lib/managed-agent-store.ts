// ─── Managed-agent on-disk store (ST-6) ─────────────────────────────
// Layout:
//   <MANAGER_HOME>/agents/<agent_id>/
//     ├── config.json        cached AWB Agent record (name, cli, working_dir)
//     ├── apikey             raw API key issued by the server provisioning
//     │                      endpoint, mode 0600. The agent-manager NEVER
//     │                      logs this verbatim — only masked.
//     └── mcp-config.json    `claude --mcp-config` shape, embeds the apiKey
//                            so spawned subagents authenticate as the
//                            managed agent (not the manager). mode 0600.
//
// Per-agent subagent logs go to MANAGER_HOME/agents/<id>/subagent.log via
// the SubagentManager (created lazily when the first spawn happens).
//
// Everything in this module is best-effort idempotent: ensure-dir is a
// no-op when the dir already exists, write* functions overwrite cleanly,
// read* functions return null for "missing" so callers can branch on
// "do we need to provision a fresh apiKey".

import { promises as fsp } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_AGENTS_DIR } from './constants.js';
import { resolveSelfCommand } from './self-path.js';
import type { AgentRuntimeConfig } from './runtime/runtime-types.js';

export interface ManagedAgentDiskConfig {
  agent_id: string;
  name: string;
  cli: string;
  working_dir: string;
  workspace_id?: string;
  /** Per-agent default model (Agent.model). Persisted so a manager restart
   *  rehydrates the same model without re-fetching from AWB. */
  model?: string | null;
  /** Explicit runtime strategy and permission policy persisted for restart. */
  runtime_config?: AgentRuntimeConfig | null;
  /** ISO timestamp of the last successful spawn_agent on this manager. */
  last_spawn_at?: string;
}

export function managedAgentDir(agentId: string): string {
  return join(MANAGED_AGENTS_DIR, agentId);
}

export function configPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'config.json');
}

function workspaceSuffix(workspaceId?: string): string {
  const scope = String(workspaceId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return scope ? `.${scope}` : '';
}

export function apiKeyPathFor(agentId: string, workspaceId?: string): string {
  return join(managedAgentDir(agentId), `apikey${workspaceSuffix(workspaceId)}`);
}

// Ticket ee26302d review round 2 (P1): 'compact' gets its own path so two
// concurrently-spawning sessions of DIFFERENT profiles for the same agent
// can never share one mutable file to race on — see mcpConfigPathFor's doc
// comment. 'full' (the default/omitted case) keeps the pre-existing
// unsuffixed path unchanged for backward compatibility with every caller
// that doesn't know about tool profiles at all.
function profileSuffix(profile?: 'full' | 'compact'): string {
  return profile === 'compact' ? '.compact' : '';
}

/**
 * Ticket ee26302d review round 2 (P1): `profile` used to be irrelevant here
 * — a single shared path served every non-pinned session regardless of its
 * resolved tool profile, and the caller (base-session-manager.ts /
 * subagent-manager.ts) rewrote it in place when the wanted profile didn't
 * match what was last written. That worked for strictly SEQUENTIAL spawns
 * but not concurrent ones: a full-profile CLI can still be starting up
 * (reading its `--mcp-config` file is not synchronous with the spawn() call
 * returning) when a compact-profile spawn for the same agent rewrites the
 * same path underneath it, or vice versa — there is no handshake confirming
 * a child already read the file before the next spawn is allowed to write
 * it again.
 *
 * Fixed structurally: each profile gets its own path, so concurrent spawns
 * of DIFFERENT profiles for the same agent can never collide on one file.
 * Two concurrent spawns of the SAME profile can still both decide "doesn't
 * exist yet" and both write — harmless, since both write byte-identical
 * content for the same (agentId, workspaceId, profile).
 */
export function mcpConfigPathFor(agentId: string, workspaceId?: string, profile?: 'full' | 'compact'): string {
  return join(managedAgentDir(agentId), `mcp-config${workspaceSuffix(workspaceId)}${profileSuffix(profile)}.json`);
}

export function credentialPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'credential.json');
}

export interface ManagedAgentCredential {
  /** AWB Credential row id — diagnostic only; the manager doesn't talk back. */
  credential_id: string;
  /** Credential.provider — one of `claude_subscription` / `claude_api_key` /
   *  `codex_subscription` / `codex_api_key` / `antigravity_subscription` /
   *  `antigravity_api_key`. The manager validates that the prefix matches the
   *  agent's CLI before applying — a mismatch silently falls through to
   *  legacy operator-HOME behaviour. */
  provider: string;
  /** Decrypted credential payload. Field set varies by provider — see
   *  PROVIDER_FIELDS in apps/server/src/modules/credentials/credentials.controller.ts. */
  fields: Record<string, string>;
}

export async function readAgentCredential(agentId: string): Promise<ManagedAgentCredential | null> {
  const path = credentialPathFor(agentId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.provider !== 'string' || !raw.provider) return null;
    return {
      credential_id: typeof raw.credential_id === 'string' ? raw.credential_id : '',
      provider: raw.provider,
      fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {},
    };
  } catch {
    return null;
  }
}

export async function writeAgentCredential(
  agentId: string,
  credential: ManagedAgentCredential,
): Promise<void> {
  await ensureManagedAgentDir(agentId);
  await fsp.writeFile(credentialPathFor(agentId), JSON.stringify(credential, null, 2), { mode: 0o600 });
}

export async function eraseAgentCredential(agentId: string): Promise<void> {
  await fsp.unlink(credentialPathFor(agentId)).catch(() => undefined);
}

export function subagentLogPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'subagent.log');
}

/**
 * Per-agent CLI home directory. The manager points the spawned CLI at
 * this path via its config-dir env var (CLAUDE_CONFIG_DIR / GEMINI_HOME
 * / CODEX_HOME) so each managed agent's CLI state — sessions, plugins,
 * settings — stays isolated. Directory is created lazily on first
 * spawn_agent so we don't litter empty dirs for agents that never run.
 */
export function cliHomeDirFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'cli-home');
}

/** mkdir -p (0700) for the per-agent CLI home. Idempotent. */
export async function ensureCliHomeDir(agentId: string): Promise<string> {
  const dir = cliHomeDirFor(agentId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** mkdir -p with 0700 perms; safe to call repeatedly. */
export async function ensureManagedAgentDir(agentId: string): Promise<string> {
  const dir = managedAgentDir(agentId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readManagedAgentConfig(agentId: string): Promise<ManagedAgentDiskConfig | null> {
  const path = configPathFor(agentId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && raw.agent_id === agentId) {
      return raw as ManagedAgentDiskConfig;
    }
  } catch {
    // Treat malformed config as "no config" — caller will rewrite.
  }
  return null;
}

export async function writeManagedAgentConfig(cfg: ManagedAgentDiskConfig): Promise<void> {
  await ensureManagedAgentDir(cfg.agent_id);
  await fsp.writeFile(configPathFor(cfg.agent_id), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export async function readApiKey(agentId: string, workspaceId?: string): Promise<string | null> {
  const path = apiKeyPathFor(agentId, workspaceId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Read the workspace-scoped key used during managed-agent rehydration.
 *
 * Versions before workspace-scoped global agents stored the only key at
 * `apikey`. During the first restart after upgrading, config.json already has
 * a workspace_id but the scoped key does not exist yet. Treat that unscoped
 * key as belonging to the persisted workspace and copy it forward. This is
 * intentionally separate from readApiKey(): normal cross-workspace dispatch
 * must provision a new key instead of reusing the legacy credential.
 */
export async function readApiKeyForRehydrate(
  agentId: string,
  workspaceId?: string,
): Promise<string | null> {
  const scoped = await readApiKey(agentId, workspaceId);
  if (scoped || !workspaceId) return scoped;

  const legacy = await readApiKey(agentId);
  if (!legacy) return null;

  await writeApiKey(agentId, legacy, workspaceId);
  return legacy;
}

export async function writeApiKey(agentId: string, raw: string, workspaceId?: string): Promise<void> {
  await ensureManagedAgentDir(agentId);
  await fsp.writeFile(apiKeyPathFor(agentId, workspaceId), raw, { mode: 0o600 });
}

/**
 * Generate the `claude --mcp-config` JSON for this agent. We write it to
 * disk eagerly (rather than per-spawn) because (a) it doesn't change unless
 * the apiKey rotates, and (b) per-spawn temp files have to be cleaned up
 * across crash/restart whereas a fixed path is just an overwrite.
 *
 * Two MCP servers are configured:
 *
 *   - `awb`: the central AWB Streamable HTTP endpoint (`/mcp`). Per-agent
 *     apiKey in the Bearer header so server-side activity logs attribute
 *     every tool call to this managed agent. `X-AWB-Client-Type:
 *     managed-subagent` distinguishes manager-spawned subagents from direct
 *     MCP clients.
 *
 *   - `host`: a stdio MCP server forked from the agent-manager binary
 *     itself (`<this-binary> mcp-host`). Exposes cross-OS host tools
 *     (screenshot, window enumeration, send keys, kill / launch process,
 *     clipboard, etc.) that let the managed agent drive the operator's
 *     desktop when a GUI tool like Unity Editor stalls. The server runs
 *     ON THE OPERATOR'S HOST — not the central AWB server — and inherits
 *     the manager process's user permissions.
 *
 *     Tool surface becomes `mcp__host__*` on the managed-agent side.
 *     Claude's `--allowedTools` allowlist already includes both
 *     `mcp__awb__*` and `mcp__host__*` (see cli-adapters/claude.ts).
 */
export async function writeMcpConfig(
  agentId: string,
  awbUrl: string,
  rawApiKey: string,
  workspaceId?: string,
  // Ticket ee26302d: extra MCP session headers, e.g.
  // resolveToolProfileHeader(claudeRuntimeProfile)'s `{'X-AWB-Tool-Profile':
  // 'compact'}` for a small-context Claude backend. Omitted by every caller
  // that doesn't have a resolved backend profile in scope — see this
  // function's callers for which ones do.
  extraHeaders?: Record<string, string>,
): Promise<string> {
  await ensureManagedAgentDir(agentId);
  // Ticket ee26302d review round 2: write target is profile-specific (see
  // mcpConfigPathFor's doc comment) — derived from extraHeaders so callers
  // don't have to separately track/pass the profile.
  const profile = extraHeaders?.['X-AWB-Tool-Profile'] === 'compact' ? 'compact' : 'full';
  const path = mcpConfigPathFor(agentId, workspaceId, profile);
  const self = resolveSelfCommand();
  const body = {
    mcpServers: {
      awb: {
        type: 'http',
        url: `${awbUrl.replace(/\/$/, '')}/mcp`,
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'X-AWB-Client-Type': 'managed-subagent',
          ...extraHeaders,
        },
      },
      host: {
        type: 'stdio',
        command: self.command,
        args: [...self.prefixArgs, 'mcp-host'],
      },
    },
  };
  await fsp.writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  return path;
}

/**
 * Reads an existing mcp-config.json's `awb` server headers and returns its
 * current `X-AWB-Tool-Profile` value (or `undefined` if absent/unreadable).
 *
 * Ticket ee26302d review round 1 (P1): callers that reuse a shared static
 * config across sessions with different resolved profiles cannot assume the
 * file's PAST content matches THIS session's desired profile just because
 * this session doesn't want 'compact' — a prior compact session may have
 * left that header stamped on the shared file. Compare this against the
 * caller's own desired header value before deciding to reuse-as-is vs
 * rewrite.
 */
export async function readMcpConfigToolProfile(path: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers?.awb?.headers?.['X-AWB-Tool-Profile'];
  } catch {
    return undefined;
  }
}

/** 관리형 Agent가 실제로 전달받는 MCP 설정의 서버 이름만 읽는다. */
export async function readMcpConfigServerNames(path: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
    return Object.keys(servers).sort();
  } catch {
    return [];
  }
}

/** Remove the on-disk apiKey + mcp-config for an agent (e.g., on stop).
 *  Also clears the per-agent CLI credential snapshot — on the next spawn the
 *  manager re-fetches it from AWB so a credential-rotation in the AWB UI
 *  takes effect without leaving a stale copy on this host. */
export async function eraseSecrets(agentId: string): Promise<void> {
  const dir = managedAgentDir(agentId);
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const scopedSecrets = names
    .filter(name => name === 'apikey' || name.startsWith('apikey.') || name === 'mcp-config.json' || name.startsWith('mcp-config.'))
    .map(name => fsp.unlink(join(dir, name)));
  await Promise.allSettled([...scopedSecrets, fsp.unlink(credentialPathFor(agentId))]);
}

/** Convenience: redact an apiKey for log output. Mirrors api-key.service. */
export function maskKey(raw: string): string {
  if (!raw) return '';
  if (raw.length <= 12) return raw.slice(0, 4) + '***';
  return raw.slice(0, 8) + '***' + raw.slice(-4);
}

/**
 * Enumerate managed-agent directories that exist on disk. Used by the
 * manager bootstrap to rehydrate AgentContexts after a restart so events
 * for previously-spawned managed agents resume routing without the admin
 * having to click Spawn again. Returns agent_ids only — caller is
 * responsible for reading config.json + apikey and validating that they
 * form a usable context (a half-written dir is silently skipped).
 */
export async function listManagedAgentDirs(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(MANAGED_AGENTS_DIR);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(MANAGED_AGENTS_DIR, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) continue;
      // Loose UUID-ish check — directories that aren't agent ids
      // shouldn't make it in here, but guard anyway. Falls back to
      // "config.json present" as the source of truth so a non-uuid
      // agent id doesn't get silently dropped.
      const cfg = configPathFor(name);
      if (existsSync(cfg)) out.push(name);
    } catch {
      /* permission / vanished — skip */
    }
  }
  return out;
}

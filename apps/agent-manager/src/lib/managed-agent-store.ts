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

export interface ManagedAgentDiskConfig {
  agent_id: string;
  name: string;
  cli: string;
  working_dir: string;
  workspace_id?: string;
  /** ISO timestamp of the last successful spawn_agent on this manager. */
  last_spawn_at?: string;
}

export function managedAgentDir(agentId: string): string {
  return join(MANAGED_AGENTS_DIR, agentId);
}

export function configPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'config.json');
}

export function apiKeyPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'apikey');
}

export function mcpConfigPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'mcp-config.json');
}

export function credentialPathFor(agentId: string): string {
  return join(managedAgentDir(agentId), 'credential.json');
}

export interface ManagedAgentCredential {
  /** AWB Credential row id — diagnostic only; the manager doesn't talk back. */
  credential_id: string;
  /** Credential.provider — one of `claude_subscription` / `claude_api_key` /
   *  `codex_subscription` / `codex_api_key` / `gemini_subscription` /
   *  `gemini_api_key`. The manager validates that the prefix matches the
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

export async function readApiKey(agentId: string): Promise<string | null> {
  const path = apiKeyPathFor(agentId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export async function writeApiKey(agentId: string, raw: string): Promise<void> {
  await ensureManagedAgentDir(agentId);
  await fsp.writeFile(apiKeyPathFor(agentId), raw, { mode: 0o600 });
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
 *     managed-subagent` distinguishes manager-spawned subagents from
 *     legacy plugin spawns.
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
): Promise<string> {
  await ensureManagedAgentDir(agentId);
  const path = mcpConfigPathFor(agentId);
  const self = resolveSelfCommand();
  const body = {
    mcpServers: {
      awb: {
        type: 'http',
        url: `${awbUrl.replace(/\/$/, '')}/mcp`,
        headers: {
          Authorization: `Bearer ${rawApiKey}`,
          'X-AWB-Client-Type': 'managed-subagent',
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

/** Remove the on-disk apiKey + mcp-config for an agent (e.g., on stop).
 *  Also clears the per-agent CLI credential snapshot — on the next spawn the
 *  manager re-fetches it from AWB so a credential-rotation in the AWB UI
 *  takes effect without leaving a stale copy on this host. */
export async function eraseSecrets(agentId: string): Promise<void> {
  await Promise.allSettled([
    fsp.unlink(apiKeyPathFor(agentId)),
    fsp.unlink(mcpConfigPathFor(agentId)),
    fsp.unlink(credentialPathFor(agentId)),
  ]);
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

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
 * The `mcpServers.awb` shape mirrors what the legacy plugin's
 * SubagentManager wrote per-spawn, with the addition of an
 * `X-AWB-Client-Type: managed-subagent` header so server-side logs can
 * distinguish manager-spawned subagents from old-plugin-spawned ones.
 */
export async function writeMcpConfig(
  agentId: string,
  awbUrl: string,
  rawApiKey: string,
): Promise<string> {
  await ensureManagedAgentDir(agentId);
  const path = mcpConfigPathFor(agentId);
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
    },
  };
  await fsp.writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  return path;
}

/** Remove the on-disk apiKey + mcp-config for an agent (e.g., on stop). */
export async function eraseSecrets(agentId: string): Promise<void> {
  await Promise.allSettled([
    fsp.unlink(apiKeyPathFor(agentId)),
    fsp.unlink(mcpConfigPathFor(agentId)),
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

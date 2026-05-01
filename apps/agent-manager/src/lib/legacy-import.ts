// First-run import of the claude-plugin daemon's config so existing users do
// not have to re-pair when they switch to the standalone agent-manager.
//
// Source: ~/.claude/channels/awb/{config.json,agent.json}
// Target: $XDG_CONFIG_HOME/awb-agent-manager/{config.json,agent.json}
//         (or platform equivalent — see constants.configBaseDir).
//
// Behavior:
//   - Idempotent. Re-running the manager never re-imports.
//   - Skips entirely if the new config.json already exists.
//   - Skips entirely if the legacy directory is missing or has no config.json.
//   - When it does import, it writes a marker file (MIGRATED-TO-AGENT-MANAGER.txt)
//     into the legacy directory so the user can spot it later, and so
//     subsequent runs can shortcut even if the new config is wiped.
//   - Never deletes legacy files — the plugin's stdio MCP proxy may still rely
//     on them for as long as the user keeps it installed.
//
// Lockfile (agent.lock) is intentionally NOT copied: it is process-state, not
// config, and the runtime checks the legacy lock separately to avoid conflicts
// with a still-running plugin daemon.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  AGENT_MANAGER_HOME,
  AGENT_PATH,
  CONFIG_PATH,
  LEGACY_AGENT_PATH,
  LEGACY_CONFIG_PATH,
  LEGACY_MIGRATION_MARKER,
  LEGACY_PLUGIN_HOME,
} from './constants.js';
import { log } from './logging.js';

export interface LegacyImportResult {
  imported: boolean;
  skipped_reason?:
    | 'new_config_exists'
    | 'no_legacy_config'
    | 'already_migrated'
    | 'copy_failed';
  copied: { config: boolean; agent: boolean };
  source: { config: string; agent: string };
  target: { config: string; agent: string };
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* race / permission — fail later when we try to write */
  }
}

function writeMarker(): void {
  const body =
    `agent-manager imported config from this directory at ${new Date().toISOString()}\n` +
    `Target: ${AGENT_MANAGER_HOME}\n\n` +
    `This directory is now legacy and is only consulted by the claude-plugin\n` +
    `stdio MCP proxy. Standalone runtime state lives at the target path above.\n` +
    `Do NOT delete this directory while the claude-plugin is still installed.\n`;
  try {
    writeFileSync(LEGACY_MIGRATION_MARKER, body);
  } catch (err: any) {
    log(`legacy-import: marker write failed (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * Best-effort import. Always returns a result; never throws.
 * Call once at startup, before loadConfig().
 */
export function importLegacyConfig(): LegacyImportResult {
  const result: LegacyImportResult = {
    imported: false,
    copied: { config: false, agent: false },
    source: { config: LEGACY_CONFIG_PATH, agent: LEGACY_AGENT_PATH },
    target: { config: CONFIG_PATH, agent: AGENT_PATH },
  };

  if (existsSync(CONFIG_PATH)) {
    result.skipped_reason = 'new_config_exists';
    return result;
  }
  if (existsSync(LEGACY_MIGRATION_MARKER)) {
    result.skipped_reason = 'already_migrated';
    return result;
  }
  if (!existsSync(LEGACY_CONFIG_PATH)) {
    result.skipped_reason = 'no_legacy_config';
    return result;
  }

  try {
    ensureDir(dirname(CONFIG_PATH));
    copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    result.copied.config = true;
  } catch (err: any) {
    log(`legacy-import: copy ${LEGACY_CONFIG_PATH} failed: ${err?.message ?? err}`);
    result.skipped_reason = 'copy_failed';
    return result;
  }

  if (existsSync(LEGACY_AGENT_PATH)) {
    try {
      ensureDir(dirname(AGENT_PATH));
      copyFileSync(LEGACY_AGENT_PATH, AGENT_PATH);
      result.copied.agent = true;
    } catch (err: any) {
      log(
        `legacy-import: copy ${LEGACY_AGENT_PATH} failed (non-fatal): ${err?.message ?? err}`,
      );
    }
  }

  writeMarker();
  result.imported = true;
  log(
    `legacy-import: imported config from ${LEGACY_PLUGIN_HOME} ` +
      `(config=${result.copied.config ? 'yes' : 'no'} agent=${result.copied.agent ? 'yes' : 'no'})`,
  );
  return result;
}

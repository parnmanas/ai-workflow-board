// Resolves an agent CLI's binary to an absolute executable path so spawn()
// doesn't depend on the inherited PATH.
//
// Resolution strategy (per CLI, first hit wins):
//   1. Explicit absolute path passed by adapter (`configured` arg)
//   2. Parent process exe (Linux /proc/{ppid}/exe — only useful for claude
//      legacy proxy use)
//   3. `command -v <name>` / `where <name>` shell lookup
//   4. Per-CLI well-known install paths (windows / unix candidates)
//   5. Fallback: literal CLI name (will ENOENT; caller's spawn error
//      listener absorbs it)
//
// Memory pin (`feedback_windows_claude_exe_only`): Windows resolution must
// reject `.cmd`/`.ps1` shims and the MSYS bash wrapper that ship next to the
// .exe — those don't spawn reliably. The Windows gate (WIN_EXEC_EXT) is
// preserved verbatim from the original claude-only resolver.

import { execSync } from 'node:child_process';
import { accessSync, constants as fsConstants, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { KNOWN_CLI_TYPES } from './constants.js';
import { log } from './logging.js';

const isWindows = process.platform === 'win32';
const WIN_EXEC_EXT = /\.exe$/i;

function canExec(p: string | null | undefined): p is string {
  if (!p) return false;
  if (isWindows && !WIN_EXEC_EXT.test(p)) return false;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface CandidateProvider {
  unix: (home: string) => string[];
  windows: (home: string) => string[];
}

const CANDIDATE_PROVIDERS: Record<string, CandidateProvider> = {
  claude: { unix: claudeUnixCandidates, windows: claudeWindowsCandidates },
  agy: { unix: agyUnixCandidates, windows: agyWindowsCandidates },
  codex: { unix: codexUnixCandidates, windows: codexWindowsCandidates },
};

function parentExeMatching(nameRegex: RegExp): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const exe = readlinkSync(`/proc/${ppid}/exe`);
    if (!exe || !canExec(exe)) return null;
    if (/\.vscode\/extensions\//.test(exe)) return null;
    if (!nameRegex.test(basename(exe))) return null;
    return exe;
  } catch {
    return null;
  }
}

const cache = new Map<string, string>();

export function resolveCliBin(cliType: string, configured?: string | null): string {
  const ct = String(cliType || 'claude').toLowerCase();
  const cached = cache.get(ct);
  if (cached) return cached;

  if (configured && configured !== ct) {
    // Defense: if `configured` is the literal name of a *different* known
    // CLI (e.g. "claude" passed for codex), it's almost certainly the
    // legacy `delegation.claudeBin` default leaking through. Ignore it
    // and fall through to normal lookup so codex / antigravity spawns find
    // their actual binary instead of launching claude with foreign argv.
    if ((KNOWN_CLI_TYPES as readonly string[]).includes(configured)) {
      log(
        `[cli-resolver:${ct}] ignoring configured="${configured}" — it names a different known CLI; falling through to lookup`,
      );
    } else {
      cache.set(ct, configured);
      log(`[cli-resolver:${ct}] using configured path: ${configured}`);
      return configured;
    }
  }

  if (ct === 'claude') {
    const viaParent = parentExeMatching(/claude/i);
    if (viaParent) {
      cache.set(ct, viaParent);
      log(`[cli-resolver:claude] resolved via parent /proc/${process.ppid}/exe: ${viaParent}`);
      return viaParent;
    }
  }

  try {
    const cmd = isWindows
      ? `where ${ct}`
      : `command -v ${ct} 2>/dev/null || which ${ct} 2>/dev/null`;
    const out = execSync(cmd, {
      encoding: 'utf8',
      timeout: 2000,
      shell: isWindows ? undefined : '/bin/sh',
    }).trim();
    const lines = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const cand of lines) {
      if (canExec(cand)) {
        cache.set(ct, cand);
        log(`[cli-resolver:${ct}] resolved via shell: ${cand}`);
        return cand;
      }
    }
  } catch {
    /* shell or spawn failed — keep trying */
  }

  const provider = CANDIDATE_PROVIDERS[ct];
  if (provider) {
    const home = homedir();
    const candidates = isWindows ? provider.windows(home) : provider.unix(home);
    for (const p of candidates) {
      if (canExec(p)) {
        cache.set(ct, p);
        log(`[cli-resolver:${ct}] resolved via candidate: ${p}`);
        return p;
      }
    }
  }

  cache.set(ct, ct);
  log(
    `[cli-resolver:${ct}] resolution failed; falling back to literal "${ct}" (expect ENOENT unless PATH is set)`,
  );
  return ct;
}

export function _resetResolverCache(): void {
  cache.clear();
}

function claudeUnixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/claude'),
    join(home, '.bun/bin/claude'),
    join(home, '.local/bin/claude'),
    join(home, '.volta/bin/claude'),
    join(home, '.npm-packages/bin/claude'),
    join(home, 'node_modules/.bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
}

function claudeWindowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const pkgBin = join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  return [
    join(pkgBin, 'claude.exe'),
    join(appdata, 'npm', 'claude.exe'),
    join(localAppData, 'Programs', 'anthropic', 'claude-code', 'claude.exe'),
  ];
}

function agyUnixCandidates(home: string): string[] {
  return [
    join(home, '.local/bin/agy'),
    join(home, '.npm-global/bin/agy'),
    join(home, '.bun/bin/agy'),
    join(home, '.volta/bin/agy'),
    join(home, '.npm-packages/bin/agy'),
    join(home, 'node_modules/.bin/agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    '/usr/bin/agy',
  ];
}

function agyWindowsCandidates(home: string): string[] {
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return [
    join(localAppData, 'Antigravity', 'agy.exe'),
    join(localAppData, 'Programs', 'google', 'antigravity', 'agy.exe'),
  ];
}

function codexUnixCandidates(home: string): string[] {
  return [
    join(home, '.npm-global/bin/codex'),
    join(home, '.bun/bin/codex'),
    join(home, '.local/bin/codex'),
    join(home, '.volta/bin/codex'),
    join(home, '.npm-packages/bin/codex'),
    join(home, 'node_modules/.bin/codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
  ];
}

function codexWindowsCandidates(home: string): string[] {
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const pkgBin = join(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin');
  return [
    join(pkgBin, 'codex.exe'),
    join(appdata, 'npm', 'codex.exe'),
    join(localAppData, 'Programs', 'openai', 'codex', 'codex.exe'),
  ];
}

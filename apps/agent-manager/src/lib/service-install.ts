// ─── systemd service installer (ST-7) ───────────────────────────────
// `awb-agent-manager service install` — registers the manager as a
// systemd service so it starts on boot and auto-restarts on crash.
// Two modes:
//   - user mode (default): `~/.config/systemd/user/awb-agent-manager.service`,
//     no sudo needed, but requires `loginctl enable-linger` for the
//     service to run when the user is not logged in.
//   - system mode (--system): `/etc/systemd/system/awb-agent-manager.service`,
//     needs sudo, runs as the invoking user via User= directive.
//
// Generated unit:
//   - ExecStart points at `node <abs-path>/dist/main.js` (resolved at
//     install time so `git pull` keeps working without re-installing).
//   - Restart=on-failure, RestartSec=5, TimeoutStopSec=30.
//   - Environment passes AWB_AGENT_MANAGER_HOME if set on caller.

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'awb-agent-manager';

export interface ServiceInstallOptions {
  /** When true, write to /etc/systemd/system/. Default: user mode. */
  system?: boolean;
  /** Override the absolute path to dist/main.js. Default: caller's location. */
  execPath?: string;
  /** Print the unit + commands without running them. */
  dryRun?: boolean;
  /** Don't fail when systemd is missing — just write the unit file and stop. */
  unitOnly?: boolean;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim() || null;
  return null;
}

function systemdAvailable(): boolean {
  return !!which('systemctl');
}

function detectExecPath(override?: string): string {
  if (override) return pathResolve(override);
  // Walk up from this module to find dist/main.js. setup.ts compiled to
  // dist/lib/setup.js; sibling main.js is dist/main.js.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = pathResolve(here, '..', 'main.js');
  return candidate;
}

function detectNode(): string {
  return process.execPath;
}

function unitContent(opts: { execPath: string; nodeBin: string; user: string; isSystem: boolean }): string {
  const { execPath, nodeBin, user, isSystem } = opts;
  const envHome = process.env.AWB_AGENT_MANAGER_HOME;
  const userDirective = isSystem ? `User=${user}\n` : '';
  const envLines = envHome ? `Environment=AWB_AGENT_MANAGER_HOME=${envHome}\n` : '';
  return `[Unit]
Description=AWB Agent Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${execPath}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
${userDirective}${envLines}KillSignal=SIGTERM

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}
`;
}

export interface ServiceInstallResult {
  ok: true;
  unitPath: string;
  mode: 'user' | 'system';
  enabled: boolean;
  started: boolean;
  notes: string[];
}

export async function installService(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
  const isSystem = !!options.system;
  const execPath = detectExecPath(options.execPath);
  const nodeBin = detectNode();
  const user = userInfo().username;

  if (!existsSync(execPath)) {
    throw new Error(
      `dist/main.js not found at ${execPath} — run \`npm run build\` first, ` +
        `or pass --exec-path <path>.`,
    );
  }

  const unit = unitContent({ execPath, nodeBin, user, isSystem });

  const unitPath = isSystem
    ? `/etc/systemd/system/${SERVICE_NAME}.service`
    : `${homedir()}/.config/systemd/user/${SERVICE_NAME}.service`;

  process.stderr.write('\n  awb-agent-manager — service install\n\n');
  process.stderr.write(`    mode:       ${isSystem ? 'system (sudo)' : 'user'}\n`);
  process.stderr.write(`    exec:       ${nodeBin} ${execPath}\n`);
  process.stderr.write(`    unit:       ${unitPath}\n`);
  process.stderr.write(`    user:       ${user}\n\n`);

  if (options.dryRun) {
    process.stderr.write('  --dry-run: would write the following unit (skipping systemctl):\n\n');
    process.stderr.write(unit.split('\n').map((l) => `    ${l}`).join('\n'));
    process.stderr.write('\n');
    return { ok: true, unitPath, mode: isSystem ? 'system' : 'user', enabled: false, started: false, notes: ['dry-run'] };
  }

  // Write the unit file.
  if (isSystem) {
    // System mode: shell out to sudo tee since this process is not root.
    const sudo = which('sudo');
    if (!sudo) {
      throw new Error('--system requires sudo, which was not found in PATH.');
    }
    const r = spawnSync('sudo', ['tee', unitPath], {
      input: unit,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (r.status !== 0) {
      throw new Error(`sudo tee ${unitPath} failed (exit ${r.status})`);
    }
  } else {
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit);
    try { chmodSync(unitPath, 0o644); } catch { /* perms best-effort */ }
  }
  process.stderr.write(`  ✓ wrote ${unitPath}\n`);

  if (options.unitOnly || !systemdAvailable()) {
    if (!systemdAvailable()) {
      process.stderr.write('  warn: systemctl not found — wrote the unit but skipped daemon-reload / enable.\n');
    }
    return {
      ok: true,
      unitPath,
      mode: isSystem ? 'system' : 'user',
      enabled: false,
      started: false,
      notes: ['unit written; systemctl steps skipped'],
    };
  }

  const runSystemctl = (args: string[]): void => {
    const cmd = isSystem ? ['sudo', 'systemctl', ...args] : ['systemctl', '--user', ...args];
    const bin = cmd[0];
    const rest = cmd.slice(1);
    try {
      execFileSync(bin, rest, { stdio: 'inherit' });
    } catch (err: any) {
      throw new Error(`${cmd.join(' ')} failed: ${err?.message ?? err}`);
    }
  };

  runSystemctl(['daemon-reload']);
  runSystemctl(['enable', SERVICE_NAME]);
  runSystemctl(['restart', SERVICE_NAME]);

  process.stderr.write(`\n  ✓ ${SERVICE_NAME} enabled and started\n\n`);

  const notes: string[] = [];
  if (!isSystem) {
    // For user-mode services to survive logout, lingering must be enabled.
    // We don't auto-run loginctl (it needs sudo) — just remind.
    notes.push(
      `User-mode service stops when you log out. To keep it running:\n` +
        `      sudo loginctl enable-linger ${user}`,
    );
  }
  notes.push(
    `Inspect:\n` +
      `      ${isSystem ? 'sudo ' : ''}systemctl ${isSystem ? '' : '--user '}status ${SERVICE_NAME}\n` +
      `      ${isSystem ? 'sudo ' : ''}journalctl ${isSystem ? '' : '--user '}-u ${SERVICE_NAME} -f`,
  );
  notes.push(
    `Uninstall:\n` +
      `      awb-agent-manager service uninstall${isSystem ? ' --system' : ''}`,
  );

  for (const n of notes) {
    process.stderr.write(`  • ${n}\n`);
  }

  return { ok: true, unitPath, mode: isSystem ? 'system' : 'user', enabled: true, started: true, notes };
}

export interface ServiceUninstallOptions {
  system?: boolean;
}

export async function uninstallService(options: ServiceUninstallOptions = {}): Promise<void> {
  const isSystem = !!options.system;
  const unitPath = isSystem
    ? `/etc/systemd/system/${SERVICE_NAME}.service`
    : `${homedir()}/.config/systemd/user/${SERVICE_NAME}.service`;

  process.stderr.write(`\n  awb-agent-manager — service uninstall (${isSystem ? 'system' : 'user'})\n\n`);

  if (systemdAvailable()) {
    const runSystemctl = (args: string[], allowFail = false): void => {
      const cmd = isSystem ? ['sudo', 'systemctl', ...args] : ['systemctl', '--user', ...args];
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
      if (r.status !== 0 && !allowFail) {
        throw new Error(`${cmd.join(' ')} failed`);
      }
    };
    runSystemctl(['stop', SERVICE_NAME], true);
    runSystemctl(['disable', SERVICE_NAME], true);
  }

  if (existsSync(unitPath)) {
    if (isSystem) {
      const sudo = which('sudo');
      if (!sudo) throw new Error('--system requires sudo to remove the unit.');
      spawnSync('sudo', ['rm', '-f', unitPath], { stdio: 'inherit' });
    } else {
      try { execFileSync('rm', ['-f', unitPath], { stdio: 'inherit' }); } catch { /* ignore */ }
    }
    process.stderr.write(`  ✓ removed ${unitPath}\n`);
  } else {
    process.stderr.write(`  (unit was not present at ${unitPath})\n`);
  }

  if (systemdAvailable()) {
    spawnSync(isSystem ? 'sudo' : 'systemctl', isSystem ? ['systemctl', 'daemon-reload'] : ['--user', 'daemon-reload'], { stdio: 'inherit' });
  }
  process.stderr.write('  ✓ done\n');
}

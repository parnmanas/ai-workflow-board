// ─── Cross-platform service installer ────────────────────────────────
// `awb-agent-manager service install` — registers the manager as a
// background service so it starts on boot and auto-restarts on crash.
//
// Auto-detects the host's service manager and dispatches:
//   - linux + systemd      → systemd unit (user / system scope)
//   - linux + Synology DSM → /usr/local/etc/rc.d/<name>.sh (boot script)
//   - linux without systemd → /etc/init.d sysvinit script
//   - darwin               → launchd plist (LaunchAgent / LaunchDaemon)
//   - win32                → Windows Task Scheduler task (logon / boot)
//
// Common modes:
//   - user mode (default): no admin/sudo, runs as the current user, only
//     active while that user is logged in (linger / logon trigger needed
//     for boot-time start).
//   - system mode (--system): admin/sudo required, runs at boot.
//
// Platform override: --platform <auto|systemd|sysvinit|synology|launchd|windows>
// for testing or when autodetect picks the wrong impl (e.g. forcing
// sysvinit on a host that has both systemd and /etc/init.d).

import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve as pathResolve, join } from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'awb-agent-manager';
const LAUNCHD_LABEL = 'com.awb.agent-manager';

export type ServicePlatform =
  | 'systemd'
  | 'sysvinit'
  | 'synology'
  | 'launchd'
  | 'windows';

export interface ServiceInstallOptions {
  /** When true, install at system scope (sudo / admin); else user scope. */
  system?: boolean;
  /** Override the absolute path to dist/main.js. Default: caller's location. */
  execPath?: string;
  /** Print the unit + commands without running them. */
  dryRun?: boolean;
  /** Write the unit/plist/script but skip register/enable. */
  unitOnly?: boolean;
  /** Force a specific platform impl. Default: auto-detect. */
  platform?: ServicePlatform | 'auto';
}

export interface ServiceInstallResult {
  ok: true;
  platform: ServicePlatform;
  unitPath: string;
  mode: 'user' | 'system';
  enabled: boolean;
  started: boolean;
  notes: string[];
}

export interface ServiceUninstallOptions {
  system?: boolean;
  platform?: ServicePlatform | 'auto';
}

// ─── shared helpers ───────────────────────────────────────────────────

function which(bin: string): string | null {
  if (process.platform === 'win32') {
    const r = spawnSync('where', [bin], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0]?.trim() || null;
    return null;
  }
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim() || null;
  return null;
}

function detectExecPath(override?: string): string {
  if (override) return pathResolve(override);
  // Walk up from this module to find dist/main.js. setup.ts compiled to
  // dist/lib/setup.js; sibling main.js is dist/main.js.
  const here = dirname(fileURLToPath(import.meta.url));
  return pathResolve(here, '..', 'main.js');
}

function detectNode(): string {
  return process.execPath;
}

function detectPlatform(): ServicePlatform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') {
    // Synology DSM ships /etc/synoinfo.conf and an rc.d-style boot dir.
    // Prefer this on DSM even when systemd is also present, because the
    // boot-time semantics on Synology are tied to /usr/local/etc/rc.d/.
    if (existsSync('/etc/synoinfo.conf') && existsSync('/usr/local/etc/rc.d')) {
      return 'synology';
    }
    if (which('systemctl')) return 'systemd';
    if (existsSync('/etc/init.d')) return 'sysvinit';
  }
  throw new Error(
    `unsupported platform: ${process.platform} — pass --platform to override`,
  );
}

function resolvePlatform(override?: ServicePlatform | 'auto'): ServicePlatform {
  if (!override || override === 'auto') return detectPlatform();
  return override;
}

function writeFileWithDir(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      /* perms best-effort (e.g. Windows / FAT) */
    }
  }
}

function writeWithSudo(path: string, content: string, mode?: number): void {
  const sudo = which('sudo');
  if (!sudo) {
    throw new Error('--system requires sudo, which was not found in PATH.');
  }
  const r = spawnSync('sudo', ['tee', path], {
    input: content,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    throw new Error(`sudo tee ${path} failed (exit ${r.status})`);
  }
  if (mode !== undefined) {
    spawnSync('sudo', ['chmod', mode.toString(8), path], { stdio: 'inherit' });
  }
}

function removeFile(path: string, withSudo: boolean): void {
  if (!existsSync(path)) return;
  if (withSudo) {
    const sudo = which('sudo');
    if (!sudo) throw new Error('--system requires sudo to remove the unit.');
    spawnSync('sudo', ['rm', '-f', path], { stdio: 'inherit' });
  } else {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

function logHeader(opts: { platform: ServicePlatform; mode: 'user' | 'system'; nodeBin: string; execPath: string; unitPath: string; user: string }): void {
  process.stderr.write('\n  awb-agent-manager — service install\n\n');
  process.stderr.write(`    platform:   ${opts.platform}\n`);
  process.stderr.write(`    mode:       ${opts.mode === 'system' ? 'system' : 'user'}\n`);
  process.stderr.write(`    exec:       ${opts.nodeBin} ${opts.execPath}\n`);
  process.stderr.write(`    unit:       ${opts.unitPath}\n`);
  process.stderr.write(`    user:       ${opts.user}\n\n`);
}

// ─── systemd (linux) ──────────────────────────────────────────────────

function systemdUnit(opts: { execPath: string; nodeBin: string; user: string; isSystem: boolean }): string {
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

async function installSystemd(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
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

  const unit = systemdUnit({ execPath, nodeBin, user, isSystem });
  const unitPath = isSystem
    ? `/etc/systemd/system/${SERVICE_NAME}.service`
    : `${homedir()}/.config/systemd/user/${SERVICE_NAME}.service`;

  logHeader({ platform: 'systemd', mode: isSystem ? 'system' : 'user', nodeBin, execPath, unitPath, user });

  if (options.dryRun) {
    process.stderr.write('  --dry-run: would write the following unit (skipping systemctl):\n\n');
    process.stderr.write(unit.split('\n').map((l) => `    ${l}`).join('\n'));
    process.stderr.write('\n');
    return { ok: true, platform: 'systemd', unitPath, mode: isSystem ? 'system' : 'user', enabled: false, started: false, notes: ['dry-run'] };
  }

  if (isSystem) writeWithSudo(unitPath, unit, 0o644);
  else writeFileWithDir(unitPath, unit, 0o644);
  process.stderr.write(`  ✓ wrote ${unitPath}\n`);

  const systemctlAvailable = !!which('systemctl');
  if (options.unitOnly || !systemctlAvailable) {
    if (!systemctlAvailable) {
      process.stderr.write('  warn: systemctl not found — wrote the unit but skipped daemon-reload / enable.\n');
    }
    return {
      ok: true,
      platform: 'systemd',
      unitPath,
      mode: isSystem ? 'system' : 'user',
      enabled: false,
      started: false,
      notes: ['unit written; systemctl steps skipped'],
    };
  }

  const runSystemctl = (args: string[]): void => {
    const cmd = isSystem ? ['sudo', 'systemctl', ...args] : ['systemctl', '--user', ...args];
    try {
      execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
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
  for (const n of notes) process.stderr.write(`  • ${n}\n`);

  return { ok: true, platform: 'systemd', unitPath, mode: isSystem ? 'system' : 'user', enabled: true, started: true, notes };
}

async function uninstallSystemd(options: ServiceUninstallOptions): Promise<void> {
  const isSystem = !!options.system;
  const unitPath = isSystem
    ? `/etc/systemd/system/${SERVICE_NAME}.service`
    : `${homedir()}/.config/systemd/user/${SERVICE_NAME}.service`;

  process.stderr.write(`\n  awb-agent-manager — service uninstall (systemd ${isSystem ? 'system' : 'user'})\n\n`);

  if (which('systemctl')) {
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

  removeFile(unitPath, isSystem);
  if (existsSync(unitPath)) {
    process.stderr.write(`  warn: ${unitPath} still exists after removal attempt\n`);
  } else {
    process.stderr.write(`  ✓ removed ${unitPath}\n`);
  }

  if (which('systemctl')) {
    const cmd = isSystem ? ['sudo', 'systemctl', 'daemon-reload'] : ['systemctl', '--user', 'daemon-reload'];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  }
  process.stderr.write('  ✓ done\n');
}

// ─── sysvinit / Synology rc.d (linux without systemd) ────────────────

function sysvinitScript(opts: { execPath: string; nodeBin: string; user: string; envHome: string | undefined }): string {
  const { execPath, nodeBin, user, envHome } = opts;
  const envExport = envHome ? `export AWB_AGENT_MANAGER_HOME='${envHome}'\n` : '';
  return `#!/bin/sh
### BEGIN INIT INFO
# Provides:          ${SERVICE_NAME}
# Required-Start:    $network $remote_fs
# Required-Stop:     $network $remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: AWB Agent Manager
### END INIT INFO

NAME=${SERVICE_NAME}
NODE_BIN='${nodeBin}'
EXEC_PATH='${execPath}'
RUN_USER='${user}'
PIDFILE="/var/run/$NAME.pid"
LOGFILE="/var/log/$NAME.log"
${envExport}
start() {
  if [ -e "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "$NAME already running (PID $(cat "$PIDFILE"))"
    return 0
  fi
  echo "Starting $NAME"
  if [ "$(id -u)" = "0" ] && [ -n "$RUN_USER" ] && [ "$RUN_USER" != "root" ]; then
    su -s /bin/sh -c "nohup '$NODE_BIN' '$EXEC_PATH' >> '$LOGFILE' 2>&1 & echo \\$! > '$PIDFILE'" "$RUN_USER"
  else
    nohup "$NODE_BIN" "$EXEC_PATH" >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
  fi
}

stop() {
  if [ ! -e "$PIDFILE" ]; then echo "$NAME not running"; return 0; fi
  PID=$(cat "$PIDFILE")
  echo "Stopping $NAME (PID $PID)"
  kill "$PID" 2>/dev/null
  rm -f "$PIDFILE"
}

status() {
  if [ -e "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "$NAME running (PID $(cat "$PIDFILE"))"
    return 0
  fi
  echo "$NAME stopped"
  return 1
}

case "$1" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
`;
}

async function installSysvinit(options: ServiceInstallOptions, flavor: 'sysvinit' | 'synology'): Promise<ServiceInstallResult> {
  // sysvinit + Synology DSM rc.d both write a shell script that responds to
  // start/stop/restart/status. Only difference is the directory and the
  // boot-registration mechanism.
  const execPath = detectExecPath(options.execPath);
  const nodeBin = detectNode();
  const user = userInfo().username;

  if (!existsSync(execPath)) {
    throw new Error(
      `dist/main.js not found at ${execPath} — run \`npm run build\` first, ` +
        `or pass --exec-path <path>.`,
    );
  }

  // Both flavors require root: /etc/init.d and /usr/local/etc/rc.d are
  // root-owned. Force system mode regardless of the --system flag.
  const isSystem = true;
  const unitPath = flavor === 'synology'
    ? `/usr/local/etc/rc.d/${SERVICE_NAME}.sh`
    : `/etc/init.d/${SERVICE_NAME}`;

  const script = sysvinitScript({ execPath, nodeBin, user, envHome: process.env.AWB_AGENT_MANAGER_HOME });

  logHeader({ platform: flavor, mode: 'system', nodeBin, execPath, unitPath, user });

  if (options.dryRun) {
    process.stderr.write('  --dry-run: would write the following script (skipping registration):\n\n');
    process.stderr.write(script.split('\n').map((l) => `    ${l}`).join('\n'));
    process.stderr.write('\n');
    return { ok: true, platform: flavor, unitPath, mode: 'system', enabled: false, started: false, notes: ['dry-run'] };
  }

  // Need root to write into /etc/init.d or /usr/local/etc/rc.d.
  if (process.getuid && process.getuid() === 0) {
    writeFileWithDir(unitPath, script, 0o755);
  } else {
    writeWithSudo(unitPath, script, 0o755);
  }
  process.stderr.write(`  ✓ wrote ${unitPath}\n`);

  if (options.unitOnly) {
    return {
      ok: true,
      platform: flavor,
      unitPath,
      mode: 'system',
      enabled: false,
      started: false,
      notes: ['script written; boot registration skipped'],
    };
  }

  const notes: string[] = [];
  let enabled = false;
  let started = false;

  if (flavor === 'synology') {
    // Synology's /usr/local/etc/rc.d/ is auto-scanned at boot; the file
    // being executable is enough. We start it now via the script itself.
    enabled = true;
    const r = spawnSync('sudo', [unitPath, 'start'], { stdio: 'inherit' });
    started = r.status === 0;
    if (!started) notes.push(`Failed to start: run \`sudo ${unitPath} start\` manually.`);
    notes.push(`Inspect:\n      sudo ${unitPath} status\n      tail -f /var/log/${SERVICE_NAME}.log`);
  } else {
    // sysvinit registration: prefer update-rc.d (Debian-style), fall back
    // to chkconfig (RHEL-style). On hosts with neither, the script is
    // present but won't auto-start at boot — the user must register it
    // manually.
    if (which('update-rc.d')) {
      const r = spawnSync('sudo', ['update-rc.d', SERVICE_NAME, 'defaults'], { stdio: 'inherit' });
      enabled = r.status === 0;
      if (!enabled) notes.push(`update-rc.d failed: run \`sudo update-rc.d ${SERVICE_NAME} defaults\` manually.`);
    } else if (which('chkconfig')) {
      const r1 = spawnSync('sudo', ['chkconfig', '--add', SERVICE_NAME], { stdio: 'inherit' });
      const r2 = spawnSync('sudo', ['chkconfig', SERVICE_NAME, 'on'], { stdio: 'inherit' });
      enabled = r1.status === 0 && r2.status === 0;
      if (!enabled) notes.push(`chkconfig failed: run \`sudo chkconfig --add ${SERVICE_NAME} && sudo chkconfig ${SERVICE_NAME} on\` manually.`);
    } else {
      notes.push(`No update-rc.d / chkconfig found — script is in place but won't auto-start at boot. Register it manually.`);
    }

    const r = spawnSync('sudo', [unitPath, 'start'], { stdio: 'inherit' });
    started = r.status === 0;
    if (!started) notes.push(`Failed to start: run \`sudo ${unitPath} start\` manually.`);
    notes.push(`Inspect:\n      sudo ${unitPath} status\n      tail -f /var/log/${SERVICE_NAME}.log`);
  }

  notes.push(`Uninstall:\n      awb-agent-manager service uninstall --platform ${flavor}`);
  process.stderr.write(`\n  ✓ ${SERVICE_NAME} ${enabled ? 'enabled and ' : ''}${started ? 'started' : 'install complete'}\n\n`);
  for (const n of notes) process.stderr.write(`  • ${n}\n`);

  return { ok: true, platform: flavor, unitPath, mode: 'system', enabled, started, notes };
}

async function uninstallSysvinit(options: ServiceUninstallOptions, flavor: 'sysvinit' | 'synology'): Promise<void> {
  const unitPath = flavor === 'synology'
    ? `/usr/local/etc/rc.d/${SERVICE_NAME}.sh`
    : `/etc/init.d/${SERVICE_NAME}`;

  process.stderr.write(`\n  awb-agent-manager — service uninstall (${flavor})\n\n`);

  // Best-effort stop and de-register before removing the script.
  if (existsSync(unitPath)) {
    spawnSync('sudo', [unitPath, 'stop'], { stdio: 'inherit' });
  }
  if (flavor === 'sysvinit') {
    if (which('update-rc.d')) {
      spawnSync('sudo', ['update-rc.d', '-f', SERVICE_NAME, 'remove'], { stdio: 'inherit' });
    } else if (which('chkconfig')) {
      spawnSync('sudo', ['chkconfig', '--del', SERVICE_NAME], { stdio: 'inherit' });
    }
  }

  removeFile(unitPath, true);
  if (existsSync(unitPath)) {
    process.stderr.write(`  warn: ${unitPath} still exists after removal attempt\n`);
  } else {
    process.stderr.write(`  ✓ removed ${unitPath}\n`);
  }
  process.stderr.write('  ✓ done\n');
}

// ─── launchd (darwin / macOS) ─────────────────────────────────────────

function launchdPlist(opts: { execPath: string; nodeBin: string; isSystem: boolean }): string {
  const { execPath, nodeBin } = opts;
  const envHome = process.env.AWB_AGENT_MANAGER_HOME;
  const envBlock = envHome
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n      <key>AWB_AGENT_MANAGER_HOME</key>\n      <string>${envHome}</string>\n    </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodeBin}</string>
      <string>${execPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/${SERVICE_NAME}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${SERVICE_NAME}.err.log</string>
${envBlock}  </dict>
</plist>
`;
}

async function installLaunchd(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
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

  const plist = launchdPlist({ execPath, nodeBin, isSystem });
  const unitPath = isSystem
    ? `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`
    : `${homedir()}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;

  logHeader({ platform: 'launchd', mode: isSystem ? 'system' : 'user', nodeBin, execPath, unitPath, user });

  if (options.dryRun) {
    process.stderr.write('  --dry-run: would write the following plist (skipping launchctl):\n\n');
    process.stderr.write(plist.split('\n').map((l) => `    ${l}`).join('\n'));
    process.stderr.write('\n');
    return { ok: true, platform: 'launchd', unitPath, mode: isSystem ? 'system' : 'user', enabled: false, started: false, notes: ['dry-run'] };
  }

  if (isSystem) writeWithSudo(unitPath, plist, 0o644);
  else writeFileWithDir(unitPath, plist, 0o644);
  process.stderr.write(`  ✓ wrote ${unitPath}\n`);

  if (options.unitOnly || !which('launchctl')) {
    if (!which('launchctl')) {
      process.stderr.write('  warn: launchctl not found — wrote the plist but skipped load.\n');
    }
    return {
      ok: true,
      platform: 'launchd',
      unitPath,
      mode: isSystem ? 'system' : 'user',
      enabled: false,
      started: false,
      notes: ['plist written; launchctl steps skipped'],
    };
  }

  // Use the modern bootstrap/bootout API. Fallback to load -w if the host
  // is on an older macOS where bootstrap isn't supported.
  const runLaunchctl = (args: string[], allowFail = false): boolean => {
    const cmd = isSystem ? ['sudo', 'launchctl', ...args] : ['launchctl', ...args];
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    if (r.status !== 0 && !allowFail) {
      throw new Error(`${cmd.join(' ')} failed`);
    }
    return r.status === 0;
  };

  // Bootout is idempotent — it removes any prior load so bootstrap doesn't
  // fail with "service already loaded".
  const domain = isSystem ? 'system' : `gui/${process.getuid?.() ?? ''}`;
  runLaunchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`], true);

  const ok = runLaunchctl(['bootstrap', domain, unitPath], true);
  if (!ok) {
    // Older macOS / fallback path.
    runLaunchctl(['load', '-w', unitPath]);
  }

  process.stderr.write(`\n  ✓ ${LAUNCHD_LABEL} loaded\n\n`);

  const notes: string[] = [];
  notes.push(
    `Inspect:\n` +
      `      ${isSystem ? 'sudo ' : ''}launchctl print ${domain}/${LAUNCHD_LABEL}\n` +
      `      tail -f /tmp/${SERVICE_NAME}.log /tmp/${SERVICE_NAME}.err.log`,
  );
  notes.push(
    `Uninstall:\n` +
      `      awb-agent-manager service uninstall${isSystem ? ' --system' : ''}`,
  );
  for (const n of notes) process.stderr.write(`  • ${n}\n`);

  return { ok: true, platform: 'launchd', unitPath, mode: isSystem ? 'system' : 'user', enabled: true, started: true, notes };
}

async function uninstallLaunchd(options: ServiceUninstallOptions): Promise<void> {
  const isSystem = !!options.system;
  const unitPath = isSystem
    ? `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`
    : `${homedir()}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;

  process.stderr.write(`\n  awb-agent-manager — service uninstall (launchd ${isSystem ? 'system' : 'user'})\n\n`);

  if (which('launchctl')) {
    const domain = isSystem ? 'system' : `gui/${process.getuid?.() ?? ''}`;
    const cmd = isSystem
      ? ['sudo', 'launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]
      : ['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    // Legacy fallback (older macOS): unload -w.
    if (existsSync(unitPath)) {
      const cmd2 = isSystem
        ? ['sudo', 'launchctl', 'unload', '-w', unitPath]
        : ['launchctl', 'unload', '-w', unitPath];
      spawnSync(cmd2[0], cmd2.slice(1), { stdio: 'inherit' });
    }
  }

  removeFile(unitPath, isSystem);
  if (existsSync(unitPath)) {
    process.stderr.write(`  warn: ${unitPath} still exists after removal attempt\n`);
  } else {
    process.stderr.write(`  ✓ removed ${unitPath}\n`);
  }
  process.stderr.write('  ✓ done\n');
}

// ─── Windows Task Scheduler ───────────────────────────────────────────

function windowsTaskXml(opts: { execPath: string; nodeBin: string; user: string; isSystem: boolean }): string {
  const { execPath, nodeBin, isSystem } = opts;
  // Boot-time vs logon-time trigger — system mode runs as SYSTEM at boot,
  // user mode runs as the current user at logon. The `RestartOnFailure`
  // settings mirror the systemd unit (5s back-off, retry 10x) so behavior
  // is consistent across platforms.
  const trigger = isSystem
    ? `    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>`
    : `    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>`;
  // S-1-5-18 = LocalSystem (boot mode); S-1-5-32-545 = Users (user mode).
  const principalId = isSystem ? 'LocalSystem' : 'Author';
  const userBlock = isSystem
    ? `      <UserId>S-1-5-18</UserId>\n      <RunLevel>HighestAvailable</RunLevel>`
    : `      <UserId>S-1-5-32-545</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AWB Agent Manager — standalone subagent runner</Description>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
    <Principal id="${principalId}">
${userBlock}
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT5S</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="${principalId}">
    <Exec>
      <Command>${nodeBin}</Command>
      <Arguments>"${execPath}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function utf16leWithBom(text: string): Buffer {
  // schtasks /Create /XML expects UTF-16 LE with BOM; UTF-8 will be
  // rejected on most Windows installs.
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(text, 'utf16le');
  return Buffer.concat([bom, body]);
}

async function installWindows(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
  const isSystem = !!options.system;
  const execPath = detectExecPath(options.execPath);
  const nodeBin = detectNode();
  const user = userInfo().username;

  if (!existsSync(execPath)) {
    throw new Error(
      `dist\\main.js not found at ${execPath} — run \`npm run build\` first, ` +
        `or pass --exec-path <path>.`,
    );
  }

  const taskName = SERVICE_NAME;
  const xml = windowsTaskXml({ execPath, nodeBin, user, isSystem });
  // schtasks needs an on-disk file path; we drop the XML into a temp
  // location, register, then leave it for inspection (~25 KB, harmless).
  const xmlPath = join(tmpdir(), `${SERVICE_NAME}-task.xml`);

  logHeader({ platform: 'windows', mode: isSystem ? 'system' : 'user', nodeBin, execPath, unitPath: `Task Scheduler\\${taskName}`, user });

  if (options.dryRun) {
    process.stderr.write('  --dry-run: would write the following task XML and run schtasks /Create:\n\n');
    process.stderr.write(xml.split('\n').map((l) => `    ${l}`).join('\n'));
    process.stderr.write('\n');
    return { ok: true, platform: 'windows', unitPath: xmlPath, mode: isSystem ? 'system' : 'user', enabled: false, started: false, notes: ['dry-run'] };
  }

  // Write the XML as UTF-16 LE + BOM so schtasks accepts it.
  mkdirSync(dirname(xmlPath), { recursive: true });
  writeFileSync(xmlPath, utf16leWithBom(xml));
  process.stderr.write(`  ✓ wrote ${xmlPath}\n`);

  if (options.unitOnly || !which('schtasks')) {
    if (!which('schtasks')) {
      process.stderr.write('  warn: schtasks.exe not found — wrote the XML but skipped task registration.\n');
    }
    return {
      ok: true,
      platform: 'windows',
      unitPath: xmlPath,
      mode: isSystem ? 'system' : 'user',
      enabled: false,
      started: false,
      notes: ['XML written; schtasks /Create skipped'],
    };
  }

  // System mode runs as SYSTEM (needs admin); user mode runs as the
  // current user at logon. /F forces overwrite of any prior task with
  // the same name (so re-running install is idempotent).
  const createArgs = ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'];
  const createR = spawnSync('schtasks', createArgs, { stdio: 'inherit' });
  if (createR.status !== 0) {
    throw new Error(
      `schtasks /Create failed (exit ${createR.status}). ` +
        (isSystem ? 'System mode requires running this from an elevated (Admin) PowerShell.' : ''),
    );
  }

  // Kick off the task right away so the user doesn't have to wait for the
  // next logon/boot. Errors here are non-fatal — registration succeeded.
  const runR = spawnSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'inherit' });
  const started = runR.status === 0;

  process.stderr.write(`\n  ✓ Task '${taskName}' registered${started ? ' and started' : ''}\n\n`);

  const notes: string[] = [];
  notes.push(
    `Inspect:\n` +
      `      schtasks /Query /TN ${taskName} /V /FO LIST\n` +
      `      taskschd.msc  (GUI — Task Scheduler Library → ${taskName})`,
  );
  notes.push(
    `Uninstall:\n` +
      `      awb-agent-manager service uninstall${isSystem ? ' --system' : ''}`,
  );
  if (!isSystem) {
    notes.push(
      `User-mode task only fires at logon. For boot-time start, re-run with --system from an elevated shell.`,
    );
  }
  for (const n of notes) process.stderr.write(`  • ${n}\n`);

  return { ok: true, platform: 'windows', unitPath: xmlPath, mode: isSystem ? 'system' : 'user', enabled: true, started, notes };
}

async function uninstallWindows(options: ServiceUninstallOptions): Promise<void> {
  const isSystem = !!options.system;
  const taskName = SERVICE_NAME;
  process.stderr.write(`\n  awb-agent-manager — service uninstall (windows ${isSystem ? 'system' : 'user'})\n\n`);

  if (which('schtasks')) {
    // /F suppresses the confirmation prompt; status≠0 just means task
    // didn't exist, which is fine for an uninstall.
    const r = spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stderr.write(`  ✓ deleted scheduled task '${taskName}'\n`);
    } else {
      process.stderr.write(`  (task '${taskName}' was not registered, or schtasks /Delete failed — exit ${r.status})\n`);
    }
  } else {
    process.stderr.write('  warn: schtasks.exe not found — cannot remove the task.\n');
  }

  // Best-effort: remove the on-disk XML we wrote at install time.
  const xmlPath = join(tmpdir(), `${SERVICE_NAME}-task.xml`);
  removeFile(xmlPath, false);
  process.stderr.write('  ✓ done\n');
}

// ─── public entry points ──────────────────────────────────────────────

export async function installService(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
  const platform = resolvePlatform(options.platform);
  switch (platform) {
    case 'systemd':
      return installSystemd(options);
    case 'sysvinit':
      return installSysvinit(options, 'sysvinit');
    case 'synology':
      return installSysvinit(options, 'synology');
    case 'launchd':
      return installLaunchd(options);
    case 'windows':
      return installWindows(options);
  }
}

export async function uninstallService(options: ServiceUninstallOptions = {}): Promise<void> {
  const platform = resolvePlatform(options.platform);
  switch (platform) {
    case 'systemd':
      return uninstallSystemd(options);
    case 'sysvinit':
      return uninstallSysvinit(options, 'sysvinit');
    case 'synology':
      return uninstallSysvinit(options, 'synology');
    case 'launchd':
      return uninstallLaunchd(options);
    case 'windows':
      return uninstallWindows(options);
  }
}

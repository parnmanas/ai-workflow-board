// Cross-OS shell helpers for the host-mcp server.
//
// All host_* tools route through these helpers so each tool can be expressed
// as "branch on platform, shell out to the right native CLI." We deliberately
// avoid native add-ons (`robotjs`, `screenshot-desktop`, etc.) because the
// agent-manager binary has to install cleanly on Synology DSM, Raspberry Pi,
// macOS arm64, Windows, headless Linux servers, and any host the operator
// drops it onto — a native-binary dependency that fails to build on one of
// those silently breaks the whole manager. Shell-outs degrade gracefully
// instead: the relevant tool returns an error explaining what binary is
// missing, and the rest of the host surface keeps working.
//
// Tools per platform (best-effort detection, callers fall back when missing):
//   Windows: PowerShell 5+ (System.Drawing for capture, Win32 P/Invoke for
//            windows / SendKeys / mouse / clipboard).
//   macOS:   /usr/sbin/screencapture, /usr/bin/osascript, pbcopy / pbpaste.
//   Linux X11:   wmctrl / xdotool / xclip (or xsel) / scrot|maim|gnome-screenshot|import.
//   Linux Wayland: grim + slurp / wtype + ydotool / wl-copy + wl-paste.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

export type HostPlatform = 'win32' | 'darwin' | 'linux';

/** Coarse OS family used by every tool branch. */
export function hostPlatform(): HostPlatform {
  // Treat any non-mac, non-win32 host as "linux family" — the linux branch
  // always shells out to standard CLI tools (wmctrl/xdotool/grim/etc.) that
  // a BSD or DSM operator can install the same way as on a desktop distro.
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

/** True on Wayland sessions (relevant only on linux). Used by screenshot /
 *  input / clipboard tools to pick `grim` over `import` etc. */
export function isWayland(): boolean {
  if (hostPlatform() !== 'linux') return false;
  return !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
}

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when spawn itself failed (binary not found, EACCES, etc.). The
   *  caller usually treats this as "feature unavailable on this host." */
  spawnFailed: boolean;
  /** Set when `spawnFailed` is true; otherwise empty. */
  spawnError: string;
}

export interface RunOptions {
  /** Pipe these bytes into the child's stdin and close. */
  stdin?: string | Buffer | null;
  /** Resolve early when the child exceeds this time (ms). Kills with SIGTERM
   *  then SIGKILL after a 1s grace. 0 = unbounded. Default 15s. */
  timeoutMs?: number;
  /** Working directory; defaults to the manager process's cwd. */
  cwd?: string;
  /** Capture stdout as binary bytes (concatenated buffers, hex-encoded into
   *  the `stdout` string field). Used by screenshot tools where the binary
   *  PNG is the entire payload. Default false. */
  binaryStdout?: boolean;
  /** Inherit the parent env unless explicit `env` overrides; defaults true. */
  inheritEnv?: boolean;
  /** Extra env vars to set on the child. */
  env?: Record<string, string>;
}

/**
 * Spawn a child process and collect stdout/stderr. Never throws — every
 * failure (binary missing, non-zero exit, timeout) is surfaced via the
 * RunResult so the MCP tool can return a structured error to the model
 * instead of crashing the server.
 *
 * binaryStdout: when true, stdout is collected as a Buffer and base64-encoded
 * into RunResult.stdout. Callers (screenshot, clipboard image) then call
 * `Buffer.from(stdout, 'base64')` to get bytes back. Keeping stdout as a
 * string in the result struct avoids a parallel type just for the binary
 * path while still keeping binary data accurate (no utf8 round-trip).
 */
export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let killTimer: NodeJS.Timeout | null = null;

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.inheritEnv === false ? opts.env : { ...process.env, ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: '',
        spawnFailed: true,
        spawnError: err?.message || String(err),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err: any) => {
      // ENOENT / EACCES — the binary doesn't exist or isn't executable.
      // Don't double-resolve if `close` already fired.
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: '',
        spawnFailed: true,
        spawnError: err?.message || String(err),
      });
    });

    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      resolve({
        code: typeof code === 'number' ? code : -1,
        signal: signal ?? null,
        stdout: opts.binaryStdout ? stdoutBuf.toString('base64') : stdoutBuf.toString('utf8'),
        stderr: stderrBuf.toString('utf8'),
        spawnFailed: false,
        spawnError: '',
      });
    });

    if (opts.stdin != null) {
      try {
        child.stdin?.end(opts.stdin);
      } catch {
        /* child already exited; close handler resolves us */
      }
    } else {
      try {
        child.stdin?.end();
      } catch { /* noop */ }
    }

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch { /* already dead */ }
        // Hard-kill after 1s grace.
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch { /* already dead */ }
        }, 1000).unref();
      }, timeoutMs);
      killTimer.unref();
    }
  });
}

/**
 * Convenience: feed a PowerShell script through `powershell -NoProfile
 * -ExecutionPolicy Bypass -Command -`. Returns the standard RunResult so
 * the caller can inspect stdout / stderr / code uniformly.
 *
 * Pwsh 7 (`pwsh`) is preferred when present (it supports `-File -` reliably
 * and matches the syntax the txiv.gameclient scripts target) but we fall
 * back to Windows PowerShell 5.1 because that's what every default Windows
 * install ships and the surface we use is intentionally PowerShell-2-era
 * (System.Drawing, Win32 P/Invoke).
 */
export async function runPowerShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  // Try pwsh first (cross-platform PowerShell Core). Fall back to
  // Windows PowerShell on systems where only the legacy shell is
  // installed. We don't dispatch based on platform because pwsh exists
  // on macOS / Linux too and the manager may run inside a container that
  // ships pwsh as the only available shell.
  const candidates = hostPlatform() === 'win32'
    ? ['pwsh', 'powershell']
    : ['pwsh'];

  let last: RunResult | null = null;
  for (const bin of candidates) {
    const result = await runCommand(
      bin,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { ...opts, stdin: script },
    );
    if (!result.spawnFailed) return result;
    last = result;
  }
  return last ?? {
    code: -1, signal: null, stdout: '', stderr: '',
    spawnFailed: true, spawnError: 'no powershell binary found',
  };
}

/** Run an osascript snippet on macOS. Returns the RunResult unchanged so
 *  the caller can decide how to interpret stdout vs stderr. */
export async function runOsascript(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return runCommand('osascript', ['-e', script], opts);
}

/**
 * Allocate a temp directory unique to this run. Used by tools that need to
 * write a file the child process can read (e.g. some screenshot CLIs only
 * accept --output-file, not stdout). Caller is expected to leave the file
 * behind — the OS reaps `os.tmpdir()` itself, and explicit cleanup races
 * against the model wanting to re-read the file from the path we returned.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `awb-host-mcp-${prefix}-`));
}

/** Pick the first binary in `candidates` that resolves via `which` / `where`.
 *  Returns `null` when none are available. Used by tools that have multiple
 *  acceptable backends (e.g. Linux screenshot tries grim → scrot → maim →
 *  gnome-screenshot → import in that preference order). */
export async function findBinary(candidates: string[]): Promise<string | null> {
  const probeCmd = hostPlatform() === 'win32' ? 'where' : 'which';
  for (const bin of candidates) {
    const result = await runCommand(probeCmd, [bin], { timeoutMs: 3000 });
    if (!result.spawnFailed && result.code === 0 && result.stdout.trim()) {
      return bin;
    }
  }
  return null;
}

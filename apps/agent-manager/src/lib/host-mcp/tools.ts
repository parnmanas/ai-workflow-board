// Cross-OS implementations of the host-mcp tool surface.
//
// Each exported function is a thin per-tool dispatcher: detect the host
// platform, shell out to the right native CLI (PowerShell on win32,
// osascript / screencapture / pbpaste on macOS, wmctrl / xdotool / grim
// on linux), normalize the result into a JSON-safe object. Every function
// catches its own errors and returns `{ ok: false, error: '…' }` rather
// than throwing — the MCP server wraps the result in the standard
// `{content:[{type:'text', text: JSON.stringify(...)}]}` envelope so the
// agent always gets actionable output.
//
// IMPORTANT: when adding a new tool, register it in server.ts as well —
// this file only owns the implementations.

import { promises as fsp } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { hostname, userInfo, release, totalmem, freemem, cpus, arch } from 'node:os';
import { join } from 'node:path';
import {
  findBinary,
  hostPlatform,
  isWayland,
  makeTempDir,
  runCommand,
  runOsascript,
  runPowerShell,
} from './platform.js';

// ─── Types ──────────────────────────────────────────────────

export interface ToolError {
  ok: false;
  error: string;
  /** Optional hint about what to install / configure to fix the error. */
  hint?: string;
  details?: Record<string, unknown>;
}

export interface ScreenshotResult {
  ok: true;
  /** Base64-encoded PNG bytes. */
  base64_png: string;
  width: number;
  height: number;
  /** Path the file was also written to (when `save_path` was provided). */
  saved_path?: string;
  platform: string;
  backend: string;
}

export interface WindowInfo {
  id?: string;
  title: string;
  pid?: number;
  app?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  focused?: boolean;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  ppid?: number;
  user?: string;
  /** CPU% if available from the underlying platform CLI. */
  cpu?: number;
  /** Resident memory in KB if available. */
  mem_kb?: number;
  cmdline?: string;
}

// ─── PowerShell snippet helpers ─────────────────────────────

/**
 * Win32 P/Invoke prologue reused by every window-targeting PowerShell
 * snippet. Kept as a single string so we don't redeclare the Win32 type
 * multiple times in the same powershell session (Add-Type rejects
 * duplicate type registration). The signature surface here covers what
 * every host_window_* tool needs.
 */
const WIN32_TYPE = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing.Common @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AwbHostWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT {
    public int Left; public int Top; public int Right; public int Bottom;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern void SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint MOUSE_LEFTDOWN = 0x0002;
  public const uint MOUSE_LEFTUP   = 0x0004;
  public const uint MOUSE_RIGHTDOWN= 0x0008;
  public const uint MOUSE_RIGHTUP  = 0x0010;
  public const uint MOUSE_MIDDOWN  = 0x0020;
  public const uint MOUSE_MIDUP    = 0x0040;
}
"@
`;

// ─── Screenshot ─────────────────────────────────────────────

export interface ScreenshotArgs {
  /** Optional file path to also persist the PNG (in addition to returning
   *  base64). When omitted, the PNG is only returned as base64. */
  save_path?: string;
  /** Display index. 0 = primary. Only honored on win32 / linux X11.
   *  Defaults to 0. */
  display?: number;
}

export async function takeScreenshot(args: ScreenshotArgs = {}): Promise<ScreenshotResult | ToolError> {
  const plat = hostPlatform();
  try {
    if (plat === 'win32') return await screenshotWin(args);
    if (plat === 'darwin') return await screenshotMac(args);
    return await screenshotLinux(args);
  } catch (err: any) {
    return { ok: false, error: `screenshot failed: ${err?.message || err}` };
  }
}

async function screenshotWin(args: ScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  const tmpDir = makeTempDir('shot');
  const outPath = args.save_path || join(tmpDir, 'screen.png');
  const displayIdx = Math.max(0, args.display ?? 0);
  const script = `${WIN32_TYPE}
$ErrorActionPreference = "Stop"
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${displayIdx}
if ($idx -ge $screens.Length) { $idx = 0 }
$bounds = $screens[$idx].Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${outPath.replace(/'/g, "''").replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}x{1}" -f $bounds.Width, $bounds.Height)
`;
  const result = await runPowerShell(script, { timeoutMs: 20_000 });
  if (result.spawnFailed) {
    return { ok: false, error: 'PowerShell not available on PATH', hint: 'Install PowerShell or pwsh' };
  }
  if (result.code !== 0) {
    return { ok: false, error: `screenshot powershell exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  }
  const m = /(\d+)x(\d+)/.exec(result.stdout);
  const width = m ? parseInt(m[1], 10) : 0;
  const height = m ? parseInt(m[2], 10) : 0;
  const bytes = await fsp.readFile(outPath);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width, height,
    saved_path: outPath,
    platform: 'win32',
    backend: 'powershell+System.Drawing',
  };
}

async function screenshotMac(args: ScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  // `screencapture -x` suppresses the camera-shutter sound; `-t png` forces
  // PNG output; `-` writes to stdout. We collect to a tempfile too so
  // save_path semantics match the other platforms.
  const tmpDir = makeTempDir('shot');
  const outPath = args.save_path || join(tmpDir, 'screen.png');
  // -D <display> selects a specific display (1-indexed on screencapture);
  // we accept 0-indexed in our API and map.
  const dispArg = typeof args.display === 'number' && args.display > 0
    ? ['-D', String(args.display + 1)]
    : [];
  const result = await runCommand('screencapture', ['-x', '-t', 'png', ...dispArg, outPath], { timeoutMs: 15_000 });
  if (result.spawnFailed) {
    return { ok: false, error: 'screencapture not available', hint: 'macOS built-in tool; verify /usr/sbin is on PATH' };
  }
  if (result.code !== 0) {
    return { ok: false, error: `screencapture exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  }
  const bytes = await fsp.readFile(outPath);
  const { width, height } = await pngDimensions(bytes);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width, height,
    saved_path: outPath,
    platform: 'darwin',
    backend: 'screencapture',
  };
}

async function screenshotLinux(args: ScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  const tmpDir = makeTempDir('shot');
  const outPath = args.save_path || join(tmpDir, 'screen.png');
  const backendCandidates = isWayland()
    ? ['grim', 'gnome-screenshot', 'spectacle', 'scrot', 'maim']
    : ['scrot', 'maim', 'gnome-screenshot', 'import', 'grim'];
  const backend = await findBinary(backendCandidates);
  if (!backend) {
    return {
      ok: false,
      error: 'no screenshot backend found',
      hint: 'Install one of: grim (Wayland), scrot, maim, gnome-screenshot, or ImageMagick (provides `import`)',
      details: { tried: backendCandidates, wayland: isWayland() },
    };
  }
  let argv: string[];
  switch (backend) {
    case 'grim':
      argv = [outPath];
      break;
    case 'scrot':
      // -o overwrites if file exists, since outPath is a tempfile we just created
      argv = ['-o', outPath];
      break;
    case 'maim':
      argv = ['-q', outPath];
      break;
    case 'gnome-screenshot':
      argv = ['-f', outPath];
      break;
    case 'spectacle':
      argv = ['-b', '-n', '-o', outPath];
      break;
    case 'import':
      argv = ['-window', 'root', outPath];
      break;
    default:
      argv = [outPath];
  }
  const result = await runCommand(backend, argv, { timeoutMs: 15_000 });
  if (result.spawnFailed) {
    return { ok: false, error: `${backend} not available`, hint: 'Install one of: grim / scrot / maim / gnome-screenshot / imagemagick' };
  }
  if (result.code !== 0) {
    return { ok: false, error: `${backend} exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  }
  if (!existsSync(outPath)) {
    return { ok: false, error: `${backend} ran but produced no output at ${outPath}` };
  }
  const bytes = await fsp.readFile(outPath);
  const { width, height } = await pngDimensions(bytes);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width, height,
    saved_path: outPath,
    platform: 'linux',
    backend,
  };
}

/** Read PNG width/height from the IHDR chunk without pulling a decoder. */
async function pngDimensions(bytes: Buffer): Promise<{ width: number; height: number }> {
  // PNG signature is 8 bytes, then IHDR chunk starts at offset 8 with
  // 4 bytes length + 4 bytes "IHDR", then 4 bytes width, 4 bytes height (BE).
  if (bytes.length < 24) return { width: 0, height: 0 };
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return { width: 0, height: 0 };
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

// ─── Window screenshot ──────────────────────────────────────

export interface WindowScreenshotArgs {
  /** Regex (JavaScript syntax) matched case-insensitively against window
   *  titles. The first visible match wins. */
  title_pattern: string;
  save_path?: string;
  /** Bring the target window to the foreground before capturing. Default
   *  true — most editor windows are obscured by the terminal that's
   *  running the agent. */
  focus_first?: boolean;
}

export async function screenshotWindow(args: WindowScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  const plat = hostPlatform();
  if (!args.title_pattern) {
    return { ok: false, error: 'title_pattern is required' };
  }
  try {
    if (plat === 'win32') return await screenshotWindowWin(args);
    if (plat === 'darwin') return await screenshotWindowMac(args);
    return await screenshotWindowLinux(args);
  } catch (err: any) {
    return { ok: false, error: `window screenshot failed: ${err?.message || err}` };
  }
}

async function screenshotWindowWin(args: WindowScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  const tmpDir = makeTempDir('winshot');
  const outPath = args.save_path || join(tmpDir, 'window.png');
  const focus = args.focus_first !== false;
  const script = `${WIN32_TYPE}
$ErrorActionPreference = "Stop"
$pattern = '${args.title_pattern.replace(/'/g, "''")}'
$rx = [System.Text.RegularExpressions.Regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$matches = New-Object System.Collections.ArrayList
$cb = [AwbHostWin32+EnumWindowsProc]{
  param($h,$l)
  if (-not [AwbHostWin32]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 1024
  [void][AwbHostWin32]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  if ($rx.IsMatch($title)) { [void]$matches.Add([pscustomobject]@{ H=$h; T=$title }) }
  return $true
}
[void][AwbHostWin32]::EnumWindows($cb, [IntPtr]::Zero)
if ($matches.Count -eq 0) { Write-Error "no window matched"; exit 2 }
$target = $matches[0]
if (${focus ? '$true' : '$false'}) {
  [void][AwbHostWin32]::ShowWindowAsync($target.H, 9)
  Start-Sleep -Milliseconds 200
  [void][AwbHostWin32]::BringWindowToTop($target.H)
  [void][AwbHostWin32]::SetForegroundWindow($target.H)
  Start-Sleep -Milliseconds 250
}
$rect = New-Object AwbHostWin32+RECT
if (-not [AwbHostWin32]::GetWindowRect($target.H, [ref]$rect)) { Write-Error "GetWindowRect failed"; exit 3 }
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "window has invalid bounds"; exit 4 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save('${outPath.replace(/'/g, "''").replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()
Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $target.T, $rect.Left, $rect.Top, $w, $h)
`;
  const result = await runPowerShell(script, { timeoutMs: 20_000 });
  if (result.spawnFailed) {
    return { ok: false, error: 'PowerShell not available on PATH' };
  }
  if (result.code !== 0) {
    return { ok: false, error: `window screenshot powershell exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  }
  const parts = result.stdout.trim().split('|');
  const width = parseInt(parts[3] || '0', 10);
  const height = parseInt(parts[4] || '0', 10);
  const bytes = await fsp.readFile(outPath);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width, height,
    saved_path: outPath,
    platform: 'win32',
    backend: 'powershell+System.Drawing',
  };
}

async function screenshotWindowMac(args: WindowScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  // macOS path: use AppleScript to bring a matching app to front (best-effort)
  // then capture the active window with `screencapture -l <id>`. To get the
  // window id we use `screencapture -lf` requires the CGWindowID which is
  // surfaced by AppleScript's `id` of window from System Events. We take a
  // simpler path: bring the app forward, then use `screencapture -W` which
  // captures the frontmost window interactively — except `-W` is interactive.
  // The robust headless path is: capture the whole screen, then crop using
  // window bounds from AppleScript. That's what we do.
  const tmpDir = makeTempDir('winshot');
  const outPath = args.save_path || join(tmpDir, 'window.png');
  // Step 1: focus a process whose front window title matches the pattern.
  const focusScript = `
on findAndFocus(pat)
  tell application "System Events"
    set procs to (every process whose visible is true)
    repeat with p in procs
      set ws to (every window of p)
      repeat with w in ws
        try
          set t to name of w
        on error
          set t to ""
        end try
        if t is not "" and (do shell script "echo " & quoted form of t & " | /usr/bin/grep -i " & quoted form of pat & " > /dev/null 2>&1; echo $?") is "0" then
          set frontmost of p to true
          delay 0.2
          set posn to position of w
          set sz to size of w
          return (name of p) & "|" & t & "|" & (item 1 of posn) & "|" & (item 2 of posn) & "|" & (item 1 of sz) & "|" & (item 2 of sz)
        end if
      end repeat
    end repeat
  end tell
  return ""
end findAndFocus
findAndFocus("${args.title_pattern.replace(/"/g, '\\"')}")
`;
  const focusResult = await runOsascript(focusScript, { timeoutMs: 10_000 });
  if (focusResult.spawnFailed) {
    return { ok: false, error: 'osascript not available' };
  }
  const line = focusResult.stdout.trim();
  if (!line) {
    return { ok: false, error: `no window matched /${args.title_pattern}/i` };
  }
  const [, , xs, ys, ws, hs] = line.split('|');
  const x = parseInt(xs, 10), y = parseInt(ys, 10), w = parseInt(ws, 10), h = parseInt(hs, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) {
    return { ok: false, error: `osascript returned malformed window geometry: ${line}` };
  }
  // Step 2: capture using region selection.
  const capResult = await runCommand(
    'screencapture',
    ['-x', '-t', 'png', '-R', `${x},${y},${w},${h}`, outPath],
    { timeoutMs: 10_000 },
  );
  if (capResult.code !== 0) {
    return { ok: false, error: `screencapture region exited ${capResult.code}`, details: { stderr: capResult.stderr.slice(0, 500) } };
  }
  const bytes = await fsp.readFile(outPath);
  const dims = await pngDimensions(bytes);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width: dims.width || w,
    height: dims.height || h,
    saved_path: outPath,
    platform: 'darwin',
    backend: 'osascript+screencapture',
  };
}

async function screenshotWindowLinux(args: WindowScreenshotArgs): Promise<ScreenshotResult | ToolError> {
  if (isWayland()) {
    // Wayland has no per-window capture without a compositor extension.
    // Best we can do is full-screen capture + return a hint.
    const full = await screenshotLinux({ save_path: args.save_path });
    if (full.ok) {
      return { ...full, backend: full.backend + '+wayland-fallback-fullscreen' };
    }
    return full;
  }
  // X11: wmctrl -l for window listing, xdotool search/select, import -window <id> for capture.
  const tmpDir = makeTempDir('winshot');
  const outPath = args.save_path || join(tmpDir, 'window.png');
  // Try xdotool first — it can search by name AND activate the window.
  const xdotool = await findBinary(['xdotool']);
  let windowId: string | null = null;
  if (xdotool) {
    const search = await runCommand('xdotool', ['search', '--name', args.title_pattern], { timeoutMs: 5000 });
    if (!search.spawnFailed && search.code === 0) {
      const lines = search.stdout.split('\n').filter(Boolean);
      if (lines.length > 0) {
        windowId = lines[0].trim();
        if (args.focus_first !== false) {
          await runCommand('xdotool', ['windowactivate', '--sync', windowId], { timeoutMs: 5000 });
        }
      }
    }
  }
  // Fallback to wmctrl listing
  if (!windowId) {
    const wmctrl = await findBinary(['wmctrl']);
    if (wmctrl) {
      const list = await runCommand('wmctrl', ['-l'], { timeoutMs: 5000 });
      if (list.code === 0) {
        const rx = new RegExp(args.title_pattern, 'i');
        for (const line of list.stdout.split('\n')) {
          const cols = line.split(/\s+/);
          const wid = cols[0];
          const title = cols.slice(3).join(' ');
          if (wid && rx.test(title)) {
            windowId = wid;
            if (args.focus_first !== false) {
              await runCommand('wmctrl', ['-i', '-a', windowId], { timeoutMs: 5000 });
            }
            break;
          }
        }
      }
    }
  }
  if (!windowId) {
    return { ok: false, error: `no X11 window matched /${args.title_pattern}/i`, hint: 'Install xdotool or wmctrl' };
  }
  // Capture with imagemagick `import -window <id>`
  const imBin = await findBinary(['import']);
  if (!imBin) {
    return { ok: false, error: 'imagemagick `import` not available for per-window capture', hint: 'Install imagemagick' };
  }
  const cap = await runCommand('import', ['-window', windowId, outPath], { timeoutMs: 10_000 });
  if (cap.code !== 0) {
    return { ok: false, error: `import exited ${cap.code}`, details: { stderr: cap.stderr.slice(0, 500) } };
  }
  const bytes = await fsp.readFile(outPath);
  const dims = await pngDimensions(bytes);
  return {
    ok: true,
    base64_png: bytes.toString('base64'),
    width: dims.width, height: dims.height,
    saved_path: outPath,
    platform: 'linux',
    backend: `${xdotool ? 'xdotool' : 'wmctrl'}+import`,
  };
}

// ─── Window listing ──────────────────────────────────────────

export interface ListWindowsArgs {
  /** Optional regex (JS syntax) to filter window titles. */
  title_pattern?: string;
  /** Include not-currently-visible / minimized windows. Default false. */
  include_hidden?: boolean;
}

export async function listWindows(args: ListWindowsArgs = {}): Promise<{ ok: true; windows: WindowInfo[]; platform: string } | ToolError> {
  const plat = hostPlatform();
  try {
    let windows: WindowInfo[];
    if (plat === 'win32') windows = await listWindowsWin(args);
    else if (plat === 'darwin') windows = await listWindowsMac(args);
    else windows = await listWindowsLinux(args);
    if (args.title_pattern) {
      const rx = new RegExp(args.title_pattern, 'i');
      windows = windows.filter((w) => rx.test(w.title || ''));
    }
    return { ok: true, windows, platform: plat };
  } catch (err: any) {
    return { ok: false, error: `list_windows failed: ${err?.message || err}` };
  }
}

async function listWindowsWin(args: ListWindowsArgs): Promise<WindowInfo[]> {
  const includeHidden = !!args.include_hidden;
  const script = `${WIN32_TYPE}
$results = New-Object System.Collections.ArrayList
$cb = [AwbHostWin32+EnumWindowsProc]{
  param($h,$l)
  $vis = [AwbHostWin32]::IsWindowVisible($h)
  if ((-not $vis) -and (-not ${includeHidden ? '$true' : '$false'})) { return $true }
  $sb = New-Object System.Text.StringBuilder 2048
  [void][AwbHostWin32]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $rect = New-Object AwbHostWin32+RECT
  [void][AwbHostWin32]::GetWindowRect($h, [ref]$rect)
  $pid = 0
  [void][AwbHostWin32]::GetWindowThreadProcessId($h, [ref]$pid)
  $fg = [AwbHostWin32]::GetForegroundWindow()
  $obj = [pscustomobject]@{
    id = $h.ToInt64()
    title = $title
    pid = [int]$pid
    x = $rect.Left
    y = $rect.Top
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
    focused = ($fg -eq $h)
  }
  [void]$results.Add($obj)
  return $true
}
[void][AwbHostWin32]::EnumWindows($cb, [IntPtr]::Zero)
$results | ConvertTo-Json -Depth 5 -Compress
`;
  const result = await runPowerShell(script, { timeoutMs: 10_000 });
  if (result.spawnFailed || result.code !== 0) return [];
  const raw = result.stdout.trim();
  if (!raw) return [];
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((w: any) => ({
    id: String(w.id),
    title: String(w.title),
    pid: Number(w.pid),
    x: Number(w.x), y: Number(w.y),
    width: Number(w.width), height: Number(w.height),
    focused: !!w.focused,
  }));
}

async function listWindowsMac(args: ListWindowsArgs): Promise<WindowInfo[]> {
  // System Events gives us visible windows per process. We don't track
  // hidden windows specifically on macOS (would require Accessibility API
  // beyond System Events), so `include_hidden` is a hint only.
  void args;
  const script = `
set out to ""
tell application "System Events"
  set procs to (every process whose visible is true)
  repeat with p in procs
    set pn to name of p
    set ppid to unix id of p
    try
      set ws to every window of p
    on error
      set ws to {}
    end try
    repeat with w in ws
      try
        set t to name of w
      on error
        set t to ""
      end try
      try
        set ps to position of w
        set sz to size of w
        set out to out & pn & "\\t" & ppid & "\\t" & t & "\\t" & (item 1 of ps) & "\\t" & (item 2 of ps) & "\\t" & (item 1 of sz) & "\\t" & (item 2 of sz) & "\\n"
      on error
        set out to out & pn & "\\t" & ppid & "\\t" & t & "\\t\\t\\t\\t\\n"
      end try
    end repeat
  end repeat
end tell
return out
`;
  const result = await runOsascript(script, { timeoutMs: 15_000 });
  if (result.spawnFailed || result.code !== 0) return [];
  const out: WindowInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const [app, pidStr, title, xs, ys, ws, hs] = cols;
    if (!app || !title) continue;
    out.push({
      app,
      title,
      pid: parseInt(pidStr, 10) || undefined,
      x: parseInt(xs, 10) || 0,
      y: parseInt(ys, 10) || 0,
      width: parseInt(ws, 10) || 0,
      height: parseInt(hs, 10) || 0,
    });
  }
  return out;
}

async function listWindowsLinux(args: ListWindowsArgs): Promise<WindowInfo[]> {
  void args;
  if (isWayland()) {
    // Wayland has no portable window-list primitive. Best effort: empty.
    return [];
  }
  const wmctrl = await findBinary(['wmctrl']);
  if (!wmctrl) return [];
  const result = await runCommand('wmctrl', ['-l', '-G', '-p'], { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  const out: WindowInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, id, , pid, x, y, w, h, host, ...titleParts] = m;
    out.push({
      id,
      title: titleParts.join(' ').trim() || m[9],
      pid: parseInt(pid, 10) || undefined,
      x: parseInt(x, 10),
      y: parseInt(y, 10),
      width: parseInt(w, 10),
      height: parseInt(h, 10),
      app: host,
    });
  }
  return out;
}

// ─── Focus window ──────────────────────────────────────────

export interface FocusWindowArgs {
  title_pattern: string;
}

export async function focusWindow(args: FocusWindowArgs): Promise<{ ok: true; title: string; platform: string } | ToolError> {
  if (!args.title_pattern) return { ok: false, error: 'title_pattern is required' };
  const plat = hostPlatform();
  try {
    if (plat === 'win32') return await focusWindowWin(args);
    if (plat === 'darwin') return await focusWindowMac(args);
    return await focusWindowLinux(args);
  } catch (err: any) {
    return { ok: false, error: `focus_window failed: ${err?.message || err}` };
  }
}

async function focusWindowWin(args: FocusWindowArgs): Promise<{ ok: true; title: string; platform: string } | ToolError> {
  const script = `${WIN32_TYPE}
$ErrorActionPreference = "Stop"
$pattern = '${args.title_pattern.replace(/'/g, "''")}'
$rx = [System.Text.RegularExpressions.Regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$found = $null
$cb = [AwbHostWin32+EnumWindowsProc]{
  param($h,$l)
  if (-not [AwbHostWin32]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 1024
  [void][AwbHostWin32]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  if ($rx.IsMatch($title) -and ($null -eq $script:found)) {
    $script:found = [pscustomobject]@{ H = $h; T = $title }
  }
  return $true
}
[void][AwbHostWin32]::EnumWindows($cb, [IntPtr]::Zero)
if ($null -eq $script:found) { Write-Error "no match"; exit 2 }
[void][AwbHostWin32]::ShowWindowAsync($script:found.H, 9)
Start-Sleep -Milliseconds 200
[void][AwbHostWin32]::BringWindowToTop($script:found.H)
[void][AwbHostWin32]::SetForegroundWindow($script:found.H)
Write-Output $script:found.T
`;
  const result = await runPowerShell(script, { timeoutMs: 8000 });
  if (result.spawnFailed) return { ok: false, error: 'PowerShell not available' };
  if (result.code !== 0) return { ok: false, error: `no window matched /${args.title_pattern}/i` };
  return { ok: true, title: result.stdout.trim(), platform: 'win32' };
}

async function focusWindowMac(args: FocusWindowArgs): Promise<{ ok: true; title: string; platform: string } | ToolError> {
  const script = `
on doFocus(pat)
  tell application "System Events"
    repeat with p in (every process whose visible is true)
      try
        set ws to (every window of p)
      on error
        set ws to {}
      end try
      repeat with w in ws
        try
          set t to name of w
        on error
          set t to ""
        end try
        if t is not "" and (do shell script "echo " & quoted form of t & " | /usr/bin/grep -i " & quoted form of pat & " > /dev/null 2>&1; echo $?") is "0" then
          set frontmost of p to true
          return t
        end if
      end repeat
    end repeat
  end tell
  return ""
end doFocus
doFocus("${args.title_pattern.replace(/"/g, '\\"')}")
`;
  const result = await runOsascript(script, { timeoutMs: 10_000 });
  if (result.spawnFailed) return { ok: false, error: 'osascript not available' };
  const title = result.stdout.trim();
  if (!title) return { ok: false, error: `no window matched /${args.title_pattern}/i` };
  return { ok: true, title, platform: 'darwin' };
}

async function focusWindowLinux(args: FocusWindowArgs): Promise<{ ok: true; title: string; platform: string } | ToolError> {
  if (isWayland()) {
    return { ok: false, error: 'window focus is not supported on Wayland (no portable API)', hint: 'Run under X11 for window focus tools' };
  }
  // Prefer xdotool (regex-aware); fall back to wmctrl (substring).
  const xdotool = await findBinary(['xdotool']);
  if (xdotool) {
    const search = await runCommand('xdotool', ['search', '--name', args.title_pattern], { timeoutMs: 5000 });
    if (!search.spawnFailed && search.code === 0) {
      const lines = search.stdout.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const id = lines[0].trim();
        const act = await runCommand('xdotool', ['windowactivate', '--sync', id], { timeoutMs: 5000 });
        if (act.code === 0) {
          const nameRes = await runCommand('xdotool', ['getwindowname', id], { timeoutMs: 5000 });
          return { ok: true, title: nameRes.stdout.trim() || `xid:${id}`, platform: 'linux' };
        }
      }
    }
  }
  const wmctrl = await findBinary(['wmctrl']);
  if (wmctrl) {
    // wmctrl substring match (-F = exact, default = substring)
    const res = await runCommand('wmctrl', ['-a', args.title_pattern], { timeoutMs: 5000 });
    if (res.code === 0) return { ok: true, title: args.title_pattern, platform: 'linux' };
  }
  return { ok: false, error: 'no window focus backend (need xdotool or wmctrl)' };
}

// ─── Input: send keys ──────────────────────────────────────

export interface SendKeysArgs {
  /** Plain text to type, OR hotkey notation. Hotkey examples:
   *  - "ctrl+p" / "ctrl+shift+p" / "cmd+s" (mac) / "alt+f4"
   *  - "Return" / "Escape" / "F5"
   *  When `chord` is true, the string is parsed as a hotkey; otherwise it
   *  is typed literally. */
  keys: string;
  /** If true, treat `keys` as a hotkey chord like "ctrl+shift+p". Default
   *  false (literal typing). */
  chord?: boolean;
  /** Optional window title to focus first. */
  focus_window?: string;
}

export async function sendKeys(args: SendKeysArgs): Promise<{ ok: true; platform: string } | ToolError> {
  if (!args.keys) return { ok: false, error: 'keys is required' };
  const plat = hostPlatform();
  try {
    if (args.focus_window) {
      const focused = await focusWindow({ title_pattern: args.focus_window });
      if (!focused.ok) return focused;
    }
    if (plat === 'win32') return await sendKeysWin(args);
    if (plat === 'darwin') return await sendKeysMac(args);
    return await sendKeysLinux(args);
  } catch (err: any) {
    return { ok: false, error: `send_keys failed: ${err?.message || err}` };
  }
}

async function sendKeysWin(args: SendKeysArgs): Promise<{ ok: true; platform: string } | ToolError> {
  // System.Windows.Forms.SendKeys notation differs from our chord syntax.
  // Convert: ctrl→^, shift→+, alt→%, win→# (not supported by SendKeys).
  // For literal text we escape the SendKeys special chars.
  let payload: string;
  if (args.chord) {
    payload = chordToSendKeys(args.keys);
  } else {
    payload = escapeSendKeysText(args.keys);
  }
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${payload.replace(/'/g, "''")}')
Write-Output "ok"
`;
  const result = await runPowerShell(script, { timeoutMs: 5000 });
  if (result.spawnFailed) return { ok: false, error: 'PowerShell not available' };
  if (result.code !== 0) return { ok: false, error: `send_keys powershell exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  return { ok: true, platform: 'win32' };
}

function chordToSendKeys(chord: string): string {
  const parts = chord.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const keys: string[] = [];
  let modifiers = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') modifiers += '^';
    else if (p === 'shift') modifiers += '+';
    else if (p === 'alt' || p === 'option') modifiers += '%';
    else if (p === 'cmd' || p === 'meta' || p === 'win') modifiers += '^'; // best-effort: Win key not supported
    else keys.push(p);
  }
  const named: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}',
    escape: '{ESC}', esc: '{ESC}',
    tab: '{TAB}', space: ' ',
    backspace: '{BS}', delete: '{DEL}', del: '{DEL}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}',
    pageup: '{PGUP}', pagedown: '{PGDN}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}',
    f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}',
    f11: '{F11}', f12: '{F12}',
  };
  const last = keys[keys.length - 1] || '';
  const keyOut = named[last] ?? (last.length === 1 ? last : `{${last.toUpperCase()}}`);
  return modifiers + keyOut;
}

function escapeSendKeysText(text: string): string {
  // SendKeys treats + ^ % ~ ( ) { } as special; brace them to send literal.
  return text.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`);
}

async function sendKeysMac(args: SendKeysArgs): Promise<{ ok: true; platform: string } | ToolError> {
  let script: string;
  if (args.chord) {
    const { key, modifiers } = parseChordForApple(args.keys);
    const modStr = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
    script = `tell application "System Events" to keystroke "${key.replace(/"/g, '\\"')}"${modStr}`;
  } else {
    script = `tell application "System Events" to keystroke "${args.keys.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  const result = await runOsascript(script, { timeoutMs: 8000 });
  if (result.spawnFailed) return { ok: false, error: 'osascript not available' };
  if (result.code !== 0) return { ok: false, error: `osascript exited ${result.code}`, details: { stderr: result.stderr.slice(0, 500) } };
  return { ok: true, platform: 'darwin' };
}

function parseChordForApple(chord: string): { key: string; modifiers: string[] } {
  const parts = chord.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods.push('control down');
    else if (p === 'shift') mods.push('shift down');
    else if (p === 'alt' || p === 'option') mods.push('option down');
    else if (p === 'cmd' || p === 'meta' || p === 'win') mods.push('command down');
    else key = p;
  }
  return { key, modifiers: mods };
}

async function sendKeysLinux(args: SendKeysArgs): Promise<{ ok: true; platform: string } | ToolError> {
  if (isWayland()) {
    // Try wtype, fall back to ydotool (requires daemon + privileges).
    const wtype = await findBinary(['wtype']);
    if (wtype) {
      if (args.chord) {
        // wtype supports -M (modifier) + -k (keysym)
        const { key, modifiers } = parseChordForWtype(args.keys);
        const argv: string[] = [];
        for (const m of modifiers) argv.push('-M', m);
        argv.push('-k', key);
        const res = await runCommand('wtype', argv, { timeoutMs: 5000 });
        if (res.code !== 0) return { ok: false, error: `wtype exited ${res.code}` };
        return { ok: true, platform: 'linux' };
      }
      const res = await runCommand('wtype', ['--', args.keys], { timeoutMs: 5000 });
      if (res.code !== 0) return { ok: false, error: `wtype exited ${res.code}` };
      return { ok: true, platform: 'linux' };
    }
    return { ok: false, error: 'wtype not installed (Wayland input requires wtype or ydotool)' };
  }
  const xdotool = await findBinary(['xdotool']);
  if (!xdotool) return { ok: false, error: 'xdotool not installed' };
  if (args.chord) {
    // xdotool's `key` accepts e.g. ctrl+shift+p directly.
    const chord = args.keys.replace(/cmd|meta|win/gi, 'super').replace(/option/gi, 'alt');
    const res = await runCommand('xdotool', ['key', chord], { timeoutMs: 5000 });
    if (res.code !== 0) return { ok: false, error: `xdotool key exited ${res.code}` };
    return { ok: true, platform: 'linux' };
  }
  const res = await runCommand('xdotool', ['type', '--delay', '20', '--', args.keys], { timeoutMs: 15_000 });
  if (res.code !== 0) return { ok: false, error: `xdotool type exited ${res.code}` };
  return { ok: true, platform: 'linux' };
}

function parseChordForWtype(chord: string): { key: string; modifiers: string[] } {
  const parts = chord.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods.push('ctrl');
    else if (p === 'shift') mods.push('shift');
    else if (p === 'alt' || p === 'option') mods.push('alt');
    else if (p === 'cmd' || p === 'meta' || p === 'win') mods.push('logo');
    else key = p;
  }
  return { key, modifiers: mods };
}

// ─── Input: mouse ────────────────────────────────────────

export interface MouseClickArgs {
  x: number;
  y: number;
  /** left | middle | right. Default left. */
  button?: 'left' | 'middle' | 'right';
  /** Number of clicks (1 = single, 2 = double). Default 1. */
  count?: number;
}

export async function mouseClick(args: MouseClickArgs): Promise<{ ok: true; platform: string } | ToolError> {
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    return { ok: false, error: 'x and y are required numbers' };
  }
  const plat = hostPlatform();
  const button = args.button ?? 'left';
  const count = Math.max(1, args.count ?? 1);
  try {
    if (plat === 'win32') return await mouseClickWin(args.x, args.y, button, count);
    if (plat === 'darwin') return await mouseClickMac(args.x, args.y, button, count);
    return await mouseClickLinux(args.x, args.y, button, count);
  } catch (err: any) {
    return { ok: false, error: `mouse_click failed: ${err?.message || err}` };
  }
}

async function mouseClickWin(x: number, y: number, button: string, count: number): Promise<{ ok: true; platform: string } | ToolError> {
  const downConst = button === 'right' ? 'MOUSE_RIGHTDOWN' : button === 'middle' ? 'MOUSE_MIDDOWN' : 'MOUSE_LEFTDOWN';
  const upConst = button === 'right' ? 'MOUSE_RIGHTUP' : button === 'middle' ? 'MOUSE_MIDUP' : 'MOUSE_LEFTUP';
  const script = `${WIN32_TYPE}
[AwbHostWin32]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 50
for ($i = 0; $i -lt ${count}; $i++) {
  [AwbHostWin32]::mouse_event([AwbHostWin32]::${downConst}, 0, 0, 0, 0)
  [AwbHostWin32]::mouse_event([AwbHostWin32]::${upConst},   0, 0, 0, 0)
  if ($i -lt (${count} - 1)) { Start-Sleep -Milliseconds 60 }
}
Write-Output "ok"
`;
  const result = await runPowerShell(script, { timeoutMs: 5000 });
  if (result.spawnFailed) return { ok: false, error: 'PowerShell not available' };
  if (result.code !== 0) return { ok: false, error: `mouse_click powershell exited ${result.code}` };
  return { ok: true, platform: 'win32' };
}

async function mouseClickMac(x: number, y: number, button: string, count: number): Promise<{ ok: true; platform: string } | ToolError> {
  // osascript / cliclick. cliclick is a small CLI that nails arbitrary
  // mouse coords reliably; if missing, fall back to AppleScript+Quartz.
  const cliclick = await findBinary(['cliclick']);
  if (cliclick) {
    const cmd = button === 'right' ? 'rc' : button === 'middle' ? 'mc' : count >= 2 ? 'dc' : 'c';
    const res = await runCommand('cliclick', [`${cmd}:${x},${y}`], { timeoutMs: 5000 });
    if (res.code !== 0) return { ok: false, error: `cliclick exited ${res.code}` };
    return { ok: true, platform: 'darwin' };
  }
  // Pure osascript fallback — only supports left click reliably.
  if (button !== 'left') return { ok: false, error: `${button} click on macOS requires cliclick`, hint: 'brew install cliclick' };
  const script = `do shell script "/usr/bin/python3 -c 'import Quartz, sys; x=int(sys.argv[1]); y=int(sys.argv[2]); n=int(sys.argv[3]);
import Quartz.CoreGraphics as CG
for i in range(n):
  e1 = CG.CGEventCreateMouseEvent(None, CG.kCGEventLeftMouseDown, (x,y), CG.kCGMouseButtonLeft);
  e2 = CG.CGEventCreateMouseEvent(None, CG.kCGEventLeftMouseUp,   (x,y), CG.kCGMouseButtonLeft);
  CG.CGEventPost(CG.kCGHIDEventTap, e1); CG.CGEventPost(CG.kCGHIDEventTap, e2);
' ${x} ${y} ${count}"`;
  const result = await runOsascript(script, { timeoutMs: 8000 });
  if (result.code !== 0) return { ok: false, error: 'mouse_click failed; install cliclick or expose Quartz via pyobjc' };
  return { ok: true, platform: 'darwin' };
}

async function mouseClickLinux(x: number, y: number, button: string, count: number): Promise<{ ok: true; platform: string } | ToolError> {
  if (isWayland()) {
    const ydotool = await findBinary(['ydotool']);
    if (!ydotool) return { ok: false, error: 'ydotool not installed (Wayland mouse needs ydotool)' };
    const btn = button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0';
    const moveRes = await runCommand('ydotool', ['mousemove', '--absolute', '--', String(x), String(y)], { timeoutMs: 5000 });
    if (moveRes.code !== 0) return { ok: false, error: `ydotool mousemove exited ${moveRes.code}` };
    for (let i = 0; i < count; i++) {
      const clickRes = await runCommand('ydotool', ['click', btn], { timeoutMs: 3000 });
      if (clickRes.code !== 0) return { ok: false, error: `ydotool click exited ${clickRes.code}` };
    }
    return { ok: true, platform: 'linux' };
  }
  const xdotool = await findBinary(['xdotool']);
  if (!xdotool) return { ok: false, error: 'xdotool not installed' };
  const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  const move = await runCommand('xdotool', ['mousemove', String(x), String(y)], { timeoutMs: 5000 });
  if (move.code !== 0) return { ok: false, error: `xdotool mousemove exited ${move.code}` };
  for (let i = 0; i < count; i++) {
    const click = await runCommand('xdotool', ['click', btn], { timeoutMs: 3000 });
    if (click.code !== 0) return { ok: false, error: `xdotool click exited ${click.code}` };
  }
  return { ok: true, platform: 'linux' };
}

export interface MouseMoveArgs { x: number; y: number; }

export async function mouseMove(args: MouseMoveArgs): Promise<{ ok: true; platform: string } | ToolError> {
  const plat = hostPlatform();
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    return { ok: false, error: 'x and y are required numbers' };
  }
  try {
    if (plat === 'win32') {
      const script = `${WIN32_TYPE}\n[AwbHostWin32]::SetCursorPos(${args.x}, ${args.y})\nWrite-Output "ok"`;
      const res = await runPowerShell(script, { timeoutMs: 5000 });
      if (res.code !== 0) return { ok: false, error: 'SetCursorPos failed' };
      return { ok: true, platform: 'win32' };
    }
    if (plat === 'darwin') {
      const cliclick = await findBinary(['cliclick']);
      if (cliclick) {
        const r = await runCommand('cliclick', [`m:${args.x},${args.y}`], { timeoutMs: 5000 });
        return r.code === 0 ? { ok: true, platform: 'darwin' } : { ok: false, error: `cliclick exited ${r.code}` };
      }
      return { ok: false, error: 'cliclick not installed; brew install cliclick' };
    }
    if (isWayland()) {
      const r = await runCommand('ydotool', ['mousemove', '--absolute', '--', String(args.x), String(args.y)], { timeoutMs: 5000 });
      return r.code === 0 ? { ok: true, platform: 'linux' } : { ok: false, error: 'ydotool mousemove failed' };
    }
    const r = await runCommand('xdotool', ['mousemove', String(args.x), String(args.y)], { timeoutMs: 5000 });
    return r.code === 0 ? { ok: true, platform: 'linux' } : { ok: false, error: 'xdotool mousemove failed' };
  } catch (err: any) {
    return { ok: false, error: `mouse_move failed: ${err?.message || err}` };
  }
}

// ─── Process listing / kill / launch ───────────────────────

export interface ListProcessesArgs {
  /** Filter by name regex (JS syntax, case-insensitive). */
  name_pattern?: string;
}

export async function listProcesses(args: ListProcessesArgs = {}): Promise<{ ok: true; processes: ProcessInfo[]; platform: string } | ToolError> {
  const plat = hostPlatform();
  try {
    let procs: ProcessInfo[];
    if (plat === 'win32') procs = await listProcessesWin();
    else procs = await listProcessesUnix();
    if (args.name_pattern) {
      const rx = new RegExp(args.name_pattern, 'i');
      procs = procs.filter((p) => rx.test(p.name) || (p.cmdline && rx.test(p.cmdline)));
    }
    return { ok: true, processes: procs, platform: plat };
  } catch (err: any) {
    return { ok: false, error: `list_processes failed: ${err?.message || err}` };
  }
}

async function listProcessesWin(): Promise<ProcessInfo[]> {
  // Get-Process is the structured PowerShell equivalent of `ps aux` on Windows.
  // Includes PID, name, PM (paged memory), CPU. We don't include CommandLine
  // by default because it requires WMI and is slow; callers wanting cmdline
  // can use the shell_exec escape hatch.
  const script = `
Get-Process | ForEach-Object {
  [pscustomobject]@{
    pid = $_.Id
    name = $_.ProcessName
    mem_kb = [int]($_.WorkingSet64 / 1024)
    cpu = $_.CPU
  }
} | ConvertTo-Json -Depth 3 -Compress
`;
  const res = await runPowerShell(script, { timeoutMs: 10_000 });
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((p: any) => ({
      pid: Number(p.pid),
      name: String(p.name),
      mem_kb: typeof p.mem_kb === 'number' ? p.mem_kb : undefined,
      cpu: typeof p.cpu === 'number' ? p.cpu : undefined,
    }));
  } catch {
    return [];
  }
}

async function listProcessesUnix(): Promise<ProcessInfo[]> {
  // `ps -eo pid,ppid,user,pcpu,rss,comm` is portable across macOS / Linux.
  // -e = all processes, -o = custom columns.
  const res = await runCommand('ps', ['-eo', 'pid,ppid,user,pcpu,rss,comm'], { timeoutMs: 8000 });
  if (res.code !== 0) return [];
  const out: ProcessInfo[] = [];
  const lines = res.stdout.split('\n');
  // Skip header (first line)
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [pidStr, ppidStr, user, cpuStr, rssStr, ...nameParts] = cols;
    out.push({
      pid: parseInt(pidStr, 10),
      ppid: parseInt(ppidStr, 10) || undefined,
      user,
      cpu: parseFloat(cpuStr),
      mem_kb: parseInt(rssStr, 10),
      name: nameParts.join(' '),
    });
  }
  return out;
}

export interface KillProcessArgs {
  /** Process ID to kill. Either `pid` or `name_pattern` must be set. */
  pid?: number;
  /** Regex match on process name (kills first matching process). */
  name_pattern?: string;
  /** Force-kill (SIGKILL / taskkill /F). Default false (SIGTERM). */
  force?: boolean;
}

export async function killProcess(args: KillProcessArgs): Promise<{ ok: true; killed: number[]; platform: string } | ToolError> {
  if (!args.pid && !args.name_pattern) {
    return { ok: false, error: 'either pid or name_pattern is required' };
  }
  const plat = hostPlatform();
  try {
    let targets: number[] = [];
    if (args.pid) targets.push(args.pid);
    if (args.name_pattern) {
      const proc = await listProcesses({ name_pattern: args.name_pattern });
      if (!proc.ok) return proc;
      for (const p of proc.processes) targets.push(p.pid);
    }
    targets = Array.from(new Set(targets));
    if (targets.length === 0) {
      return { ok: false, error: 'no matching processes' };
    }
    const killed: number[] = [];
    if (plat === 'win32') {
      for (const pid of targets) {
        const argv = args.force ? ['/PID', String(pid), '/F', '/T'] : ['/PID', String(pid), '/T'];
        const r = await runCommand('taskkill', argv, { timeoutMs: 5000 });
        if (r.code === 0) killed.push(pid);
      }
    } else {
      const sig = args.force ? 'SIGKILL' : 'SIGTERM';
      for (const pid of targets) {
        try {
          process.kill(pid, sig);
          killed.push(pid);
        } catch {
          /* permission / already dead */
        }
      }
    }
    return { ok: true, killed, platform: plat };
  } catch (err: any) {
    return { ok: false, error: `kill_process failed: ${err?.message || err}` };
  }
}

export interface LaunchProcessArgs {
  /** Executable to launch. */
  command: string;
  /** Arguments to pass. */
  args?: string[];
  /** Working directory. */
  cwd?: string;
  /** Environment variables to override. */
  env?: Record<string, string>;
  /** Detach so the launched process outlives the agent-manager. Default true
   *  — typically the agent wants to relaunch Unity / Editor and forget. */
  detach?: boolean;
}

export async function launchProcess(args: LaunchProcessArgs): Promise<{ ok: true; pid: number | null; platform: string } | ToolError> {
  if (!args.command) return { ok: false, error: 'command is required' };
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(args.command, args.args || [], {
      cwd: args.cwd,
      env: { ...process.env, ...(args.env || {}) },
      detached: args.detach !== false,
      stdio: 'ignore',
    });
    if (args.detach !== false) {
      child.unref();
    }
    return { ok: true, pid: child.pid ?? null, platform: hostPlatform() };
  } catch (err: any) {
    return { ok: false, error: `launch_process failed: ${err?.message || err}` };
  }
}

// ─── Files: wait_for / read_tail ─────────────────────────

export interface WaitForFileArgs {
  path: string;
  /** Max seconds to wait. Default 30. */
  timeout_seconds?: number;
  /** Poll interval in milliseconds. Default 500. */
  poll_ms?: number;
  /** When set, only resolve once the file's mtime is >= this Unix-ms (so
   *  stale signal files don't immediately satisfy the wait). */
  newer_than_ms?: number;
  /** When set, only resolve once the file's contents match this regex. */
  content_pattern?: string;
}

export async function waitForFile(args: WaitForFileArgs): Promise<{ ok: true; appeared_at: string; size: number; content?: string } | ToolError> {
  if (!args.path) return { ok: false, error: 'path is required' };
  const deadline = Date.now() + Math.max(1, args.timeout_seconds ?? 30) * 1000;
  const interval = Math.max(50, args.poll_ms ?? 500);
  const rx = args.content_pattern ? new RegExp(args.content_pattern) : null;
  while (Date.now() < deadline) {
    try {
      const st = statSync(args.path);
      const mtimeOk = !args.newer_than_ms || st.mtimeMs >= args.newer_than_ms;
      if (mtimeOk) {
        if (!rx) {
          return { ok: true, appeared_at: new Date(st.mtimeMs).toISOString(), size: st.size };
        }
        const content = (await fsp.readFile(args.path, 'utf8')).slice(0, 64 * 1024);
        if (rx.test(content)) {
          return { ok: true, appeared_at: new Date(st.mtimeMs).toISOString(), size: st.size, content };
        }
      }
    } catch {
      /* not present yet */
    }
    await new Promise<void>((res) => setTimeout(res, interval));
  }
  return { ok: false, error: `timed out after ${args.timeout_seconds ?? 30}s waiting for ${args.path}` };
}

export interface ReadFileTailArgs {
  path: string;
  /** Number of bytes to read from the end. Default 8192. Clamped to 1 MiB. */
  bytes?: number;
}

export async function readFileTail(args: ReadFileTailArgs): Promise<{ ok: true; content: string; size: number; mtime: string } | ToolError> {
  if (!args.path) return { ok: false, error: 'path is required' };
  if (!existsSync(args.path)) return { ok: false, error: `file not found: ${args.path}` };
  try {
    const st = statSync(args.path);
    const want = Math.min(1024 * 1024, Math.max(1, args.bytes ?? 8192));
    const start = Math.max(0, st.size - want);
    const fh = await fsp.open(args.path, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      return {
        ok: true,
        content: buf.toString('utf8'),
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      };
    } finally {
      await fh.close();
    }
  } catch (err: any) {
    return { ok: false, error: `read_file_tail failed: ${err?.message || err}` };
  }
}

// ─── Clipboard ────────────────────────────────────────

export async function clipboardRead(): Promise<{ ok: true; text: string; platform: string } | ToolError> {
  const plat = hostPlatform();
  try {
    if (plat === 'win32') {
      const res = await runPowerShell('Get-Clipboard -Raw', { timeoutMs: 5000 });
      if (res.code !== 0) return { ok: false, error: 'Get-Clipboard failed' };
      return { ok: true, text: res.stdout, platform: 'win32' };
    }
    if (plat === 'darwin') {
      const res = await runCommand('pbpaste', [], { timeoutMs: 5000 });
      if (res.spawnFailed) return { ok: false, error: 'pbpaste not available' };
      return { ok: true, text: res.stdout, platform: 'darwin' };
    }
    if (isWayland()) {
      const res = await runCommand('wl-paste', [], { timeoutMs: 5000 });
      if (res.spawnFailed) return { ok: false, error: 'wl-paste not installed' };
      return { ok: true, text: res.stdout, platform: 'linux' };
    }
    const xclip = await findBinary(['xclip', 'xsel']);
    if (!xclip) return { ok: false, error: 'xclip / xsel not installed' };
    const argv = xclip === 'xclip' ? ['-selection', 'clipboard', '-o'] : ['--clipboard', '--output'];
    const res = await runCommand(xclip, argv, { timeoutMs: 5000 });
    if (res.code !== 0) return { ok: false, error: `${xclip} exited ${res.code}` };
    return { ok: true, text: res.stdout, platform: 'linux' };
  } catch (err: any) {
    return { ok: false, error: `clipboard_read failed: ${err?.message || err}` };
  }
}

export interface ClipboardWriteArgs {
  text: string;
}

export async function clipboardWrite(args: ClipboardWriteArgs): Promise<{ ok: true; platform: string } | ToolError> {
  if (typeof args.text !== 'string') return { ok: false, error: 'text is required' };
  const plat = hostPlatform();
  try {
    if (plat === 'win32') {
      // Set-Clipboard reads from stdin via -Value parameter; pipe through.
      const script = `$input | Set-Clipboard`;
      const res = await runPowerShell(script, { timeoutMs: 5000, stdin: args.text });
      if (res.code !== 0) return { ok: false, error: 'Set-Clipboard failed' };
      return { ok: true, platform: 'win32' };
    }
    if (plat === 'darwin') {
      const res = await runCommand('pbcopy', [], { timeoutMs: 5000, stdin: args.text });
      if (res.spawnFailed) return { ok: false, error: 'pbcopy not available' };
      return { ok: true, platform: 'darwin' };
    }
    if (isWayland()) {
      const res = await runCommand('wl-copy', [], { timeoutMs: 5000, stdin: args.text });
      if (res.spawnFailed) return { ok: false, error: 'wl-copy not installed' };
      return { ok: true, platform: 'linux' };
    }
    const xclip = await findBinary(['xclip', 'xsel']);
    if (!xclip) return { ok: false, error: 'xclip / xsel not installed' };
    const argv = xclip === 'xclip' ? ['-selection', 'clipboard', '-i'] : ['--clipboard', '--input'];
    const res = await runCommand(xclip, argv, { timeoutMs: 5000, stdin: args.text });
    if (res.code !== 0) return { ok: false, error: `${xclip} exited ${res.code}` };
    return { ok: true, platform: 'linux' };
  } catch (err: any) {
    return { ok: false, error: `clipboard_write failed: ${err?.message || err}` };
  }
}

// ─── System info ────────────────────────────────────────

export async function osInfo(): Promise<{ ok: true; info: Record<string, unknown> }> {
  return {
    ok: true,
    info: {
      platform: hostPlatform(),
      wayland: isWayland(),
      hostname: hostname(),
      user: userInfo().username,
      os_release: release(),
      arch: arch(),
      cpu_count: cpus().length,
      memory_total_mb: Math.round(totalmem() / (1024 * 1024)),
      memory_free_mb: Math.round(freemem() / (1024 * 1024)),
      env_display: process.env.DISPLAY || null,
      env_wayland_display: process.env.WAYLAND_DISPLAY || null,
      node_version: process.version,
      pid: process.pid,
    },
  };
}

// ─── Shell exec (escape hatch) ────────────────────────────

export interface ShellExecArgs {
  command: string;
  args?: string[];
  cwd?: string;
  timeout_seconds?: number;
  stdin?: string;
}

export async function shellExec(args: ShellExecArgs): Promise<{ ok: true; code: number; stdout: string; stderr: string } | ToolError> {
  if (!args.command) return { ok: false, error: 'command is required' };
  const timeoutMs = Math.max(1, args.timeout_seconds ?? 30) * 1000;
  try {
    const res = await runCommand(args.command, args.args || [], {
      cwd: args.cwd,
      stdin: args.stdin,
      timeoutMs,
    });
    if (res.spawnFailed) return { ok: false, error: res.spawnError };
    return { ok: true, code: res.code, stdout: res.stdout, stderr: res.stderr };
  } catch (err: any) {
    return { ok: false, error: `shell_exec failed: ${err?.message || err}` };
  }
}

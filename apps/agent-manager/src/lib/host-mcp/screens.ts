// Monitor enumeration. Returns one entry per attached display so the model
// can pick a `display` index for screenshot calls or learn the virtual-desktop
// layout before computing absolute mouse coords.
//
// Shells out per-OS — same philosophy as the rest of host-mcp: never carry a
// native add-on that might fail to build on Synology / RasPi / Windows.

import { findBinary, hostPlatform, isWayland, runCommand, runPowerShell } from './platform.js';

export interface MonitorInfo {
  index: number;
  /** Top-left in virtual-desktop coords (negative when arranged left of primary). */
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  /** HiDPI scale factor (1.0 / 2.0 / 1.5 ...). null when not knowable. */
  scale: number | null;
  /** Friendly name from the OS when available. */
  name: string | null;
}

export interface ListScreensResult {
  ok: true;
  monitors: MonitorInfo[];
  platform: string;
  /** Set when zero monitors enumerated; explains what tool was tried. */
  warning?: string;
}

export interface ListScreensError {
  ok: false;
  error: string;
  hint?: string;
}

export async function listScreens(): Promise<ListScreensResult | ListScreensError> {
  const plat = hostPlatform();
  try {
    if (plat === 'win32') return await listScreensWin();
    if (plat === 'darwin') return await listScreensMac();
    return isWayland() ? await listScreensWayland() : await listScreensX11();
  } catch (err: any) {
    return { ok: false, error: `list_screens failed: ${err?.message ?? err}` };
  }
}

async function listScreensWin(): Promise<ListScreensResult | ListScreensError> {
  // System.Windows.Forms.Screen.AllScreens — virtual-desktop coords come
  // from .Bounds. DPI scale isn't exposed there; report null and let the
  // model fall back on screenshot dimensions to detect HiDPI.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$idx = 0
$out = foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $row = [pscustomobject]@{
    index   = $idx
    x       = $s.Bounds.X
    y       = $s.Bounds.Y
    width   = $s.Bounds.Width
    height  = $s.Bounds.Height
    primary = [bool]$s.Primary
    scale   = $null
    name    = $s.DeviceName
  }
  $idx++
  $row
}
$out | ConvertTo-Json -Depth 3 -Compress
`;
  const r = await runPowerShell(script, { timeoutMs: 8000 });
  if (r.spawnFailed) return { ok: false, error: 'PowerShell not available', hint: 'Install PowerShell or pwsh' };
  if (r.code !== 0) return { ok: false, error: `Screen.AllScreens failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  return parseMonitors(r.stdout, 'win32');
}

async function listScreensMac(): Promise<ListScreensResult | ListScreensError> {
  // NSScreen.screens() is the source of truth for visible-frame + scale,
  // but AppleScript can't read it directly. Shell out to python3 + AppKit;
  // when python3 isn't installed (newer macOS may remove it), fall back to
  // a single-display stub using `screencapture -i` exits — better than a
  // hard failure.
  const script = `
import json, sys
try:
  import AppKit
except Exception as e:
  print('[]')
  sys.exit(0)
main = AppKit.NSScreen.mainScreen()
out = []
for i, s in enumerate(AppKit.NSScreen.screens()):
  f = s.frame()
  out.append({
    'index': i,
    'x': int(f.origin.x),
    'y': int(f.origin.y),
    'width': int(f.size.width),
    'height': int(f.size.height),
    'primary': bool(s == main),
    'scale': float(s.backingScaleFactor()),
    'name': str(s.localizedName()) if hasattr(s, 'localizedName') else None,
  })
print(json.dumps(out))
`;
  const r = await runCommand('/usr/bin/python3', ['-c', script], { timeoutMs: 6000 });
  if (r.spawnFailed) {
    return {
      ok: false,
      error: 'python3 not available for AppKit display enumeration',
      hint: 'Install python3 (xcode-select --install) or use display=0 implicitly',
    };
  }
  if (r.code !== 0) {
    return { ok: false, error: `AppKit enumeration exited ${r.code}: ${r.stderr.trim()}` };
  }
  return parseMonitors(r.stdout, 'darwin');
}

async function listScreensX11(): Promise<ListScreensResult | ListScreensError> {
  // xrandr --listmonitors line shape:
  //   "  0: +*HDMI-1 1920/598x1080/336+0+0  HDMI-1"
  // index → primary("*") → WxH+X+Y. We don't try to parse mm/scale.
  const bin = await findBinary(['xrandr']);
  if (!bin) {
    return {
      ok: false,
      error: 'xrandr not installed',
      hint: 'apt install x11-xserver-utils',
    };
  }
  const r = await runCommand('xrandr', ['--listmonitors'], { timeoutMs: 5000 });
  if (r.spawnFailed || r.code !== 0) {
    return { ok: false, error: `xrandr failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  const monitors: MonitorInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+):\s*\+(\*?)\S+\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    monitors.push({
      index: Number(m[1]),
      x: Number(m[5]),
      y: Number(m[6]),
      width: Number(m[3]),
      height: Number(m[4]),
      primary: m[2] === '*',
      scale: null,
      name: m[7],
    });
  }
  return {
    ok: true,
    monitors,
    platform: 'linux',
    warning: monitors.length === 0 ? 'xrandr returned no monitor rows' : undefined,
  };
}

async function listScreensWayland(): Promise<ListScreensResult | ListScreensError> {
  // wlr-randr covers the wlroots family (sway / hyprland / wayfire). GNOME
  // and KDE Wayland have no portable CLI — XWayland's xrandr is the
  // fallback for those.
  const wlr = await findBinary(['wlr-randr']);
  if (wlr) {
    const r = await runCommand('wlr-randr', ['--json'], { timeoutMs: 5000 });
    if (!r.spawnFailed && r.code === 0 && r.stdout.trim()) {
      try {
        const data = JSON.parse(r.stdout);
        const monitors: MonitorInfo[] = [];
        let idx = 0;
        for (const dev of Array.isArray(data) ? data : []) {
          const currentMode = (dev.modes || []).find((m: any) => m.current) || (dev.modes || [])[0];
          const pos = dev.position || { x: 0, y: 0 };
          monitors.push({
            index: idx++,
            x: Number(pos.x ?? 0),
            y: Number(pos.y ?? 0),
            width: Number(currentMode?.width ?? 0),
            height: Number(currentMode?.height ?? 0),
            primary: idx === 1 && !!dev.enabled,
            scale: typeof dev.scale === 'number' ? dev.scale : null,
            name: dev.name || dev.make || null,
          });
        }
        return { ok: true, monitors, platform: 'linux' };
      } catch (err: any) {
        return { ok: false, error: `wlr-randr JSON parse: ${err?.message ?? err}` };
      }
    }
  }
  // Fall through to xrandr (XWayland) — usable on GNOME/KDE Wayland too.
  return listScreensX11();
}

function parseMonitors(stdout: string, platform: string): ListScreensResult | ListScreensError {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: true, monitors: [], platform, warning: 'enumeration returned empty output' };
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err: any) {
    return { ok: false, error: `JSON parse failed: ${err?.message ?? err}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const monitors: MonitorInfo[] = list.map((r: any, i: number) => ({
    index: typeof r.index === 'number' ? r.index : i,
    x: Number(r.x ?? 0),
    y: Number(r.y ?? 0),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    primary: !!r.primary,
    scale: typeof r.scale === 'number' ? r.scale : null,
    name: typeof r.name === 'string' ? r.name : null,
  }));
  return { ok: true, monitors, platform };
}

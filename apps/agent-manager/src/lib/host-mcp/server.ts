// host-mcp stdio MCP server — exposes cross-OS "host" tools to managed
// subagents. Spawned by claude/antigravity via `awb-agent-manager mcp-host`.
//
// Why a separate stdio server (not a tool added to the AWB HTTP /mcp endpoint):
//   - These tools must run on the agent-manager HOST (the operator's
//     desktop / laptop / Synology). The AWB server runs centrally,
//     possibly on a different machine, and has no business taking a
//     screenshot of the operator's monitor.
//   - stdio invocation gives the managed agent's CLI (claude / antigravity)
//     direct access to a process forked from the agent-manager binary,
//     which is already running with the operator's permissions on the
//     operator's box.
//   - No network egress: agent → CLI → fork(agent-manager mcp-host).
//     No surface for cross-host attack.
//
// Each tool is registered with a zod schema. Errors are caught at the
// tool boundary and returned as `isError:true` content; the server itself
// never throws so a misbehaving tool can't kill the connection.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  clipboardRead,
  clipboardWrite,
  focusWindow,
  killProcess,
  launchProcess,
  listProcesses,
  listWindows,
  mouseClick,
  mouseMove,
  osInfo,
  readFileTail,
  screenshotWindow,
  sendKeys,
  shellExec,
  takeScreenshot,
  waitForFile,
} from './tools.js';
import { listScreens } from './screens.js';
import { findUnityLogs } from './logs.js';

// MCP wire format for a tool response.
// Reused across every tool below so changes to the envelope shape land
// in one place.
type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
type McpResponse = { content: McpContent[]; isError?: boolean };

function okText(payload: unknown): McpResponse {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errText(message: string, extra?: Record<string, unknown>): McpResponse {
  const payload = extra ? { error: message, ...extra } : { error: message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
}

function imageReply(base64Png: string, meta: Record<string, unknown>): McpResponse {
  // Two-block response: the image (so the model can see it) PLUS a text
  // block with size / path / backend metadata. Claude / Antigravity both
  // honour multi-block tool replies.
  return {
    content: [
      { type: 'image' as const, data: base64Png, mimeType: 'image/png' },
      { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
    ],
  };
}

const HOST_MCP_SERVER_NAME = 'awb-host';
const HOST_MCP_SERVER_VERSION = '1.0.0';

export function createHostMcpServer(): McpServer {
  const server = new McpServer(
    { name: HOST_MCP_SERVER_NAME, version: HOST_MCP_SERVER_VERSION },
    { capabilities: {} },
  );

  // ── screenshot ─────────────────────────────────────────────
  server.tool(
    'screenshot',
    'Capture a full-screen screenshot of the host the agent-manager is running on. ' +
      'Returns the PNG inline as an image content block (the model can see it directly) plus a JSON text block with width, height, saved_path, platform, backend. ' +
      'Use this when you suspect a GUI tool (Unity Editor, browser, IDE) has popped up a modal, crashed, or otherwise stalled — a screenshot will tell you what state the screen is in. ' +
      'Cross-OS: Windows uses System.Drawing, macOS uses screencapture, Linux uses grim / scrot / gnome-screenshot / import depending on what is installed.',
    {
      save_path: z.string().optional().describe('Optional absolute path to also write the PNG to (in addition to returning base64).'),
      display: z.number().int().optional().describe('Display index, 0 = primary. Honored on Windows / Linux X11.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await takeScreenshot(args);
      if (!result.ok) return errText(result.error, { hint: result.hint, details: result.details });
      return imageReply(result.base64_png, {
        width: result.width,
        height: result.height,
        saved_path: result.saved_path,
        platform: result.platform,
        backend: result.backend,
      });
    },
  );

  // ── window_screenshot ────────────────────────────────────
  server.tool(
    'window_screenshot',
    'Capture a screenshot of the first visible window whose title matches a regex pattern. ' +
      'Useful when the agent needs to focus on a single app (e.g. Unity Editor, Visual Studio) without the rest of the desktop in frame. ' +
      'On Linux Wayland (no per-window capture API) the implementation falls back to a full-screen capture and marks the backend with `wayland-fallback-fullscreen`. ' +
      'Default `focus_first=true` brings the window to the foreground before capturing.',
    {
      title_pattern: z.string().describe('Regex (JS syntax, case-insensitive) matched against window titles. First visible match wins.'),
      save_path: z.string().optional().describe('Optional absolute path to also write the PNG to.'),
      focus_first: z.boolean().optional().describe('Focus the target window before capture. Default true.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await screenshotWindow(args);
      if (!result.ok) return errText(result.error, { hint: result.hint, details: result.details });
      return imageReply(result.base64_png, {
        width: result.width,
        height: result.height,
        saved_path: result.saved_path,
        platform: result.platform,
        backend: result.backend,
      });
    },
  );

  // ── list_windows ────────────────────────────────────────
  server.tool(
    'list_windows',
    'List visible windows on the host with their pid, title, and geometry. ' +
      'Pass `title_pattern` to filter by regex. Use this to discover which window to target with `focus_window` / `window_screenshot` / `send_keys`. ' +
      'On Linux Wayland this returns an empty list (no portable API).',
    {
      title_pattern: z.string().optional().describe('Optional regex (JS syntax) to filter by window title.'),
      include_hidden: z.boolean().optional().describe('Include not-currently-visible windows. Default false. Honored only on Windows.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await listWindows(args);
      if (!result.ok) return errText(result.error);
      return okText({ count: result.windows.length, windows: result.windows, platform: result.platform });
    },
  );

  // ── focus_window ────────────────────────────────────────
  server.tool(
    'focus_window',
    'Bring the first visible window matching `title_pattern` to the foreground. ' +
      'Required as a precondition for `send_keys` / `mouse_click` on most platforms — input gets routed to whatever window currently has focus.',
    {
      title_pattern: z.string().describe('Regex (JS syntax, case-insensitive) matched against window titles. First visible match wins.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await focusWindow(args);
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ title: result.title, platform: result.platform });
    },
  );

  // ── send_keys ────────────────────────────────────────────
  server.tool(
    'send_keys',
    'Send keystrokes to the currently-focused window (or focus a window first by passing `focus_window`). ' +
      'Two modes: literal typing (default — `keys` is typed verbatim) OR hotkey chord (`chord:true` — `keys` is parsed as `ctrl+shift+p`, `cmd+s`, `f5`, `enter`, etc.). ' +
      'On macOS, `cmd` maps to Command; on Windows, `cmd` falls back to Ctrl (Win key is not exposed via SendKeys). ' +
      'Linux Wayland requires `wtype` (or `ydotool` with the daemon running).',
    {
      keys: z.string().describe('Text to type, or hotkey chord like "ctrl+p" when `chord` is true.'),
      chord: z.boolean().optional().describe('Parse `keys` as a hotkey chord instead of literal text. Default false.'),
      focus_window: z.string().optional().describe('Optional title regex — focus this window before sending keys.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await sendKeys(args);
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ sent: true, platform: result.platform });
    },
  );

  // ── mouse_click ────────────────────────────────────────────
  server.tool(
    'mouse_click',
    'Click at absolute screen coordinates (x, y). Use with prior `window_screenshot` to figure out where buttons are. ' +
      'macOS requires `cliclick` (brew install cliclick) for non-left-click. Linux Wayland requires `ydotool`.',
    {
      x: z.number().int().describe('Absolute screen x coordinate.'),
      y: z.number().int().describe('Absolute screen y coordinate.'),
      button: z.enum(['left', 'middle', 'right']).optional().describe('Button. Default left.'),
      count: z.number().int().min(1).max(5).optional().describe('Click count (1 = single, 2 = double). Default 1.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await mouseClick(args);
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ clicked: true, platform: result.platform });
    },
  );

  // ── mouse_move ─────────────────────────────────────────────
  server.tool(
    'mouse_move',
    'Move the mouse cursor to absolute screen coordinates without clicking. Useful to hover before screenshotting (some IDE/editor surfaces only render tooltips on hover).',
    {
      x: z.number().int().describe('Absolute screen x coordinate.'),
      y: z.number().int().describe('Absolute screen y coordinate.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await mouseMove(args);
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ moved: true, platform: result.platform });
    },
  );

  // ── list_processes ─────────────────────────────────────────
  server.tool(
    'list_processes',
    'List running processes on the host (pid, name, cpu, mem_kb, ppid, user when available). ' +
      'Pass `name_pattern` to filter by regex. Use this to check whether Unity / Editor / a build tool is still alive, find PIDs to kill, etc.',
    {
      name_pattern: z.string().optional().describe('Regex (JS syntax) to filter process names / cmdlines.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await listProcesses(args);
      if (!result.ok) return errText(result.error);
      return okText({ count: result.processes.length, processes: result.processes, platform: result.platform });
    },
  );

  // ── kill_process ───────────────────────────────────────────
  server.tool(
    'kill_process',
    'Kill a process by pid or by name regex. Default uses SIGTERM (graceful); pass `force:true` to use SIGKILL / `taskkill /F`. ' +
      'Returns the list of pids actually killed. Common usage: after detecting Unity has frozen via `list_processes`, kill and then `launch_process` to relaunch it.',
    {
      pid: z.number().int().optional().describe('PID to kill.'),
      name_pattern: z.string().optional().describe('Regex matching process names — kills all matching processes.'),
      force: z.boolean().optional().describe('Force kill (SIGKILL / taskkill /F). Default false (SIGTERM).'),
    },
    async (args): Promise<McpResponse> => {
      const result = await killProcess(args);
      if (!result.ok) return errText(result.error);
      return okText({ killed: result.killed, count: result.killed.length, platform: result.platform });
    },
  );

  // ── launch_process ─────────────────────────────────────────
  server.tool(
    'launch_process',
    'Launch a program on the host. Returns the pid (when available). The launched process is detached by default so it outlives the agent-manager; pass `detach:false` to tie its lifetime to the manager.',
    {
      command: z.string().describe('Executable path or name on PATH.'),
      args: z.array(z.string()).optional().describe('Command-line arguments.'),
      cwd: z.string().optional().describe('Working directory.'),
      env: z.record(z.string(), z.string()).optional().describe('Environment variables to set/override.'),
      detach: z.boolean().optional().describe('Detach the launched process. Default true.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await launchProcess(args);
      if (!result.ok) return errText(result.error);
      return okText({ pid: result.pid, platform: result.platform });
    },
  );

  // ── wait_for_file ──────────────────────────────────────────
  server.tool(
    'wait_for_file',
    'Poll for a file to appear (and optionally satisfy a content regex) within a timeout. Used to synchronize with external tools that signal completion via a file — e.g. Unity Editor writes a play-ready JSON signal once the play-mode loop has stabilized.',
    {
      path: z.string().describe('Absolute path to wait for.'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe('Max wait time. Default 30s, cap 600s.'),
      poll_ms: z.number().int().min(50).max(10_000).optional().describe('Poll interval. Default 500ms.'),
      newer_than_ms: z.number().int().optional().describe('Only succeed if the file mtime is at least this Unix-ms timestamp. Use to skip stale signal files.'),
      content_pattern: z.string().optional().describe('Only succeed if file content matches this regex (first 64 KiB checked).'),
    },
    async (args): Promise<McpResponse> => {
      const result = await waitForFile(args);
      if (!result.ok) return errText(result.error);
      return okText(result);
    },
  );

  // ── read_file_tail ─────────────────────────────────────────
  server.tool(
    'read_file_tail',
    'Read the tail of a text file (default last 8 KiB, max 1 MiB). Use to inspect Unity Editor.log, build logs, error logs, etc., without paging through the whole file.',
    {
      path: z.string().describe('Absolute path to read.'),
      bytes: z.number().int().min(1).max(1024 * 1024).optional().describe('Bytes from end. Default 8192, max 1 MiB.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await readFileTail(args);
      if (!result.ok) return errText(result.error);
      return okText(result);
    },
  );

  // ── clipboard_read ─────────────────────────────────────────
  server.tool(
    'clipboard_read',
    'Read the system clipboard as text. Cross-OS: PowerShell on Windows, pbpaste on macOS, wl-paste / xclip / xsel on Linux.',
    {},
    async (): Promise<McpResponse> => {
      const result = await clipboardRead();
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ text: result.text, length: result.text.length, platform: result.platform });
    },
  );

  // ── clipboard_write ────────────────────────────────────────
  server.tool(
    'clipboard_write',
    'Write text to the system clipboard. Useful when the agent has prepared a code snippet / answer for a human to paste somewhere the agent cannot directly type into.',
    {
      text: z.string().describe('Text to put on the clipboard.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await clipboardWrite(args);
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({ written: true, length: args.text.length, platform: result.platform });
    },
  );

  // ── os_info ────────────────────────────────────────────────
  server.tool(
    'os_info',
    'Report basic info about the host the agent-manager is running on (platform, hostname, user, OS release, arch, cpu count, memory, DISPLAY / WAYLAND_DISPLAY). ' +
      'Use this once at the start of a session that needs to drive the GUI — different OS branches need different follow-up tools.',
    {},
    async (): Promise<McpResponse> => {
      const result = await osInfo();
      return okText(result.info);
    },
  );

  // ── list_screens ───────────────────────────────────────────
  server.tool(
    'list_screens',
    'Enumerate attached monitors with their virtual-desktop position, size, scale, and primary flag. Coordinates are in the same space `screenshot` / `mouse_click` / `mouse_move` expect, so use this before computing absolute pixel positions on a multi-monitor host.',
    {},
    async (): Promise<McpResponse> => {
      const result = await listScreens();
      if (!result.ok) return errText(result.error, { hint: result.hint });
      return okText({
        count: result.monitors.length,
        monitors: result.monitors,
        platform: result.platform,
        warning: result.warning,
      });
    },
  );

  // ── find_unity_logs ────────────────────────────────────────
  server.tool(
    'find_unity_logs',
    'Resolve canonical Unity log paths for the host OS (Editor.log, Editor-prev.log, crash dir, Hub log). When `project_path` is supplied, also computes Player.log / Player-prev.log from the project\'s ProjectSettings companyName + productName. Pair with `read_file_tail` to inspect the contents. Use this when investigating a stuck Unity Editor — different OSes put Unity logs in completely different places.',
    {
      project_path: z.string().optional().describe('Absolute path to a Unity project (the dir containing ProjectSettings/). Required for Player.log resolution.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await findUnityLogs(args);
      return okText(result);
    },
  );

  // ── shell_exec (escape hatch) ─────────────────────────────
  server.tool(
    'shell_exec',
    'Execute an arbitrary command on the host and return its stdout / stderr / exit code. Use as an escape hatch when a host_* tool above does not cover the workflow (e.g. Unity Editor batch mode invocation, custom build script). ' +
      'Default timeout 30s; clamped to 600s. The command runs with the agent-manager process credentials.',
    {
      command: z.string().describe('Executable path or name.'),
      args: z.array(z.string()).optional().describe('Arguments.'),
      cwd: z.string().optional().describe('Working directory.'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe('Timeout. Default 30s, max 600s.'),
      stdin: z.string().optional().describe('String to pipe into the child stdin.'),
    },
    async (args): Promise<McpResponse> => {
      const result = await shellExec(args);
      if (!result.ok) return errText(result.error);
      return okText({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    },
  );

  return server;
}

/** Entry point: run the host-mcp server over stdio. Returns when the
 *  transport closes (typically when the parent CLI exits). */
export async function runHostMcpServerOverStdio(): Promise<void> {
  // CRITICAL: stdio MCP uses stdout for the JSON-RPC wire format. Anything
  // we write to stdout that isn't a valid MCP frame will corrupt the stream
  // and the parent CLI will close us with a parse error. Route diagnostics
  // to stderr only.
  const server = createHostMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostic to stderr only.
  process.stderr.write(
    `[awb-host-mcp] ${HOST_MCP_SERVER_NAME} v${HOST_MCP_SERVER_VERSION} running on stdio (platform=${process.platform})\n`,
  );
  // Keep alive until the transport closes (process.on('SIGTERM') etc. is
  // handled by the SDK's transport).
  await new Promise<void>((resolve) => {
    const close = (): void => resolve();
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
    transport.onclose = close;
  });
}

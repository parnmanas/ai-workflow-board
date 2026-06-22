#!/usr/bin/env node
/**
 * qa-visual-capture.mjs — reference capture helper for the `browser` QA driver.
 *
 * Drives the real AWB client UI with headless Chrome over the Chrome DevTools
 * Protocol (CDP) and produces the visual evidence the scenario-QA viewer renders:
 * PNG screenshots of each screen and (optionally) an MP4 journey recording.
 *
 * It is intentionally **zero-dependency**: it talks CDP using Node's built-in global
 * `WebSocket` (Node ≥ 21) and shells out to the system `google-chrome` (or
 * $QA_CHROME). Video encoding shells out to `ffmpeg` (or $QA_FFMPEG); if no ffmpeg
 * is available the raw frames are still written so the journey can be encoded later.
 *
 * This mirrors the `browser` driver contract in docs/qa-driver-guide.md §4:
 *   setup     → launch Chrome + (optional) start screencast
 *   do        → navigate / login
 *   observe   → Page.captureScreenshot (PNG) / screencast frames → MP4
 *   teardown  → close the browser
 *
 * The QA agent normally invokes this, then uploads the outputs with save_resource
 * (type=image, file_mimetype=image/png for shots; file_mimetype=video/mp4 for the
 * clip) and records them via record_qa_step / attach_qa_artifact.
 *
 * Usage:
 *   node apps/server/scripts/qa-visual-capture.mjs \
 *     --base-url https://awb.example:7700 \
 *     --email qa@awb.local --password secret \
 *     --workspace <ws-id> --board <board-id> --ticket <ticket-id> \
 *     --out /tmp/qa-shots [--record-video] [--ffmpeg /path/to/ffmpeg]
 *
 * Auth: with --token <session-token> the token is injected into localStorage
 * (auth_token + currentWorkspaceId) directly; otherwise --email/--password are
 * POSTed to {base}/api/auth/login to mint one. Prints a JSON manifest on stdout.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { out: '/tmp/qa-visual', recordVideo: false, width: 1440, height: 900 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--base-url': a.baseUrl = next(); break;
      case '--email': a.email = next(); break;
      case '--password': a.password = next(); break;
      case '--token': a.token = next(); break;
      case '--workspace': a.workspace = next(); break;
      case '--board': a.board = next(); break;
      case '--ticket': a.ticket = next(); break;
      case '--out': a.out = next(); break;
      case '--record-video': a.recordVideo = true; break;
      case '--ffmpeg': a.ffmpeg = next(); break;
      case '--chrome': a.chrome = next(); break;
      case '--width': a.width = Number(next()); break;
      case '--height': a.height = Number(next()); break;
      default: break;
    }
  }
  if (!a.baseUrl) throw new Error('--base-url is required');
  a.baseUrl = a.baseUrl.replace(/\/$/, '');
  return a;
}

// ── minimal CDP client over Node's built-in WebSocket ────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => {
        this.ws.addEventListener('message', (e) => this._onMessage(e.data));
        res();
      }, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('CDP ws error: ' + (e?.message || e))), { once: true });
    });
  }
  _onMessage(data) {
    const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.rej(new Error(`${msg.error.message} (${msg.error.code})`)) : p.res(msg.result);
    } else if (msg.method) {
      for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(method, fn) {
    const arr = this.handlers.get(method) || [];
    arr.push(fn);
    this.handlers.set(method, arr);
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

// ── chrome launch ────────────────────────────────────────────────────────────
async function launchChrome(a) {
  const bin = a.chrome || process.env.QA_CHROME || 'google-chrome';
  const userDir = join(a.out, '.chrome-profile');
  await mkdir(userDir, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    `--window-size=${a.width},${a.height}`,
    `--user-data-dir=${userDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // Chrome prints "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>"
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const to = globalThis.setTimeout(() => rej(new Error('timed out waiting for DevTools endpoint')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { globalThis.clearTimeout(to); res(m[0]); }
    });
    proc.on('exit', (code) => rej(new Error('chrome exited early, code ' + code)));
  });
  return { proc, wsUrl };
}

// ── auth ─────────────────────────────────────────────────────────────────────
async function resolveToken(a) {
  if (a.token) return { token: a.token, workspace: a.workspace };
  if (!a.email || !a.password) throw new Error('provide --token, or --email + --password');
  const r = await fetch(`${a.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const workspace = a.workspace || j.workspaces?.[0]?.id || '';
  return { token: j.token, workspace };
}

// ── page helpers ─────────────────────────────────────────────────────────────
async function navigate(cdp, sid, url, settleMs = 2600) {
  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', () => res()));
  await cdp.send('Page.navigate', { url }, sid);
  await Promise.race([loaded, sleep(8000)]);
  await sleep(settleMs); // let the SPA render after load
}

// Client-side navigation inside the already-loaded SPA: pushState + popstate so
// React Router swaps routes without a full reload. This is what makes capture work
// regardless of whether the server does history-mode SPA fallback for deep routes.
async function spaNavigate(cdp, sid, pathWithQuery, settleMs = 2600) {
  const expr = `(() => { history.pushState({}, '', ${JSON.stringify(pathWithQuery)});`
    + ` window.dispatchEvent(new PopStateEvent('popstate')); })()`;
  await cdp.send('Runtime.evaluate', { expression: expr }, sid);
  await sleep(settleMs);
}

function toPath(baseUrl, url) {
  return url.startsWith(baseUrl) ? (url.slice(baseUrl.length) || '/') : url;
}

async function screenshot(cdp, sid, outPath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
  await writeFile(outPath, Buffer.from(data, 'base64'));
  return outPath;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  await mkdir(a.out, { recursive: true });
  const manifest = { base_url: a.baseUrl, screenshots: [], video: null };

  const { token, workspace } = await resolveToken(a);
  const ws = workspace || a.workspace || '';

  // The screens to capture. Authenticated routes need a logged-in SPA.
  const shots = [
    { name: 'login.png', url: `${a.baseUrl}/`, auth: false },
    { name: 'board.png', url: `${a.baseUrl}/ws/${ws}/boards/${a.board}`, auth: true },
    { name: 'ticket-detail.png', url: `${a.baseUrl}/ws/${ws}/boards/${a.board}?ticket=${a.ticket}`, auth: true },
    { name: 'chat.png', url: `${a.baseUrl}/ws/${ws}/chat`, auth: true },
    { name: 'qa-manager.png', url: `${a.baseUrl}/ws/${ws}/boards/${a.board}/qa`, auth: true },
    { name: 'resources.png', url: `${a.baseUrl}/ws/${ws}/resources`, auth: true },
    { name: 'board-submenu.png', url: `${a.baseUrl}/ws/${ws}/boards/${a.board}/settings`, auth: true },
  ];

  const { proc, wsUrl } = await launchChrome(a);
  const cdp = new CDP(wsUrl);
  await cdp.connect();

  // attach to a fresh page target (flatten → route domain calls via sessionId)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false }, sid);

  try {
    // 1. Capture the unauthenticated screens (login) with a real page load first.
    for (const s of shots.filter((x) => !x.auth)) {
      await navigate(cdp, sid, s.url, 2000);
      const p = await screenshot(cdp, sid, join(a.out, s.name));
      manifest.screenshots.push({ name: s.name, path: p, url: s.url });
      process.stderr.write(`captured ${s.name}\n`);
    }

    // 2. Inject the session token, then reload '/' so the SPA boots authenticated.
    if (token) {
      const expr = `localStorage.setItem('auth_token', ${JSON.stringify(token)});`
        + (ws ? `localStorage.setItem('currentWorkspaceId', ${JSON.stringify(ws)});` : '');
      await cdp.send('Runtime.evaluate', { expression: expr }, sid);
      await navigate(cdp, sid, `${a.baseUrl}/`, 2600);
    }

    // optional journey video (recorded across the authenticated client-side nav)
    let frames = [];
    if (a.recordVideo) {
      cdp.on('Page.screencastFrame', async (p) => {
        frames.push(Buffer.from(p.data, 'base64'));
        try { await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid); } catch { /* noop */ }
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }, sid);
    }

    // 3. Authenticated screens via in-SPA navigation (no full reload → no 404 even
    //    when the server lacks history-mode fallback for deep routes).
    for (const s of shots.filter((x) => x.auth)) {
      await spaNavigate(cdp, sid, toPath(a.baseUrl, s.url));
      const p = await screenshot(cdp, sid, join(a.out, s.name));
      manifest.screenshots.push({ name: s.name, path: p, url: s.url });
      process.stderr.write(`captured ${s.name}\n`);
    }

    if (a.recordVideo) {
      await cdp.send('Page.stopScreencast', {}, sid);
      manifest.video = await encodeVideo(a, frames);
    }
  } finally {
    cdp.close();
    try { proc.kill('SIGKILL'); } catch { /* noop */ }
  }

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

async function encodeVideo(a, frames) {
  const framesDir = join(a.out, 'frames');
  await mkdir(framesDir, { recursive: true });
  for (let i = 0; i < frames.length; i++) {
    await writeFile(join(framesDir, `frame-${String(i).padStart(4, '0')}.jpg`), frames[i]);
  }
  const outMp4 = join(a.out, 'ticket-journey.mp4');
  const ffmpeg = a.ffmpeg || process.env.QA_FFMPEG;
  if (!ffmpeg) {
    process.stderr.write(`no ffmpeg (set --ffmpeg or $QA_FFMPEG); wrote ${frames.length} raw frames to ${framesDir}\n`);
    return { mp4: null, frames_dir: framesDir, frame_count: frames.length };
  }
  await new Promise((res, rej) => {
    const ff = spawn(ffmpeg, [
      '-y', '-framerate', '4', '-i', join(framesDir, 'frame-%04d.jpg'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outMp4,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    ff.on('exit', (code) => code === 0 ? res() : rej(new Error('ffmpeg exit ' + code)));
  });
  const wrote = (await readdir(a.out)).includes('ticket-journey.mp4');
  return { mp4: wrote ? outMp4 : null, frames_dir: framesDir, frame_count: frames.length };
}

main().catch((e) => { process.stderr.write('FATAL: ' + (e?.stack || e) + '\n'); process.exit(1); });

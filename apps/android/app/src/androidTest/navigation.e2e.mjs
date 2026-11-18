// Run against a disposable emulator with a debug APK. Only loopback fixture servers are used.
// AWB_ANDROID_TEST_SERIAL=emulator-5580 ANDROID_HOME=... node apps/android/app/src/androidTest/navigation.e2e.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const exec = promisify(execFile);
const serial = process.env.AWB_ANDROID_TEST_SERIAL;
assert.match(serial || '', /^emulator-\d+$/, 'Use a disposable emulator; this test clears its AWB app data.');
const adbPath = `${process.env.ANDROID_HOME}/platform-tools/adb`;
const adb = async (...args) => (await exec(adbPath, ['-s', serial, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const pause = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
const app = 'com.parnmanas.awb';
const output = resolve(process.env.AWB_ANDROID_TEST_OUTPUT || '/tmp/awb-android-navigation-test');
await mkdir(output, { recursive: true });
assert.equal(await adb('shell', 'getprop', 'ro.kernel.qemu'), '1');

async function until(task, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    try { const result = await task(); if (result) return result; } catch (error) { failure = error; }
    await pause();
  }
  throw new Error(`Timed out: ${label}`, { cause: failure });
}

function attributes(node) {
  return Object.fromEntries([...node.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) =>
    [key, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>')]));
}

async function nodes() {
  return until(async () => {
    const result = await adb('shell', 'uiautomator', 'dump', '/sdcard/awb-navigation-test.xml');
    if (!result.includes('dumped')) return null;
    const xml = await adb('shell', 'cat', '/sdcard/awb-navigation-test.xml');
    return [...xml.matchAll(/<node\b[^>]*>/g)].map(match => attributes(match[0]));
  }, 'native UI hierarchy', 30_000);
}

async function click(key, value, scroll = false) {
  for (let attempt = 0; attempt < (scroll ? 8 : 3); attempt++) {
    const tree = await nodes();
    const match = tree.find(node => node[key] === value && node.enabled !== 'false'
      && (key !== 'text' || node['resource-id'] !== `${app}:id/navigation_title`));
    if (match) {
      const [x1, y1, x2, y2] = match.bounds.match(/\d+/g).map(Number);
      if (x2 > x1 && y2 > y1) {
        await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
        await pause();
        return;
      }
    }
    if (scroll) {
      const [, , width, height] = tree[0].bounds.match(/\d+/g).map(Number);
      await adb('shell', 'input', 'swipe', String(Math.round(width * 0.7)), String(height - 70),
        String(Math.round(width * 0.7)), '140', '250');
    }
    else await pause();
  }
  throw new Error(`Cannot tap ${key}=${value}`);
}

const byId = (id, scroll) => click('resource-id', `${app}:id/${id}`, scroll);
const byText = (text, scroll) => click('text', text, scroll);
async function fill(id, value) {
  await byId(id, true);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
  await adb('shell', 'input', 'keycombination', '113', '29');
  await adb('shell', 'input', 'text', `'${value.replaceAll("'", "'\\''")}'`);
  await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
}

async function screenshot(name) {
  const { stdout } = await exec(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  await writeFile(`${output}/${name}.png`, stdout);
}

const requests = [];
async function fixture(name) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ server: name, path: request.url, auth: request.headers.authorization, body });
    response.setHeader('Cache-Control', 'no-store');
    if (request.url.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      let result = {};
      if (request.url === '/api/health') result = { status: 'ok', database: 'ok' };
      if (request.url === '/api/auth/me') result = { id: name, name };
      if (request.url === '/api/auth/devices') result = { device_id: name, device_token: `device-${name}` };
      if (request.url === '/api/auth/devices/session') result = { token: `session-${name}` };
      response.end(JSON.stringify(result));
      return;
    }
    if (request.url === '/broken') { response.writeHead(503); response.end('Unavailable'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${name}</title><style>body{background:#0f172a;color:white;font:18px sans-serif;padding:16px}a{color:#a5b4fc}</style>
      <h1>${name}</h1><p id="route"></p><a href="/details?view=2#chart">Details</a><input id="note" placeholder="Draft">
      <script>document.querySelector('#route').textContent=location.pathname+location.search+location.hash;</script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  return { name, server, port, url: `http://127.0.0.1:${port}` };
}

let debugPort;
let sockets = [];
async function connectDebug() {
  const pid = await adb('shell', 'pidof', app);
  if (debugPort) await adb('forward', '--remove', `tcp:${debugPort}`);
  debugPort = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
}

async function pageAt(url) {
  return until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const target = targets.find(target => target.url === url);
    if (!target) return null;
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    sockets.push(socket);
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    };
    return {
      async evaluate(expression) {
        const id = ++sequence;
        const answer = new Promise(resolve => pending.set(id, resolve));
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        const message = await Promise.race([answer, pause(10_000).then(() => { throw new Error('CDP evaluation timeout'); })]);
        assert.ok(!message.error && !message.result.exceptionDetails, JSON.stringify(message));
        return message.result.result.value;
      },
    };
  }, `WebView ${url}`);
}

async function native(page, type, fields = {}) {
  return page.evaluate(`new Promise(resolve => {
    const id = 'test-' + Math.random();
    AwbAndroid.onmessage = event => { const reply = JSON.parse(event.data); if (reply.id === id) resolve(reply); };
    AwbAndroid.postMessage(JSON.stringify({ ...${JSON.stringify({ type, ...fields })}, id }));
  })`);
}

async function addServer(item) {
  await byId('navigation_button');
  await byText('+ 서버 추가', true);
  await fill('server_input', item.url);
  await fill('name_input', item.name);
  await byId('primary_button', true);
  const page = await pageAt(`${item.url}/`);
  await native(page, 'voice.setEnabled', { enabled: false });
  assert.equal((await native(page, 'session.loggedIn', { token: `session-${item.name}` })).ok, true);
  await page.evaluate(`localStorage.setItem('test-user', ${JSON.stringify(item.name)})`);
  return page;
}

async function addPage(url, name) {
  await byId('navigation_button');
  await byText('+ 웹 페이지 추가', true);
  await fill('server_input', url);
  await fill('name_input', name);
  await byId('primary_button', true);
}

let first, second;
try {
  first = await fixture('Server-A');
  second = await fixture('Server-B');
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'pm', 'clear', app);
  await adb('shell', 'wm', 'size', '320x568');
  await adb('shell', 'wm', 'density', '160');
  await adb('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  await until(async () => (await adb('shell', 'pidof', app)), 'app running');
  await connectDebug();

  // A dashboard can be used before any AWB server has been configured.
  const dashboardUrl = `${first.url}/dash/?org=2&var=a+b#/overview`;
  await addPage(dashboardUrl, 'Dashboard');
  let dashboard = await pageAt(dashboardUrl);
  assert.equal(await dashboard.evaluate('typeof window.AwbAndroid'), 'undefined');
  assert.equal(await dashboard.evaluate('navigator.userAgent.includes("AWBAndroid/")'), false);
  assert.equal(await dashboard.evaluate('location.search + location.hash'), '?org=2&var=a+b#/overview');
  await screenshot('phone-dashboard');
  console.log('PASS custom page before AWB setup; query/hash preserved; no native bridge');

  let a = await addServer(first);
  await a.evaluate('history.pushState({}, "", "/sessions/test?view=one#latest"); document.querySelector("#note").value="unsent draft"');
  let b = await addServer(second);
  assert.equal((await native(b, 'session.get')).result.token, 'session-Server-B');
  assert.equal(await b.evaluate('localStorage.getItem("test-user")'), 'Server-B');
  await byId('navigation_button');
  await byText('Server-A', true);
  a = await pageAt(`${first.url}/sessions/test?view=one#latest`);
  assert.equal((await native(a, 'session.get')).result.token, 'session-Server-A');
  assert.equal(await a.evaluate('localStorage.getItem("test-user")'), 'Server-A');
  await a.evaluate('document.querySelector("#note").value="retained draft"');
  await byId('navigation_button');
  await byText('Dashboard', true);
  dashboard = await pageAt(dashboardUrl);
  assert.equal(await a.evaluate('document.visibilityState'), 'hidden', 'AWB voice must yield while a dashboard is visible');
  assert.equal(await dashboard.evaluate('typeof window.AwbAndroid'), 'undefined', 'Even a saved page on an AWB origin is unprivileged');
  await byId('navigation_button');
  await byText('Server-A', true);
  a = await pageAt(`${first.url}/sessions/test?view=one#latest`);
  assert.equal(await a.evaluate('document.querySelector("#note").value'), 'retained draft');
  console.log('PASS two servers retain isolated native sessions/storage and last route; dashboard return preserves AWB document');

  await byId('navigation_button');
  await byText('Dashboard', true);
  await byId('navigation_more');
  await byText('웹 페이지 수정');
  await fill('server_input', `${second.url}/reports/#/week`);
  await fill('name_input', 'Weekly');
  await byId('primary_button', true);
  await pageAt(`${second.url}/reports/#/week`);
  await adb('shell', 'am', 'force-stop', app);
  await adb('shell', 'am', 'start', '-n', `${app}/.MainActivity`);
  await pause(1000);
  await connectDebug();
  await pageAt(`${second.url}/reports/#/week`);
  assert.ok((await nodes()).some(node => node.text === 'Weekly'));
  console.log('PASS edited name/URL and active page survive process restart');

  // Phone, tablet and landscape: tap real controls, not only checking overflow.
  for (const [name, size, wide] of [['phone', '320x568', false], ['tablet', '768x1024', true], ['landscape', '667x375', true]]) {
    await adb('shell', 'wm', 'size', size);
    await pause(500);
    await byId('navigation_button');
    const list = await nodes();
    assert.equal(list.some(node => node['resource-id'] === `${app}:id/navigation_rail`), wide);
    await screenshot(`${name}-switcher`);
    await byText('Weekly', true);
    await byId('navigation_more');
    await byText('등록한 URL로 이동');
    await pageAt(`${second.url}/reports/#/week`);
  }
  console.log('PASS 320px phone, tablet and landscape: grouped list and page actions accessible');

  await adb('shell', 'wm', 'size', '320x568');
  await addPage(`${second.url}/broken`, 'Offline');
  await until(async () => (await nodes()).some(node => node.text?.includes('HTTP 503')), 'dashboard error');
  await byId('navigation_button');
  await byText('Weekly', true);
  await byId('navigation_more');
  await byText('목록에서 삭제');
  await byText('취소');
  await byId('navigation_more');
  await byText('목록에서 삭제');
  await byText('삭제');
  assert.ok(!(await nodes()).some(node => node.text === 'Weekly'));
  await byText('Server-B', true);
  b = await pageAt(`${second.url}/`);
  assert.equal((await native(b, 'session.get')).result.token, 'session-Server-B');
  assert.ok(!requests.some(request => request.auth && request.auth !== `Bearer session-${request.server}`));
  console.log('PASS offline recovery, deletion/cancel and server auth survives page removal; no cross-server authorization');
} finally {
  for (const socket of sockets) socket.close();
  for (const item of [first, second].filter(Boolean)) {
    item.server.closeAllConnections();
    item.server.close();
    await adb('reverse', '--remove', `tcp:${item.port}`).catch(() => {});
  }
  if (debugPort) await adb('forward', '--remove', `tcp:${debugPort}`).catch(() => {});
  await adb('shell', 'wm', 'size', 'reset');
  await adb('shell', 'wm', 'density', 'reset');
}

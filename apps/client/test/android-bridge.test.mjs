// Android 앱(apps/android) ↔ 웹 화면 — apps/client/src/native/androidBridge.ts.
//
// 고정하는 것:
//   1. 웹(브라우저 · PWA)에서는 앱이 있다고 거짓말하지 않는다 — 토큰도 상시 음성도 없다.
//   2. 앱 안에서는 {id,type} 요청에 {id,ok,result} 답이 짝지어지고, 앱이 먼저 보내는 {event} 는
//      구독자에게 간다. 답이 없으면 시간 제한으로 끝난다(화면이 영원히 기다리지 않는다).
//   3. 웹이 부르는 요청 이름이 앱(WebBridge.java)에 모두 있다 — 한쪽만 바꾸면 조용히 unknown_type 이 된다.
//   4. 화면 쪽 배선: 부팅 · 401 · 로그인 · 로그아웃이 앱에 묻고 알리며, 숨은 동안 웹은 듣지도 읽지도 않는다.
//   5. 알림 링크 파서: 세션 경로만 받는다.
//   6. 서버 여러 개: 사이드바가 지금 서버를 보이고 앱의 서버 목록을 열며, 알림 링크는 어느 서버의 소식인지 싣는다.
//   7. 내려받기 · 클립보드: 화면의 바이트(blob: · data:)는 조각으로 앱에 넘겨 다운로드 폴더에, http(s) 는 앱의
//      DownloadManager 로, 이미지는 앱의 클립보드로. 앱 안의 `<a download>` 는 전부 이 길을 탄다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callNative,
  isAndroidApp,
  nativeAppInfo,
  nativeRefreshToken,
  nativeSessionToken,
  nativeVoiceStatus,
  NATIVE_VOICE_OFF,
  onNativeEvent,
  parseAwbDeepLink,
  NATIVE_FILE_CHUNK_BYTES,
  copyImageToNativeClipboard,
  saveBlobToNativeDownloads,
} from '../src/native/androidBridge.ts';
import {
  canCopyImage,
  copyImage,
  interceptDownloadsInAndroidApp,
  mediaActionError,
} from '../src/components/common/mediaActions.ts';
import { triggerBlobDownload } from '../src/components/chat/utils/attachments.ts';
import { setupDom } from './helpers/jsdom.mjs';
import { ui } from './helpers/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('웹에서는 앱이 아니고, 앱에만 있는 것을 주지 않는다', async () => {
  assert.equal(isAndroidApp(), false);
  assert.equal(await nativeSessionToken(), '');
  assert.equal(await nativeRefreshToken('x'), '');
  assert.deepEqual(await nativeVoiceStatus(), NATIVE_VOICE_OFF);
  assert.equal(await nativeAppInfo(), null);
  await assert.rejects(callNative('hello'), /not_android_app/);
});

test('앱 안에서는 요청과 답이 짝지어지고, 앱의 알림은 구독자에게 간다', async (t) => {
  const sent = [];
  let listener = null;
  const port = {
    onmessage: null,
    addEventListener(type, fn) { if (type === 'message') listener = fn; },
    postMessage(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      const reply = (body) => setTimeout(() => listener({ data: JSON.stringify(body) }), 0);
      if (msg.type === 'session.get') reply({ id: msg.id, ok: true, result: { token: 'fresh' } });
      else if (msg.type === 'session.refresh') reply({ id: msg.id, ok: true, result: { token: msg.rejected } });
      else if (msg.type === 'voice.status') reply({ id: msg.id, ok: true, result: { enabled: true, state: 'sleeping' } });
      else if (msg.type === 'hello') reply({ id: msg.id, ok: true, result: { app: 'android', server: 'https://a.example', server_name: '집' } });
      else if (msg.type === 'boom') reply({ id: msg.id, ok: false, error: 'unknown_type' });
      // 'silent' 에는 답하지 않는다
    },
  };
  globalThis.window = { AwbAndroid: port };
  t.after(() => { delete globalThis.window; });

  assert.equal(isAndroidApp(), true);
  assert.equal(await nativeSessionToken(), 'fresh');
  // 앱이 같은(거절된) 토큰을 돌려주면 새 세션이 아니다 — 401 루프를 만들지 않는다.
  assert.equal(await nativeRefreshToken('dead'), '');
  assert.deepEqual(await nativeVoiceStatus(), { ...NATIVE_VOICE_OFF, enabled: true, state: 'sleeping' });
  assert.equal((await nativeAppInfo())?.server_name, '집');
  await assert.rejects(callNative('boom'), /unknown_type/);
  await assert.rejects(callNative('silent', {}, 30), /native_timeout/);
  assert.ok(sent.every((m) => typeof m.id === 'string' && m.id.length > 0));

  const got = [];
  const off = onNativeEvent('navigate', (m) => got.push(m.path));
  listener({ data: JSON.stringify({ event: 'navigate', path: '/sessions/h/c/s' }) });
  off();
  listener({ data: JSON.stringify({ event: 'navigate', path: '/sessions/h/c/t' }) });
  assert.deepEqual(got, ['/sessions/h/c/s']);
});

test('웹이 부르는 요청 이름은 앱 WebBridge 에 모두 있다', () => {
  const bridge = read('apps/client/src/native/androidBridge.ts');
  const java = read('apps/android/app/src/main/java/com/parnmanas/awb/WebBridge.java');
  const types = [...bridge.matchAll(/callNative(?:<[^(]*>)?\('([a-zA-Z.]+)'/g)].map((m) => m[1]);
  assert.ok(types.length >= 9, `found ${types.length}`);
  for (const type of new Set(types)) {
    assert.ok(java.includes(`case "${type}":`), `WebBridge.java has no case for "${type}"`);
  }
  // 앱이 먼저 보내는 알림 이름도 같다.
  for (const event of ['voice-status', 'navigate']) {
    assert.ok(read('apps/android/app/src/main/java/com/parnmanas/awb/MainActivity.java').includes(`"${event}"`));
  }
});

test('화면 쪽 배선 — 부팅 · 401 · 로그인 · 로그아웃 · 구글 · 숨은 동안', () => {
  const auth = read('apps/client/src/contexts/AuthContext.tsx');
  assert.match(auth, /nativeSessionToken\(\)/, '부팅할 때 앱의 세션을 먼저 묻는다');
  assert.match(auth, /nativeRefreshToken\(/, '401 이면 앱에 새 세션을 달라고 한다');
  assert.match(auth, /notifyNativeLoggedIn\(/);
  assert.match(auth, /notifyNativeLoggedOut\(/);
  assert.match(read('apps/client/src/components/LoginPage.tsx'), /startNativeGoogleLogin\(\)/);
  assert.match(read('apps/client/src/voice/WakeListener.tsx'), /!hiddenInApp/);
  assert.match(read('apps/client/src/voice/VoiceAnnouncer.tsx'), /if \(hiddenInAndroidApp\(\)\) return;/);
  assert.match(read('apps/client/src/voice/wakeState.ts'), /setNativeVoice\(enabled\)/);
  assert.match(read('apps/client/src/components/AppLayout.tsx'), /<AndroidAppBridge \/>/);
});

test('서버 여러 개 — 사이드바는 지금 서버를 보이고 앱의 서버 목록을 연다', () => {
  const sidebar = read('apps/client/src/components/Sidebar.tsx');
  assert.match(sidebar, /useNativeServerLabel\(\)/, '사용자 줄에 지금 서버 이름');
  assert.match(sidebar, /onClick=\{\(\) => changeNativeServer\(\)\}/, '서버 전환 단추');
  // 앱은 예전 이름(server.change)으로 서버 목록을 연다 — 이름을 바꾸면 이미 깔린 웹 · 앱이 서로 못 알아듣는다.
  const java = read('apps/android/app/src/main/java/com/parnmanas/awb/WebBridge.java');
  assert.match(java, /case "server\.change":[\s\S]*?showServers/);
  assert.match(java, /"server_name", s\.label\(\)/);
});

test('알림 링크는 어느 서버의 소식인지 싣고, 앱은 그 서버로 돌아가며 그 표시를 웹 경로에서 뗀다', () => {
  const voice = read('apps/android/app/src/main/java/com/parnmanas/awb/voice/VoiceService.java');
  const api = read('apps/android/app/src/main/java/com/parnmanas/awb/voice/VoiceApi.java');
  const activity = read('apps/android/app/src/main/java/com/parnmanas/awb/MainActivity.java');
  assert.match(api, /"\?server=" \+ Uri\.encode\(serverId\)/, 'operator 세션 링크');
  assert.match(voice, /"\?server=" \+ Uri\.encode\(serverId\)/, '작업 알림 링크');
  assert.match(activity, /withoutQueryParam\(uri\.getEncodedQuery\(\), "server"\)/);
  assert.match(activity, /uri\.getQueryParameter\("server"\)/);
  // 앱 아이콘 바로가기와 그 처리
  assert.match(activity, /"awb:\/\/servers\/" \+ s\.id/);
  assert.match(activity, /"servers"\.equals\(host\)/);
});

test('알림 링크를 세션 경로로 바꾼다', () => {
  assert.equal(
    parseAwbDeepLink('awb://sessions/host-1/claude/s1?say=%EC%8B%9C%EC%9E%91%ED%95%B4'),
    '/sessions/host-1/claude/s1?say=%EC%8B%9C%EC%9E%91%ED%95%B4',
  );
  assert.equal(parseAwbDeepLink('awb://sessions/h/c/s'), '/sessions/h/c/s');
  assert.equal(parseAwbDeepLink('https://awb.example.com/sessions/h/c/s?say=x'), '/sessions/h/c/s?say=x');
});

test('세션 경로가 아니면 null 이다', () => {
  assert.equal(parseAwbDeepLink('awb://open'), null);
  assert.equal(parseAwbDeepLink('awb://oauth?code=x'), null);
  assert.equal(parseAwbDeepLink('awb://tickets/123'), null);
  assert.equal(parseAwbDeepLink('https://awb.example.com/tickets'), null);
  assert.equal(parseAwbDeepLink('not a url'), null);
  assert.equal(parseAwbDeepLink('tel:+821012345678'), null);
});

// ─── 내려받기 · 클립보드 ─────────────────────────────────────────────────

/**
 * 앱 대역 — 받은 요청을 기록하고 `answer(msg)` 로 답한다(던지면 그 메시지가 실패 사유). `win` 에 포트를 단다
 * (jsdom 창 또는 맨 객체).
 */
function fakeApp(t, answer = () => ({}), win) {
  const sent = [];
  let listener = null;
  const port = {
    onmessage: null,
    addEventListener(type, fn) { if (type === 'message') listener = fn; },
    postMessage(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      let out;
      try {
        out = { id: msg.id, ok: true, result: answer(msg) ?? {} };
      } catch (e) {
        out = { id: msg.id, ok: false, error: e.message };
      }
      setTimeout(() => listener({ data: JSON.stringify(out) }), 0);
    },
  };
  if (win) {
    win.AwbAndroid = port;
  } else {
    globalThis.window = { AwbAndroid: port };
    t.after(() => { delete globalThis.window; });
  }
  return sent;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pngDataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('앱 내려받기: 화면의 바이트를 조각으로 넘기고 앱이 정한 이름을 돌려준다', async (t) => {
  const chunks = [];
  const sent = fakeApp(t, (msg) => {
    if (msg.type === 'file.begin') return { transfer: 'tx1' };
    if (msg.type === 'file.chunk') {
      chunks.push(Buffer.from(msg.base64, 'base64'));
      return {};
    }
    if (msg.type === 'file.end') return { name: 'demo (1).mp4' };
    throw new Error('unknown_type');
  });
  const bytes = Buffer.alloc(NATIVE_FILE_CHUNK_BYTES * 2 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const saved = await saveBlobToNativeDownloads(new Blob([bytes], { type: 'video/mp4' }), 'demo.mp4');
  assert.equal(saved, 'demo (1).mp4', '같은 이름이 있으면 앱이 바꾼 이름');
  assert.deepEqual(sent.map((m) => m.type), ['file.begin', 'file.chunk', 'file.chunk', 'file.chunk', 'file.end']);
  assert.deepEqual([sent[0].name, sent[0].mime, sent[0].size], ['demo.mp4', 'video/mp4', bytes.length]);
  assert.ok(sent.slice(1, -1).every((m) => m.transfer === 'tx1'));
  assert.ok(Buffer.concat(chunks).equals(bytes), '조각을 이으면 원본이다');
  assert.equal(sent.at(-1).complete, true);
});

test('앱 내려받기: 도중에 실패하면 앱에 취소를 알려 반쪽 파일을 남기지 않는다', async (t) => {
  let chunk = 0;
  const sent = fakeApp(t, (msg) => {
    if (msg.type === 'file.begin') return { transfer: 'tx2' };
    if (msg.type === 'file.chunk' && ++chunk === 2) throw new Error('size_mismatch');
    return {};
  });
  await assert.rejects(
    saveBlobToNativeDownloads(new Blob([Buffer.alloc(NATIVE_FILE_CHUNK_BYTES * 3)]), 'x.bin'),
    /size_mismatch/,
  );
  assert.deepEqual(sent.at(-1), { ...sent.at(-1), type: 'file.end', transfer: 'tx2', complete: false });
});

test('이미지 복사: 바이트와 형식을 앱의 클립보드로 넘긴다', async (t) => {
  const sent = fakeApp(t);
  await copyImageToNativeClipboard(new Blob([PNG], { type: 'image/png' }));
  assert.equal(sent[0].type, 'clipboard.image');
  assert.equal(sent[0].mime, 'image/png');
  assert.ok(Buffer.from(sent[0].base64, 'base64').equals(PNG));
});

test('앱 안의 `<a download>` 는 앱의 다운로드 폴더로 — 바이트는 조각으로, http(s) 는 주소로', async (t) => {
  const dom = setupDom({ url: 'https://awb.example/sessions' });
  t.after(() => dom.cleanup());
  const sent = fakeApp(t, (msg) => (msg.type === 'file.begin' ? { transfer: 'tx3' } : msg.type === 'file.end' ? { name: 'shot.png' } : {}), dom.window);
  const errors = [];
  const off = interceptDownloadsInAndroidApp((m) => errors.push(m));
  t.after(off);
  const click = (attrs) => {
    const a = document.createElement('a');
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    a.textContent = 'x';
    document.body.appendChild(a);
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    a.remove();
    return event.defaultPrevented;
  };

  assert.equal(click({ href: pngDataUrl, download: 'shot.png' }), true, 'WebView 의 기본 동작보다 먼저 막는다');
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ['file.begin', 'file.chunk', 'file.end']);
  assert.deepEqual([sent[0].name, sent[0].mime, sent[0].size], ['shot.png', 'image/png', PNG.length]);

  sent.length = 0;
  click({ href: '/api/resources/r1/raw', download: 'r1.pdf' });
  click({ href: 'https://dive.example.com/preview/a.mp4', download: 'a.mp4' });
  await settle();
  assert.deepEqual(sent.map((m) => [m.type, m.url, m.name]), [
    ['download.url', 'https://awb.example/api/resources/r1/raw', 'r1.pdf'],
    ['download.url', 'https://dive.example.com/preview/a.mp4', 'a.mp4'],
  ]);
  assert.deepEqual(errors, []);
});

test('코드로 여는 내려받기(triggerBlobDownload — 장부 CSV · 계약서 PDF · 첨부)도 앱으로: 링크를 문서에 붙여 누르고, 다음 틱에 풀리는 주소를 그 전에 읽는다', async (t) => {
  const dom = setupDom({ url: 'https://awb.example/business' });
  t.after(() => dom.cleanup());
  const sent = fakeApp(t, (msg) => (msg.type === 'file.begin' ? { transfer: 'tx5' } : msg.type === 'file.end' ? { name: 'cashbook.csv' } : {}), dom.window);
  const errors = [];
  t.after(interceptDownloadsInAndroidApp((m) => errors.push(m)));
  triggerBlobDownload(new Blob(['날짜,금액\n'], { type: 'text/csv;charset=utf-8' }), 'cashbook.csv');
  await settle();
  assert.deepEqual(sent.map((m) => m.type), ['file.begin', 'file.chunk', 'file.end']);
  assert.deepEqual([sent[0].name, sent[0].mime], ['cashbook.csv', 'text/csv;charset=utf-8']);
  assert.equal(Buffer.from(sent[1].base64, 'base64').toString(), '날짜,금액\n');
  assert.deepEqual(errors, []);
  // 문서에 붙이지 않은 링크의 a.click() 은 문서까지 오지 않는다 — 앱에서는 아무 일도 일어나지 않는 버튼이 된다.
  // 코드로 내려받기 링크를 만드는 파일은 그 링크를 문서에 붙인다(또는 triggerBlobDownload 를 쓴다).
  const srcDir = path.join(ROOT, 'apps/client/src');
  const detached = fs.readdirSync(srcDir, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => {
      const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
      return /\.download\s*=[^=]/.test(src) && !/appendChild\(/.test(src);
    });
  assert.deepEqual(detached, []);
});

test('옛 앱은 http(s) 내려받기를 예전처럼 WebView 에 맡기고, 바이트 내려받기는 앱을 업데이트하라고 알린다', async (t) => {
  const dom = setupDom({ url: 'https://awb.example/' });
  t.after(() => dom.cleanup());
  fakeApp(t, () => { throw new Error('unknown_type'); }, dom.window);
  const errors = [];
  t.after(interceptDownloadsInAndroidApp((m) => errors.push(m)));
  const passedThrough = [];
  // 가로채기 뒤(문서의 버블 단계)에서 지나간 클릭을 기록하고, jsdom 이 실제로 이동하지 않게 막는다.
  const record = (e) => {
    const a = e.target.closest?.('a');
    if (a) passedThrough.push([a.getAttribute('href'), a.getAttribute('download'), a.dataset.awbNative || '']);
    e.preventDefault();
  };
  document.addEventListener('click', record);
  t.after(() => document.removeEventListener('click', record));
  const a = document.createElement('a');
  a.setAttribute('href', '/api/resources/r1/raw');
  a.setAttribute('download', 'r1.pdf');
  document.body.appendChild(a);
  a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(passedThrough, [
    ['/api/resources/r1/raw', 'r1.pdf', ''],
    ['https://awb.example/api/resources/r1/raw', 'r1.pdf', 'skip'],
  ], '첫 클릭은 가로채고(기본 동작은 막힘), 표시를 단 재시도가 WebView 로 지나간다');

  const b = document.createElement('a');
  b.setAttribute('href', pngDataUrl);
  b.setAttribute('download', 'shot.png');
  document.body.appendChild(b);
  b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(errors, [ui('Update the Android app to use this.')]);
});

test('브라우저(앱 아님)에서는 가로채지 않는다', (t) => {
  const dom = setupDom({ url: 'https://awb.example/' });
  t.after(() => dom.cleanup());
  const off = interceptDownloadsInAndroidApp(() => assert.fail('no error expected'));
  const a = document.createElement('a');
  a.setAttribute('href', pngDataUrl);
  a.setAttribute('download', 'shot.png');
  document.body.appendChild(a);
  let prevented = null;
  a.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
  a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  off();
  assert.equal(prevented, false, '브라우저의 내려받기 그대로');
});

test('이미지 복사: 앱이면 앱의 클립보드, 브라우저면 Clipboard API(PNG) — 못 하면 사유를 말로', async (t) => {
  const dom = setupDom({ url: 'https://awb.example/' });
  t.after(() => dom.cleanup());
  assert.equal(canCopyImage(pngDataUrl), true);
  assert.equal(canCopyImage('blob:https://awb.example/x'), true);
  assert.equal(canCopyImage('/api/resources/r1/raw'), true, '같은 서버의 그림');
  assert.equal(canCopyImage('https://cdn.example.com/a.png'), false, '다른 사이트 그림은 화면이 읽지 못한다');

  // 브라우저: Clipboard API 가 없으면 사유와 함께 실패한다.
  await assert.rejects(copyImage(pngDataUrl), (err) => mediaActionError(err, 'copy') === ui('This browser cannot copy images.'));
  // 브라우저: PNG 는 그대로 ClipboardItem 으로.
  const written = [];
  const previousItem = globalThis.ClipboardItem;
  globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { write: async (items) => { written.push(...items); } } });
  t.after(() => {
    delete globalThis.navigator.clipboard;
    if (previousItem === undefined) delete globalThis.ClipboardItem; else globalThis.ClipboardItem = previousItem;
  });
  await copyImage(pngDataUrl);
  const png = await written[0].items['image/png'];
  assert.ok(Buffer.from(await png.arrayBuffer()).equals(PNG));

  // 앱: 앱의 클립보드로(WebView 의 Clipboard API 는 이미지를 쓰지 못한다).
  const sent = fakeApp(t, () => ({}), dom.window);
  await copyImage(pngDataUrl);
  assert.deepEqual(sent.map((m) => [m.type, m.mime]), [['clipboard.image', 'image/png']]);
  assert.equal(written.length, 1, '앱에서는 브라우저 클립보드를 쓰지 않는다');
});

test('실패 사유를 사람이 읽는 말로', () => {
  assert.equal(mediaActionError(new Error('unknown_type'), 'download'), ui('Update the Android app to use this.'));
  assert.equal(mediaActionError(new Error('storage_permission'), 'download'), ui('Allow storage access, then try again.'));
  assert.equal(mediaActionError(new Error('size_mismatch'), 'download'), ui('Download failed'));
  assert.equal(mediaActionError(new Error('io_error'), 'copy'), ui('Copy failed'));
});

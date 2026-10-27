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
} from '../src/native/androidBridge.ts';

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

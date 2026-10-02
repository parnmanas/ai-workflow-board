// 세션 답 속 로컬 경로 이미지(`![alt](E:/…png)`) — 매니저가 그 장비에서 읽어 주는 `local_image` RPC.
//   1. 경로 모양: 드라이브 문자 · `/E:/`(win32) · file:// · ~ · 상대(cwd 기준) · `%20`.
//   2. 이미지 파일만: 확장자 + 매직 바이트(이름만 .png 인 텍스트는 거절), SVG 거절, 상한.
//   3. 러너가 RPC 로 { base64, mime_type } 을 돌려주고, 실패는 코드와 함께 ok:false 로 답한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LOCAL_IMAGE_MAX_BYTES,
  LocalImageError,
  readLocalImage,
  resolveLocalImagePath,
  sniffImageMime,
} from '../dist/lib/session-local-image.js';
import { AgentSessionRunner } from '../dist/lib/agent-session-runner.js';
import { AgentSessionStore } from '../dist/lib/agent-session-store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'awb-local-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveLocalImagePath: 에이전트가 쓰는 경로 모양을 이 장비의 절대 경로로', () => {
  assert.equal(resolveLocalImagePath('/tmp/a.png', ''), '/tmp/a.png');
  assert.equal(resolveLocalImagePath('shots/a.png', '/work/repo'), '/work/repo/shots/a.png');
  assert.equal(resolveLocalImagePath('~/a.png', ''), resolve(homedir(), 'a.png'));
  assert.equal(resolveLocalImagePath(pathToFileURL('/tmp/x y.png').href, ''), '/tmp/x y.png');
  // `/E:/…` 는 Windows 장비에서만 드라이브 경로다 — 다른 OS 에서는 손대지 않는다.
  assert.equal(resolveLocalImagePath('/E:/a.png', '', 'linux'), '/E:/a.png');
  assert.throws(() => resolveLocalImagePath('a.png', ''), (e) => e instanceof LocalImageError && e.code === 'invalid_path', 'cwd 를 모르면 상대 경로는 거절');
  assert.throws(() => resolveLocalImagePath('https://x.test/a.png', '/w'), (e) => e.code === 'invalid_path', '원격 URL 은 매니저가 읽지 않는다');
  assert.throws(() => resolveLocalImagePath('', '/w'), (e) => e.code === 'invalid_path');
});

test('sniffImageMime: 매직 바이트로만 판정한다', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null, 'SVG 는 이미지로 다루지 않는다');
  assert.equal(sniffImageMime(Buffer.from('hello')), null);
});

test('readLocalImage: 이미지 파일을 읽고, 공백을 %20 으로 적은 경로도 찾는다', async (t) => {
  const dir = await scratch(t);
  await mkdir(join(dir, 'ui shots'));
  const file = join(dir, 'ui shots', 'town_forge.png');
  await writeFile(file, PNG);
  const direct = await readLocalImage(file, '');
  assert.deepEqual([direct.mimeType, direct.bytes.equals(PNG), direct.path], ['image/png', true, file]);
  const encoded = await readLocalImage(join(dir, 'ui%20shots', 'town_forge.png'), '');
  assert.equal(encoded.path, file);
  const relative = await readLocalImage('ui shots/town_forge.png', dir);
  assert.equal(relative.path, file, '상대 경로는 cwd 기준');
});

test('readLocalImage: 이미지가 아니거나 너무 크면 이유와 함께 거절한다', async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'secret.txt'), 'token=abc');
  await writeFile(join(dir, 'fake.png'), 'token=abc');
  await writeFile(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const big = Buffer.alloc(LOCAL_IMAGE_MAX_BYTES + 1);
  PNG.copy(big);
  await writeFile(join(dir, 'big.png'), big);
  const codeOf = (p) => readLocalImage(join(dir, p), '').then(() => 'ok', (e) => e.code);
  assert.equal(await codeOf('secret.txt'), 'not_image', '확장자가 이미지가 아니면 열지도 않는다');
  assert.equal(await codeOf('fake.png'), 'not_image', '이름만 .png 인 파일은 내용으로 걸러진다');
  assert.equal(await codeOf('icon.svg'), 'not_image');
  assert.equal(await codeOf('big.png'), 'too_large');
  assert.equal(await codeOf('missing.png'), 'not_found');
  assert.equal(await codeOf(''), 'not_found', '디렉터리는 파일이 아니다');
});

test('runner: local_image RPC 가 바이트와 mime 을 돌려주고 실패는 코드로 답한다', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'shot.png');
  await writeFile(file, PNG);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const runner = new AgentSessionRunner(
    { url: 'http://127.0.0.1:0', apiKey: 'k' },
    { getManagerId: () => 'm', store: new AgentSessionStore(join(dir, 'home')), sessionHomesDir: join(dir, 'session-homes'), idleMinutes: 0 },
  );
  t.after(() => runner.shutdown?.());
  const rpc = async (requestId, extra) => {
    await runner.handle({ manager_id: 'm', cli: 'claude', op: 'local_image', request_id: requestId, session_id: 'sess-1', driver_user_id: 'u', issued_at: new Date().toISOString(), ...extra });
    return calls.find((c) => c.url.endsWith(`/api/agent/sessions/rpc/${requestId}`))?.body;
  };
  const ok = await rpc('r1', { image_path: 'shot.png', cwd: dir });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.mime_type, 'image/png');
  assert.equal(Buffer.from(ok.result.base64, 'base64').equals(PNG), true);
  const missing = await rpc('r2', { image_path: join(dir, 'nope.png') });
  assert.deepEqual([missing.ok, missing.code], [false, 'not_found']);
  const notImage = await rpc('r3', { image_path: join(dir, 'home') });
  assert.deepEqual([notImage.ok, notImage.code], [false, 'not_found']);
});

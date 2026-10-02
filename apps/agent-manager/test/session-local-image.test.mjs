// 세션 답 속 로컬 경로 미리보기 파일(`![alt](E:/…png)`, `[보고서](./report.html)`) — 매니저가 그 장비에서 읽어 주는 `local_image` RPC.
//   1. 경로 모양: 드라이브 문자 · `/E:/`(win32) · file:// · ~ · 상대(cwd 기준) · `%20`.
//   2. 미리보기 파일만: 이미지(확장자 + 매직 바이트, 이름만 .png 인 텍스트는 거절, SVG 거절, 상한)와
//      html/md(확장자 + 텍스트 확인 — NUL 바이트가 있으면 거절).
//   3. 러너가 RPC 로 { base64, mime_type } 을 돌려주고, 실패는 코드와 함께 ok:false 로 답한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 아래 두 테스트는 `platform` 인자(경로 문법 seam)로 OS 를 명시한다 — 러너가 ubuntu 든
// windows 든 같은 리터럴이 나와야 한다. 호스트 네이티브 갈래(`~`, `file://`)는 세 번째 테스트.
test('resolveLocalImagePath: POSIX 장비의 경로 모양', () => {
  assert.equal(resolveLocalImagePath('/tmp/a.png', '', 'linux'), '/tmp/a.png');
  assert.equal(resolveLocalImagePath('shots/a.png', '/work/repo', 'linux'), '/work/repo/shots/a.png');
  // `/E:/…` 는 Windows 장비에서만 드라이브 경로다 — 다른 OS 에서는 손대지 않는다.
  assert.equal(resolveLocalImagePath('/E:/a.png', '', 'linux'), '/E:/a.png');
});

// 루트를 가진 입력만 쓴다 — `win32.resolve('/tmp/a.png')` 는 cwd 의 드라이브를 끌어오므로
// (linux 에서 `\tmp\a.png`, windows 러너에서 `D:\tmp\a.png`) 드라이브 없는 절대 경로로는
// 리터럴을 단정할 수 없다. `~`/`file://` 도 이 분기에 섞지 않는다(호스트 homedir 모양이 샌다).
test('resolveLocalImagePath: Windows 장비의 경로 모양 — 드라이브 문자와 `/E:/`', () => {
  assert.equal(resolveLocalImagePath('C:\\x\\a.png', '', 'win32'), 'C:\\x\\a.png');
  assert.equal(resolveLocalImagePath('E:/a.png', '', 'win32'), 'E:\\a.png');
  assert.equal(resolveLocalImagePath('/E:/a.png', '', 'win32'), 'E:\\a.png', 'URL 경로 모양으로 적힌 드라이브 경로');
  assert.equal(resolveLocalImagePath('//srv/share/a.png', '', 'win32'), '\\\\srv\\share\\a.png', 'UNC 공유');
  assert.equal(resolveLocalImagePath('shots\\a.png', 'C:\\work\\repo', 'win32'), 'C:\\work\\repo\\shots\\a.png');
});

test('resolveLocalImagePath: 호스트 네이티브 갈래와 거절', () => {
  assert.equal(resolveLocalImagePath('~/a.png', ''), resolve(homedir(), 'a.png'));
  // 공백이 `%20` 으로 적힌 file:// URL — 기대값은 이 장비 모양이라 왕복으로 단정한다.
  const url = pathToFileURL(resolve(tmpdir(), 'x y.png')).href;
  assert.match(url, /x%20y\.png$/, '공백은 URL 에서 %20 이다');
  assert.equal(resolveLocalImagePath(url, ''), fileURLToPath(url));
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

test('readLocalImage: html/md 미리보기 파일을 이미지와 같은 통으로 읽는다', async (t) => {
  const dir = await scratch(t);
  const html = '<!doctype html><html><body>보고서</body></html>';
  const md = '# 보고서\n\n- 항목\n';
  await writeFile(join(dir, 'report.html'), html);
  await writeFile(join(dir, 'notes.MD'), md);
  const gotHtml = await readLocalImage(join(dir, 'report.html'), '');
  assert.deepEqual([gotHtml.mimeType, gotHtml.bytes.toString('utf8')], ['text/html', html]);
  const gotMd = await readLocalImage('notes.MD', dir);
  assert.deepEqual([gotMd.mimeType, gotMd.bytes.toString('utf8')], ['text/markdown', md]);
});

test('readLocalImage: 확장자만 .md 인 바이너리는 거절한다', async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'evil.md'), Buffer.concat([Buffer.from('# x\n'), Buffer.from([0x00, 0x01, 0x02])]));
  await writeFile(join(dir, 'empty.md'), '');
  const codeOf = (p) => readLocalImage(join(dir, p), '').then(() => 'ok', (e) => e.code);
  assert.equal(await codeOf('evil.md'), 'not_image', 'NUL 바이트가 있으면 텍스트가 아니다');
  assert.equal(await codeOf('empty.md'), 'not_image', '빈 파일은 미리보기가 아니다');
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

// 자료실 클라이언트 바인딩 — apps/client/src/api.ts + LibraryPage.
// 고정하는 것:
//   1. 다운로드는 /raw?download=1 직링크다(APK를 attachment로 내린다). 토큰이 있으면
//      쿼리로 싣고, 없어도 모양은 깨지지 않는다.
//   2. /library 라우트와 사이드바 Library 항목이 있다 — 없으면 올릴 곳도 받을 곳도 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rawResourceUrl } from '../src/api.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('다운로드 링크는 /raw?download=1 이다', () => {
  const url = rawResourceUrl('res-123', { download: true });
  assert.match(url, /\/api\/resources\/res-123\/raw\?/);
  assert.match(url, /download=1/);
});

test('라우트와 사이드바에 Library가 있다', () => {
  assert.match(read('src/App.tsx'), /path="library" element=\{<LibraryPage \/>\}/);
  assert.match(read('src/components/Sidebar.tsx'), /key: 'library', path: `\$\{basePath\}\/library`/);
});

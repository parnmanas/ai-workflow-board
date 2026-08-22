// SPA fallback dot-segment 회귀 테스트 (ticket 6000fadf).
//
// applySpaFallback(common/spa-fallback.ts, ticket 7ba057fb)은
// res.sendFile('index.html', { root: clientDistRoot }, cb) 처럼 root 를 명시해서
// 호출한다. root 가 없으면(과거 @nestjs/serve-static 내장 fallback이 그랬듯)
// send 모듈이 절대경로 전체 세그먼트를 dotfile 검사 대상으로 삼아, 이 저장소의
// AWB worktree 작업 폴더 관례(`.awb/wt/<board>/<ticket>/...`) 아래에서는 항상
// 404 로 떨어진다. 아래 첫 테스트는 그 dotfile-세그먼트 회피가 실제로 동작함을,
// 두 번째 테스트는 root 없이 호출하면 정확히 같은 경로가 깨진다는 대조군을
// 직접 증명한다.
//
// apps/server 의 test 스크립트는 서버만 빌드하므로 실제 apps/client/dist 경로가
// dot-segment 를 포함하는지는 checkout 위치에 좌우된다(로컬 AWB worktree에서는
// 포함하지만 CI 등 일반 checkout에서는 그렇지 않다) — 그래서 이 테스트는 실행
// 환경과 무관하게 항상 재현되도록 os.tmpdir() 아래에 `.awb/wt/...` 형태의
// dot-segment 임시 트리를 직접 만들어 검증한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const BASE_PORT = Number(process.env.TEST_SERVER_PORT || 7935);

const { applySpaFallback } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'spa-fallback.js')
);

const INDEX_MARKER = 'AWB-SPA-FALLBACK-DOTSEGMENT-TEST-MARKER';
// 이 저장소 자체의 worktree 작업 폴더 관례(.awb/wt/<board>/<ticket>/...)를 그대로
// 흉내낸 dot-segment 임시 경로.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-spa-fallback-'));
const DOTSEG_DIST = path.join(TMP_ROOT, '.awb', 'wt', 'board', 'ticket', 'dist');
fs.mkdirSync(DOTSEG_DIST, { recursive: true });
fs.writeFileSync(path.join(DOTSEG_DIST, 'index.html'), `<!doctype html><html><body>${INDEX_MARKER}</body></html>`);

test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('applySpaFallback: dot-segment(.awb/wt/...) 경로에서도 root 옵션 덕분에 index.html이 정상 반환된다', async (t) => {
  const app = express();
  applySpaFallback(app, DOTSEG_DIST);
  const server = app.listen(BASE_PORT);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${BASE_PORT}/ws/abc/boards`);
  assert.equal(res.status, 200, 'dot-segment 경로 아래에서도 SPA fallback이 200이어야 한다');
  const body = await res.text();
  assert.ok(body.includes(INDEX_MARKER), 'index.html 본문을 받아야 한다');
});

test('회귀 대조군: root 옵션 없이 절대경로로 sendFile하면 같은 dot-segment 경로가 404한다', async (t) => {
  // ticket 6000fadf 설명에 나온 실증 재현 그대로 — NestJS 없이 sendFile(path, null,
  // cb) 만으로 dotfile 검사가 절대경로 전체에 걸린다는 것을 보인다. 이 테스트가
  // 실패한다면(=200을 받는다면) 재현 전제 자체가 바뀐 것이니 위 테스트의 의미도
  // 다시 검토해야 한다.
  const absoluteIndexPath = path.join(DOTSEG_DIST, 'index.html');
  const app = express();
  app.get('/ws/abc/boards', (req, res) => {
    res.sendFile(absoluteIndexPath, null, (err) => {
      if (err) res.status(404).json({ message: err.message });
    });
  });
  const port = BASE_PORT + 1;
  const server = app.listen(port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${port}/ws/abc/boards`);
  assert.equal(res.status, 404, 'root 옵션 없는 절대경로 sendFile은 .awb 세그먼트를 dotfile로 오인해 404해야 한다');
  const body = await res.json();
  assert.equal(body.message, 'Not Found');
});

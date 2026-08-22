// SPA fallback 은 원래 /assets/* 아래 존재하지 않는 파일까지 index.html(200
// text/html) 로 돌려줬다 — 재배포로 청크 해시가 바뀐 뒤 stale 탭이 사라진 청크를
// lazy-import 하면 브라우저의 strict MIME 체크("Expected a JavaScript-or-Wasm
// module script but the server responded with a MIME type of text/html")를
// 위반해 흰 화면으로 죽었다 (ticket 2cae7314). app.module.ts 의 ServeStaticModule
// exclude 에 '/assets{*path}' 를 추가해 그 경로는 fallback 대상에서 빠지고 정상
// 404 로 응답하도록 고쳤다 — 이 테스트가 그 계약과, 실존 asset 은 계속 정상
// 서빙된다는 회귀 안전망을 고정한다.
//
// apps/server 의 test 스크립트는 서버만 빌드하므로(apps/client/dist 는 만들지
// 않는다) ServeStaticModule 이 실제로 읽는 apps/client/dist 경로에 최소
// index.html + 실존 asset 파일을 직접 심어 진짜 정적 서빙 코드 경로(express.static
// + exclude 카탈로그)를 구동한다.
//
// 범위에서 뺀 것: "/assets 이외의 알 수 없는 라우트(예 /ws/:id/boards)도 여전히
// index.html 로 fallback 되는지"는 이 스위트가 검증하지 않는다 — 그 catch-all 은
// @nestjs/serve-static 이 내부적으로 res.sendFile(indexFilePath, null, cb) 를
// root 옵션 없이 호출하는데(node_modules/@nestjs/serve-static/dist/loaders/
// express.loader.js), root 가 없으면 send 모듈이 절대경로 전체 세그먼트를
// dotfile 검사 대상으로 삼는다. 이 저장소의 AWB worktree 절대경로는
// `.../.awb/wt/<board>/<ticket>/...` 형태라 `.awb` 세그먼트가 dotfile 로 인식돼
// 항상 404 로 떨어진다 — /assets 제외 변경과 무관한 기존 버그이며 프로덕션
// Dockerfile(WORKDIR=/app, dot-segment 없음)에는 영향이 없다. 후속 티켓
// #[ticket:6000fadf-d4a0-4bae-a285-aae0a20ea2e2|SPA fallback res.sendFile이 root 옵션 없이 호출돼 dot-segment 포함 경로(.awb worktree 등)에서 항상 404]
// 로 분리 기록. 아래는 그 버그를 우회하는 케이스(루트 `/` — express.static 자체의
// index-serving 으로 처리되어 이 dotfile 경로를 타지 않는다)만 회귀 가드로 쓴다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7830';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
const INDEX_HTML_PATH = path.join(CLIENT_DIST, 'index.html');
const CLIENT_DIST_PRE_EXISTED = fs.existsSync(CLIENT_DIST);
// 로컬에서 `npm run build -w client` 를 먼저 돌려본 뒤 이 테스트를 실행해도 실제
// 빌드 산출물을 잃지 않도록, 덮어쓰기 전 원본 index.html 을 있으면 백업해뒀다가
// 그대로 복원한다(단순 삭제는 진짜 빌드를 날린다).
const ORIGINAL_INDEX_HTML = fs.existsSync(INDEX_HTML_PATH) ? fs.readFileSync(INDEX_HTML_PATH) : null;
const INDEX_MARKER = 'AWB-SPA-FALLBACK-TEST-MARKER';
const EXISTING_CHUNK = 'existing-chunk-9f2a.js';
const MISSING_CHUNK = 'missing-chunk-deadbeef.js';

function seedClientDist() {
  fs.mkdirSync(path.join(CLIENT_DIST, 'assets'), { recursive: true });
  fs.writeFileSync(INDEX_HTML_PATH, `<!doctype html><html><body>${INDEX_MARKER}</body></html>`);
  fs.writeFileSync(path.join(CLIENT_DIST, 'assets', EXISTING_CHUNK), '// existing built chunk\n');
}

function cleanupClientDist() {
  fs.rmSync(path.join(CLIENT_DIST, 'assets', EXISTING_CHUNK), { force: true });
  if (CLIENT_DIST_PRE_EXISTED) {
    if (ORIGINAL_INDEX_HTML !== null) {
      fs.writeFileSync(INDEX_HTML_PATH, ORIGINAL_INDEX_HTML);
    } else {
      fs.rmSync(INDEX_HTML_PATH, { force: true });
    }
  } else {
    fs.rmSync(CLIENT_DIST, { recursive: true, force: true });
  }
}

test('/assets 의 존재하지 않는 청크는 SPA fallback(200 index.html) 대신 404, 실존 asset·앱 셸(index.html)은 그대로 동작', async (t) => {
  seedClientDist();
  t.after(cleanupClientDist);

  const { app, port } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });

  const missing = await fetch(`http://127.0.0.1:${port}/assets/${MISSING_CHUNK}`);
  assert.equal(missing.status, 404, '없는 /assets 청크는 404 여야 한다');
  const missingBody = await missing.text();
  assert.ok(!missingBody.includes(INDEX_MARKER), 'index.html 폴백 본문을 돌려주면 안 된다');
  // 상태코드 404 만으로는 이 fix 를 증명하지 못한다 — 위 코멘트의 dotfile 버그
  // 때문에 exclude 가 없어도(고쳐지기 전 상태) /assets/<missing> 요청은 sendFile
  // 실패로 "우연히" 같은 404 를 반환한다. 두 경로는 본문으로 구분된다: exclude 로
  // next() 되면 요청 경로를 담은 "Cannot GET /assets/..." 가, sendFile 이 실패하면
  // 경로 정보 없는 범용 "Not Found" 가 온다. 파일명 포함 여부로 실제 exclude 분기를
  // 탔는지(=이 fix 가 적용됐는지) 확정한다.
  assert.ok(missingBody.includes(MISSING_CHUNK), `exclude 분기(경로 포함 404)를 타야 한다 — 실제 응답: ${missingBody}`);

  const existing = await fetch(`http://127.0.0.1:${port}/assets/${EXISTING_CHUNK}`);
  assert.equal(existing.status, 200, '실존하는 /assets 파일은 계속 정상 서빙돼야 한다');
  assert.ok((await existing.text()).includes('existing built chunk'));

  const root = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(root.status, 200, '앱 셸(index.html)은 계속 정상 서빙돼야 한다');
  assert.ok((await root.text()).includes(INDEX_MARKER));
});

test.after(() => exitAfterTests());

// CSP 가 첨부 렌더를 막지 않는가 (2026-09-26 실측 사고).
//
// 증상: 미션 증거 스크린샷이 화면에서 전부 안 보였다. 서버 로그에는 아무것도 남지
// 않았고(요청은 200), 브라우저 콘솔에만 CSP 위반이 찍혔다 — helmet 기본값의
// `img-src 'self' data:` 가 `blob:` 을 빼고 있었기 때문이다. 원인을 "업로드된 파일이
// 잘렸다"로 두 번 오진했고, 그 사이 사용자는 계속 깨진 화면을 봤다.
//
// 이런 종류의 회귀는 서버 테스트가 잡기 가장 어렵다: 응답은 정상이고 실패가 브라우저
// 안에서만 일어난다. 그래서 **배포되는 지시어 값 자체**를 단언한다.
//
// 이 파일이 고정하는 것:
//   1. img/media 가 blob: 과 data: 를 허용한다 — 첨부는 object URL 로 그린다.
//   2. 그 완화가 **실행 가능한 자원으로 번지지 않는다**: script-src/object-src 는
//      blob:/data: 를 받지 않는다. 이게 이 완화의 안전선이다.
//   3. objectSrc 'none' / frameAncestors 'none' 이 그대로 남아 있다.
//   4. main.ts 가 이 상수를 실제로 쓴다 — 값만 맞고 배선이 끊기면 의미가 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { CSP_DIRECTIVES } = await import(
  pathToFileURL(path.join(__dirname, '..', 'dist', 'common', 'security-headers.js')).href
);

test('img/media 는 blob: 을 허용한다 — 첨부 이미지·동영상이 object URL 로 그려진다', () => {
  for (const key of ['imgSrc', 'mediaSrc']) {
    const v = CSP_DIRECTIVES[key];
    assert.ok(Array.isArray(v), `${key} 가 선언돼 있어야 한다`);
    assert.ok(v.includes("'self'"), `${key}: 같은 오리진은 당연히 허용`);
    assert.ok(
      v.includes('blob:'),
      `${key} 에 blob: 이 없으면 첨부가 화면에서 전부 차단된다 — 서버 로그에는 아무 흔적도 남지 않는다`,
    );
    assert.ok(v.includes('data:'), `${key}: 레거시 인라인 이미지(data: URL)도 계속 그려져야 한다`);
  }
});

test('완화가 실행 가능한 자원으로 번지지 않는다 — blob: 은 그리기 전용이다', () => {
  for (const key of ['scriptSrc', 'scriptSrcAttr', 'objectSrc']) {
    const v = CSP_DIRECTIVES[key];
    if (!v) continue; // 선언하지 않으면 helmet 기본값(더 엄격)이 적용된다
    for (const scheme of ['blob:', 'data:']) {
      assert.ok(!v.includes(scheme), `${key} 에 ${scheme} 을 주면 임의 코드 실행 경로가 열린다`);
    }
  }
});

test('기존 하드닝은 그대로 남는다', () => {
  assert.deepEqual(CSP_DIRECTIVES.objectSrc, ["'none'"]);
  assert.deepEqual(CSP_DIRECTIVES.frameAncestors, ["'none'"]);
});

test('main.ts 가 이 상수를 실제로 CSP 미들웨어에 넘긴다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(src, /import \{ CSP_DIRECTIVES \}/, 'main.ts 가 공유 상수를 가져와야 한다');
  assert.match(
    src,
    /helmet\.contentSecurityPolicy\(\{[\s\S]{0,200}directives: CSP_DIRECTIVES/,
    '가져오기만 하고 인라인 지시어를 따로 쓰면 값과 배포가 갈린다',
  );
});

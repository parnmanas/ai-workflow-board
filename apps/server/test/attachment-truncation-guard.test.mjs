// 잘린 미디어 업로드를 받지 않는다 (2026-09-26 실측 사고).
//
// 증상: 미션 evidence 로 올라온 스크린샷 4장 중 3장이 JPEG 종료 마커(FFD9)가 **아예 없는**
// 잘린 파일이었다. base64 는 완전했고 헤더도 진짜 JPEG 라서 mime sniffer 를 그대로
// 통과했고, 몇 시간 뒤 운영자가 "스크린샷이 다 깨져 보인다"로 발견했다.
//
// 원인은 올리는 쪽이다(아직 저장이 끝나지 않은 캡처 파일을 읽으면 이 모양이 된다). 그래도
// 받는 쪽에서 막는 이유: 깨진 증거가 기록되면 그 step 은 증거가 없는 것과 같고, agent 는
// 실패를 알 방법이 없어 다시 올리지도 않는다. 업로드가 실패하면 그 자리에서 재시도한다.
//
// 이 파일이 고정하는 것:
//   1. 잘린 jpeg/png/gif/webp 는 400 으로 거부되고, 메시지가 원인과 조치를 말한다.
//   2. 정상 파일은 그대로 통과한다(형식별 종료 마커 + 꼬리 패딩 허용).
//   3. 완결성을 값싸게 판정할 수 없는 형식(동영상 컨테이너·텍스트·PDF·zip)은 통과시킨다 —
//      억지 추측으로 정상 업로드를 막지 않는 것이 이 검사의 값어치다.
//   4. 검사가 `validateAttachmentMimetype` **안에서** 일어난다: 업로드 경로 둘이 모두 그
//      함수를 지나므로, 별도 호출을 각자 추가하는 방식이면 새 경로가 조용히 빠진다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helpers = await import(
  pathToFileURL(path.join(__dirname, '..', 'dist', 'modules', 'mcp', 'shared', 'ticket-helpers.js')).href
);
const { validateAttachmentMimetype, assertAttachmentNotTruncated, repairTruncatedMediaForRead } = helpers;

/** 1x1 PNG (완결). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const b64 = (buf) => Buffer.from(buf).toString('base64');
const cut = (base64, n) => {
  const raw = Buffer.from(base64, 'base64');
  return b64(raw.subarray(0, raw.length - n));
};

/**
 * 최소한의 완결 JPEG: SOI + APP0(JFIF) + 약간의 본문 + EOI. 실제 인코더 출력이 아니라
 * **종료 마커 규칙만** 시험하는 픽스처다(디코드 가능성은 이 검사의 소관이 아니다).
 */
function jpeg({ eoi = true, trailing = 0 } = {}) {
  const parts = [
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0'),
    Buffer.alloc(200, 0x41),
  ];
  if (eoi) parts.push(Buffer.from([0xff, 0xd9]));
  if (trailing) parts.push(Buffer.alloc(trailing, 0x00));
  return b64(Buffer.concat(parts));
}

function webp(declaredDelta = 0) {
  const payload = Buffer.alloc(40, 0x61);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length + 4 + declaredDelta, 4);
  head.write('WEBP', 8, 'ascii');
  return b64(Buffer.concat([head, payload]));
}

test('잘린 JPEG 은 400 으로 거부되고 메시지가 원인과 조치를 말한다', () => {
  const err = (() => {
    try {
      validateAttachmentMimetype('evidence.jpg', 'image/jpeg', jpeg({ eoi: false }));
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err, '종료 마커 없는 JPEG 은 통과해서는 안 된다');
  assert.equal(err.status, 400, '업로드 경로가 그대로 400/툴 에러로 바꿔 낼 수 있어야 한다');
  assert.match(err.message, /evidence\.jpg/, '어느 파일인지 말한다');
  assert.match(err.message, /incomplete/i);
  assert.match(err.message, /still being written/i, '원인을 짚는다 — agent 가 스스로 고칠 수 있는 형태로');
  assert.match(err.message, /upload it again/i, '조치를 말한다');
  assert.match(err.message, /Nothing was stored/i, '저장되지 않았다는 사실도 — 재시도 여부를 판단할 근거다');
});

test('정상 JPEG 은 통과하고, 종료 마커 뒤 꼬리 패딩도 허용한다', () => {
  assert.equal(validateAttachmentMimetype('a.jpg', 'image/jpeg', jpeg()), 'image/jpeg');
  // 일부 인코더는 EOI 뒤에 패딩을 붙인다. "정확히 끝에 있어야 한다"로 좁히면 오탐한다.
  assert.equal(validateAttachmentMimetype('a.jpg', 'image/jpeg', jpeg({ trailing: 20 })), 'image/jpeg');
});

test('종료 마커가 마지막 64바이트 밖이면 잘린 것으로 본다 (EXIF 썸네일 통과 방지)', () => {
  // 파일 전체에서 FFD9 를 찾으면 EXIF 안에 박힌 완결 썸네일의 마커를 보고 잘린 파일을
  // 통과시킨다. 그래서 창을 꼬리 64바이트로 좁혔다.
  assert.throws(() => validateAttachmentMimetype('a.jpg', 'image/jpeg', jpeg({ trailing: 200 })), /incomplete/i);
});

test('잘린 PNG · GIF · WebP 도 각각의 종료 규칙으로 거부된다', () => {
  assert.throws(() => validateAttachmentMimetype('a.png', 'image/png', cut(PNG, 8)), /PNG data is incomplete/i);
  assert.equal(validateAttachmentMimetype('a.png', 'image/png', PNG), 'image/png', '정상 PNG 는 통과');

  const gif = b64(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 0x41)]));
  assert.throws(() => assertAttachmentNotTruncated('a.gif', 'image/gif', gif), /GIF data is incomplete/i);
  assert.doesNotThrow(() =>
    assertAttachmentNotTruncated('a.gif', 'image/gif', b64(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 0x41), Buffer.from([0x3b])]))),
  );

  // RIFF 는 길이를 헤더에 적어 둔다 — 선언보다 짧으면 잘린 것이다.
  assert.throws(() => assertAttachmentNotTruncated('a.webp', 'image/webp', webp(50)), /WebP data is incomplete/i);
  assert.doesNotThrow(() => assertAttachmentNotTruncated('a.webp', 'image/webp', webp(0)));
});

test('빈 파일은 형식과 무관하게 거부된다', () => {
  assert.throws(() => validateAttachmentMimetype('e.png', 'image/png', ''), /empty \(0 bytes decoded\)/i);
});

test('완결성을 값싸게 판정할 수 없는 형식은 통과시킨다 — 억지 추측으로 정상 업로드를 막지 않는다', () => {
  // 동영상 컨테이너: 꼬리 한 번으로 완결성을 알 수 없다.
  assert.equal(
    validateAttachmentMimetype('v.webm', 'video/webm', b64(Buffer.from('\x1aE\xdf\xa3webm-stub'))),
    'video/webm',
  );
  assert.equal(validateAttachmentMimetype('v.mp4', 'video/mp4', b64(Buffer.alloc(64, 0x21))), 'video/mp4');
  // 텍스트·로그·소스: "잘렸다"는 개념 자체가 없다. 채팅의 가장 흔한 업로드다.
  assert.equal(validateAttachmentMimetype('b.log', 'text/plain', b64(Buffer.from('half a line'))), 'text/plain');
});

test('mime 위장 거부는 그대로 살아 있다 — 완결성 검사가 그 가드를 가리지 않는다', () => {
  // PNG 바이트를 pdf 라고 주장 → 기존 보안 가드(400)가 먼저 잡는다.
  assert.throws(
    () => validateAttachmentMimetype('a.pdf', 'application/pdf', PNG),
    /does not match file bytes/i,
  );
});

test('검사는 validateAttachmentMimetype 안에서 일어난다 — 새 업로드 경로가 빠뜨릴 수 없다', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'mcp', 'shared', 'ticket-helpers.ts'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('export function validateAttachmentMimetype'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const returns = (body.match(/return [a-zA-Z]+;/g) || []).length;
  const checks = (body.match(/assertAttachmentNotTruncated\(/g) || []).length;
  assert.ok(checks > 0, 'validateAttachmentMimetype 이 완결성 검사를 호출해야 한다');
  assert.equal(
    checks,
    returns,
    `성공 반환 경로마다 검사가 있어야 한다 (반환 ${returns}개, 검사 ${checks}개) — ` +
      '한 경로만 빠져도 그 조합의 업로드는 검사 없이 저장된다',
  );
});

// ── 읽기 시점 복구 ───────────────────────────────────────────────────────────
//
// 업로드 게이트가 생기기 전에 저장된 잘린 파일이 남아 있다. 그 바이트는 쓸모없지 않다 —
// 종료 마커만 붙이면 디코더가 도착한 스캔라인까지 그려 준다(실측: 한 장은 98% 복원).
// 저장된 행은 고치지 않는다: 실제로 올라온 바이트가 기록이고, 덮어쓰면 무엇이 잘못
// 올라왔는지의 증거가 사라진다.

test('잘린 JPEG 은 읽을 때 종료 마커를 붙여 돌려주고, 일부라는 사실을 함께 알린다', () => {
  const cutJpeg = jpeg({ eoi: false });
  const out = repairTruncatedMediaForRead('image/jpeg', cutJpeg);
  assert.equal(out.truncated, true, '화면이 "일부만"이라고 말할 근거가 필요하다');
  const bytes = Buffer.from(out.file_data, 'base64');
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9], '스트림이 닫혀야 디코더가 받은 만큼 그린다');
  assert.equal(
    bytes.length,
    Buffer.from(cutJpeg, 'base64').length + 2,
    '내용을 지어내지 않는다 — 마커 2바이트만 덧붙인다',
  );
});

test('온전한 파일은 한 바이트도 건드리지 않는다', () => {
  for (const [mime, data] of [['image/jpeg', jpeg()], ['image/png', PNG], ['text/plain', b64(Buffer.from('log'))]]) {
    const out = repairTruncatedMediaForRead(mime, data);
    assert.equal(out.truncated, false);
    assert.equal(out.file_data, data, `${mime} 은 그대로 나가야 한다`);
  }
});

test('복구할 수 없는 형식도 잘렸다는 사실은 알린다 (PNG 는 청크·CRC 구조라 꼬리를 못 붙인다)', () => {
  const out = repairTruncatedMediaForRead('image/png', cut(PNG, 8));
  assert.equal(out.truncated, true);
  assert.equal(out.file_data, cut(PNG, 8), '고치지 못할 때 바이트를 바꾸면 더 깨진다');
});

test('업로드 거부와 읽기 복구는 같은 판정을 쓴다 — 갈리면 "통과했는데 잘렸다고 표시"가 된다', () => {
  const cases = [jpeg({ eoi: false }), cut(PNG, 8)];
  for (const data of cases) {
    const mime = data === cases[0] ? 'image/jpeg' : 'image/png';
    assert.throws(() => assertAttachmentNotTruncated('x', mime, data), /incomplete/i);
    assert.equal(repairTruncatedMediaForRead(mime, data).truncated, true);
  }
  for (const [mime, data] of [['image/jpeg', jpeg()], ['video/webm', b64(Buffer.from('webm'))]]) {
    assert.doesNotThrow(() => assertAttachmentNotTruncated('x', mime, data));
    assert.equal(repairTruncatedMediaForRead(mime, data).truncated, false);
  }
});

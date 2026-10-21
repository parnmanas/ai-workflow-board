// 메일 연락처 CSV 가져오기의 순수 규칙(docs/marketing.md "메일").
//
// 고정하는 계약:
//   1. CSV 는 RFC 4180 에 가깝게 읽는다 — 따옴표 안의 구분자 · 줄바꿈 · "" , CRLF, BOM, 빈 줄, ; · 탭 구분자.
//   2. 열 이름은 영문 · 한글 별칭과 표기 차이(Consent At / consent_at)를 같은 필드로 맞춘다.
//   3. 동의 증거(방법 · 시각 · 출처)가 없는 행은 보내지 않는다. 동의 시각은 기본값으로 채우지 않는다.
//   4. 같은 파일 안의 중복 주소는 처음 행만 — 뒤엣것이 앞의 동의 증거를 덮지 않게.
//   5. 메일 주소 · 목록 이름 판정이 서버(marketing-channel.logic)와 같다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-contacts-csv.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_IMPORT_PER_REQUEST,
  autoMapHeaders,
  buildContactImport,
  chunkContacts,
  detectDelimiter,
  isEmailAddress,
  normalizeHeader,
  normalizeListName,
  parseBooleanCell,
  parseCsv,
} from '../src/components/marketing/marketingContacts.logic.ts';
import * as serverChannel from '../../server/src/modules/marketing/marketing-channel.logic.ts';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const DEFAULTS = { lists: [], consent_method: '', consent_source: '' };

function plan(csv, defaults = DEFAULTS) {
  const parsed = parseCsv(csv);
  assert.equal(parsed.error, null, `파싱 실패: ${parsed.error}`);
  return buildContactImport(parsed, autoMapHeaders(parsed.headers), defaults, NOW);
}

test('parseCsv — 따옴표 안의 쉼표 · 줄바꿈 · "" 를 한 칸으로 읽는다', () => {
  const r = parseCsv('email,name,note\r\na@x.io,"Kim, Minji","line1\r\nline2"\r\nb@x.io,"He said ""hi""",\r\n');
  assert.equal(r.error, null);
  assert.deepEqual(r.headers, ['email', 'name', 'note']);
  assert.deepEqual(r.rows, [
    ['a@x.io', 'Kim, Minji', 'line1\r\nline2'],
    ['b@x.io', 'He said "hi"', ''],
  ]);
  assert.deepEqual(r.lines, [2, 4], '여러 줄 칸 다음 행의 줄 번호가 원본과 맞다');
});

test('parseCsv — BOM · LF · 빈 줄 · 마지막 줄바꿈 없음', () => {
  const r = parseCsv('﻿email,name\n\na@x.io,A\n\n\nb@x.io,B');
  assert.deepEqual(r.headers, ['email', 'name'], 'BOM 이 첫 머리글에 섞이지 않는다');
  assert.deepEqual(r.rows, [['a@x.io', 'A'], ['b@x.io', 'B']]);
  assert.deepEqual(r.lines, [3, 6]);
});

test('parseCsv — ; · 탭 구분자를 첫 줄에서 알아낸다(따옴표 안은 세지 않는다)', () => {
  assert.equal(detectDelimiter('email;name;"a,b,c"\n'), ';');
  assert.equal(detectDelimiter('email\tname\n'), '\t');
  assert.equal(detectDelimiter('email,name\n'), ',');
  assert.equal(detectDelimiter('email\n'), ',');
  const r = parseCsv('email;name\na@x.io;"Lee; Jun"\n');
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.rows, [['a@x.io', 'Lee; Jun']]);
});

test('parseCsv — 닫히지 않은 따옴표는 오류다', () => {
  const r = parseCsv('email,name\na@x.io,"Kim\nb@x.io,B\n');
  assert.match(r.error, /2번째 줄에서 시작한 따옴표가 닫히지 않았습니다/);
  assert.deepEqual(r.rows, []);
  assert.match(parseCsv('').error, /내용이 없습니다/);
});

test('autoMapHeaders — 영문 · 한글 별칭과 표기 차이를 같은 필드로', () => {
  assert.equal(normalizeHeader(' Consent At '), 'consentat');
  const m = autoMapHeaders(['E-mail', '이름', 'Consent Method', '동의 출처', 'consented_at', 'Night Consent', 'Country', 'tz', 'lists', 'extra']);
  assert.equal(m.email, 0);
  assert.equal(m.name, 1);
  assert.equal(m.consent_method, 2);
  assert.equal(m.consent_source, 3);
  assert.equal(m.consent_at, 4);
  assert.equal(m.night_consent, 5);
  assert.equal(m.country, 6);
  assert.equal(m.timezone, 7);
  assert.equal(m.lists, 8);
  assert.equal(m.consent_ip, -1, '없는 열은 -1');
  assert.equal(m.consent_text_version, -1);
});

test('buildContactImport — 동의 증거가 있는 행을 가져오기 본문으로 만든다', () => {
  const p = plan([
    'email,name,lists,consent_method,consent_source,consent_at,consent_text_version,night_consent,country,timezone',
    ' Kim@Example.com ,김민지,beta;newsletter,signup_form,https://ex.com/signup,2026-09-01T10:00:00Z,v3,yes,kr,Asia/Seoul',
  ].join('\n'));
  assert.equal(p.invalidCount, 0, JSON.stringify(p.rows));
  assert.deepEqual(p.valid, [{
    email: 'kim@example.com',
    name: '김민지',
    lists: ['beta', 'newsletter'],
    consent_method: 'signup_form',
    consent_source: 'https://ex.com/signup',
    consent_at: '2026-09-01T10:00:00.000Z',
    consent_text_version: 'v3',
    night_consent: true,
    country: 'KR',
    timezone: 'Asia/Seoul',
  }]);
  assert.deepEqual(p.validLines, [2]);
});

test('buildContactImport — 방법 · 출처는 기본값으로 채울 수 있지만 동의 시각은 아니다', () => {
  const withDefaults = plan('email,consent_at\na@x.io,2026-01-02\nb@x.io,\n', {
    lists: ['Newsletter'],
    consent_method: 'event',
    consent_source: '2026 meetup sign-up sheet',
  });
  assert.equal(withDefaults.valid.length, 1);
  assert.equal(withDefaults.valid[0].consent_method, 'event');
  assert.equal(withDefaults.valid[0].consent_source, '2026 meetup sign-up sheet');
  assert.equal(withDefaults.valid[0].lists, undefined, '기본 목록은 본문의 lists 로 따로 간다');
  const b = withDefaults.rows.find((r) => r.email === 'b@x.io');
  assert.match(b.errors.join(' '), /동의 시각\(consent_at\)이 없습니다/);

  const noEvidence = plan('email,consent_at\na@x.io,2026-01-02\n', { lists: ['news'], consent_method: '', consent_source: '' });
  assert.equal(noEvidence.valid.length, 0);
  const errors = noEvidence.rows[0].errors.join(' ');
  assert.match(errors, /동의 방법\(consent_method\)이 없습니다/);
  assert.match(errors, /동의 출처\(consent_source\)가 없습니다/);
});

test('buildContactImport — 행마다 무엇이 틀렸는지 말한다', () => {
  const p = plan([
    'email,consent_method,consent_source,consent_at,lists,night_consent,country,timezone',
    'not-an-email,signup_form,form,2026-01-01,news,,,',
    'a@x.io,newsletter_box,form,2026-01-01,news,,,',
    'b@x.io,signup_form,form,2099-01-01,news,,,',
    'c@x.io,signup_form,form,어제,news,,,',
    'd@x.io,signup_form,form,2026-01-01,News Letter!,,,',
    'e@x.io,signup_form,form,2026-01-01,news,maybe,,',
    'f@x.io,signup_form,form,2026-01-01,news,,KOR,',
    'g@x.io,signup_form,form,2026-01-01,news,,,Mars/Base',
    'h@x.io,signup_form,form,2026-01-01,,,,',
  ].join('\n'));
  const byLine = Object.fromEntries(p.rows.map((r) => [r.line, r.errors.join(' / ')]));
  assert.match(byLine[2], /이메일 주소가 아닙니다/);
  assert.match(byLine[3], /동의 방법 "newsletter_box"/);
  assert.match(byLine[4], /동의 시각이 미래입니다/);
  assert.match(byLine[5], /동의 시각을 읽을 수 없습니다/);
  assert.match(byLine[6], /목록 이름 "News Letter!"/);
  assert.match(byLine[7], /야간 수신 동의는 true \/ false/);
  assert.match(byLine[8], /국가는 ISO 3166-1 두 글자/);
  assert.match(byLine[9], /알 수 없는 시간대/);
  assert.match(byLine[10], /수신 목록이 없습니다/);
  assert.equal(p.valid.length, 0);
  assert.equal(p.invalidCount, 9);
});

test('buildContactImport — 파일 안의 중복 주소는 처음 행만 가져온다', () => {
  const p = plan('email,consent_method,consent_source,consent_at\nA@x.io,signup_form,form,2026-01-01\na@x.io,import,crm,2026-02-01\n', {
    lists: ['news'], consent_method: '', consent_source: '',
  });
  assert.equal(p.valid.length, 1);
  assert.equal(p.valid[0].consent_method, 'signup_form', '앞 행의 동의 증거가 남는다');
  assert.match(p.rows[1].errors.join(' '), /중복된 주소/);
});

test('buildContactImport — 기본 목록 이름이 틀리면 아무것도 보내지 않는다', () => {
  const p = plan('email,consent_method,consent_source,consent_at\na@x.io,signup_form,form,2026-01-01\n', {
    lists: ['뉴스레터'], consent_method: '', consent_source: '',
  });
  assert.equal(p.defaultListErrors.length, 1);
  assert.deepEqual(p.valid, []);
  assert.deepEqual(p.validLines, []);
});

test('야간 수신 동의 칸 — 비면 보내지 않고, 예/아니오 낱말을 읽는다', () => {
  assert.equal(parseBooleanCell(''), undefined);
  assert.equal(parseBooleanCell('TRUE'), true);
  assert.equal(parseBooleanCell('예'), true);
  assert.equal(parseBooleanCell('0'), false);
  assert.equal(parseBooleanCell('미동의'), false);
  assert.equal(parseBooleanCell('maybe'), 'invalid');
});

test('메일 주소 · 목록 이름 판정이 서버와 같다', () => {
  for (const email of ['a@x.io', 'kim.minji+news@example.co.kr', 'no-at-sign', 'a@b', 'a b@x.io', '<a@x.io>', `${'a'.repeat(250)}@x.io`]) {
    assert.equal(isEmailAddress(email), serverChannel.isEmailAddress(email), email);
  }
  for (const name of ['newsletter', 'Beta Users', 'beta_users-2026.q4', '', ' ', '-news', '뉴스', 'a'.repeat(101), 'news!']) {
    let server = null;
    try { server = serverChannel.normalizeListName(name); } catch { server = null; }
    assert.equal(normalizeListName(name), server, `"${name}"`);
  }
});

test('chunkContacts — 서버 한도(한 요청 5,000명)로 나눈다', () => {
  assert.equal(MAX_IMPORT_PER_REQUEST, 5000);
  const chunks = chunkContacts(Array.from({ length: 12001 }, (_, i) => i));
  assert.deepEqual(chunks.map((c) => c.length), [5000, 5000, 2001]);
  assert.equal(chunks[2][0], 10000);
  assert.deepEqual(chunkContacts([]), []);
});

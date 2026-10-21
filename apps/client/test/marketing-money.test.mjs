// Marketing 금액 규칙(docs/marketing.md "예산 편성 · 집행 · 결제") — 화면의 formatMinor / parseMajorToMinor.
//
// 고정하는 계약:
//   1. 표기는 서버 formatMinorAmount 와 글자 그대로 같다(지시문 · 감사 요약 · 화면이 같은 금액 글자를 본다).
//   2. 통화 지수(KRW · JPY 0, 대부분 2, BHD · KWD … 3)가 서버 currencyExponent 와 같다.
//   3. 입력(major) → 정수 최소 단위 변환은 부동소수를 거치지 않는다(0.29 USD = 29, 28 이 아니다).
//   4. 통화가 허용하는 것보다 소수 자리가 많으면 반올림하지 않고 거부한다.
//   5. 쉼표는 세 자리 구분으로만 읽는다 — "12,50" 이 1250 이 되지 않는다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-money.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MINOR_AMOUNT,
  currencyExponent,
  formatMinor,
  isCurrencyCode,
  minorToMajorInput,
  parseMajorToMinor,
  shortHash,
} from '../src/components/marketing/marketing.logic.ts';
import * as serverMoney from '../../server/src/common/marketing/money.ts';

const CURRENCIES = ['KRW', 'JPY', 'VND', 'USD', 'EUR', 'GBP', 'BHD', 'KWD', 'JOD', 'TND', 'CHF'];

test('통화 지수는 서버와 같다 — KRW · JPY 0, 대부분 2, BHD · KWD 3', () => {
  assert.equal(currencyExponent('KRW'), 0);
  assert.equal(currencyExponent('jpy'), 0, '소문자도 같은 통화');
  assert.equal(currencyExponent('USD'), 2);
  assert.equal(currencyExponent('BHD'), 3);
  assert.equal(currencyExponent('KWD'), 3);
  for (const code of [...CURRENCIES, 'BIF', 'CLP', 'ISK', 'XOF', 'IQD', 'LYD', 'OMR', 'AUD', 'XYZ']) {
    assert.equal(currencyExponent(code), serverMoney.currencyExponent(code), `${code} 의 지수가 서버와 다르다`);
  }
});

test('formatMinor 는 서버 formatMinorAmount 와 글자 그대로 같다', () => {
  assert.equal(formatMinor(50000, 'KRW'), '50,000 KRW');
  assert.equal(formatMinor(1250, 'USD'), '12.50 USD');
  assert.equal(formatMinor(5, 'USD'), '0.05 USD');
  assert.equal(formatMinor(1234567, 'BHD'), '1,234.567 BHD');
  assert.equal(formatMinor(-1250, 'USD'), '-12.50 USD');
  assert.equal(formatMinor(0, 'KRW'), '0 KRW');
  for (const currency of CURRENCIES) {
    for (const amount of [0, 1, 9, 10, 99, 100, 101, 999, 1000, 1001, 123456, 1234567, 99999999, MAX_MINOR_AMOUNT, -1, -100000]) {
      assert.equal(formatMinor(amount, currency), serverMoney.formatMinorAmount(amount, currency), `${amount} ${currency}`);
    }
  }
});

test('formatMinor — 값이 없으면 —, 비율에서 나온 소수(CPC)는 반올림한다', () => {
  assert.equal(formatMinor(null, 'KRW'), '—');
  assert.equal(formatMinor(undefined, 'KRW'), '—');
  assert.equal(formatMinor(Number.NaN, 'KRW'), '—');
  assert.equal(formatMinor(123.6, 'KRW'), '124 KRW');
  assert.equal(formatMinor(1234.4, 'USD'), '12.34 USD');
});

test('parseMajorToMinor — major 단위 글자를 정수 최소 단위로', () => {
  const ok = (input, currency, minor, opts) => {
    const r = parseMajorToMinor(input, currency, opts);
    assert.equal(r.ok, true, `${input} ${currency} 를 받아야 한다: ${r.ok ? '' : r.error}`);
    assert.equal(r.minor, minor, `${input} ${currency}`);
  };
  ok('12.50', 'USD', 1250);
  ok('12.5', 'USD', 1250);
  ok('12', 'USD', 1200);
  ok('0.05', 'USD', 5);
  ok('12500', 'KRW', 12500);
  ok('12,500', 'KRW', 12500);
  ok('1,234,567.89', 'USD', 123456789);
  ok('1.234', 'BHD', 1234);
  ok('007', 'KRW', 7);
  ok('  42  ', 'KRW', 42);
  ok('0', 'KRW', 0, { allowZero: true });
});

test('parseMajorToMinor — 부동소수를 거치지 않는다(0.29 * 100 = 28.999… 이 28 이 되지 않는다)', () => {
  assert.equal(0.29 * 100 === 29, false, '전제: 부동소수 곱은 29 가 아니다');
  const r = parseMajorToMinor('0.29', 'USD');
  assert.equal(r.ok && r.minor, 29);
  const s = parseMajorToMinor('1.005', 'BHD');
  assert.equal(s.ok && s.minor, 1005);
});

test('parseMajorToMinor — 통화가 허용하는 것보다 소수 자리가 많으면 반올림하지 않고 거부한다', () => {
  const krw = parseMajorToMinor('100.5', 'KRW');
  assert.equal(krw.ok, false);
  assert.match(krw.error, /KRW 는 소수점 아래 금액이 없습니다/);
  const usd = parseMajorToMinor('12.345', 'USD');
  assert.equal(usd.ok, false);
  assert.match(usd.error, /2자리까지/);
  const bhd = parseMajorToMinor('1.2345', 'BHD');
  assert.equal(bhd.ok, false);
  assert.match(bhd.error, /3자리까지/);
});

test('parseMajorToMinor — 형식이 틀린 금액은 거부한다', () => {
  for (const bad of ['', '   ', '-5', '-0.5', '1e3', '12.', '.5', '+5', '12,50', '1,2345', '12 500', 'abc', '0x10', '١٢']) {
    const r = parseMajorToMinor(bad, 'USD');
    assert.equal(r.ok, false, `"${bad}" 를 받으면 안 된다`);
    assert.ok(r.error.length > 0, `"${bad}" 의 거부 사유가 비었다`);
  }
  const zero = parseMajorToMinor('0', 'KRW');
  assert.equal(zero.ok, false, '0 은 allowZero 일 때만 받는다');
  assert.match(zero.error, /0보다 큰/);
});

test('parseMajorToMinor — 서버 상한(MAX_MINOR_AMOUNT)을 넘으면 거부한다', () => {
  assert.equal(MAX_MINOR_AMOUNT, serverMoney.MAX_MINOR_AMOUNT, '상한이 서버와 같다');
  const atMax = parseMajorToMinor('90000000000.00', 'USD');
  assert.equal(atMax.ok && atMax.minor, MAX_MINOR_AMOUNT);
  assert.equal(parseMajorToMinor('90000000000.01', 'USD').ok, false);
  assert.equal(parseMajorToMinor('9000000000001', 'KRW').ok, false);
  assert.equal(parseMajorToMinor('99999999999999999999', 'KRW').ok, false);
});

test('minorToMajorInput 로 채운 칸은 다시 읽으면 같은 금액이고, 서버 parseMinorAmount 가 받는 정수다', () => {
  for (const currency of CURRENCIES) {
    for (const minor of [1, 7, 10, 99, 100, 101, 1234, 50000, 123456789, MAX_MINOR_AMOUNT]) {
      const text = minorToMajorInput(minor, currency);
      const back = parseMajorToMinor(text, currency);
      assert.equal(back.ok && back.minor, minor, `${minor} ${currency} → "${text}"`);
      assert.equal(serverMoney.parseMinorAmount(back.minor, 'amount_minor'), minor);
    }
  }
  assert.equal(minorToMajorInput(1250, 'USD'), '12.50');
  assert.equal(minorToMajorInput(1250000, 'KRW'), '1250000', '입력칸에는 구분 쉼표를 넣지 않는다');
  assert.equal(minorToMajorInput(null, 'KRW'), '');
});

test('통화 코드 · 해시 표기', () => {
  assert.equal(isCurrencyCode('KRW'), true);
  assert.equal(isCurrencyCode(' usd '), true);
  assert.equal(isCurrencyCode('KR'), false);
  assert.equal(isCurrencyCode('KRW1'), false);
  assert.equal(shortHash('0123456789abcdef0123'), '0123456789ab');
  assert.equal(shortHash(null), '');
});

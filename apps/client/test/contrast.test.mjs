// 디자인 토큰 명도 대비 순수 테스트 — F2-5 (ticket 10987a81) 접근성 심화 (e).
//
// jsdom/axe 의 color-contrast 룰은 실제 레이어링/알파 합성을 못 봐 신뢰 불가하므로,
// 토큰 팔레트의 전경/배경 조합 WCAG 2.1 대비를 정적 수식으로 계산해 고정한다. 회귀로
// 누군가 텍스트/서피스 색을 어둡게 바꾸면(대비 붕괴) 이 테스트가 즉시 잡는다.
// react/DOM 불필요 — 순수 함수만 검증(board memory: client 로직 DI-extract node:test).
//
// 실행:  node --import tsx --test apps/client/test/contrast.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHex,
  relativeLuminance,
  contrastRatio,
  meetsAA,
  AA_NORMAL,
  AA_LARGE,
} from '../src/utils/contrast.ts';
import { tokens } from '../src/tokens.ts';

const c = tokens.colors;

// ─── 순수 수식 정확성 ────────────────────────────────────────────────────────
test('relativeLuminance: 검정=0, 흰색=1 (경계값)', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
});

test('contrastRatio: 흑백 최대 대비 21:1, 순서 무관(대칭)', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.equal(contrastRatio('#f1f5f9', '#0f172a'), contrastRatio('#0f172a', '#f1f5f9'));
  assert.equal(contrastRatio('#abcdef', '#abcdef'), 1); // 동일색 = 1:1
});

test('parseHex: 3자리 shorthand 확장 + 불투명 hex 만 허용(rgba 거부)', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#000'), [0, 0, 0]);
  assert.deepEqual(parseHex('#6366f1'), [99, 102, 241]);
  assert.throws(() => parseHex('rgba(0,0,0,0.6)'), /불투명/);
  assert.throws(() => parseHex('#12'), /hex/);
});

test('meetsAA: 임계 상수(4.5 일반 / 3.0 큰텍스트·UI)', () => {
  assert.equal(AA_NORMAL, 4.5);
  assert.equal(AA_LARGE, 3);
  assert.equal(meetsAA('#ffffff', '#000000'), true);
  assert.equal(meetsAA('#777777', '#808080'), false); // 저대비 → 실패
  assert.equal(meetsAA('#767676', '#ffffff'), true); // 정확히 4.5 부근 경계 통과
});

// ─── 본문 텍스트: 모든 서피스 위에서 AA 일반(4.5:1) ──────────────────────────
test('본문 텍스트(primary/strong/secondary/disabled)는 서피스 위 AA 일반 통과', () => {
  const surfaces = [c.surface, c.surfaceCard, c.surfaceHover];
  for (const bg of surfaces) {
    for (const fg of [c.textPrimary, c.textStrong, c.textSecondary, c.textDisabled]) {
      assert.ok(meetsAA(fg, bg), `${fg} on ${bg} = ${contrastRatio(fg, bg).toFixed(2)} (<4.5)`);
    }
  }
});

// ─── 상태 강조색(light 변형)은 기본 서피스 위 AA 일반 ────────────────────────
test('상태 강조 텍스트색(success/danger/warning/info)은 surface 위 AA 일반', () => {
  for (const fg of [c.successLight, c.dangerMid, c.warningLight, c.info, c.success, c.warning]) {
    assert.ok(meetsAA(fg, c.surface), `${fg} on surface = ${contrastRatio(fg, c.surface).toFixed(2)}`);
  }
});

// ─── 채워진 배지/버튼 위 흰색 텍스트는 AA 일반 ───────────────────────────────
test('채워진 상태 배경 위 흰색 텍스트(textInverse)는 AA 일반', () => {
  for (const bg of [c.successBg, c.dangerBg, c.warningBg, c.badgeAgentBg, c.badgeUserBg]) {
    assert.ok(meetsAA(c.textInverse, bg), `inverse on ${bg} = ${contrastRatio(c.textInverse, bg).toFixed(2)}`);
  }
  // 시스템 배지 텍스트도 자기 배경 위 AA 일반.
  assert.ok(meetsAA(c.badgeSystemText, c.badgeSystemBg));
  assert.ok(meetsAA(c.badgeSystemText, c.badgeSystemSurface));
});

// ─── UI 컴포넌트/큰 텍스트(3:1): 포커스 링·accent 버튼 ───────────────────────
test('포커스 링은 어두운 서피스 위 UI 대비(3:1) 이상', () => {
  // :focus-visible 아웃라인 가시성 — WCAG 1.4.11 비텍스트 대비(3:1).
  assert.ok(meetsAA(c.focusRing, c.surface, true), `focusRing/surface=${contrastRatio(c.focusRing, c.surface).toFixed(2)}`);
  assert.ok(meetsAA(c.focusRing, c.surfaceCard, true), `focusRing/surfaceCard=${contrastRatio(c.focusRing, c.surfaceCard).toFixed(2)}`);
});

test('accent 채움 버튼 위 흰색 라벨은 큰텍스트/UI 대비(3:1) 이상', () => {
  // accent 버튼은 굵은/큰 라벨을 쓰므로 큰텍스트 기준(3:1). 일반 4.5 는 만족 못 함을 명시.
  const ratio = contrastRatio(c.textInverse, c.accent);
  assert.ok(ratio >= AA_LARGE, `inverse/accent=${ratio.toFixed(2)} (<3)`);
});

// ─── textMuted 는 캡션/보조 전용 — 큰텍스트 기준만 만족(일반 4.5 미달을 계약으로 고정) ─
test('textMuted 는 큰텍스트/보조(3:1) 전용 — 본문 크기 일반(4.5)에는 쓰지 말 것', () => {
  assert.ok(meetsAA(c.textMuted, c.surface, true), 'textMuted 는 surface 위 최소 UI/큰텍스트 대비는 넘는다');
  // 일반 본문 임계(4.5)에는 미달 — 이 조합을 본문에 쓰면 접근성 위반임을 회귀로 못박는다.
  assert.equal(meetsAA(c.textMuted, c.surfaceCard), false, 'textMuted/surfaceCard 는 일반 본문 대비 미달(캡션 전용)');
});

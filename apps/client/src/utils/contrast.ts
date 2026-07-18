// WCAG 2.1 명도 대비 순수 계산 (에픽 bf65ca00 · F2-5 접근성 심화).
//
// jsdom+axe 의 color-contrast 룰은 실제 렌더 레이어링/알파 합성을 못 봐 신뢰할 수 없다
// (레포에도 axe 미도입). 그래서 토큰 팔레트의 전경/배경 조합 대비를 정적 수식으로
// 계산해 node:test 로 고정한다 — DOM 불필요, 결정적. 반투명(rgba) 오버레이는 합성
// 결과가 맥락마다 달라 대상에서 제외하고, 불투명 hex 조합만 다룬다.

/** '#rrggbb' | '#rgb' → [r,g,b] (0–255). 3자리 shorthand 도 허용. */
export function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().replace(/^#/, '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`대비 계산: 불투명 6자리 hex 만 지원합니다 — 받은 값: "${hex}"`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** sRGB 채널(0–255) → 선형화 값. WCAG 상대 휘도 정의 그대로. */
function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 상대 휘도 L (0=검정 … 1=흰색). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** 두 색의 대비비(1:1 … 21:1). 순서 무관 — 밝은 쪽을 분자로 둔다. */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA 임계: 일반 텍스트 4.5:1, 큰 텍스트(≥18.66px bold/≥24px)·UI 컴포넌트 3:1. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

/** fg/bg 대비가 AA(기본 일반 텍스트 4.5:1)를 만족하는가. large=true 면 3:1. */
export function meetsAA(fg: string, bg: string, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? AA_LARGE : AA_NORMAL);
}

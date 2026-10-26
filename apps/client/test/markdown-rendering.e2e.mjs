import { test, expect } from '@playwright/test';

const formula = String.raw`\[
\text{아래로 당기는 힘}
=\sum_{\text{모든 원자}}
\frac{G\times\text{내 질량}\times\text{원자 질량}}
{(\text{나와 그 원자의 거리})^2}
\times\text{아래 방향 성분의 비율}
\]`;

for (const surface of ['session', 'chat', 'ticket', 'artifact']) {
for (const width of [360, 768, 1280]) {
  test(`${surface} formulas and tables render and scroll within the answer at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/test/fixtures/markdown-rendering.html?surface=${surface}`);
    await page.waitForFunction(() => typeof window.renderTranscript === 'function');
    const source = '# 중력 계산\n\n' + formula + '\n\n문장 안의 \\(r^2\\) 수식.\n\n| 항목 | 설명 |\n| --- | --- |\n| 질량 | ' + '긴표내용'.repeat(50) + ' |\n\n```sh\necho gravity\n```';
    await page.evaluate(text => window.renderTranscript(text), source);
    await expect(page.locator('.katex')).toHaveCount(2);
    await expect(page.locator('h1')).toHaveText('중력 계산');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator('.katex').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('KaTeX');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const math = page.locator('.katex-display');
    expect(await math.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    if (width === 360) {
      expect(await math.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await math.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await math.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
    await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
    await page.evaluate(() => window.renderTranscript('\\[\\frac{1}{'));
    await expect(page.locator('.math-pending')).toHaveText('\\[\\frac{1}{');
    await page.evaluate(() => window.renderTranscript('\\[\\frac{1}{2}\\]'));
    await expect(page.locator('.katex-display')).toHaveCount(1);
    await expect(page.locator('.math-pending')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

}

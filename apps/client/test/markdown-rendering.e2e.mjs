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

for (const width of [360, 768, 1280]) {
  test(`streamed responses stay attached across a user prompt at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/test/fixtures/markdown-rendering.html?surface=session');
    await page.waitForFunction(() => typeof window.renderSessionEvents === 'function');
    for (const [kind, head, tail] of [
      ['table', '| 방식 | 영향 |\n| --- | --- |\n| ACM | 인증서 관리 |\n| Cloudflare | 요청 연결 |\n| Workers | 단순 전달이면 부담이 ', '작을 수 있습니다. |\n\n뒤 문장도 유지합니다.'],
      ['plain', '단순 전달이면 부담이 ', '작을 수 있습니다.'],
      ['code', '```js\nconst value = ', '42;\n```'],
      ['math', '\\[\\frac{1}{', '2}\\]'],
    ]) {
      const first = { id: `${kind}:1`, seq: 1, turn_id: 'running', type: 'text', payload: { text: head }, created_at: '2026-10-26T12:53:00Z' };
      const prompt = { id: 'local:steering', seq: 2, turn_id: 'steering', type: 'user_prompt', payload: { text: '도메인 처리만 workers 로 만들 수도 있어?' }, created_at: '2026-10-26T12:53:01Z' };
      const last = { id: `${kind}:3`, seq: 3, turn_id: 'running', type: 'text', payload: { text: tail }, created_at: '2026-10-26T12:53:02Z' };
      await page.evaluate(events => window.renderSessionEvents(events), [first]);
      const assistant = page.locator('[data-block="assistant"]');
      await expect(assistant).toHaveCount(1);
      const original = await assistant.elementHandle();
      await page.evaluate(events => window.renderSessionEvents(events), [first, prompt]);
      await expect(page.locator('[data-block="prompt"]')).toHaveText(prompt.payload.text);
      await page.evaluate(events => window.renderSessionEvents(events), [first, prompt, last]);
      await expect(assistant).toHaveCount(1);
      expect(await original.evaluate(el => el.isConnected)).toBe(true);
      await original.dispose();
      if (kind === 'table') {
        await expect(assistant.locator('tbody tr')).toHaveCount(3);
        await expect(assistant.locator('tbody tr').last().locator('td').last()).toHaveText('단순 전달이면 부담이 작을 수 있습니다.');
        await expect(assistant.locator('p').last()).toHaveText('뒤 문장도 유지합니다.');
      } else if (kind === 'plain') {
        await expect(assistant).toHaveText(head + tail);
      } else if (kind === 'code') {
        await expect(assistant.locator('pre code')).toHaveText('const value = 42;\n');
      } else {
        await expect(assistant.locator('.katex-display')).toHaveCount(1);
        await expect(assistant.locator('.math-pending')).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

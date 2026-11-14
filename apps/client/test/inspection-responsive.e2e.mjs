import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const locales = Object.fromEntries(['en', 'ko'].map(locale => [locale, JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))]));
const account = { id: 'inspection-account', name: 'Inspection account', owner_user_id: 'owner' };
const name = '모바일 서비스 인증과 결제 보안 점검 / Mobile authentication and payment inspection';
const longPath = `/srv/${'very-long-project-directory/'.repeat(8)}auth.ts`;
const now = new Date().toISOString();
const runtime = { manager_agent_id: 'host', cli: 'codex', working_dir: '/tmp/inspection', label: 'Inspection host / Long runtime name for mobile', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
const base = { id: 'entry', name, account_id: account.id, enabled: true, description: 'Check authentication and payment results.', tags: [], target_runtime: runtime, target_agent_id: 'runtime', on_failure_ticket: null, last_run_status: 'failed', last_run_at: now, run_count: 2, max_runs: 30 };
const scenario = { ...base, project_id: 'project', qa_driver: 'http-api', qa_driver_config: null, result_delivery: null, steps: [{ idx: 0, action: 'Open the authentication endpoint', expect: 'Authenticated response' }, { idx: 1, action: 'Verify the payment', expect: 'Payment result is visible' }] };
const profile = { ...base, category: 'external', target_kind: 'url', target_resource_id: null, scan_driver: 'tls-check', scan_driver_config: { target_url: 'https://mobile.example.test/authentication' }, scope_mode: 'incremental', checklist: [{ id: 'auth', title: 'Check authentication', severity_hint: 'high', guidance: 'Check credentials before access.' }] };
const schedule = { id: 'schedule', name: '매일 서비스 검사 / Daily mobile service inspection', account_id: account.id, enabled: true, scope: 'all', kind: 'scan', project_id: 'project', scenario_ids: ['entry'], profile_ids: ['entry'], cron: '0 3 * * *', interval_ms: null, next_run_at: now, last_run_at: now, target_agent_id: 'runtime', target_runtime: runtime, task_prompt: 'Inspect the service', stop_on_fail: false };
const run = { id: 'run', scenario_id: 'entry', profile_id: 'entry', account_id: account.id, status: 'failed', created_at: now, started_at: now, finished_at: now, scope_used: 'incremental', summary: 'Authentication needs review.', artifact_resource_ids: [], step_results: [{ idx: 0, status: 'failed', log: longPath }, { idx: 1, status: 'passed', log: 'Payment checked' }], findings: [{ id: 'finding', title: 'Authentication failed', severity: 'high', file: longPath, line: 42, evidence: 'Missing authentication guard', remediation: 'Check credentials before access.', checklist_item_id: 'auth' }] };

async function fixture(page, kind, locale) {
  const writes = []; const errors = [];
  const tr = key => locales[locale][key] ?? key;
  const catalog = kind === 'qa' ? '/qa/scenarios' : '/security/profiles';
  const schedules = kind === 'schedules' ? '/automation-schedules' : `/${kind}/schedules`;
  let currentSchedule = { ...schedule };
  let entry = { ...(kind === 'qa' ? scenario : profile) };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ account, locale }) => {
    localStorage.setItem('awb.locale', locale);
    localStorage.setItem('auth_token', 'inspection-test');
    localStorage.setItem('currentAccountId', account.id);
    window.EventSource = class extends EventTarget { readyState = 1; close() {} };
  }, { account, locale });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const method = request.method(); let body = [];
    const batch = { id: 'batch', account_id: account.id, status: 'done', total: 1, current_index: 1, scenario_ids: ['entry'], profile_ids: ['entry'], passed: 0, failed: 1, errored: 0, run_ids: ['run'] };
    if (['POST', 'PATCH', 'DELETE'].includes(method)) {
      const input = request.postData() ? request.postDataJSON() : null;
      writes.push({ path, method, input });
      if (path === `${schedules}/schedule` && method === 'PATCH') { currentSchedule = { ...currentSchedule, ...input }; body = currentSchedule; }
      else if (path === `${schedules}/schedule/run-now`) body = { schedule: currentSchedule, kind: 'scan', batch, dispatch: { room_id: 'room' } };
      else if (path === `${catalog}/entry` && method === 'PATCH') { entry = { ...entry, ...input }; body = entry; }
      else if (path.endsWith('/batches')) body = batch;
      else body = { ...entry, run_id: 'run', room_id: 'room' };
    } else if (path === '/auth/me') body = { id: 'owner', name: 'Owner', status: 'active', role: 'admin', resolved_permissions: ['actions.manage'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path === '/projects') body = [{ id: 'project', name: 'Mobile service project', account_id: account.id, host_folders: [] }];
    else if (path === catalog) body = [entry, { ...entry, id: 'disabled', name: 'Disabled inspection', enabled: false }];
    else if (path.endsWith('/runs')) body = [run, { ...run, id: 'older-run', status: 'passed', summary: 'Earlier inspection passed.', findings: [], step_results: [] }];
    else if (path === schedules) body = [currentSchedule];
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/cli-catalog') body = { clis: [] };
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`/${kind}`);
  await expect(page.getByRole('row').filter({ hasText: kind === 'schedules' ? schedule.name : name })).toBeVisible();
  return { writes, errors, tr, catalog, schedules };
}

async function expectFits(page) {
  const overflows = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.awb-content, .awb-inspection, .awb-inspection-run-detail, .awb-inspection-dialog')]
    .filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 1)
    .map(el => ({ element: el.className || el.tagName, width: el.clientWidth, scroll: el.scrollWidth })));
  expect(overflows).toEqual([]);
}

async function expectControlsFit(root) {
  const clipped = await root.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll('button, input, select, textarea')].filter(control => {
      const r = control.getBoundingClientRect();
      return r.width && (r.x < bounds.x - 1 || r.right > bounds.right + 1);
    }).map(control => control.textContent || control.getAttribute('aria-label') || control.tagName);
  });
  expect(clipped).toEqual([]);
}

async function editSchedule(page, f) {
  const row = page.getByRole('row').filter({ hasText: schedule.name });
  await expectControlsFit(row);
  await row.getByRole('checkbox').click();
  await expect.poll(() => f.writes.find(w => w.path === `${f.schedules}/schedule`)?.input.enabled).toBe(false);
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await row.getByRole('button', { name: f.tr('▶ Run now'), exact: true }).click();
  await expect.poll(() => f.writes.some(w => w.path === `${f.schedules}/schedule/run-now`)).toBe(true);
  await row.getByRole('button', { name: f.tr('Edit'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(f.tr('주기 (interval)'), { exact: true }).check();
  await dialog.getByRole('spinbutton').fill('2');
  await expectControlsFit(dialog);
  await expectFits(page);
  await dialog.getByRole('button', { name: f.tr('Save'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => f.writes.some(w => w.path === `${f.schedules}/schedule` && w.input.interval_ms === 7_200_000)).toBe(true);
  await row.getByRole('button', { name: f.tr('Delete'), exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(schedule.name);
  await page.getByRole('dialog').getByRole('button', { name: f.tr('Cancel'), exact: true }).click();
  expect(f.writes.filter(w => w.method === 'DELETE')).toEqual([]);
}

const sizes = [
  { width: 320, height: 568, locale: 'ko' },
  { width: 390, height: 844, locale: 'en' },
  { width: 667, height: 375, locale: 'ko' },
  { width: 768, height: 1024, locale: 'en' },
  { width: 1024, height: 768, locale: 'ko' },
  { width: 1440, height: 900, locale: 'en' },
];

for (const kind of ['security', 'qa']) {
  for (const size of sizes) {
    test(`${kind} populated list, editor, runs and schedules at ${size.width}x${size.height} (${size.locale})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const f = await fixture(page, kind, size.locale);
      const row = page.getByRole('row').filter({ hasText: name });
      await expectFits(page);
      const compact = (await page.locator('.awb-inspection').boundingBox()).width <= 960;
      if (compact) {
        await expectControlsFit(row);
        const table = page.getByRole('table').first();
        expect(await table.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        for (const button of await row.getByRole('button').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
      }
      if (size.width >= 768) await expect(page.locator('.awb-sidebar')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${kind}-list.png`) });

      // Selection does not navigate; the compact menu runs exactly that selection.
      await row.getByRole('checkbox').check();
      const toolbar = page.locator('.awb-inspection-toolbar');
      const menu = toolbar.getByRole('button', { name: f.tr('More actions'), exact: true });
      if (await menu.isVisible()) await menu.click();
      const selectedRun = toolbar.getByRole('button', { name: `${f.tr('▶ 선택 순차 실행')} (1)`, exact: true });
      await selectedRun.click();
      await expect.poll(() => f.writes.find(w => w.path === `/${kind}/batches`)?.input[kind === 'qa' ? 'scenario_ids' : 'profile_ids']).toEqual(['entry']);
      await expectFits(page);

      await row.getByRole('button', { name: f.tr('Edit'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expectControlsFit(dialog);
      await expectFits(page);
      await dialog.getByRole('textbox').nth(1).fill('Edited on a mobile screen');
      await dialog.getByRole('button', { name: f.tr('Save'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => f.writes.find(w => w.path === `${f.catalog}/entry`)?.input.description).toBe('Edited on a mobile screen');

      await row.getByRole('button', { name: f.tr('▶ Run'), exact: true }).click();
      await expect.poll(() => f.writes.some(w => w.path === `${f.catalog}/entry/run`)).toBe(true);
      await expect(page.getByText('Authentication needs review.', { exact: true })).toBeVisible();
      const history = page.locator('.awb-inspection-history');
      await history.getByRole('button').nth(1).click();
      await expect(page.getByText('Earlier inspection passed.', { exact: true })).toBeVisible();
      await history.getByRole('button').first().click();
      await expect(page.getByText('Authentication needs review.', { exact: true })).toBeVisible();
      await expectFits(page);
      await expectControlsFit(page.locator('.awb-inspection-detail-heading'));
      const detailBounds = await page.locator('.awb-inspection-run-detail').boundingBox();
      const areaBounds = await page.locator('.awb-inspection-runs').boundingBox();
      if (areaBounds.width <= 700) expect(detailBounds.width).toBeGreaterThanOrEqual(areaBounds.width - 1);
      await page.locator('.awb-inspection-run-detail').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${kind}-result.png`) });
      await page.getByRole('button', { name: f.tr('← Back'), exact: true }).click();
      await editSchedule(page, f);
      await expectFits(page);
      expect(f.errors).toEqual([]);
    });
  }
}

for (const size of [sizes[0], sizes[2], sizes[3], sizes[5]]) {
  test(`general schedules can be toggled, run and edited at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const f = await fixture(page, 'schedules', size.locale);
    await expectFits(page);
    await page.screenshot({ path: testInfo.outputPath('schedules.png') });
    await editSchedule(page, f);
    expect(f.errors).toEqual([]);
  });
}

test('security editor preserves a draft on rotation and exposes create and checklist actions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const f = await fixture(page, 'security', 'en');
  await page.getByRole('button', { name: f.tr('+ 새 프로파일'), exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('New inspection draft');
  for (const size of [{ width: 667, height: 375 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size);
    await expect(dialog.getByRole('textbox').first()).toHaveValue('New inspection draft');
    await expectControlsFit(dialog);
    await expectFits(page);
    await dialog.getByRole('button', { name: f.tr('Save'), exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: f.tr('Save'), exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath('security-editor.png') });
  await dialog.getByRole('button', { name: f.tr('Cancel'), exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: f.tr('↻ Checklist'), exact: true }).click();
  await expect.poll(() => f.writes.some(w => w.path === `${f.catalog}/entry/refresh-checklist`)).toBe(true);
  await row.getByRole('button', { name: f.tr('Delete'), exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(name);
  await dialog.getByRole('button', { name: f.tr('Cancel'), exact: true }).click();
  expect(f.writes.filter(w => w.method === 'DELETE' || w.path === f.catalog)).toEqual([]);
  expect(f.errors).toEqual([]);
});

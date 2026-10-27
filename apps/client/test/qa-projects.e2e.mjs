import { test, expect } from '@playwright/test';

const account = { id: 'qa-account', name: 'QA account', owner_user_id: 'owner' };
const projects = [{ id: 'project-a', name: 'Project A', account_id: account.id, host_folders: [] }, { id: 'project-b', name: 'Project B', account_id: account.id, host_folders: [] }];
const runtime = { manager_agent_id: 'host', cli: 'codex', working_dir: '/tmp/qa', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
const rows = ['a', 'b', 'disabled'].map((id, i) => ({ id, name: `Scenario ${id}`, account_id: account.id, project_id: i === 1 ? 'project-b' : 'project-a',
  enabled: i !== 2, description: '', steps: [], tags: [], qa_driver: 'http-api', target_runtime: runtime, target_agent_id: 'runtime',
  on_failure_ticket: null, result_delivery: null, last_run_status: null, run_count: 0 }));

async function fixture(page) {
  const writes = []; const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(account => {
    localStorage.setItem('awb.locale', 'en'); localStorage.setItem('auth_token', 'qa-test'); localStorage.setItem('currentAccountId', account.id);
    window.EventSource = class extends EventTarget { readyState = 1; close() {} };
  }, account);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    const method = route.request().method(); let body = [];
    if (method === 'POST' || method === 'PATCH') {
      const input = route.request().postDataJSON(); writes.push({ path, input });
      body = path === '/qa/batches' ? { id: 'batch', total: input.scenario_ids.length, scenario_ids: input.scenario_ids, status: 'done', run_ids: [] }
        : { ...rows.find(r => path.endsWith(`/${r.id}`)), ...input };
    } else if (path === '/auth/me') body = { id: 'owner', name: 'Owner', status: 'active', role: 'admin', resolved_permissions: ['actions.manage'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path === '/projects') body = projects;
    else if (path === '/qa/scenarios') body = rows;
    else if (path === '/channels') body = [{ id: 'channel', name: 'QA reports', account_id: account.id, is_active: 1, type: 'discord' }];
    else if (path === '/business/mail/connections') body = { connectors: [], credentials: [], connections: [{ id: 'mail', name: 'QA mail', account_id: account.id, enabled: true, provider: 'jmap', config: { addresses: ['qa@example.test'] } }] };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/cli-catalog') body = { clis: [] };
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/qa');
  await expect(page.getByText('Scenario a', { exact: true })).toBeVisible();
  return { writes, errors };
}

for (const width of [390, 1024]) {
  test(`project filter runs only visible enabled scenarios at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes, errors } = await fixture(page);
    await page.getByLabel('Project', { exact: true }).selectOption('project-a');
    await expect(page.getByText('Scenario b', { exact: true })).toHaveCount(0);
    const run = page.getByRole('button', { name: '▶ Run filtered scenarios (1)', exact: true });
    await expect(run).toBeInViewport(); await run.click();
    await expect.poll(() => writes.find(w => w.path === '/qa/batches')?.input.scenario_ids).toEqual(['a']);
    expect(errors).toEqual([]);
  });
}

test('scenario editor saves project, sharing and email without enabling automatic tickets', async ({ page }) => {
  const { writes, errors } = await fixture(page);
  await page.getByRole('row').filter({ hasText: 'Scenario a' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project', { exact: true }).selectOption('project-b');
  await dialog.getByLabel('Share results to channels').check();
  await dialog.getByLabel('QA reports', { exact: true }).check();
  await dialog.getByLabel('Email results').check();
  await dialog.getByLabel('Outgoing mail connection', { exact: true }).selectOption('mail');
  await dialog.getByLabel('Recipient', { exact: true }).fill('owner@example.test');
  await dialog.getByLabel('When to send results', { exact: true }).selectOption('always');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.find(w => w.path === '/qa/scenarios/a')?.input.project_id).toBe('project-b');
  const saved = writes.find(w => w.path === '/qa/scenarios/a').input;
  expect(saved.on_failure_ticket.enabled).toBe(false);
  expect(saved.result_delivery).toEqual({ when: 'always', channel_ids: ['channel'], email: { connection_id: 'mail', from: 'qa@example.test', to: ['owner@example.test'] } });
  expect(errors).toEqual([]);
});

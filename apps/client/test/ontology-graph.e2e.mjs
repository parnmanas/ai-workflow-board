import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { bootApp, closeTestApp } from '../../server/test/helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_FOLDER = 'apps/client/test/fixtures/ontology-smoke-source';

let app;
let vite;
let baseUrl;
let account;
let project;
let token;
const dbPaths = [
  path.join(REPO_ROOT, '.ontology-smoke-primary.db'),
  path.join(REPO_ROOT, '.ontology-smoke-graph.db'),
];
const gitCachePath = path.join(REPO_ROOT, '.ontology-smoke-git-cache');

test.beforeAll(async () => {
  for (const dbPath of dbPaths) fs.rmSync(dbPath, { force: true });
  fs.rmSync(gitCachePath, { recursive: true, force: true });
  [process.env.SQLJS_DB_PATH, process.env.SQLJS_ONTOLOGY_DB_PATH] = dbPaths;
  process.env.AWB_GIT_CACHE_DIR = gitCachePath;
  const boot = await bootApp({ port: 0, logger: false });
  app = boot.app;
  const apiUrl = `http://127.0.0.1:${boot.port}`;
  // Keep the real API, including SSE, isolated from any running AWB server.
  vite = await createServer({
    root: path.resolve(__dirname, '..'),
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { target: apiUrl }, '/mcp': { target: apiUrl } },
    },
  });
  await vite.listen();
  baseUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;

  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const { AuthService } = await import('../../server/dist/services/auth.service.js');
  const dataSource = app.get(getDataSourceToken());
  const user = await dataSource.getRepository('User').save({
    name: 'Ontology smoke user',
    email: 'ontology-smoke@example.test',
    role: 'admin',
    status: 'active',
  });
  account = await dataSource.getRepository('Account').save({
    name: 'Ontology smoke account',
    description: 'Bounded browser smoke fixture',
    kind: 'personal',
    owner_user_id: user.id,
  });
  project = await dataSource.getRepository('Project').save({
    account_id: account.id,
    name: 'AWB ontology smoke fixture',
    description: 'Two-file repository fixture',
    repo_url: 'https://github.com/parnmanas/ai-workflow-board.git',
    default_branch: process.env.GITHUB_HEAD_REF
      || process.env.GITHUB_REF_NAME
      || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  });
  token = app.get(AuthService).createSession(user.id);
});

test.afterAll(async () => {
  await vite?.close();
  await closeTestApp(app);
  for (const dbPath of dbPaths) fs.rmSync(dbPath, { force: true });
  fs.rmSync(gitCachePath, { recursive: true, force: true });
});

test('실제 SQL.js 빌드부터 Sigma 상호작용과 새로고침까지 동작한다', async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(({ authToken, accountId }) => {
    localStorage.setItem('auth_token', authToken);
    localStorage.setItem('currentAccountId', accountId);
  }, { authToken: token, accountId: account.id });

  const statuses = [];
  let snapshotLoads = 0;
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/ontology/status' && response.ok()) {
      statuses.push((await response.json()).status);
    }
    if (url.pathname === '/api/ontology/graph' && response.ok()) snapshotLoads += 1;
  });

  await page.goto(`${baseUrl}/ontology-graph`);
  await page.getByPlaceholder('repo root').fill(FIXTURE_FOLDER);
  await page.locator('select').filter({ has: page.locator(`option[value="${project.id}"]`) }).selectOption(project.id);

  await expect(page.getByText(/nodes · .*edges/)).toBeVisible({ timeout: 30_000 });
  expect(statuses).toContain('building');
  expect(statuses.at(-1)).toBe('ready');

  const graph = page.getByLabel('Ontology graph canvas');
  await expect(graph).toBeVisible();
  await expect.poll(() => graph.locator('canvas').count()).toBeGreaterThan(0);

  await graph.focus();
  await page.keyboard.press('Enter');
  await expect(graph.locator('xpath=..').locator('aside')).toContainText(/연결 \d+개/);
  await expect.poll(() => graph.locator('canvas').count()).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const beforeZoom = await graph.screenshot();
  await graph.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(250);
  const afterZoom = await graph.screenshot();
  expect(Buffer.compare(beforeZoom, afterZoom)).not.toBe(0);

  const box = await graph.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 45, { steps: 8 });
  await page.mouse.up();
  const afterPan = await graph.screenshot();
  expect(Buffer.compare(afterZoom, afterPan)).not.toBe(0);

  const loadsBeforeRefresh = snapshotLoads;
  statuses.length = 0;
  await page.getByRole('button', { name: 'Refresh Graph' }).click();
  await expect.poll(() => statuses.includes('building'), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => statuses.at(-1), { timeout: 30_000 }).toBe('ready');
  await expect.poll(() => snapshotLoads, { timeout: 10_000 }).toBeGreaterThan(loadsBeforeRefresh);
  await expect.poll(() => graph.locator('canvas').count()).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  expect(statuses).not.toContain('error');
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

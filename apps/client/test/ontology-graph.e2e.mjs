import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bootApp, closeTestApp } from '../../server/test/helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const API_PORT = 7701;
const FIXTURE_FOLDER = 'apps/client/test/fixtures/ontology-smoke-source';

let app;
let workspace;
let resource;
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
  ({ app } = await bootApp({ port: API_PORT, logger: false }));

  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const { AuthService } = await import('../../server/dist/services/auth.service.js');
  const dataSource = app.get(getDataSourceToken());
  const user = await dataSource.getRepository('User').save({
    name: 'Ontology smoke user',
    email: 'ontology-smoke@example.test',
    role: 'admin',
    status: 'active',
  });
  workspace = await dataSource.getRepository('Workspace').save({
    name: 'Ontology smoke workspace',
    description: 'Bounded browser smoke fixture',
  });
  await dataSource.getRepository('RelationTuple').save({
    subject_type: 'user', subject_id: user.id, relation: 'admin',
    object_type: 'workspace', object_id: workspace.id,
  });
  resource = await dataSource.getRepository('Resource').save({
    workspace_id: workspace.id,
    name: 'AWB ontology smoke fixture',
    description: 'Two-file repository fixture',
    type: 'repository',
    url: 'https://github.com/parnmanas/ai-workflow-board.git',
    default_branch: process.env.GITHUB_HEAD_REF
      || process.env.GITHUB_REF_NAME
      || execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  });
  token = app.get(AuthService).createSession(user.id);
});

test.afterAll(async () => {
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

  await page.addInitScript(({ authToken, workspaceId }) => {
    localStorage.setItem('auth_token', authToken);
    localStorage.setItem('currentWorkspaceId', workspaceId);
    localStorage.setItem('awb.viewMode', 'advanced');
  }, { authToken: token, workspaceId: workspace.id });

  const statuses = [];
  let snapshotLoads = 0;
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/ontology/status' && response.ok()) {
      statuses.push((await response.json()).status);
    }
    if (url.pathname === '/api/ontology/graph' && response.ok()) snapshotLoads += 1;
  });

  await page.goto(`/ws/${workspace.id}/ontology-graph`);
  await page.getByLabel('Folder (optional)').fill(FIXTURE_FOLDER);
  await page.getByLabel('Repository').selectOption(resource.id);

  await expect(page.getByText(/nodes · .*edges/)).toBeVisible({ timeout: 30_000 });
  expect(statuses).toContain('building');
  expect(statuses.at(-1)).toBe('ready');

  const graph = page.getByLabel('Ontology graph canvas');
  await expect(graph).toBeVisible();
  await expect.poll(() => graph.locator('canvas').count()).toBeGreaterThan(0);

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

  let selected = false;
  for (let x = 0.2; x <= 0.8 && !selected; x += 0.1) {
    for (let y = 0.2; y <= 0.8 && !selected; y += 0.1) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      selected = await page.getByText(/연결 \d+개/).isVisible().catch(() => false);
    }
  }
  expect(selected).toBe(true);

  const loadsBeforeRefresh = snapshotLoads;
  statuses.length = 0;
  await page.getByRole('button', { name: 'Refresh Graph' }).click();
  await expect.poll(() => statuses.includes('building'), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => statuses.at(-1), { timeout: 30_000 }).toBe('ready');
  await expect.poll(() => snapshotLoads, { timeout: 10_000 }).toBeGreaterThan(loadsBeforeRefresh);
  await expect.poll(() => graph.locator('canvas').count()).toBeGreaterThan(0);

  expect(statuses).not.toContain('error');
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

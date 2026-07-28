import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  catalogScopeOf,
  normalizeCatalogScope,
  canUseCatalogItem,
  assertCatalogBoardScope,
} from '../dist/common/catalog-scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

test('catalog scope normalizes to the canonical nullable pair', () => {
  assert.deepEqual(normalizeCatalogScope({ scope: 'global', workspace_id: 'ignored', board_id: 'ignored' }), {
    workspace_id: null,
    board_id: null,
  });
  assert.deepEqual(normalizeCatalogScope({ scope: 'workspace', workspace_id: 'ws', board_id: 'ignored' }), {
    workspace_id: 'ws',
    board_id: null,
  });
  assert.deepEqual(normalizeCatalogScope({ scope: 'board', workspace_id: 'ws', board_id: 'board' }), {
    workspace_id: 'ws',
    board_id: 'board',
  });
});

test('scope labels and visibility use Global → Workspace → Board boundaries', () => {
  assert.equal(catalogScopeOf({ workspace_id: null, board_id: null }), 'global');
  assert.equal(catalogScopeOf({ workspace_id: 'ws', board_id: null }), 'workspace');
  assert.equal(catalogScopeOf({ workspace_id: 'ws', board_id: 'board' }), 'board');
  assert.equal(canUseCatalogItem({ workspace_id: null, board_id: null }, 'ws', 'board'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: null }, 'ws', 'board'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: 'board' }, 'ws', 'board'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: 'other' }, 'ws', 'board'), false);
  assert.equal(canUseCatalogItem({ workspace_id: 'other', board_id: null }, 'ws', 'board'), false);
});

test('board scope fails closed when the board/workspace pair is invalid', async () => {
  await assert.rejects(
    assertCatalogBoardScope(async () => false, { workspace_id: 'ws', board_id: 'board' }),
    /does not belong/,
  );
  await assert.doesNotReject(
    assertCatalogBoardScope(async () => true, { workspace_id: 'ws', board_id: 'board' }),
  );
});

test('client exposes one catalog route and redirects legacy management routes', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'components', 'Sidebar.tsx'), 'utf8');
  const boardSubMenu = fs.readFileSync(path.join(ROOT, 'components', 'BoardSubMenu.tsx'), 'utf8');
  assert.match(app, /path="catalog" element={<WorkspaceCatalogPage/);
  assert.match(app, /CatalogRedirect tab="functions"/);
  assert.match(app, /CatalogRedirect tab="resources"/);
  assert.match(sidebar, /label: 'Automation Catalog'/);
  assert.doesNotMatch(sidebar, /label: 'Global Functions'/);
  assert.doesNotMatch(sidebar, /label: 'Global Credentials'/);
  assert.match(boardSubMenu, /label: 'Automation Catalog'/);
  assert.doesNotMatch(boardSubMenu, /label: '(QA|Security|Resources)'/);
});

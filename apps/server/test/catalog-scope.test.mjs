import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  catalogScopeOf,
  normalizeCatalogScope,
  canUseCatalogItem,
} from '../dist/common/catalog-scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');

test('catalog scope normalizes to the canonical Global/Workspace nullable pair', () => {
  assert.deepEqual(normalizeCatalogScope({ scope: 'global', workspace_id: 'ignored', board_id: null }), {
    workspace_id: null,
    board_id: null,
  });
  assert.deepEqual(normalizeCatalogScope({ scope: 'workspace', workspace_id: 'ws', board_id: null }), {
    workspace_id: 'ws',
    board_id: null,
  });
  assert.throws(
    () => normalizeCatalogScope({ scope: 'board', workspace_id: 'ws', board_id: 'board' }),
    /no longer supported/,
  );
});

test('scope labels and visibility use Global and Workspace boundaries only', () => {
  assert.equal(catalogScopeOf({ workspace_id: null, board_id: null }), 'global');
  assert.equal(catalogScopeOf({ workspace_id: 'ws', board_id: null }), 'workspace');
  assert.equal(canUseCatalogItem({ workspace_id: null, board_id: null }, 'ws', 'board'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: null }, 'ws', 'board'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: 'board' }, 'ws', 'board'), false);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws', board_id: 'other' }, 'ws', 'board'), false);
  assert.equal(canUseCatalogItem({ workspace_id: 'other', board_id: null }, 'ws', 'board'), false);
});

test('client exposes individual management menus with Global/current-Workspace pages only', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'components', 'Sidebar.tsx'), 'utf8');
  const boardSubMenu = fs.readFileSync(path.join(ROOT, 'components', 'BoardSubMenu.tsx'), 'utf8');
  const management = fs.readFileSync(path.join(ROOT, 'components', 'WorkspaceManagementPage.tsx'), 'utf8');
  assert.doesNotMatch(app, /WorkspaceCatalogPage|function CatalogRedirect/);
  assert.match(app, /path="catalog" element={<LegacyCatalogRedirect/);
  for (const kind of ['functions', 'resources', 'prompt-templates', 'actions', 'qa', 'security', 'schedules']) {
    assert.match(app, new RegExp(`path="${kind}" element={<WorkspaceManagementPage kind="${kind}"`));
  }
  assert.match(app, /path="settings\/credentials" element={<WorkspaceManagementPage kind="credentials"/);
  assert.match(app, /path="settings\/claude-profiles" element={<WorkspaceManagementPage kind="claude-backend-profiles"/);
  for (const label of ['Functions', 'Credentials', 'Resources', 'Prompt Templates', 'Actions', 'QA', 'Security', 'Schedules', 'Claude Profiles']) {
    assert.match(sidebar, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(sidebar, /label: 'Automation Catalog'/);
  assert.doesNotMatch(sidebar, /label: 'Global Functions'/);
  assert.doesNotMatch(sidebar, /label: 'Global Credentials'/);
  assert.doesNotMatch(boardSubMenu, /label: 'Automation Catalog'/);
  assert.match(management, /Workspace for new item/);
  assert.match(management, /<option value="global">Not set \(Global\)<\/option>/);
  assert.match(management, /<option value="workspace">/);
  assert.doesNotMatch(management, /boardScoped|boardId/);
  for (const kind of ['functions', 'credentials', 'resources', 'prompt-templates', 'actions', 'qa', 'security', 'schedules']) {
    assert.doesNotMatch(app, new RegExp(`boards/:boardId/${kind}`));
  }
});

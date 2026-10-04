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

test('catalog scope normalizes to the canonical Global/Workspace nullable workspace_id', () => {
  assert.deepEqual(normalizeCatalogScope({ scope: 'global', workspace_id: 'ignored' }), {
    workspace_id: null,
  });
  assert.deepEqual(normalizeCatalogScope({ scope: 'workspace', workspace_id: 'ws' }), {
    workspace_id: 'ws',
  });
  // Scope inferred from the presence of workspace_id when `scope` is omitted.
  assert.deepEqual(normalizeCatalogScope({ workspace_id: 'ws' }), { workspace_id: 'ws' });
  assert.deepEqual(normalizeCatalogScope({}), { workspace_id: null });
  // The Board layer is gone together with boards — 'board' is just an
  // unknown scope now.
  assert.throws(
    () => normalizeCatalogScope({ scope: 'board', workspace_id: 'ws' }),
    /scope must be 'global' or 'workspace'/,
  );
  assert.throws(
    () => normalizeCatalogScope({ scope: 'workspace', workspace_id: '  ' }),
    /workspace_id is required/,
  );
});

test('scope labels and visibility use Global and Workspace boundaries only', () => {
  assert.equal(catalogScopeOf({ workspace_id: null }), 'global');
  assert.equal(catalogScopeOf({ workspace_id: 'ws' }), 'workspace');
  assert.equal(canUseCatalogItem({ workspace_id: null }, 'ws'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'ws' }, 'ws'), true);
  assert.equal(canUseCatalogItem({ workspace_id: 'other' }, 'ws'), false);
});

test('client exposes individual management menus with Global/current-Workspace pages only', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'components', 'Sidebar.tsx'), 'utf8');
  const management = fs.readFileSync(path.join(ROOT, 'components', 'WorkspaceManagementPage.tsx'), 'utf8');
  assert.doesNotMatch(app, /WorkspaceCatalogPage|function CatalogRedirect/);
  assert.match(app, /path="catalog" element={<LegacyCatalogRedirect/);
  for (const kind of ['functions', 'resources', 'actions', 'qa', 'security', 'schedules']) {
    assert.match(app, new RegExp(`path="${kind}" element={<WorkspaceManagementPage kind="${kind}"`));
  }
  assert.match(app, /path="settings\/credentials" element={<WorkspaceManagementPage kind="credentials"/);
  assert.match(app, /path="settings\/claude-profiles" element={<WorkspaceManagementPage kind="claude-backend-profiles"/);
  for (const label of ['Functions', 'Credentials', 'Resources', 'Actions', 'QA', 'Security', 'Schedules', 'Claude Profiles']) {
    assert.match(sidebar, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(sidebar, /label: 'Automation Catalog'/);
  assert.doesNotMatch(sidebar, /label: 'Global Functions'/);
  assert.doesNotMatch(sidebar, /label: 'Global Credentials'/);
  assert.match(management, /Workspace for new item/);
  assert.match(management, /<option value="global">Not set \(Global\)<\/option>/);
  assert.match(management, /<option value="workspace">/);
  assert.doesNotMatch(management, /boardScoped|boardId/);
  // Boards are gone, so no catalog page may hang off a board route.
  assert.doesNotMatch(app, /boards\/:boardId/);
});

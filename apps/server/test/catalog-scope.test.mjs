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

test('catalog scope normalizes to the canonical Global/Account nullable account_id', () => {
  assert.deepEqual(normalizeCatalogScope({ scope: 'global', account_id: 'ignored' }), {
    account_id: null,
  });
  assert.deepEqual(normalizeCatalogScope({ scope: 'account', account_id: 'ws' }), {
    account_id: 'ws',
  });
  // Scope inferred from the presence of account_id when `scope` is omitted.
  assert.deepEqual(normalizeCatalogScope({ account_id: 'ws' }), { account_id: 'ws' });
  assert.deepEqual(normalizeCatalogScope({}), { account_id: null });
  // The Board layer is gone together with boards — 'board' is just an
  // unknown scope now.
  assert.throws(
    () => normalizeCatalogScope({ scope: 'board', account_id: 'ws' }),
    /scope must be 'global' or 'account'/,
  );
  assert.throws(
    () => normalizeCatalogScope({ scope: 'account', account_id: '  ' }),
    /account_id is required/,
  );
});

test('scope labels and visibility use Global and Account boundaries only', () => {
  assert.equal(catalogScopeOf({ account_id: null }), 'global');
  assert.equal(catalogScopeOf({ account_id: 'ws' }), 'account');
  assert.equal(canUseCatalogItem({ account_id: null }, 'ws'), true);
  assert.equal(canUseCatalogItem({ account_id: 'ws' }, 'ws'), true);
  assert.equal(canUseCatalogItem({ account_id: 'other' }, 'ws'), false);
});

test('client exposes direct management routes with Global/current-Account catalog ownership', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(ROOT, 'components', 'Sidebar.tsx'), 'utf8');
  const management = fs.readFileSync(path.join(ROOT, 'components', 'AccountManagementPage.tsx'), 'utf8');
  assert.doesNotMatch(app, /WorkspaceCatalogPage|function CatalogRedirect/);
  assert.match(app, /path="catalog" element={<GlobalRedirect to="functions"/);
  for (const kind of ['functions', 'resources', 'actions', 'qa', 'security', 'schedules']) {
    assert.match(app, new RegExp(`path="${kind}" element={<AccountManagementPage kind="${kind}"`));
  }
  assert.match(app, /path="settings\/credentials" element={<AccountManagementPage kind="credentials"/);
  assert.match(app, /path="settings\/claude-profiles" element={<AccountManagementPage kind="claude-backend-profiles"/);
  for (const label of ['Functions', 'Credentials', 'Resources', 'Actions', 'QA', 'Security', 'Schedules', 'Claude Profiles']) {
    assert.match(sidebar, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(sidebar, /label: 'Automation Catalog'/);
  assert.doesNotMatch(sidebar, /label: 'Global Functions'/);
  assert.doesNotMatch(sidebar, /label: 'Global Credentials'/);
  assert.match(management, /Account for new item/);
  assert.match(management, /<option value="global">Not set \(Global\)<\/option>/);
  assert.match(management, /<option value="account">/);
  assert.doesNotMatch(management, /boardScoped|boardId/);
  // Boards are gone, so no catalog page may hang off a board route.
  assert.doesNotMatch(app, /boards\/:boardId/);
});

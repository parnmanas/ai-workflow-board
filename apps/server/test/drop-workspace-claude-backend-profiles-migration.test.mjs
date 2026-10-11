// The orphaned workspace_claude_backend_profiles table (entity removed in
// 8a382b20; synchronize never drops entity-less tables) is dropped by migration
// 1760000000093, and the migration is safe on a database that never had it.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import { DropWorkspaceClaudeBackendProfiles1760000000093 } from '../dist/database/migrations/1760000000093-DropWorkspaceClaudeBackendProfiles.js';

async function tableExists(source) {
  const rows = await source.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_claude_backend_profiles'");
  return rows.length > 0;
}

test('drops the leftover table and is a no-op when it is already gone', async () => {
  const source = await new DataSource({ type: 'sqljs', entities: [], synchronize: false, logging: false }).initialize();
  try {
    await source.query('CREATE TABLE workspace_claude_backend_profiles (id varchar PRIMARY KEY, account_id varchar, profile_id varchar)');
    await source.query("INSERT INTO workspace_claude_backend_profiles VALUES ('a', 'acc', 'p')");
    assert.equal(await tableExists(source), true);

    const runner = source.createQueryRunner();
    try {
      await new DropWorkspaceClaudeBackendProfiles1760000000093().up(runner);
      assert.equal(await tableExists(source), false);
      await new DropWorkspaceClaudeBackendProfiles1760000000093().up(runner);
      assert.equal(await tableExists(source), false);
    } finally {
      await runner.release();
    }
  } finally {
    await source.destroy();
  }
});

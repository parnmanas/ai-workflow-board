import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import 'reflect-metadata';

import { RunSkillSnapshotService } from '../dist/modules/skills/run-skill-snapshot.service.js';

function snapshotRepository() {
  const rows = [];
  return {
    rows,
    async findOne({ where }) {
      return rows.find((row) =>
        row.workspace_id === where.workspace_id && row.run_id === where.run_id,
      ) || null;
    },
    create(value) {
      return { id: `snapshot-${rows.length + 1}`, ...value };
    },
    async save(value) {
      rows.push(value);
      return value;
    },
    async update(where, patch) {
      for (const row of rows) {
        if (
          row.workspace_id === where.workspace_id
          && row.run_id === where.run_id
          && row.status === where.status
        ) {
          Object.assign(row, patch);
        }
      }
    },
  };
}

test('run skill snapshot is deterministic, scoped and immutable after first resolution', async () => {
  const snapshots = snapshotRepository();
  const assignments = {
    async find() {
      return [
        { skill_version_id: 'v-global', board_id: '', role_slug: '' },
        { skill_version_id: 'v-review', board_id: 'board-1', role_slug: 'reviewer' },
        { skill_version_id: 'v-other', board_id: 'board-2', role_slug: '' },
      ];
    },
  };
  const versionsState = [
    {
      id: 'v-review',
      skill_id: 's-review',
      version: 4,
      digest: 'digest-review',
      body: '# Review',
      support_files: [],
    },
    {
      id: 'v-global',
      skill_id: 's-global',
      version: 2,
      digest: 'digest-global',
      body: '# Global',
      support_files: [],
    },
  ];
  const versions = { async find() { return [...versionsState]; } };
  const skills = {
    async find() {
      return [
        { id: 's-review', slug: 'review', status: 'active' },
        { id: 's-global', slug: 'base', status: 'active' },
      ];
    },
  };
  const service = new RunSkillSnapshotService(
    snapshots,
    assignments,
    versions,
    skills,
  );

  const first = await service.resolve({
    workspaceId: 'ws-1',
    runId: 'ticket:t-1:reviewer',
    agentId: 'agent-1',
    boardId: 'board-1',
    roleSlug: 'reviewer',
  });
  assert.deepEqual(first.manifest.map((entry) => entry.slug), ['base', 'review']);
  assert.equal(
    first.digest,
    createHash('sha256').update(JSON.stringify(first.manifest)).digest('hex'),
  );

  versionsState.push({
    id: 'v-later',
    skill_id: 's-global',
    version: 3,
    digest: 'later',
    body: '# Later',
    support_files: [],
  });
  const second = await service.resolve({
    workspaceId: 'ws-1',
    runId: 'ticket:t-1:reviewer',
    agentId: 'agent-1',
    boardId: 'board-1',
    roleSlug: 'reviewer',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.digest, first.digest);

  await service.lock('ws-1', first.run_id);
  assert.equal(first.status, 'locked');
  assert.ok(first.locked_at instanceof Date);
});

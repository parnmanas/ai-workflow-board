import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SkillMaterializationError,
  SkillMaterializer,
} from '../dist/lib/skills/skill-materializer.js';

function entry(slug = 'review') {
  const body = '# Review\nCheck carefully.\n';
  const support_files = [{ path: 'references/checklist.md', content: '1. Test\n' }];
  const digest = createHash('sha256')
    .update(JSON.stringify({ body, support_files }))
    .digest('hex');
  return { slug, version: 1, digest, body, support_files };
}

test('materializer writes a private deterministic run snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = [entry()];
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const dir = await new SkillMaterializer(root).materialize('run-1', { digest, manifest });
  assert.equal(
    await readFile(join(dir, 'review', 'SKILL.md'), 'utf8'),
    manifest[0].body,
  );
  assert.equal(
    await readFile(join(dir, 'review', 'references', 'checklist.md'), 'utf8'),
    '1. Test\n',
  );
});

test('materializer fails closed on snapshot, file, and path digest drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const materializer = new SkillMaterializer(root);
  await assert.rejects(
    materializer.materialize('run-1', { digest: 'bad', manifest: [entry()] }),
    (error) => error instanceof SkillMaterializationError
      && error.code === 'skill_digest_mismatch',
  );
  const malicious = entry();
  malicious.support_files[0].path = '../escape';
  const digest = createHash('sha256').update(JSON.stringify([malicious])).digest('hex');
  await assert.rejects(
    materializer.materialize('run-2', { digest, manifest: [malicious] }),
    (error) => error instanceof SkillMaterializationError,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SkillValidationError,
  canonicalizeSkillContent,
} from '../dist/modules/skills/skill-validation.js';

test('skill digest is canonical across file order and line endings', () => {
  const first = canonicalizeSkillContent('Use this.\r\n', [
    { path: 'references/b.md', content: 'B\r\n' },
    { path: 'references/a.md', content: 'A\n' },
  ]);
  const second = canonicalizeSkillContent('Use this.\n', [
    { path: 'references/a.md', content: 'A\n' },
    { path: 'references/b.md', content: 'B\n' },
  ]);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.supportFiles.map((file) => file.path), [
    'references/a.md',
    'references/b.md',
  ]);
});

test('skill validation rejects traversal, symlinks, oversized and secret-bearing content', () => {
  for (const files of [
    [{ path: '../escape', content: 'x' }],
    [{ path: 'safe', content: 'x', type: 'symlink' }],
    [{ path: 'large', content: 'x'.repeat(65 * 1024) }],
  ]) {
    assert.throws(
      () => canonicalizeSkillContent('body', files),
      (error) => error instanceof SkillValidationError,
    );
  }
  assert.throws(
    () => canonicalizeSkillContent(
      'password = "this-is-a-real-looking-secret-value"',
      [],
    ),
    (error) => error instanceof SkillValidationError
      && error.code === 'skill_secret_detected',
  );
});

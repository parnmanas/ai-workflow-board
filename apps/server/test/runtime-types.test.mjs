import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_CLI_TYPES,
  CLI_TYPES,
} from '../dist/common/types/cli-types.js';

test('server accepts Hermes as an explicit managed runtime', () => {
  assert.deepEqual(
    CLI_TYPES,
    ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'hermes', 'custom'],
  );
  assert.equal(ALLOWED_CLI_TYPES.has('hermes'), true);
});

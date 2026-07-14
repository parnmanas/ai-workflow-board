import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSecret } from '../dist/common/mask.js';

test('credential mask preserves only identifying prefix and suffix', () => {
  assert.equal(maskSecret('ghp_1234567890abcdef'), 'ghp_••••cdef');
  assert.equal(maskSecret('short'), '••••••••');
  assert.equal(maskSecret(''), '');
});

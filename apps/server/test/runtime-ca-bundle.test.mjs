import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('production image installs a CA bundle for Git HTTPS remotes', () => {
  const dockerfile = readFileSync(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8');
  assert.match(dockerfile, /apt-get install[^\n]*ca-certificates/);
  assert.match(dockerfile, /update-ca-certificates/);
});

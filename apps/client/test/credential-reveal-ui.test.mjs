import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../src/components/admin/CredentialManager.tsx', import.meta.url),
  'utf8',
);
const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

test('Reveal is rendered only for admin users and requires explicit confirmation', () => {
  assert.match(source, /user\?\.role === 'admin'/);
  assert.match(source, /Confirm and Reveal/);
  assert.match(source, /type="password"/);
  assert.match(source, /api\.revealCredential\(revealTarget\.id, revealPassword\)/);
});

test('revealed secret auto-clears after 30 seconds and modal close/unmount clear state', () => {
  assert.match(source, /CREDENTIAL_REVEAL_TTL_MS = 30_000/);
  assert.match(source, /setTimeout\(clearRevealedSecret, CREDENTIAL_REVEAL_TTL_MS\)/);
  assert.match(source, /useEffect\(\(\) => \(\) => clearRevealedSecret\(\)/);
  assert.match(source, /const closeReveal = \(\) => \{\s*clearRevealedSecret\(\)/);
  assert.match(source, /setRevealedFields\(\{\}\)/);
  assert.match(source, /setRevealPassword\(''\)/);
});

test('clipboard copy has feedback and secrets are not persisted or placed in URLs', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(source, /Copied to clipboard/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.setItem\([^)]*(?:revealedFields|value)/);
  assert.match(apiSource, /method: 'POST',\s*cache: 'no-store'/);
  assert.match(apiSource, /body: JSON\.stringify\(\{ password \}\)/);
  assert.doesNotMatch(apiSource, /reveal\?.*password/);
});

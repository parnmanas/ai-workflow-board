import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { OpencodeCliAdapter } from '../dist/lib/cli-adapters/opencode.js';

const authText = JSON.stringify({ 'opencode-go': { type: 'api', key: 'test-operator-key' } });
const apiCredential = { provider: 'opencode_api_key', fields: { api_key: 'test-bound-key' } };

async function fixture(t) {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'awb-opencode-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operatorHome = join(root, 'operator');
  const homeMock = t.mock.method(os, 'homedir', () => operatorHome);
  syncBuiltinESMExports();
  t.after(() => { homeMock.mock.restore(); syncBuiltinESMExports(); });
  const operatorData = join(operatorHome, '.local', 'share', 'opencode');
  const operatorAuth = join(operatorData, 'auth.json');
  await fs.mkdir(operatorData, { recursive: true });
  await fs.writeFile(operatorAuth, authText, { mode: 0o600 });
  const cliHome = join(root, 'session');
  const sessionData = join(cliHome, '.local', 'share', 'opencode');
  const sessionAuth = join(sessionData, 'auth.json');
  return { root, operatorData, operatorAuth, cliHome, sessionData, sessionAuth };
}

async function assertPreserved(path, before) {
  const after = await fs.lstat(path);
  assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
  assert.equal(after.ino, before.ino, 'the original directory entry must not be replaced');
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
  assert.equal(await fs.readFile(path, 'utf8'), authText);
}

for (const credential of [null, apiCredential]) {
  test(`shared session data preserves operator auth (${credential?.provider ?? 'operator-login'})`, async (t) => {
    const f = await fixture(t);
    // AgentSessionRunner links the entire data directory before prepareCliHome.
    await fs.mkdir(join(f.cliHome, '.local', 'share'), { recursive: true });
    await fs.symlink(f.operatorData, f.sessionData, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await fs.lstat(f.operatorAuth);
    const adapter = new OpencodeCliAdapter();
    for (let i = 0; i < 3; i++) await adapter.prepareCliHome(f.cliHome, credential);
    await assertPreserved(f.operatorAuth, before);
    assert.equal(await fs.realpath(f.sessionAuth), await fs.realpath(f.operatorAuth));
    const config = JSON.parse(await fs.readFile(join(f.cliHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(JSON.stringify(config).includes('test-operator-key'), false);
  });
}

test('a correct file link remains intact across repeated and concurrent preparations', async (t) => {
  const f = await fixture(t);
  const adapter = new OpencodeCliAdapter();
  await adapter.prepareCliHome(f.cliHome, apiCredential);
  const original = await fs.lstat(f.operatorAuth);
  const inherited = await fs.lstat(f.sessionAuth);
  // Windows may copy the file when file symlinks require additional privileges.
  if (inherited.isSymbolicLink()) {
    await Promise.all(Array.from({ length: 4 }, () => adapter.prepareCliHome(f.cliHome, apiCredential)));
    assert.equal((await fs.lstat(f.sessionAuth)).ino, inherited.ino);
  }
  await assertPreserved(f.operatorAuth, original);
  assert.equal(await fs.readFile(f.sessionAuth, 'utf8'), authText);
});

test('a stale destination link is replaced without touching the operator store', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.sessionData, { recursive: true });
  await fs.symlink(f.sessionAuth, f.sessionAuth);
  const before = await fs.lstat(f.operatorAuth);
  await new OpencodeCliAdapter().prepareCliHome(f.cliHome, apiCredential);
  await assertPreserved(f.operatorAuth, before);
  assert.equal(await fs.realpath(f.sessionAuth), await fs.realpath(f.operatorAuth));
});

test('a symlink used as the operator credential is preserved through the shared directory', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const backingAuth = join(f.root, 'backing-auth.json');
  await fs.rename(f.operatorAuth, backingAuth);
  await fs.symlink(backingAuth, f.operatorAuth);
  await fs.mkdir(join(f.cliHome, '.local', 'share'), { recursive: true });
  await fs.symlink(f.operatorData, f.sessionData, 'dir');
  const before = await fs.lstat(f.operatorAuth);
  await new OpencodeCliAdapter().prepareCliHome(f.cliHome, apiCredential);
  await assertPreserved(f.operatorAuth, before);
  assert.equal(await fs.readlink(f.operatorAuth), backingAuth);
});

test('an unavailable operator store never deletes an existing session credential', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.operatorAuth);
  await fs.mkdir(f.sessionData, { recursive: true });
  await fs.writeFile(f.sessionAuth, authText, { mode: 0o600 });
  const before = await fs.lstat(f.sessionAuth);
  await new OpencodeCliAdapter().prepareCliHome(f.cliHome, apiCredential);
  await assertPreserved(f.sessionAuth, before);
});

// Exercise the repository's real npm wiring with small substitute phase manifests.
// Keeping scripts and runner unchanged makes reverting the lifecycle fix fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditRegistration } from './helpers/registration-audit.mjs';
import { listSuiteNames, readSuiteSteps } from './helpers/suite-manifest.mjs';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
const phases = ['pretest', 'test', 'posttest'];

function runFixture(t, failed) {
  const dir = fs.mkdtempSync(path.join(serverRoot, '.lifecycle-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'test/helpers'), { recursive: true });
  for (const file of ['run-suite.mjs', 'helpers/run-suite-argv.mjs', 'helpers/suite-manifest.mjs']) {
    fs.copyFileSync(path.join(serverRoot, 'test', file), path.join(dir, 'test', file));
  }
  fs.cpSync(path.join(serverRoot, 'test/suites'), path.join(dir, 'test/suites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    private: true,
    scripts: { ...pkg.scripts, build: 'node build.cjs' },
  }));
  fs.writeFileSync(path.join(dir, 'build.cjs'),
    `console.log('VISITED:build'); process.exit(${failed === 'build' ? 1 : 0});`);
  for (const phase of phases) {
    fs.writeFileSync(path.join(dir, 'test/suites', `${phase}.txt`), `test/${phase}.test.mjs\n`);
    fs.writeFileSync(path.join(dir, 'test', `${phase}.test.mjs`),
      `console.log('VISITED:${phase}'); process.exit(${failed === phase ? 1 : 0});`);
  }
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'test'] : ['test'];
  const env = { ...process.env, npm_config_ignore_scripts: 'false' };
  // This child starts its own node --test processes, not nested test runners.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd: dir, encoding: 'utf8', timeout: 30_000,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const failed of [null, ...phases]) {
  test(`npm test runs all phases in order when ${failed ?? 'nothing'} fails`, (t) => {
    const result = runFixture(t, failed);
    assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
    assert.deepEqual([...result.stdout.matchAll(/VISITED:(\w+)/g)].map((m) => m[1]), ['build', ...phases]);
    const summaries = result.stdout.match(/run-suite: \d+\/1 steps passed/g) ?? [];
    assert.equal(summaries.length, 3, result.stdout);
    assert.equal(summaries.filter((s) => s.includes('0/1')).length, failed ? 1 : 0);
    assert.ok(result.stdout.includes(`run-suite: ${failed ? 2 : 3}/3 steps passed`), result.stdout);
  });
}

test('npm test stops before every phase when the build fails', (t) => {
  const result = runFixture(t, 'build');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual([...result.stdout.matchAll(/VISITED:(\w+)/g)].map((m) => m[1]), ['build']);
  assert.ok(!result.stdout.includes('run-suite: '), result.stdout);
});

test('registration audit reaches every phase through the aggregate manifest', () => {
  const manifests = new Map(listSuiteNames().map((name) => [name, readSuiteSteps(name)]));
  const result = auditRegistration({
    scripts: pkg.scripts, manifests, ciEntryScripts: ['test'], diskTestPaths: [],
  });
  for (const phase of phases) {
    assert.ok(result.runnableSuites.has(phase), `unreachable phase: ${phase}`);
    for (const step of manifests.get(phase).filter((s) => s.startsWith('test/'))) {
      assert.ok(result.registered.has(step), `unregistered: ${step}`);
    }
  }
});

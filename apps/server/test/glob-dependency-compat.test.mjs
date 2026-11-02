import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve('fork-ts-checker-webpack-plugin'));

test('Nest webpack issue filters retain the callable minimatch API', () => {
  const match = pluginRequire('minimatch');
  assert.equal(pluginRequire('minimatch/package.json').name, '@awb/minimatch-compat');
  const adapterRequire = createRequire(pluginRequire.resolve('minimatch'));
  assert.equal(adapterRequire('minimatch/package.json').version, '11.0.4');
  assert.equal(typeof match, 'function');
  assert.equal(match('src/example.ts', '**/*.ts'), true);
  assert.equal(match('src/example.js', '**/*.ts'), false);
  assert.equal(match('src/.hidden.ts', '**/*.ts'), false);
  const { createIssuePredicateFromIssueMatch } = pluginRequire('./issue/issue-match');
  const matches = createIssuePredicateFromIssueMatch('/project', { file: 'src/**/*.ts' });
  assert.equal(matches({ file: '/project/src/example.ts' }), true);
  assert.equal(matches({ file: '/project/test/example.ts' }), false);
});

test('TypeORM glob supports class discovery with the patched version', async () => {
  const typeormRequire = createRequire(require.resolve('typeorm'));
  const { glob } = typeormRequire('glob');
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  assert.deepEqual(glob.sync('glob-dependency-compat.test.mjs', { cwd }), ['glob-dependency-compat.test.mjs']);
  assert.deepEqual(await glob('glob-dependency-compat.test.mjs', { cwd }), ['glob-dependency-compat.test.mjs']);
});

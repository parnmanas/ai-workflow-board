import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlowFile } from '../dist/modules/qa/qa-flow-runner.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

// Exercise the production spawn path with real children that flush both DBs.
// Keep temporary files beneath this checkout, including the runner's tmpdir.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(testDir, '.qa-isolation-'));
  const keys = ['SQLJS_DB_PATH', 'SQLJS_ONTOLOGY_DB_PATH', 'TMPDIR', 'TMP', 'TEMP', 'DB_TYPE', 'PORT', 'NODE_TEST_CONTEXT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = dir;
  // The runner normally lives in the server, outside node:test.
  delete process.env.NODE_TEST_CONTEXT;
  process.env.DB_TYPE = 'sqlite';
  process.env.PORT = '7701';
  const child = path.join(dir, 'probe.test.mjs');
  fs.writeFileSync(child, `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import initSqlJs from 'sql.js';
    test('flush isolated databases', async () => {
      const SQL = await initSqlJs();
      for (const key of ['SQLJS_DB_PATH', 'SQLJS_ONTOLOGY_DB_PATH']) {
        const db = new SQL.Database();
        db.run('CREATE TABLE child_only (id INTEGER)');
        fs.writeFileSync(process.env[key], db.export());
        db.close();
      }
      fs.writeFileSync(process.env.QA_TRACE_PATH, JSON.stringify([{
        t: 0, type: 'isolation', primary: process.env.SQLJS_DB_PATH,
        ontology: process.env.SQLJS_ONTOLOGY_DB_PATH, port: process.env.PORT,
        dbType: process.env.DB_TYPE,
      }]));
      assert.equal(process.env.PORT, '');
    });
  `);
  return { dir, child };
}

for (const mode of ['absolute', 'relative', 'unset']) {
  test(`flow children isolate both databases with ${mode} parent paths`, async t => {
    const { dir, child } = fixture(t);
    const primary = path.join(dir, 'live.db');
    const ontology = path.join(dir, 'live-ontology.db');
    fs.writeFileSync(primary, 'parent primary bytes');
    fs.writeFileSync(ontology, 'parent ontology bytes');
    if (mode === 'unset') {
      delete process.env.SQLJS_DB_PATH;
      delete process.env.SQLJS_ONTOLOGY_DB_PATH;
    } else {
      process.env.SQLJS_DB_PATH = mode === 'absolute' ? primary : path.relative(process.cwd(), primary);
      process.env.SQLJS_ONTOLOGY_DB_PATH = mode === 'absolute' ? ontology : path.relative(process.cwd(), ontology);
    }
    const parentPaths = [process.env.SQLJS_DB_PATH, process.env.SQLJS_ONTOLOGY_DB_PATH];
    const results = await Promise.all([runFlowFile(child), runFlowFile(child)]);
    const paths = [];
    for (const result of results) {
      assert.equal(result.status, 'PASS', JSON.stringify(result));
      const event = result.trace[0];
      assert.equal(event.dbType, 'sqlite');
      for (const dbPath of [event.primary, event.ontology]) {
        assert.ok(path.isAbsolute(dbPath));
        assert.notEqual(dbPath, primary);
        assert.notEqual(dbPath, ontology);
        assert.equal(fs.existsSync(path.dirname(dbPath)), false, 'run directory cleaned after close');
        paths.push(dbPath);
      }
    }
    assert.equal(new Set(paths).size, 4, 'overlapping runs never share files');
    assert.equal(fs.readFileSync(primary, 'utf8'), 'parent primary bytes');
    assert.equal(fs.readFileSync(ontology, 'utf8'), 'parent ontology bytes');
    assert.deepEqual([process.env.SQLJS_DB_PATH, process.env.SQLJS_ONTOLOGY_DB_PATH], parentPaths);
  });
}

test('failed child preserves failure and trace, then removes databases', async t => {
  const { dir, child } = fixture(t);
  fs.appendFileSync(child, "\ntest('intentional failure', () => { throw new Error('failure sentinel'); });\n");
  const result = await runFlowFile(child);
  assert.equal(result.status, 'FAIL');
  assert.match(result.error, /failure sentinel/);
  assert.equal(fs.existsSync(path.dirname(result.trace[0].primary)), false);
  assert.deepEqual(fs.readdirSync(dir), ['probe.test.mjs']);
});

test('spawn failure cleans its reserved directory', async t => {
  const { dir } = fixture(t);
  const result = await runFlowFile(path.join(dir, 'missing', 'test', 'flows', 'probe.test.mjs'));
  assert.equal(result.status, 'FAIL');
  assert.match(result.error, /spawn failed:/);
  assert.deepEqual(fs.readdirSync(dir), ['probe.test.mjs']);
});

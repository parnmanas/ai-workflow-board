import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  listHermesProfiles,
  parseHermesProfileList,
  resetHermesAcpCommandCache,
  resolveHermesAcpCommand,
} from '../dist/lib/runtime/hermes/hermes-command.js';

test('parseHermesProfileList: skips header/separator/default, keeps named profiles', () => {
  const output = [
    ' Profile          Model         Gateway    Alias   Distribution',
    ' ───────────────  ────────────  ─────────  ──────  ────────────',
    ' ◆default         gpt-5.6-sol   stopped    —       —',
    ' coder            gpt-5.6-sol   stopped    —       —',
    ' reviewer         claude-x      stopped    —       —',
    '',
  ].join('\n');
  assert.deepEqual(parseHermesProfileList(output), ['coder', 'reviewer']);
});

test('parseHermesProfileList: empty / whitespace-only output yields no profiles', () => {
  assert.deepEqual(parseHermesProfileList(''), []);
  assert.deepEqual(parseHermesProfileList('   \n   \n'), []);
});

test('parseHermesProfileList: only the default profile exists → empty list (AWB represents that as unset)', () => {
  const output = [
    ' Profile   Model         Gateway    Alias   Distribution',
    ' ───────   ────────────  ─────────  ──────  ────────────',
    ' ◆default  gpt-5.6-sol   stopped    —       —',
    '',
  ].join('\n');
  assert.deepEqual(parseHermesProfileList(output), []);
});

test('resolveHermesAcpCommand: explicit HERMES_ACP_COMMAND override wins without probing', async () => {
  const previous = process.env.HERMES_ACP_COMMAND;
  process.env.HERMES_ACP_COMMAND = '/custom/hermes-acp-wrapper';
  try {
    const resolved = await resolveHermesAcpCommand();
    assert.deepEqual(resolved, { command: '/custom/hermes-acp-wrapper', argsPrefix: [] });
  } finally {
    if (previous === undefined) delete process.env.HERMES_ACP_COMMAND;
    else process.env.HERMES_ACP_COMMAND = previous;
  }
});

async function withFakeBin(scripts, run) {
  const binDir = await mkdtemp(join(tmpdir(), 'awb-hermes-bin-'));
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(binDir, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }
  const previousPath = process.env.PATH;
  const previousOverride = process.env.HERMES_ACP_COMMAND;
  delete process.env.HERMES_ACP_COMMAND;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
  resetHermesAcpCommandCache();
  try {
    await run(binDir);
  } finally {
    process.env.PATH = previousPath;
    if (previousOverride === undefined) delete process.env.HERMES_ACP_COMMAND;
    else process.env.HERMES_ACP_COMMAND = previousOverride;
    resetHermesAcpCommandCache();
    await rm(binDir, { recursive: true, force: true });
  }
}

test('resolveHermesAcpCommand: prefers hermes-acp when it is on PATH (bug C, common case)', async () => {
  await withFakeBin({
    'hermes-acp': '#!/usr/bin/env node\nprocess.exit(0);\n',
  }, async () => {
    const resolved = await resolveHermesAcpCommand();
    assert.deepEqual(resolved, { command: 'hermes-acp', argsPrefix: [] });
  });
});

test('resolveHermesAcpCommand: falls back to `hermes acp` when hermes-acp is missing (bug C, this host\'s real shape)', async () => {
  await withFakeBin({
    hermes: '#!/usr/bin/env node\nprocess.exit(0);\n',
  }, async () => {
    const resolved = await resolveHermesAcpCommand();
    assert.deepEqual(resolved, { command: 'hermes', argsPrefix: ['acp'] });
  });
});

test('listHermesProfiles: degrades to [] when hermes is not on PATH at all (never throws)', async () => {
  await withFakeBin({}, async () => {
    const profiles = await listHermesProfiles();
    assert.deepEqual(profiles, []);
  });
});

test('listHermesProfiles: runs `hermes profile list` and parses its table output', async () => {
  await withFakeBin({
    hermes: [
      '#!/usr/bin/env node',
      "if (process.argv.slice(2).join(' ') === 'profile list') {",
      "  process.stdout.write(' Profile   Model   Gateway   Alias   Distribution\\n"
        + " ───────   ─────   ───────   ─────   ────────────\\n"
        + " ◆default  m       stopped   —       —\\n"
        + " coder     m       stopped   —       —\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);',
    ].join('\n'),
  }, async () => {
    const profiles = await listHermesProfiles();
    assert.deepEqual(profiles, ['coder']);
  });
});

test('listHermesProfiles: degrades to [] when `hermes profile list` exits non-zero', async () => {
  await withFakeBin({
    hermes: '#!/usr/bin/env node\nprocess.exit(1);\n',
  }, async () => {
    const profiles = await listHermesProfiles();
    assert.deepEqual(profiles, []);
  });
});

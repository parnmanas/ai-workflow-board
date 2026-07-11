// Unit tests for the pure parse + tree-walk logic in process-tree.ts
// (ticket 89716f04). The enumerate/reap edges shell out and aren't exercised
// here; these tests feed synthetic process tables so the descendant walk and
// benign-subtree pruning are deterministic.
//
// Run: npm run build && node --test test/process-tree.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseProcListUnix,
  parseProcListUnixWithGroup,
  parseProcListWin,
  isBenignCmd,
  collectNonBenignDescendants,
  collectNonBenignGroupMembers,
  BENIGN_CMD_PATTERNS,
} = await import('../dist/lib/process-tree.js');

const pids = (nodes) => nodes.map((n) => n.pid).sort((a, b) => a - b);

test('parseProcListUnix parses pid/ppid/args and skips non-matching lines', () => {
  const stdout = [
    '      1       0 /sbin/init splash',
    '  26923    1363 /usr/local/bin/node /path/main.js --flag',
    '  46479   26923 claude --model x --mcp-config /p/cfg.json',
    '  99999   46479 node /x/self.js mcp-host',
    'garbage header line with no leading pid',
    '', // blank line skipped
  ].join('\n');
  const nodes = parseProcListUnix(stdout);
  assert.equal(nodes.length, 4);
  assert.deepEqual(nodes[0], { pid: 1, ppid: 0, cmd: '/sbin/init splash' });
  // Full args preserved (spaces within the command line are not lost).
  assert.equal(nodes[1].cmd, '/usr/local/bin/node /path/main.js --flag');
  assert.equal(nodes[2].pid, 46479);
  assert.equal(nodes[2].ppid, 26923);
  assert.equal(nodes[3].cmd, 'node /x/self.js mcp-host');
});

test('parseProcListWin handles array, single-object, null CommandLine, and junk', () => {
  const arr = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 4, CommandLine: 'C:\\claude.exe --model x' },
    { ProcessId: 200, ParentProcessId: 100, CommandLine: null },
  ]);
  const parsed = parseProcListWin(arr);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].pid, 100);
  assert.equal(parsed[0].ppid, 4);
  assert.equal(parsed[1].cmd, ''); // null CommandLine → empty string

  // ConvertTo-Json emits a bare object (not an array) for a single row.
  const single = parseProcListWin(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: 'x' }));
  assert.equal(single.length, 1);
  assert.equal(single[0].pid, 7);

  assert.deepEqual(parseProcListWin('not json'), []);
  assert.deepEqual(parseProcListWin('null'), []);
  assert.deepEqual(parseProcListWin(''), []);
});

test('isBenignCmd matches the mcp-host stdio child only', () => {
  assert.equal(isBenignCmd('node /home/x/self.js mcp-host'), true);
  assert.equal(isBenignCmd('awb-agent-manager mcp-host'), true);
  assert.equal(isBenignCmd('bash -c "sleep 999"'), false);
  assert.equal(isBenignCmd('powershell -Command build.ps1'), false);
  assert.equal(isBenignCmd('/opt/unity/Editor/Unity -batchmode'), false);
  // Default denylist is exactly the mcp-host marker.
  assert.equal(BENIGN_CMD_PATTERNS.length, 1);
});

test('collectNonBenignDescendants returns live orphans and prunes the benign subtree', () => {
  const table = [
    { pid: 100, ppid: 1, cmd: 'claude --model x' }, // the CLI child (root)
    { pid: 200, ppid: 100, cmd: 'node /x/self.js mcp-host' }, // benign direct child
    { pid: 250, ppid: 200, cmd: 'screencapture -x /tmp/a.png' }, // benign subtree (child of mcp-host)
    { pid: 300, ppid: 100, cmd: 'bash -c "powershell build-monitor"' }, // orphan bg task
    { pid: 400, ppid: 300, cmd: 'powershell -File build.ps1' }, // orphan grandchild
    { pid: 500, ppid: 999, cmd: 'unrelated other-tree' }, // different tree
  ];
  const res = collectNonBenignDescendants(table, 100);
  // bash (300) + its child (400); NOT the mcp-host subtree (200/250), NOT the
  // root itself (100), NOT the unrelated tree (500).
  assert.deepEqual(pids(res), [300, 400]);
});

test('collectNonBenignDescendants prunes a non-benign child under a benign parent', () => {
  const table = [
    { pid: 10, ppid: 1, cmd: 'claude' },
    { pid: 20, ppid: 10, cmd: 'self mcp-host' }, // benign
    { pid: 30, ppid: 20, cmd: 'evil-thing --do-stuff' }, // child of benign → pruned with parent
  ];
  assert.deepEqual(collectNonBenignDescendants(table, 10), []);
});

test('collectNonBenignDescendants excludes the root and returns [] when root absent', () => {
  const table = [{ pid: 300, ppid: 100, cmd: 'bash' }];
  assert.deepEqual(collectNonBenignDescendants(table, 999), []); // root not in table
  // Root present but childless.
  assert.deepEqual(collectNonBenignDescendants([{ pid: 100, ppid: 1, cmd: 'x' }], 100), []);
});

test('collectNonBenignDescendants terminates on a ppid cycle (no infinite loop)', () => {
  const table = [
    { pid: 2, ppid: 1, cmd: 'a' },
    { pid: 3, ppid: 2, cmd: 'b' },
    { pid: 4, ppid: 3, cmd: 'c' },
    { pid: 3, ppid: 4, cmd: 'b-cycle' }, // 3 also claims parent 4 → cycle 3→4→3
  ];
  const res = collectNonBenignDescendants(table, 1);
  // Each pid visited once thanks to the `seen` guard.
  assert.deepEqual(pids(res), [2, 3, 4]);
});

test('collectNonBenignDescendants honours a custom benign denylist', () => {
  const table = [
    { pid: 10, ppid: 1, cmd: 'claude' },
    { pid: 20, ppid: 10, cmd: 'unity -batchmode -build' },
    { pid: 30, ppid: 10, cmd: 'bash -c sleep' },
  ];
  // Treat unity as benign for this call only.
  const res = collectNonBenignDescendants(table, 10, [/\bunity\b/i]);
  assert.deepEqual(pids(res), [30]); // unity pruned, bash kept
});

// -- POSIX process-group enumeration (ticket 55d3063f) ------------------------

test('parseProcListUnixWithGroup parses pid/ppid/pgid/args and skips junk', () => {
  const stdout = [
    '      1       0       1 /sbin/init splash',
    '  46479   26923   46479 codex --model x',
    '  99999       1   46479 node /x/self.js mcp-host', // reparented (ppid=1) but same pgid
    '  50000       1   46479 bash -c "build monitor loop"', // orphaned bg task, same pgid
    'garbage header',
    '',
  ].join('\n');
  const nodes = parseProcListUnixWithGroup(stdout);
  assert.equal(nodes.length, 4);
  assert.deepEqual(nodes[0], { pid: 1, ppid: 0, pgid: 1, cmd: '/sbin/init splash' });
  assert.equal(nodes[1].pgid, 46479);
  assert.equal(nodes[2].ppid, 1); // reparented
  assert.equal(nodes[2].pgid, 46479); // still in the leader's group
  assert.equal(nodes[3].cmd, 'bash -c "build monitor loop"'); // full args preserved
});

test('collectNonBenignGroupMembers finds reparented orphans by pgid (the ppid walk would miss)', () => {
  // The one-shot CLI (leader pid=46479, pgid=46479) has EXITED, so its children
  // reparented to init (ppid=1). A ppid walk from 46479 finds nothing; the group
  // scan still catches them because they kept the leader's pgid.
  const table = [
    { pid: 1, ppid: 0, pgid: 1, cmd: '/sbin/init' },
    { pid: 200, ppid: 1, pgid: 46479, cmd: 'node /x/self.js mcp-host' }, // benign, reparented
    { pid: 250, ppid: 200, pgid: 46479, cmd: 'screencapture -x /tmp/a.png' }, // benign subtree
    { pid: 300, ppid: 1, pgid: 46479, cmd: 'bash -c "build monitor"' }, // orphan bg task
    { pid: 400, ppid: 300, pgid: 46479, cmd: 'powershell -File build.ps1' }, // orphan grandchild
    { pid: 500, ppid: 1, pgid: 777, cmd: 'unrelated other-group' }, // different group
  ];
  const res = collectNonBenignGroupMembers(table, 46479);
  // bash (300) + its child (400); NOT the mcp-host subtree (200/250), NOT the
  // process in another group (500).
  assert.deepEqual(pids(res), [300, 400]);
});

test('collectNonBenignGroupMembers excludes the group leader itself (pid === pgid)', () => {
  const table = [
    { pid: 46479, ppid: 1, pgid: 46479, cmd: 'codex --model x' }, // the (maybe-zombie) leader
    { pid: 300, ppid: 46479, pgid: 46479, cmd: 'bash -c sleep' },
  ];
  assert.deepEqual(pids(collectNonBenignGroupMembers(table, 46479)), [300]);
});

test('collectNonBenignGroupMembers prunes a non-benign child under a benign parent', () => {
  const table = [
    { pid: 20, ppid: 1, pgid: 46479, cmd: 'self mcp-host' }, // benign
    { pid: 30, ppid: 20, pgid: 46479, cmd: 'evil-thing --do-stuff' }, // child of benign → pruned
  ];
  assert.deepEqual(collectNonBenignGroupMembers(table, 46479), []);
});

test('collectNonBenignGroupMembers returns [] when the group has no non-leader members', () => {
  assert.deepEqual(collectNonBenignGroupMembers([], 46479), []);
  // Only the leader present.
  assert.deepEqual(
    collectNonBenignGroupMembers([{ pid: 46479, ppid: 1, pgid: 46479, cmd: 'codex' }], 46479),
    [],
  );
  // Members exist but none share the target pgid.
  assert.deepEqual(
    collectNonBenignGroupMembers([{ pid: 300, ppid: 1, pgid: 999, cmd: 'bash' }], 46479),
    [],
  );
});

test('collectNonBenignGroupMembers honours a custom benign denylist', () => {
  const table = [
    { pid: 20, ppid: 1, pgid: 46479, cmd: 'unity -batchmode -build' },
    { pid: 30, ppid: 1, pgid: 46479, cmd: 'bash -c sleep' },
  ];
  const res = collectNonBenignGroupMembers(table, 46479, [/\bunity\b/i]);
  assert.deepEqual(pids(res), [30]); // unity pruned, bash kept
});

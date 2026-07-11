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
  isGroupLeaderReused,
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

test('parseProcListUnixWithGroup parses pid/ppid/pgid/stat/args and skips junk', () => {
  // Columns: `ps -o pid=,ppid=,pgid=,stat=,args=` — the stat token (Ss / Sl / Z)
  // sits between pgid and the free-form command line.
  const stdout = [
    '      1       0       1 Ss  /sbin/init splash',
    '  46479   26923   46479 Sl  codex --model x',
    '  99999       1   46479 S   node /x/self.js mcp-host', // reparented (ppid=1) but same pgid
    '  50000       1   46479 S   bash -c "build monitor loop"', // orphaned bg task, same pgid
    '  60000       1   46479 Z   [codex] <defunct>', // zombie member: stat parsed, args kept
    'garbage header',
    '',
  ].join('\n');
  const nodes = parseProcListUnixWithGroup(stdout);
  assert.equal(nodes.length, 5);
  assert.deepEqual(nodes[0], { pid: 1, ppid: 0, pgid: 1, state: 'Ss', cmd: '/sbin/init splash' });
  assert.equal(nodes[1].pgid, 46479);
  assert.equal(nodes[1].state, 'Sl'); // stat token captured, not folded into args
  assert.equal(nodes[2].ppid, 1); // reparented
  assert.equal(nodes[2].pgid, 46479); // still in the leader's group
  assert.equal(nodes[3].cmd, 'bash -c "build monitor loop"'); // full args preserved
  assert.equal(nodes[4].state, 'Z'); // zombie state
  assert.equal(nodes[4].cmd, '[codex] <defunct>'); // defunct args preserved
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

test('collectNonBenignGroupMembers excludes the group leader itself (zombie leader = still ours)', () => {
  const table = [
    // Leader present but a zombie ('Z') — parent hasn't reaped it yet, so the
    // group is still ours: the pid-reuse guard proceeds, and the leader row is
    // dropped from the member set by the pid !== pgid filter.
    { pid: 46479, ppid: 1, pgid: 46479, state: 'Z', cmd: '[codex] <defunct>' },
    { pid: 300, ppid: 46479, pgid: 46479, state: 'S', cmd: 'bash -c sleep' },
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
  // Only the (zombie, still-ours) leader present → no members to reap.
  assert.deepEqual(
    collectNonBenignGroupMembers([{ pid: 46479, ppid: 1, pgid: 46479, state: 'Z', cmd: '[codex] <defunct>' }], 46479),
    [],
  );
  // Members exist but none share the target pgid.
  assert.deepEqual(
    collectNonBenignGroupMembers([{ pid: 300, ppid: 1, pgid: 999, state: 'S', cmd: 'bash' }], 46479),
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

// -- pid-reuse guard for the one-shot group sweep (ticket 7b5f2572) -----------
//
// The one-shot exit handler awaits network I/O before the `ps` scan, so the OS
// can reuse the dead leader's pid for a new detached group leader in between.
// Without the guard, that stranger's group members (same reused pgid) would be
// mis-reaped and its run falsely finalized as error. A LIVE non-zombie leader
// row (pid == pgid) is the reuse signal → abort. Absent/zombie leader → ours.

test('collectNonBenignGroupMembers aborts when the leader pid was reused by a live group', () => {
  // The dead one-shot leader's pid (46479) was reused by an UNRELATED new
  // detached group leader (live, non-zombie) that spawned its own child. Both
  // carry pgid=46479, so without the guard the stranger's child (800) would be
  // mis-reaped and its run falsely errored. The live leader row signals reuse →
  // abort the whole sweep (→ collectNonBenignGroupMembers returns []).
  const table = [
    { pid: 46479, ppid: 1, pgid: 46479, state: 'Ss', cmd: 'codex --model y' }, // reused pid, LIVE leader
    { pid: 800, ppid: 46479, pgid: 46479, state: 'R', cmd: 'bash -c "someone elses build"' },
  ];
  assert.deepEqual(collectNonBenignGroupMembers(table, 46479), []);
});

test('isGroupLeaderReused: live non-zombie leader present → reused (abort)', () => {
  assert.equal(isGroupLeaderReused([{ pid: 46479, ppid: 1, pgid: 46479, state: 'Ss', cmd: 'codex' }], 46479), true);
  // Foreground ('+') / running ('R') leaders are equally live.
  assert.equal(isGroupLeaderReused([{ pid: 46479, ppid: 1, pgid: 46479, state: 'R+', cmd: 'x' }], 46479), true);
});

test('isGroupLeaderReused: zombie leader → not reused (still ours, proceed)', () => {
  assert.equal(
    isGroupLeaderReused([{ pid: 46479, ppid: 1, pgid: 46479, state: 'Z', cmd: '[codex] <defunct>' }], 46479),
    false,
  );
});

test('isGroupLeaderReused: leader absent (reaped) → not reused (proceed)', () => {
  // Only members carry the pgid; the leader row is gone (the normal one-shot case).
  assert.equal(isGroupLeaderReused([{ pid: 300, ppid: 1, pgid: 46479, state: 'S', cmd: 'bash' }], 46479), false);
  assert.equal(isGroupLeaderReused([], 46479), false);
});

test('isGroupLeaderReused: leader present with unknown/empty state → treated as reused (safe abort)', () => {
  // An unclassifiable leader row is aborted on rather than risk a mis-reap — the
  // safe direction, deferring to the ~45-min liveness reaper.
  assert.equal(isGroupLeaderReused([{ pid: 46479, ppid: 1, pgid: 46479, cmd: 'codex' }], 46479), true);
  assert.equal(isGroupLeaderReused([{ pid: 46479, ppid: 1, pgid: 46479, state: '', cmd: 'codex' }], 46479), true);
});

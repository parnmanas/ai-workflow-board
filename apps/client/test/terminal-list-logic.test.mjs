// Terminal 목록의 순수 로직 — docs/terminals.md.
//
// 세션 목록과 결정적으로 다른 규칙 하나를 고정한다: **죽은 터미널은 목록에서 지운다.**
// 터미널은 장비에 기록이 없어 다시 열 수 없으므로, 남겨 두면 눌러도 아무 일도 없는
// 행이 된다(세션은 반대로 CLI 홈에 기록이 있어 죽은 뒤에도 유효한 행이다).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  basename,
  decodeBase64,
  describeTerminalStatus,
  isLiveTerminal,
  terminalDisplayTitle,
  terminalPath,
  upsertTerminal,
} from '../src/components/terminals/terminalList.logic.ts';

const row = (over = {}) => ({
  manager_id: 'm1',
  manager_name: 'rolf',
  terminal_id: 't1',
  shell: 'bash',
  shell_label: 'bash',
  cwd: '/home/parn/repo',
  title: '',
  cols: 80,
  rows: 24,
  pid: 10,
  status: 'live',
  exit_code: null,
  last_error: null,
  driver_user_id: null,
  created_at: '2026-09-26T00:00:00.000Z',
  updated_at: '2026-09-26T00:00:00.000Z',
  ...over,
});

test('upsertTerminal: live rows are replaced in place, dead rows are removed', () => {
  const a = row({ terminal_id: 'a', created_at: '2026-09-26T00:00:00.000Z' });
  const b = row({ terminal_id: 'b', created_at: '2026-09-26T00:00:05.000Z' });
  let list = upsertTerminal(upsertTerminal([], b), a);
  assert.deepEqual(list.map((t) => t.terminal_id), ['a', 'b'], 'ordered by start time, oldest first');

  list = upsertTerminal(list, { ...a, title: 'build' });
  assert.equal(list.length, 2, 'the same terminal is updated, not duplicated');
  assert.equal(list.find((t) => t.terminal_id === 'a').title, 'build');

  list = upsertTerminal(list, { ...a, status: 'exited', exit_code: 0 });
  assert.deepEqual(list.map((t) => t.terminal_id), ['b'], 'an exited terminal leaves the list');

  // 처음 보는 죽은 행도 들어오지 않는다(하트비트 정리가 늦게 도착한 경우).
  assert.deepEqual(upsertTerminal([], row({ status: 'error' })), []);
});

test('isLiveTerminal / describeTerminalStatus', () => {
  assert.equal(isLiveTerminal(row({ status: 'live' })), true);
  assert.equal(isLiveTerminal(row({ status: 'starting' })), true);
  assert.equal(isLiveTerminal(row({ status: 'exited' })), false);
  assert.equal(isLiveTerminal(row({ status: 'error' })), false);
  assert.equal(describeTerminalStatus('live').tone, 'success');
  assert.equal(describeTerminalStatus('error').tone, 'danger');
  assert.equal(describeTerminalStatus(undefined).label, 'Unknown');
});

test('terminalDisplayTitle falls back to shell + folder, on both path styles', () => {
  assert.equal(terminalDisplayTitle(row({ title: 'deploy' })), 'deploy');
  assert.equal(terminalDisplayTitle(row()), 'bash — repo');
  assert.equal(terminalDisplayTitle(row({ cwd: 'C:\\Users\\parn\\proj', shell_label: 'PowerShell 7' })), 'PowerShell 7 — proj');
  assert.equal(terminalDisplayTitle(row({ cwd: '' })), 'bash');
  assert.equal(basename('/a/b/c/'), 'c');
  assert.equal(basename(''), '');
});

test('decodeBase64 round-trips raw bytes (UTF-8 is xterm\'s job, not ours)', () => {
  const bytes = decodeBase64(Buffer.from('안녕 $ ls\r\n', 'utf8').toString('base64'));
  assert.equal(Buffer.from(bytes).toString('utf8'), '안녕 $ ls\r\n');
  assert.deepEqual(Array.from(decodeBase64('')), []);
});

test('terminalPath', () => {
  assert.equal(terminalPath('ws1', 'm1', 't1'), '/ws/ws1/terminals/m1/t1');
});

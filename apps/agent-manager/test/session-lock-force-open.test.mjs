// Connect 가 "이미 writer 가 있다" 로 막혔을 때의 **회복 정책**.
//
// 고치는 증상(실측, ralf/codex): 터미널이나 Codex 앱에서 열려 있는 스레드는 AWB 에서
// 열 수 없다. codex 는 스레드마다 writer 잠금을 걸고, 잠금 파일은 0바이트라 안에 주인
// 정보가 없다. 사용자는 "그 장비 어딘가에서 닫아라" 는 말만 듣고 어디를 닫아야 하는지
// 알 수 없었다.
//
// 그래서 정한 정책(사용자 선택: 기본 안전 + 확인 후 강제):
//   - AWB 가 띄운 유령 ACP 어댑터는 묻지 않고 정리한다 — 잃을 것이 그것뿐이다.
//   - 그 밖의 프로세스는 이름·PID 를 보여 주고 확인을 받기 전에는 **절대** 죽이지 않는다.
//     실측상 codex 의 잠금 주인은 스레드 전용 프로세스가 아니라 Codex 앱의 공용
//     app-server 였다 — 죽이면 그 앱의 다른 대화까지 함께 끊긴다.
//   - 매니저 자신은 어떤 경우에도 대상이 아니다.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHolder,
  describeHolders,
  findLockHolders,
  parseHolderLines,
  selectKillTargets,
} from '../dist/lib/file-lock-holders.js';
import { cliSessions } from '../dist/lib/clis/index.js';

const adapter = { pid: 11, name: 'node', command: '/usr/bin/node /opt/codex-acp/bin/codex-acp', kind: 'awb_adapter' };
const app = { pid: 22, name: 'codex.exe', command: 'C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe app-server', kind: 'external' };

test('AWB 어댑터와 외부 프로세스를 가른다', () => {
  assert.equal(classifyHolder('/usr/bin/node /opt/codex-acp/bin/codex-acp'), 'awb_adapter');
  assert.equal(classifyHolder('npx --yes @agentclientprotocol/codex-acp'), 'awb_adapter');
  assert.equal(classifyHolder('/usr/local/bin/opencode acp'), 'awb_adapter');
  // 운영자의 Codex 앱·터미널 codex 는 AWB 것이 아니다 — 이름에 codex 가 들어간다고
  // 어댑터로 착각하면 확인 없이 앱을 죽이게 된다.
  assert.equal(classifyHolder('C:\\...\\codex.exe app-server'), 'external');
  assert.equal(classifyHolder('codex resume 01a0e005'), 'external');
  assert.equal(classifyHolder(''), 'external', '모르는 것은 외부로 본다 — 안전한 쪽');
});

test('기본은 AWB 어댑터만 정리한다', () => {
  const targets = selectKillTargets([adapter, app], { selfPid: 99 });
  assert.deepEqual(targets.map((h) => h.pid), [11]);
});

test('force 를 받았을 때만 외부 프로세스까지 대상이 된다', () => {
  const targets = selectKillTargets([adapter, app], { force: true, selfPid: 99 });
  assert.deepEqual(targets.map((h) => h.pid), [11, 22]);
});

test('매니저 자신은 force 여도 대상이 아니다', () => {
  const self = { pid: 99, name: 'node', command: 'awb-agent-manager', kind: 'external' };
  assert.deepEqual(selectKillTargets([self, app], { force: true, selfPid: 99 }).map((h) => h.pid), [22]);
});

test('확인 대화상자가 읽을 수 있게 이름과 PID 를 함께 적는다', () => {
  const text = describeHolders([app, adapter]);
  assert.match(text, /codex\.exe \(pid 22\)/);
  assert.match(text, /node \(pid 11, AWB 어댑터\)/);
  assert.equal(describeHolders([]), '');
});

test('주인을 알아내지 못해도 던지지 않는다 — 빈 목록은 "모른다" 다', async () => {
  const holders = await findLockHolders('/nonexistent/thread-writer-locks/x.lock', {
    probe: async () => { throw new Error('lsof: not found'); },
  });
  assert.deepEqual(holders, []);
});

test('Windows Restart Manager 출력을 pid/이름/명령줄로 읽는다', () => {
  const rows = parseHolderLines([
    '335720\tcodex.exe\tC:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe app-server',
    '', // 빈 줄
    'not-a-pid\tjunk',
  ].join('\r\n'));
  assert.equal(rows.length, 1);
  assert.deepEqual({ pid: rows[0].pid, name: rows[0].name, kind: rows[0].kind }, {
    pid: 335720, name: 'codex.exe', kind: 'external',
  });
});

test('잠금 경로는 CLI 모듈이 선언한다 — 러너가 codex 를 이름으로 알지 않는다', () => {
  const codex = cliSessions('codex');
  assert.equal(
    codex.lockRelativePath('01a0e005-ccaa-7512-b4fb-b7278d260e33'),
    'thread-writer-locks/01a0e005-ccaa-7512-b4fb-b7278d260e33.lock',
  );
  // 잠금 개념이 없는 CLI 는 선언하지 않는다 → 강제 열기를 아예 제공하지 않는다.
  assert.equal(cliSessions('claude')?.lockRelativePath, undefined);
});

// 세션이 띄울 claude 실행 파일 — 장비의 claude 와 어댑터 번들 CLI 중 무엇을 쓰는가.
//
// 배경: claude-agent-acp 는 `CLAUDE_CODE_EXECUTABLE` 이 없으면 자기 SDK 가 번들한 claude 를 띄운다.
// 그래서 세션 모델 목록이 호스트 `claude` 가 아니라 **어댑터 버전**을 따라갔고, 같은 계정인데
// 호스트마다 Fable 5.2 / 5.1 로 갈렸다(2026-11-10). 이제 장비의 claude 가 번들보다 같거나 새로우면
// 그것을 쓴다 — 세션 · 티켓 · 모델 스캔이 한 바이너리를 보게.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  chooseSessionClaude,
  decideSessionClaude,
  sessionClaudeEnv,
  REAL_SESSION_CLAUDE_IO,
  _resetSessionClaudeCacheForTests,
} from '../dist/lib/clis/claude/session-executable.js';
import { cliSessions } from '../dist/lib/clis/index.js';

const host = (version, path = '/usr/local/bin/claude') => ({ path, version });
const bundled = (version) => ({ path: '/mgr/acp-adapters/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', version });

test('판정표: 장비의 claude 가 같거나 새로우면 host, 더 오래됐거나 못 쓰면 bundled', () => {
  const rows = [
    // [host, bundled, 기대, 설명]
    [null, bundled('2.1.321'), 'bundled', 'claude 가 없는 장비는 예전처럼 번들 CLI'],
    [host('2.1.322'), bundled('2.1.321'), 'host', '장비가 더 새롭다'],
    [host('2.1.321'), bundled('2.1.321'), 'host', '같으면 장비 — 티켓 · 스캔과 같은 파일이어야 한다'],
    [host('2.1.318'), bundled('2.1.321'), 'bundled', '장비가 더 오래됐다 — SDK 가 모르는 플래그로 죽을 수 있다'],
    [host('2.1.322'), bundled(null), 'host', '번들 버전을 모르면 장비'],
    [host('2.1.322'), null, 'host', '번들 CLI 를 못 찾아도 장비'],
    [host(null), bundled('2.1.321'), 'bundled', '장비 버전을 못 읽으면 번들(깨진 설치일 수 있다)'],
    [host('2.1.322', 'C:\\nvm4w\\nodejs\\claude.cmd'), bundled('2.1.321'), 'bundled', 'Windows 셸 shim 은 SDK 가 띄우지 못한다'],
    [host('2.1.322', 'C:\\nvm4w\\nodejs\\claude.ps1'), bundled('2.1.321'), 'bundled', '.ps1 도 마찬가지'],
    [host('2.1.322', 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'), bundled('2.1.321'), 'host', 'shim 을 따라간 실제 .exe 는 된다'],
  ];
  for (const [h, b, expected, why] of rows) {
    const decision = chooseSessionClaude(h, b);
    assert.equal(decision.use, expected, `${why}: ${decision.why}`);
    assert.ok(decision.why.length > 0, 'every decision carries a reason for the log');
  }
});

test('더 오래된 장비 claude 는 사유에 "claude update" 를 담는다 — 조용히 번들로 넘어가지 않는다', () => {
  const decision = chooseSessionClaude(host('2.1.318'), bundled('2.1.321'));
  assert.equal(decision.use, 'bundled');
  assert.match(decision.why, /claude update/);
  assert.match(decision.why, /2\.1\.318/);
  assert.match(decision.why, /2\.1\.321/);
});

test('env: host 면 CLAUDE_CODE_EXECUTABLE 하나, bundled 면 아무것도 더하지 않는다', () => {
  assert.deepEqual(sessionClaudeEnv(chooseSessionClaude(host('2.1.322'), bundled('2.1.321'))), { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' });
  assert.deepEqual(sessionClaudeEnv(chooseSessionClaude(host('2.1.318'), bundled('2.1.321'))), {});
  assert.deepEqual(sessionClaudeEnv(chooseSessionClaude(null, bundled('2.1.321'))), {});
});

test('decideSessionClaude 는 두 파일의 버전을 재서 판정한다 (I/O 주입)', async () => {
  _resetSessionClaudeCacheForTests();
  const probed = [];
  const io = {
    hostClaude: () => '/host/claude',
    bundledClaude: (entry) => (entry === '/adapter/dist/index.js' ? '/adapter/sdk/claude' : null),
    version: async (path) => {
      probed.push(path);
      return path === '/host/claude' ? '2.1.322' : '2.1.321';
    },
  };
  const decision = await decideSessionClaude('/adapter/dist/index.js', io);
  assert.equal(decision.use, 'host');
  assert.deepEqual(probed.sort(), ['/adapter/sdk/claude', '/host/claude']);
  assert.equal(decision.bundled?.version, '2.1.321');

  // 어댑터 entry 를 모르면(PATH/npx 어댑터) 번들 버전도 모른다 → 장비 claude.
  const noEntry = await decideSessionClaude(null, io);
  assert.equal(noEntry.use, 'host');
  assert.equal(noEntry.bundled, null);
});

test('실제 version prober: --version 출력에서 semver 를 뽑고, 파일이 바뀌기 전까지 캐시한다', async () => {
  _resetSessionClaudeCacheForTests();
  const dir = await mkdtemp(join(tmpdir(), 'awb-claude-exe-'));
  const script = join(dir, 'claude.js');
  // `.js` 는 node 로 띄운다(npm 설치 claude 의 cli.js 레이아웃) — SDK 와 같은 구분.
  await writeFile(script, 'process.stdout.write("2.1.322 (Claude Code)\\n");');
  assert.equal(await REAL_SESSION_CLAUDE_IO.version(script), '2.1.322');

  await writeFile(script, 'process.stdout.write("2.1.330 (Claude Code)\\n");');
  // 같은 mtime 이면 캐시 — 같은 초 안의 덮어쓰기로는 재측정을 보장할 수 없어 mtime 을 명시적으로 돌린다.
  const past = new Date(Date.now() - 60_000);
  await utimes(script, past, past);
  assert.equal(await REAL_SESSION_CLAUDE_IO.version(script), '2.1.330', 'mtime change → re-probed (claude update)');

  await writeFile(join(dir, 'broken.js'), 'process.exit(3);');
  assert.equal(await REAL_SESSION_CLAUDE_IO.version(join(dir, 'broken.js')), null, 'failed probe → null, never throws');
  assert.equal(await REAL_SESSION_CLAUDE_IO.version(join(dir, 'missing.js')), null, 'missing file → null');
});

test('claude 모듈의 resolveAcpCommand 는 명령과 함께 env 를 낸다(있을 때만) — 다른 키는 섞지 않는다', async () => {
  const resolved = await cliSessions('claude').resolveAcpCommand(async () => null);
  assert.ok(resolved.command, 'always a command');
  if (resolved.env) {
    assert.deepEqual(Object.keys(resolved.env), ['CLAUDE_CODE_EXECUTABLE'], 'only the executable rides the command env');
    assert.ok(resolved.env.CLAUDE_CODE_EXECUTABLE.length > 0);
  }
});

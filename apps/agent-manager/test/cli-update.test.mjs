// runCliUpdate — 호스트에 깔린 CLI **한 설치본**을 올린다.
//
// 이 모듈이 실제로 책임지는 것만 본다(진짜 npm/claude 를 돌릴 수는 없으므로 spawn,
// 버전 probe, 설치 방법 판정을 전부 주입한다):
//
//   1) 올릴 방법을 **설치 레이아웃**에서 고른다. npm prefix 아래 설치본은
//      `npm --prefix <prefix> install -g <pkg>@latest` 로 그 설치본만 올린다.
//      CLI 자체 업데이터는 "증명된 방법이 없을 때" 와 "그 방법이 실패했을 때" 의
//      대안이다 — ragnar 실측에서 `claude update` 가 남의 prefix 를 올리고
//      exit 0 으로 끝났기 때문이다.
//   2) snap / Homebrew / 쓰기 권한 없는 prefix 는 **아무것도 돌리지 않고**
//      운영자가 칠 명령을 그대로 돌려준다. 여기에 자체 업데이터를 돌리면
//      제자리가 아니라 남의 npm prefix 에 새 설치를 만든다.
//   3) 버전이 안 움직인 것을 *이미 최신* 과 *못 올렸다* 로 가른다. 가르는 근거는
//      `latest` 이고, 없으면 업데이터의 종료 코드를 믿되 그 사실을 detail 에 적는다.
//   4) 같은 CLI 의 다른 설치본은 **실패가 아니다** — vLLM 백엔드용 두 번째 claude
//      처럼 일부러 둔 구성이므로 정보로만 싣는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runCliUpdate, listCliInstalls, npmLatestApplies, extractSemver, compareCliVersions } = await import(
  '../dist/lib/cli-update.js'
);

/** 이 호스트에 다른 설치본이 없다 — 대부분의 테스트가 보려는 상황. */
const noOtherInstalls = () => [];

// 모든 테스트는 대상 경로를 **명시**한다(`{ bin }`) 또는 해석을 주입한다.
// 경로를 안 주면 runCliUpdate 가 어댑터의 resolveBin 을 타고, 그러면 "이 러너에
// claude 가 깔려 있는가" 가 결과를 가른다 — CI 를 실제로 빨갛게 만든 실수다
// (board lesson: CLI resolver 테스트는 호스트 설치에 의존하지 말 것).
const NPM_CLAUDE = '/home/parn/.npm-global/bin/claude';
const NATIVE_CLAUDE = '/home/parn/.local/bin/claude';

/** npm prefix 아래 정상 설치 — 가장 흔한 모양. */
const npmMethod = (prefix, pkg) => ({
  kind: 'npm-prefix',
  argv: { cmd: 'npm', args: ['--prefix', prefix, 'install', '-g', `${pkg}@latest`] },
  label: `npm --prefix ${prefix}`,
  manualCommand: `npm --prefix ${prefix} install -g ${pkg}@latest`,
  prefix,
  needsElevation: false,
});

/** 우리가 못 건드리는 설치 — snap / brew / 루트 소유 prefix. */
const unmanageable = (kind, label, manualCommand, needsElevation = false) => ({
  kind,
  argv: null,
  label,
  manualCommand,
  prefix: null,
  needsElevation,
});

/** 레이아웃을 못 알아본 설치 — CLI 자체 업데이터에 맡기는 경우. */
const unknownMethod = () => unmanageable('unknown', 'unrecognised install layout', null);

test('npm prefix 설치본은 그 prefix 를 박아 올린다 — 자체 업데이터를 쓰지 않는다', async () => {
  // ragnar 회귀의 핵심. `claude update` 는 PATH 위 npm 의 prefix 로 설치하므로
  // 여러 벌 깔린 호스트에서 엉뚱한 설치본을 올린다.
  const runs = [];
  const result = await runCliUpdate(
    'claude',
    {
      hostLabel: 'ragnar',
      listCandidates: noOtherInstalls,
      detectMethod: () => npmMethod('/home/parn/.local', '@anthropic-ai/claude-code'),
      run: async (cmd, args) => {
        runs.push([cmd, ...args]);
        return { ok: true, output: 'added 1 package' };
      },
      probeVersion: (() => {
        let n = 0;
        return async () => (n++ === 0 ? '2.1.273 (Claude Code)' : '2.1.281 (Claude Code)');
      })(),
    },
    { bin: '/home/parn/.local/bin/claude' },
  );

  assert.deepEqual(runs, [
    ['npm', '--prefix', '/home/parn/.local', 'install', '-g', '@anthropic-ai/claude-code@latest'],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.before, '2.1.273 (Claude Code)');
  assert.equal(result.after, '2.1.281 (Claude Code)');
  assert.equal(result.resolvedPath, '/home/parn/.local/bin/claude');
  assert.match(result.detail, /2\.1\.273 \(Claude Code\) → 2\.1\.281/);
});

test('증명된 방법이 없으면 CLI 자체 업데이터에 맡긴다', async () => {
  const runs = [];
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: unknownMethod,
      run: async (cmd, args) => {
        runs.push([cmd, ...args]);
        return { ok: true, output: '' };
      },
      probeVersion: (() => {
        let n = 0;
        return async () => (n++ === 0 ? '2.0.0' : '2.1.0');
      })(),
    },
    { bin: NATIVE_CLAUDE },
  );

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(1), ['update'], 'claude 어댑터의 update 서브커맨드');
  assert.equal(runs[0][0], NATIVE_CLAUDE, '그 설치본을 직접 돌린다');
  assert.equal(result.ok, true);
});

test('prefix 방법이 실패하면 자체 업데이터로 물러선다', async () => {
  const runs = [];
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => npmMethod('/home/parn/.npm-global', '@anthropic-ai/claude-code'),
      run: async (cmd) => {
        runs.push(cmd);
        // npm 은 실패, 자체 업데이터는 성공.
        return cmd === 'npm'
          ? { ok: false, output: 'npm ERR! ETIMEDOUT' }
          : { ok: true, output: 'updated' };
      },
      probeVersion: (() => {
        let n = 0;
        return async () => (n++ === 0 ? '2.0.0' : '2.1.0');
      })(),
    },
    { bin: NPM_CLAUDE },
  );

  assert.equal(runs.length, 2, 'npm → 자체 업데이터');
  assert.equal(runs[0], 'npm');
  assert.equal(runs[1], NPM_CLAUDE);
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
});

test('prefix 방법이 성공했으면 자체 업데이터를 덧돌리지 않는다 — npm 재설치는 그 자체로 최종이다', async () => {
  const runs = [];
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => npmMethod('/p', '@anthropic-ai/claude-code'),
      run: async (cmd) => {
        runs.push(cmd);
        return { ok: true, output: 'up to date' };
      },
      probeVersion: async () => '2.1.281 (Claude Code)',
    },
    { bin: NPM_CLAUDE },
  );

  assert.deepEqual(runs, ['npm']);
  assert.equal(result.ok, true, '버전이 그대로여도 npm 이 성공했으면 이미 최신이다');
  assert.match(result.detail, /already current/);
});

for (const [kind, label, manual, elevation] of [
  ['snap', 'snap package', 'sudo snap refresh codex', false],
  ['homebrew', 'Homebrew formula', 'brew upgrade codex', false],
  ['npm-prefix', 'npm --prefix /usr/local', 'sudo npm --prefix /usr/local install -g @openai/codex@latest', true],
]) {
  test(`${kind} 설치본에는 아무것도 돌리지 않고 운영자가 칠 명령을 돌려준다`, async () => {
    // 여기에 `codex update` 를 돌리면 제자리가 아니라 PATH 위 npm prefix 에 새
    // 설치가 생긴다 — 대상은 그대로인데 남의 설치본만 바뀌는 ragnar 패턴이다.
    let ran = 0;
    const result = await runCliUpdate(
      'codex',
      {
        hostLabel: 'rolf',
        listCandidates: noOtherInstalls,
        detectMethod: () => unmanageable(kind, label, manual, elevation),
        run: async () => {
          ran++;
          return { ok: true, output: '' };
        },
        probeVersion: async () => 'codex-cli 0.114.0',
      },
      { bin: '/snap/bin/codex' },
    );

    assert.equal(ran, 0, '실행하지 않는다');
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(manual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('버전이 안 움직였을 때 최신 버전을 알면 *이미 최신* 과 *못 올렸다* 를 가른다', async () => {
  const deps = {
    listCandidates: noOtherInstalls,
    detectMethod: () => npmMethod('/p', '@anthropic-ai/claude-code'),
    // 업데이터는 성공했다고 말하지만 버전은 그대로다 — ragnar 의 모양.
    run: async () => ({ ok: true, output: 'done' }),
    probeVersion: async () => '2.1.273 (Claude Code)',
  };

  const stale = await runCliUpdate('claude', deps, { bin: NPM_CLAUDE, latest: '2.1.281' });
  assert.equal(stale.ok, false, '최신이 더 위에 있는데 안 움직였으면 실패다');
  assert.match(stale.detail, /latest available is 2\.1\.281/);

  const current = await runCliUpdate('claude', deps, { bin: NPM_CLAUDE, latest: '2.1.273' });
  assert.equal(current.ok, true);
  assert.match(current.detail, /already current \(latest 2\.1\.273\)/);

  const unknown = await runCliUpdate('claude', deps, { bin: NPM_CLAUDE, latest: null });
  assert.equal(unknown.ok, true, '최신을 모르면 업데이터의 말을 믿는다');
  assert.match(unknown.detail, /latest version unknown/, '다만 그 불확실성을 적는다');
});

test('같은 CLI 의 다른 설치본은 실패가 아니라 정보다 (vLLM 용 두 번째 claude)', async () => {
  const other = '/home/parn/.nvm/versions/node/v22.23.1/bin/claude';
  const result = await runCliUpdate(
    'claude',
    {
      hostLabel: 'ragnar',
      listCandidates: () => ['/home/parn/.local/bin/claude', other],
      detectMethod: () => npmMethod('/home/parn/.local', '@anthropic-ai/claude-code'),
      run: async () => ({ ok: true, output: '' }),
      probeVersion: async (bin) =>
        bin === other ? '2.1.281 (Claude Code)' : '2.1.273 (Claude Code)',
    },
    { bin: '/home/parn/.local/bin/claude', latest: '2.1.273' },
  );

  assert.equal(result.ok, true, '다른 설치본이 더 새롭다고 해서 실패가 아니다');
  assert.deepEqual(result.otherInstalls, [{ path: other, version: '2.1.281 (Claude Code)' }]);
});

test('경로를 지정하면 그 경로만 본다 — 재해석으로 대상이 바뀌지 않는다', async () => {
  const probed = [];
  const pinned = '/home/parn/.nvm/versions/node/v22.23.1/bin/claude';
  let invalidated = 0;
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => npmMethod('/home/parn/.nvm/versions/node/v22.23.1', '@anthropic-ai/claude-code'),
      run: async () => ({ ok: true, output: '' }),
      probeVersion: async (bin) => {
        probed.push(bin);
        return '2.1.281 (Claude Code)';
      },
      invalidateResolved: () => {
        invalidated++;
      },
    },
    { bin: pinned },
  );

  assert.equal(result.resolvedPath, pinned);
  assert.deepEqual([...new Set(probed)], [pinned]);
  assert.equal(invalidated, 0, '지정된 경로가 곧 대상이므로 재해석하지 않는다');
});

test('자체 업데이터도 없고 방법도 못 알아보면 조용히 성공한 척하지 않는다', async () => {
  let ran = 0;
  const result = await runCliUpdate(
    'pi',
    {
      hostLabel: 'rolf',
      listCandidates: noOtherInstalls,
      detectMethod: unknownMethod,
      run: async () => {
        ran++;
        return { ok: true, output: '' };
      },
      probeVersion: async () => '1.0.0',
    },
    // 경로를 명시한다 — 러너 장비에 pi 가 깔려 있는지에 결과가 좌우되면 안 된다.
    { bin: '/opt/weird/pi' },
  );

  assert.equal(ran, 0);
  assert.equal(result.ok, false);
  assert.match(result.detail, /rolf/);
});

test('알 수 없는 CLI 는 throw 대신 해석 실패 사유를 담아 돌아온다', async () => {
  const result = await runCliUpdate('not-a-cli', {
    listCandidates: noOtherInstalls,
    run: async () => ({ ok: true, output: '' }),
    probeVersion: async () => '1.0.0',
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not-a-cli/);
});

test('listCliInstalls 는 같은 CLI 의 설치본을 전부 돌려준다 — update_cli 의 허용목록이기도 하다', async () => {
  const rows = await listCliInstalls('claude', {
    resolveBin: () => NPM_CLAUDE,
    listCandidates: (key) => {
      assert.equal(key, 'claude');
      return ['/a/bin/claude', '/b/bin/claude'];
    },
    detectMethod: (bin) => npmMethod(bin.replace('/bin/claude', ''), '@anthropic-ai/claude-code'),
    probeVersion: async (bin) => (bin === '/a/bin/claude' ? '2.1.281' : '2.1.273'),
  });

  assert.deepEqual(
    rows.map((r) => [r.path, r.version, r.method.kind]),
    [
      ['/a/bin/claude', '2.1.281', 'npm-prefix'],
      ['/b/bin/claude', '2.1.273', 'npm-prefix'],
    ],
  );
});

test('빌려 쓰는 어댑터는 실제 바이너리 이름으로 후보를 센다 (deepseek → claude)', async () => {
  const asked = [];
  await listCliInstalls('deepseek', {
    // 해석을 주입한다 — 안 그러면 "러너 장비에 claude 가 깔려 있는가" 가 결과를 가른다.
    resolveBin: () => NPM_CLAUDE,
    listCandidates: (key) => {
      asked.push(key);
      return [];
    },
    probeVersion: async () => null,
  });
  assert.deepEqual(asked, ['claude'], 'cliType 이 아니라 해석된 바이너리 이름으로 묻는다');
});

// ─── 권한 상승 경로 ─────────────────────────────────────────────────────────
//
// 비밀번호는 **권한 상승이 실제로 필요한 분기에 도달했을 때만** 당겨 온다. 이게
// 무너지면, 권한이 필요 없는 설치본을 올릴 때도 운영자의 root 비밀번호가 괜히
// 네트워크를 타고 호스트까지 간다.

/** root 로만 올릴 수 있는 설치본(쓰기 불가 prefix / snap). */
const elevatedOnly = (label = 'npm --prefix /usr/local') => ({
  kind: 'npm-prefix',
  argv: null,
  elevatedArgv: { cmd: 'npm', args: ['--prefix', '/usr/local', 'install', '-g', 'p@latest'] },
  label,
  manualCommand: `sudo ${label} install -g p@latest`,
  prefix: '/usr/local',
  needsElevation: true,
});

test('권한 상승이 필요 없으면 비밀번호를 아예 요청하지 않는다', async () => {
  let asked = 0;
  await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => npmMethod('/p', '@anthropic-ai/claude-code'),
      run: async () => ({ ok: true, output: '' }),
      probeVersion: async () => '2.1.281',
    },
    {
      bin: NPM_CLAUDE,
      getSudoPassword: async () => {
        asked++;
        return 'pw';
      },
    },
  );
  assert.equal(asked, 0, '필요 없는데 비밀번호를 당겨 오면 티켓이 헛되이 소비된다');
});

test('권한 상승 수단이 없으면 시도하지 않고 칠 명령을 돌려준다', async () => {
  let ran = 0;
  const result = await runCliUpdate(
    'claude',
    {
      hostLabel: 'rolf',
      listCandidates: noOtherInstalls,
      detectMethod: () => elevatedOnly(),
      run: async () => {
        ran++;
        return { ok: true, output: '' };
      },
      probeVersion: async () => '2.1.92 (Claude Code)',
    },
    { bin: '/usr/local/bin/claude' },
  );

  assert.equal(ran, 0);
  assert.equal(result.ok, false);
  assert.equal(result.needsSudo, true, 'UI 가 비밀번호를 물어야 한다는 신호');
  assert.match(result.detail, /sudo npm --prefix \/usr\/local/);
});

test('비밀번호가 오면 그 설치본을 root 로 올린다', async () => {
  // 실제 sudo 실행은 sudo-runner 가 덮는다. 여기서는 "그 경로로, 그 비밀번호로
  // 갔는가" 만 본다. runSudo 를 주입하지 않으면 러너에서 진짜 인증 실패가 일어난다.
  const sudoCalls = [];
  let asked = 0;
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => elevatedOnly(),
      run: async () => {
        throw new Error('권한 상승 경로에서는 일반 run 을 쓰지 않는다');
      },
      runSudo: async (argv, password) => {
        sudoCalls.push({ argv, password });
        return { ok: true, output: 'added 1 package', reason: null };
      },
      probeVersion: (() => {
        let n = 0;
        return async () => (n++ === 0 ? '2.1.92 (Claude Code)' : '2.1.281 (Claude Code)');
      })(),
    },
    {
      bin: '/usr/local/bin/claude',
      getSudoPassword: async () => {
        asked++;
        return 'pw';
      },
    },
  );

  assert.equal(asked, 1, '권한 상승 분기에 도달했을 때 정확히 한 번만 당겨 온다');
  assert.equal(result.needsSudo, true);
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 1);
  assert.match(result.attempts[0].method, /sudo/);
  assert.deepEqual(sudoCalls, [
    {
      argv: { cmd: 'npm', args: ['--prefix', '/usr/local', 'install', '-g', 'p@latest'] },
      password: 'pw',
    },
  ]);
});

test('비밀번호를 못 받아 오면 다시 누르라고만 말한다 — 조용히 성공하지 않는다', async () => {
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => elevatedOnly(),
      run: async () => ({ ok: true, output: '' }),
      probeVersion: async () => '2.1.92 (Claude Code)',
    },
    { bin: '/usr/local/bin/claude', getSudoPassword: async () => null },
  );

  assert.equal(result.ok, false);
  assert.equal(result.needsSudo, true);
  assert.match(result.detail, /press Update again/);
});

test('비밀번호가 틀리면 "이미 최신" 으로 읽히지 않는다', async () => {
  // 버전이 안 움직였다는 사실만 보면 "이미 최신" 과 구분되지 않는다. 그렇게 읽히면
  // 운영자는 올라간 줄 알고 넘어간다.
  const result = await runCliUpdate(
    'claude',
    {
      listCandidates: noOtherInstalls,
      detectMethod: () => elevatedOnly(),
      probeVersion: async () => '2.1.92 (Claude Code)',
      run: async () => ({ ok: true, output: '' }),
      runSudo: async () => ({ ok: false, output: 'Sorry, try again.', reason: 'bad_password' }),
    },
    {
      bin: '/usr/local/bin/claude',
      getSudoPassword: async () => 'definitely-wrong',
      // 설치 == 최신이라, sudo 실패를 무시하면 "이미 최신" 으로 접혀 버린다.
      latest: '2.1.92 (Claude Code)',
    },
  );

  assert.equal(result.ok, false, 'sudo 가 실패했으면 버전 비교로 덮지 않는다');
  assert.equal(result.sudoFailure, 'bad_password');
  assert.match(result.detail, /password was rejected/);
});

test('snap 설치본은 **그 채널의** 최신으로 판정한다 (rolf 의 비공식 snap codex)', async () => {
  // rolf 실측: /snap/bin/codex 는 OpenAI 가 아니라 제3자(jcat)가 올린 스냅이고,
  // 추적 중인 latest/stable 이 0.114.0(2026-03-14)에서 멈춰 있다. `snap refresh` 는
  // 그 채널 안에서만 올리므로 "올릴 것 없음" 이 정답이다. 같은 호스트의 npm 최신
  // (0.156.1)은 **다른 배포 채널의 숫자**라 판정 근거가 될 수 없다 — 호출자가
  // 채널에 맞는 값을 골라 넘기고, 여기서는 그 값을 그대로 쓴다.
  const snap = {
    kind: 'snap',
    argv: null,
    elevatedArgv: { cmd: 'snap', args: ['refresh', 'codex'] },
    label: 'snap package',
    manualCommand: 'sudo snap refresh codex',
    prefix: null,
    needsElevation: true,
  };
  const run = (latest) =>
    runCliUpdate(
      'codex',
      {
        hostLabel: 'Rolf',
        listCandidates: noOtherInstalls,
        detectMethod: () => snap,
        probeVersion: async () => 'codex-cli 0.114.0',
        runSudo: async () => ({ ok: true, output: 'snap "codex" has no updates available', reason: null }),
      },
      { bin: '/snap/bin/codex', latest, getSudoPassword: async () => 'pw' },
    );

  // 채널의 최신에 이미 도달 — 성공이고, 화면은 이 값으로 버튼을 잠글 수 있다.
  const atChannelLatest = await run('0.114.0');
  assert.equal(atChannelLatest.ok, true);
  assert.match(atChannelLatest.detail, /already current \(latest 0\.114\.0\)/);
  assert.doesNotMatch(
    atChannelLatest.detail,
    /updater's word/,
    '채널 최신을 아는데도 "모른다" 로 접으면 버튼이 영원히 눌린다',
  );

  // 채널에 더 새 것이 있는데 안 움직였다면 그건 진짜 실패다.
  const behindChannel = await run('0.154.0');
  assert.equal(behindChannel.ok, false);
  assert.match(behindChannel.detail, /latest available is 0\.154\.0/);
});

test('호출자가 채널에 맞는 최신을 고른다 — npmLatestApplies', () => {
  // npm 레지스트리에서 온 설치본에만 npm 의 latest 가 적용된다. 이 구분이 무너지면
  // 한쪽에서는 snap 을 npm 숫자로 재고(거짓 실패), 다른 쪽에서는 npm 설치본의
  // latest 를 버려 ragnar 회귀(남의 prefix 를 올리고 exit 0)가 돌아온다.
  const of = (kind) => ({ kind, argv: null, elevatedArgv: null, label: kind, manualCommand: null, prefix: null, needsElevation: false });
  for (const kind of ['npm-prefix', 'bun', 'volta', 'pnpm']) {
    assert.equal(npmLatestApplies(of(kind)), true, kind);
  }
  for (const kind of ['snap', 'homebrew', 'native', 'unknown']) {
    assert.equal(npmLatestApplies(of(kind)), false, kind);
  }
});

test('npm 채널 설치본은 npm latest 로 그대로 판정된다', async () => {
  for (const kind of ['npm-prefix', 'bun', 'volta', 'pnpm']) {
    const result = await runCliUpdate(
      'claude',
      {
        listCandidates: noOtherInstalls,
        detectMethod: () => ({ ...npmMethod('/p', '@anthropic-ai/claude-code'), kind }),
        run: async () => ({ ok: true, output: '' }),
        probeVersion: async () => '2.1.273 (Claude Code)',
      },
      { bin: NPM_CLAUDE, latest: '2.1.281' },
    );
    assert.equal(result.ok, false, `${kind}: 최신이 더 위에 있는데 안 움직였으면 실패다`);
    assert.match(result.detail, /latest available is 2\.1\.281/);
  }
});

test('버전 문자열의 장식은 비교 전에 벗긴다 — 못 벗기면 비교를 포기한다', () => {
  assert.equal(extractSemver('2.1.281 (Claude Code)'), '2.1.281');
  assert.equal(extractSemver('codex-cli 0.153.4'), '0.153.4');
  assert.equal(extractSemver('unknown build'), null);
  assert.equal(extractSemver(null), null);
  assert.equal(compareCliVersions('codex-cli 0.156.1', 'codex-cli 0.153.4'), 1);
  assert.equal(compareCliVersions('2.1.281 (Claude Code)', '2.1.281 (Claude Code)'), 0);
  assert.equal(compareCliVersions('nightly', '2.1.281'), null, '비교 불가는 0 이 아니다');
});

// ─── 하트비트의 cli_versions ────────────────────────────────────────────────
//
// 업데이트 결과가 UI 에 닿는 유일한 경로. 모델 목록과 같은 provider 계약을
// 따른다 — 매 tick 다시 읽고, 실패해도 하트비트를 멈추지 않는다.

const { InstanceHeartbeat } = await import('../dist/lib/instance-heartbeat.js');

function collectFetch(t) {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return bodies;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const heartbeatConfig = () => ({ url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' });

test('하트비트는 cliVersionsProvider 를 매 tick 다시 읽는다 — update_cli 결과가 재시작 없이 실린다', async (t) => {
  const bodies = collectFetch(t);
  let versions = { claude: '2.0.0', codex: '0.9.0' };
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-1', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    cliVersionsProvider: () => versions,
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].cli_versions, { claude: '2.0.0', codex: '0.9.0' });

  versions = { claude: '2.1.0', codex: '0.9.0' };
  await heartbeat.postNow();
  assert.deepEqual(bodies[1].cli_versions, { claude: '2.1.0', codex: '0.9.0' });
});

test('cliVersionsProvider 가 throw 하거나 없으면 필드만 빠지고 하트비트는 계속 돈다', async (t) => {
  const bodies = collectFetch(t);
  const exploding = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-2', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    cliVersionsProvider: () => {
      throw new Error('probe 폭발');
    },
  });
  t.after(() => exploding.stop());
  exploding.start();
  await flush();
  assert.equal('cli_versions' in bodies[0], false);
  assert.equal(bodies[0].mode, 'manager', '나머지 하트비트 필드는 그대로 실린다');

  const legacy = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-3', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => legacy.stop());
  await legacy.postNow();
  assert.equal('cli_versions' in bodies[1], false);
});

test('하트비트는 cli_latest_versions 도 provider 로 싣는다 — 없으면 필드가 빠진다', async (t) => {
  const bodies = collectFetch(t);
  let latest = { claude: '2.1.281' };
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-4', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    cliVersionsProvider: () => ({ claude: '2.1.273 (Claude Code)' }),
    cliLatestVersionsProvider: () => latest,
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].cli_latest_versions, { claude: '2.1.281' });

  // 이번 회차 조회가 통째로 실패하면(빈 맵) 필드를 아예 빼서, UI 가 "최신을
  // 모른다" 로 접히고 버튼이 다시 눌릴 수 있게 한다 — 낡은 최신으로 잠그지 않는다.
  latest = {};
  await heartbeat.postNow();
  assert.equal('cli_latest_versions' in bodies[1], false);

  const legacy = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-5', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => legacy.stop());
  await legacy.postNow();
  assert.equal('cli_latest_versions' in bodies[2], false);
});

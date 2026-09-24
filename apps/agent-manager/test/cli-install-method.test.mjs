// detectInstallMethod — "이 설치본은 어떻게 깔렸고, 어떻게 올리나".
//
// CLI 자체 업데이터만으로는 부족하다는 것이 이 모듈의 존재 이유다. `claude update`
// 는 자기 자신이 아니라 **PATH 위 npm 의 prefix** 로 설치한다 — ragnar 실측에서
// `~/.local/bin/claude`(2.1.273)를 통해 돌렸더니 새 버전이 nvm prefix 에 깔리고
// exit 0 으로 끝났다. 설치 레이아웃에서 prefix 를 직접 읽어야 "누른 그것" 이 올라간다.
//
// 판정은 전부 디스크 증거(심링크를 푼 실제 경로)로만 하므로, fs 를 주입해 실제
// 설치 없이 전수로 검사한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectInstallMethod, npmPackageFromRealPath, npmPrefixFromRealPath, describeInstallMethod } =
  await import('../dist/lib/cli-install-method.js');

const probes = (realMap, writableSet = null) => ({
  realpath: (p) => realMap[p] ?? p,
  writable: (p) => (writableSet ? writableSet.has(p) : true),
  windows: false,
});

test('npm prefix 설치는 prefix 를 박은 재설치 명령을 만든다', () => {
  const bin = '/home/parn/.local/bin/claude';
  const m = detectInstallMethod(
    bin,
    null,
    probes({ [bin]: '/home/parn/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' }),
  );

  assert.equal(m.kind, 'npm-prefix');
  assert.equal(m.prefix, '/home/parn/.local');
  assert.deepEqual(m.argv, {
    cmd: 'npm',
    args: ['--prefix', '/home/parn/.local', 'install', '-g', '@anthropic-ai/claude-code@latest'],
  });
  assert.equal(m.needsElevation, false);
});

test('패키지 이름은 어댑터의 선언이 아니라 경로에서 읽는다', () => {
  // 어댑터가 패키지를 선언하지 않은 CLI 도 npm 으로 깔려 있기만 하면 올릴 수 있다.
  const bin = '/home/parn/.npm-global/bin/gemini';
  const m = detectInstallMethod(
    bin,
    null,
    probes({ [bin]: '/home/parn/.npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js' }),
  );
  assert.deepEqual(m.argv.args.slice(-1), ['@google/gemini-cli@latest']);

  // 선언과 경로가 어긋나면 경로가 이긴다 — 이 설치본에 관한 사실이기 때문이다.
  const wrong = detectInstallMethod(bin, '@anthropic-ai/claude-code', probes({
    [bin]: '/home/parn/.npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js',
  }));
  assert.deepEqual(wrong.argv.args.slice(-1), ['@google/gemini-cli@latest']);
});

test('스코프 없는 패키지도 한 조각으로 읽는다', () => {
  assert.equal(
    npmPackageFromRealPath('/home/p/.npm-global/lib/node_modules/opencode-ai/bin/opencode'),
    'opencode-ai',
  );
  assert.equal(
    npmPackageFromRealPath('/home/p/.npm-global/lib/node_modules/@openai/codex/bin/codex'),
    '@openai/codex',
  );
  assert.equal(npmPackageFromRealPath('/usr/bin/git'), null);
});

test('쓸 수 없는 prefix 는 현재 권한으로 돌리지 않고, root 로 돌릴 argv 를 따로 내놓는다', () => {
  // 현재 사용자로 돌려 봐야 EACCES 다. 그렇다고 못 올리는 것은 아니고, 운영자가
  // 비밀번호를 준 경우에 한해 같은 명령을 root 로 돌릴 수 있다 — 그래서 두 argv 를
  // 나눠 둔다. 권한 상승 수단이 없는 호출자는 manualCommand 를 그대로 보여주면 된다.
  const bin = '/usr/local/bin/claude';
  const real = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const m = detectInstallMethod(bin, null, probes({ [bin]: real }, new Set()));

  assert.equal(m.kind, 'npm-prefix');
  assert.equal(m.argv, null, '현재 권한으로는 돌리지 않는다');
  assert.equal(m.needsElevation, true);
  assert.deepEqual(m.elevatedArgv, {
    cmd: 'npm',
    args: ['--prefix', '/usr/local', 'install', '-g', '@anthropic-ai/claude-code@latest'],
  });
  assert.match(m.manualCommand, /^sudo npm --prefix \/usr\/local install -g @anthropic-ai\/claude-code@latest$/);
  assert.match(describeInstallMethod(m), /needs sudo/);
});

test('snap 은 root 로 refresh 할 수 있지만 Homebrew 는 아니다', () => {
  // brew 는 root 실행을 스스로 거부하고 억지로 돌리면 설치 트리 소유권이 망가진다.
  // "권한만 올리면 다 된다" 로 뭉뚱그리면 안 되는 대표 사례다.
  const snap = detectInstallMethod('/snap/bin/codex', null, probes({}));
  assert.deepEqual(snap.elevatedArgv, { cmd: 'snap', args: ['refresh', 'codex'] });
  assert.equal(snap.needsElevation, true);

  const brew = detectInstallMethod('/opt/homebrew/bin/codex', null, probes({
    '/opt/homebrew/bin/codex': '/opt/homebrew/Cellar/codex/0.1/bin/codex',
  }));
  assert.equal(brew.elevatedArgv, null, 'brew 는 sudo 로 돌리면 안 된다');
  assert.equal(brew.needsElevation, false);
  assert.equal(brew.manualCommand, 'brew upgrade codex');
});

test('현재 권한으로 올릴 수 있는 설치본에는 권한 상승 argv 를 만들지 않는다', () => {
  // 안 올려도 되는 권한은 올리지 않는다.
  const bin = '/home/parn/.npm-global/bin/claude';
  const m = detectInstallMethod(bin, null, probes({
    [bin]: '/home/parn/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  }));
  assert.ok(m.argv);
  assert.equal(m.elevatedArgv, null);
  assert.equal(m.needsElevation, false);
});

test('bun / volta / pnpm 은 일반 npm prefix 규칙보다 먼저 잡는다', () => {
  // 이들의 전역 트리 안에도 node_modules 가 있어서, 순서가 뒤집히면 엉뚱한
  // prefix 로 npm 을 돌리게 된다.
  const bun = '/home/p/.bun/bin/claude';
  const bunM = detectInstallMethod(bun, '@anthropic-ai/claude-code', probes({
    [bun]: '/home/p/.bun/install/global/node_modules/@anthropic-ai/claude-code/bin/claude',
  }));
  assert.equal(bunM.kind, 'bun');
  assert.deepEqual(bunM.argv, { cmd: 'bun', args: ['add', '-g', '@anthropic-ai/claude-code@latest'] });

  const volta = '/home/p/.volta/bin/claude';
  const voltaM = detectInstallMethod(volta, '@anthropic-ai/claude-code', probes({
    [volta]: '/home/p/.volta/tools/image/packages/@anthropic-ai/claude-code/bin/claude',
  }));
  assert.equal(voltaM.kind, 'volta');
  assert.deepEqual(voltaM.argv, { cmd: 'volta', args: ['install', '@anthropic-ai/claude-code@latest'] });

  const pnpm = '/home/p/.local/share/pnpm/claude';
  const pnpmM = detectInstallMethod(pnpm, '@anthropic-ai/claude-code', probes({
    [pnpm]: '/home/p/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/bin/claude',
  }));
  assert.equal(pnpmM.kind, 'pnpm');
  assert.deepEqual(pnpmM.argv, { cmd: 'pnpm', args: ['add', '-g', '@anthropic-ai/claude-code@latest'] });
});

test('snap / Homebrew 는 우리가 돌리지 않고 정확한 명령만 돌려준다', () => {
  const snap = detectInstallMethod('/snap/bin/codex', '@openai/codex', probes({}));
  assert.equal(snap.kind, 'snap');
  assert.equal(snap.argv, null);
  assert.equal(snap.manualCommand, 'sudo snap refresh codex');

  // 이름은 호출된 파일명에서 뽑는다 — realpath 의 마지막 조각은 패키지 이름이
  // 아닐 수 있다(`/snap/<name>/current/bin/...`).
  const snapDeep = detectInstallMethod('/snap/bin/codex', null, probes({
    '/snap/bin/codex': '/snap/codex/42/usr/bin/codex-wrapper',
  }));
  assert.equal(snapDeep.manualCommand, 'sudo snap refresh codex');

  const brew = detectInstallMethod('/opt/homebrew/bin/codex', null, probes({
    '/opt/homebrew/bin/codex': '/opt/homebrew/Cellar/codex/0.1/bin/codex',
  }));
  assert.equal(brew.kind, 'homebrew');
  assert.equal(brew.argv, null);
  assert.equal(brew.manualCommand, 'brew upgrade codex');
});

test('node_modules 밖의 단일 실행 파일은 native installer 로 보고 자체 업데이터에 맡긴다', () => {
  const bin = '/home/p/.local/bin/claude';
  const m = detectInstallMethod(bin, '@anthropic-ai/claude-code', probes({ [bin]: bin }));
  assert.equal(m.kind, 'native');
  assert.equal(m.argv, null);
  assert.equal(m.manualCommand, null, 'CLI 자체 업데이터가 제자리를 갈아 끼운다');
});

test('전혀 모르는 레이아웃은 unknown — 추측해서 npm 을 돌리지 않는다', () => {
  const bin = '/opt/vendor/bin/claude';
  const m = detectInstallMethod(bin, '@anthropic-ai/claude-code', probes({ [bin]: bin }));
  assert.equal(m.kind, 'unknown');
  assert.equal(m.argv, null);
});

test('Windows npm 레이아웃(`<prefix>\\node_modules`)에서도 prefix 를 뽑는다', () => {
  assert.equal(
    npmPrefixFromRealPath('C:/Users/u/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.exe', true),
    'C:\\Users\\u\\AppData\\Roaming\\npm',
  );
  // POSIX 레이아웃을 그대로 쓰는 Windows 설치(nvm-windows)도 접는다.
  assert.equal(
    npmPrefixFromRealPath('C:/nvm/v22/lib/node_modules/@openai/codex/bin/codex.exe', true),
    'C:\\nvm\\v22',
  );
});

// 회귀 테스트: PATH 우선순위 재검토 + codex bin override 설정 키 (ticket ce65cf25,
// 702d0ebe 후속).
//
// 702d0ebe 인시던트: 호스트 PATH가 구버전 비공식 snap codex(0.114.0)를 공식 npm
// 전역 설치본(0.146.0)보다 먼저 노출해, resolveCliBin 이 매 spawn 마다 잘못된
// 바이너리를 선택했다. 이 파일은 두 가지 수정을 pin 한다:
//   1. orderResolutionSources(): well-known 설치 경로가 PATH lookup 결과보다
//      먼저 온다 — 둘 다 디스크에 존재하면 well-known 이 이긴다. 순수 함수라
//      실제 shell/fs 없이 순서 계약 자체를 테스트할 수 있다.
//   2. resolveBinOverride(): delegation.codexBin 이 delegation.claudeBin 과
//      동일한 관례(오퍼레이터가 절대경로로 고정, 기본값은 CLI 이름 자체를 쓰는
//      sentinel)로 CLI 타입별로 정확히 게이팅된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, normalize, win32 } from 'node:path';
import {
  canonicalizeResolvedBin,
  orderResolutionSources,
  resolveBinOverride,
  scanPathForBinary,
  selectBinary,
  resolveCliBin,
  _resetResolverCache,
} from '../dist/lib/cli-resolver.js';

test('orderResolutionSources: well-known candidates are ordered before PATH hits', () => {
  const ordered = orderResolutionSources(['/well/known/codex'], ['/path/hit/codex']);
  assert.deepEqual(ordered, ['/well/known/codex', '/path/hit/codex']);
});

test('orderResolutionSources: falls back to PATH-only order when no well-known candidates exist', () => {
  const ordered = orderResolutionSources([], ['/path/hit/codex']);
  assert.deepEqual(ordered, ['/path/hit/codex']);
});

test('regression (702d0ebe): a well-known npm install wins over a stray PATH hit', () => {
  // 702d0ebe 재현: PATH가 비공식/구버전 설치(예: snap)를 먼저 노출해도, 공식 npm
  // 전역 설치가 well-known 후보 목록에 있으면 그것이 선택돼야 한다.
  const npmGlobal = '/home/u/.npm-global/bin/codex'; // 공식 0.146.0
  const strayPathHit = '/snap/bin/codex'; // 비공식 0.114.0, PATH 상 먼저 노출
  const sources = orderResolutionSources([npmGlobal], [strayPathHit]);
  const picked = selectBinary('codex', sources, {
    isWindows: false,
    exists: (p) => p === npmGlobal || p === strayPathHit,
  });
  assert.equal(picked.bin, npmGlobal);
});

test('resolveBinOverride: codex uses delegation.codexBin', () => {
  assert.equal(resolveBinOverride('codex', { codexBin: '/custom/codex' }), '/custom/codex');
});

test('resolveBinOverride: codex never falls back to delegation.claudeBin', () => {
  assert.equal(resolveBinOverride('codex', { claudeBin: '/custom/claude' }), null);
});

test('resolveBinOverride: claude prefers the runtime-lease executable over delegation.claudeBin', () => {
  assert.equal(
    resolveBinOverride('claude', { claudeBin: '/custom/claude' }, '/lease/claude'),
    '/lease/claude',
  );
});

test('resolveBinOverride: claude falls back to delegation.claudeBin without a runtime lease', () => {
  assert.equal(resolveBinOverride('claude', { claudeBin: '/custom/claude' }), '/custom/claude');
});

test('resolveBinOverride: unsupported CLI types get no override', () => {
  assert.equal(resolveBinOverride('antigravity', { claudeBin: '/x', codexBin: '/y' }), null);
  assert.equal(resolveBinOverride('pi', { claudeBin: '/x', codexBin: '/y' }), null);
});

test('resolveBinOverride: a missing delegation config is handled gracefully', () => {
  assert.equal(resolveBinOverride('codex', undefined), null);
  assert.equal(resolveBinOverride('claude', null), null);
});

test('resolveCliBin: an explicit codexBin override short-circuits PATH/well-known lookup entirely', () => {
  _resetResolverCache();
  const bin = resolveCliBin('codex', '/opt/custom/codex-override');
  assert.equal(bin, normalize('/opt/custom/codex-override'));
  _resetResolverCache();
});

/** 경로 동일성 비교. 기대값은 `node:path.normalize()` 로 맞추고, Windows 에서는
 *  대소문자를 무시한다 — 두 규칙 모두 board lesson(d5f925ca)에서 왔다. */
function samePath(a, b) {
  const [x, y] = [normalize(a), normalize(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** resolveCliBin 내부의 fileExecutable 과 같은 판정(X_OK). Windows 에는 실행
 *  비트가 없어 존재 확인으로 degrade 된다. */
function accessible(p) {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function withCodexOnPath(run) {
  const dir = await mkdtemp(join(tmpdir(), 'awb-codex-resolver-'));
  const executable = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await copyFile(process.execPath, executable);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ''}`;
  try {
    return await run({ dir, executable });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    _resetResolverCache();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── canonicalizeResolvedBin ──────────────────────────────────────────────
//
// resolveCliBin 은 결과를 만드는 분기가 둘이고(shell lookup / PATH 스캔), 부하가
// 높은 Windows 러너에서는 같은 프로세스의 연속 두 호출이 서로 다른 분기를 타
// 표기가 다른 같은 경로를 돌려줬다 — `...runneradmin...codex.exe`(where) 대
// `...RUNNER~1...codex.EXE`(8.3 단축명 + PATHEXT 표기). 아래 sentinel 테스트가
// main CI 에서 그 차이로 red 였다. 정규화는 반환 직전 한 번 접는 것으로 해결하고,
// 여기서는 그 접는 함수 자체의 계약을 플랫폼 무관하게 고정한다.

test('canonicalizeResolvedBin: windows 축은 간접 경로를 디스크의 실제 경로로 편다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awb-canon-'));
  try {
    const realDir = join(root, 'real');
    await mkdir(realDir);
    const executable = join(realDir, 'codex.exe');
    await writeFile(executable, '');
    const linkDir = join(root, 'link');
    await symlink(realDir, linkDir, 'junction');

    // 같은 파일을 가리키는 두 표기(실제 경로 / 링크 경유)가 한 값으로 접혀야 한다.
    const viaLink = canonicalizeResolvedBin(join(linkDir, 'codex.exe'), true);
    const viaReal = canonicalizeResolvedBin(executable, true);
    assert.equal(viaLink, viaReal);
    assert.equal(viaReal, realpathSync.native(executable));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonicalizeResolvedBin: 존재하지 않는 경로에서도 throw 하지 않고 정규화만 한다', () => {
  // 정규화는 표기 통일일 뿐이라, 경로 조회 실패가 resolve 자체를 깨면 안 된다.
  const missing = 'C:\\nope\\..\\nope\\codex.exe';
  assert.equal(canonicalizeResolvedBin(missing, true), win32.normalize(missing));
});

test('canonicalizeResolvedBin: POSIX 축은 값을 그대로 통과시킨다', async () => {
  // POSIX 는 두 분기가 같은 join(PATH 항목, 이름) 을 만들어 갈리지 않는다. 여기서
  // realpath 를 태우면 npm bin 래퍼 symlink 를 풀어 spawn 대상이 바뀌므로, 통과
  // 시키는 것이 계약이다 — symlink 를 줘도 접히지 않아야 한다.
  const root = await mkdtemp(join(tmpdir(), 'awb-canon-posix-'));
  try {
    const target = join(root, 'codex-real');
    await writeFile(target, '');
    const wrapper = join(root, 'codex');
    await symlink(target, wrapper);
    assert.equal(canonicalizeResolvedBin(wrapper, false), wrapper);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCliBin: the codexBin sentinel default ("codex") is ignored, same as claudeBin\'s "claude"', async () => {
  // DELEGATION_DEFAULTS.codexBin defaults to the literal CLI name "codex" —
  // resolveCliBin must treat that exactly like "no override provided", not
  // try to spawn a binary literally named "codex" as a relative-path override.
  await withCodexOnPath(() => {
    _resetResolverCache();
    const withoutOverride = resolveCliBin('codex');
    _resetResolverCache();
    const withSentinel = resolveCliBin('codex', 'codex');
    assert.equal(withSentinel, withoutOverride);
  });
});

test('resolveCliBin hot-reload: override set/change/remove takes effect on the very next call, WITHOUT resetting the cache', async () => {
  // 리뷰 지적(ce65cf25 라운드1): 캐시가 cliType으로만 키잉되면 codex가 한 번
  // resolve된 뒤 reload_config/SIGHUP으로 delegation.codexBin을 설정·변경·
  // 해제해도 다음 spawn까지 stale 캐시가 계속 반환됐다. 위의 다른 테스트들은
  // 매번 _resetResolverCache() 후 override를 넣어 이 실패를 가렸으므로, 이
  // 테스트는 의도적으로 리셋 없이 연속 호출만으로 hot-reload 시나리오를
  // 재현한다.
  await withCodexOnPath(() => {
    _resetResolverCache();

  // 1) override 없이 한 번 resolve해 "no override" 캐시 엔트리를 채운다.
  const noOverride = resolveCliBin('codex');

  // 2) delegation.codexBin을 새 절대경로로 설정(reload_config 시뮬레이션) →
  //    리셋 없이 재호출해도 stale 캐시가 아니라 새 override 값을 즉시 반영.
  const overrideA = resolveCliBin('codex', '/custom/reload-a/codex');
  assert.equal(overrideA, normalize('/custom/reload-a/codex'));
  assert.notEqual(overrideA, noOverride);

  // 3) override 값을 다시 변경해도(리셋 없이) 최신 값을 반영해야 한다 — 첫
  //    override에 고착되면 안 된다.
  const overrideB = resolveCliBin('codex', '/custom/reload-b/codex');
  assert.equal(overrideB, normalize('/custom/reload-b/codex'));

  // 4) override 제거(override 없이 재호출) → 원래의 no-override 결과로
  //    정확히 복귀해야 한다 — 제거 후에도 override 캐시가 새면 안 된다.
  const afterRemoval = resolveCliBin('codex');
  assert.equal(afterRemoval, noOverride);

    _resetResolverCache();
  });
});

test('resolveCliBin hot-reload: removing an override via the sentinel default resolves identically to true no-override, without a cache reset', async () => {
  await withCodexOnPath(() => {
    _resetResolverCache();
    const noOverride = resolveCliBin('codex');
    resolveCliBin('codex', '/custom/reload-c/codex');
  // 오퍼레이터가 codexBin을 지우면 config 병합이 delegation.codexBin을
  // sentinel 기본값("codex")으로 되돌린다 — configured==='codex'는 ct와
  // 같아 "override 없음"과 동일하게 취급되고, 리셋 없이도 원래 결과로
  // 복귀해야 한다.
    const afterSentinelReset = resolveCliBin('codex', 'codex');
    assert.equal(afterSentinelReset, noOverride);
    _resetResolverCache();
  });
});

// ── shell lookup 이 빈손일 때의 PATH 스캔 fallback (티켓 6fd625bb) ──────────
//
// resolveCliBin 의 PATH lookup 은 서브프로세스(`where` / `command -v`)라 호스트
// 부하에 좌우된다. 2000ms timeout 에 걸리면 빈손으로 돌아오고, well-known 위치에
// 없는 CLI 는 PATH 에 멀쩡히 설치돼 있는데도 "executable not found" 로 죽는다
// (Windows CI 실측: `resolveCliBin: … executable not found`, duration≈2.2s =
// 정확히 그 timeout). scanPathForBinary 는 같은 후보를 서브프로세스 없이
// 결정적으로 만들어내는 fallback 이다.
//
// 아래 테스트는 board lesson(d5f925ca)대로 **호스트 설치나 POSIX 경로 표현에
// 의존하지 않는다** — exists 를 주입하고, 기대 경로는 플랫폼별 join 으로 만든다.

test('scanPathForBinary(POSIX): PATH 순서대로 실행 가능한 후보만 모은다', () => {
  const hits = scanPathForBinary('codex', ['/a/bin', '/b/bin', '/c/bin'].join(':'), {
    isWindows: false,
    exists: (p) => p === '/b/bin/codex' || p === '/c/bin/codex',
  });
  assert.deepEqual(hits, ['/b/bin/codex', '/c/bin/codex']);
});

test('scanPathForBinary(Windows): PATHEXT 를 순서대로 붙여 본다', () => {
  const dir = 'C:\\tools';
  const hits = scanPathForBinary('codex', dir, {
    isWindows: true,
    pathExt: '.COM;.EXE;.CMD',
    exists: (p) => p === `${dir}\\codex.EXE` || p === `${dir}\\codex.CMD`,
  });
  // `.exe` 와 `.cmd` 둘 다 후보로 올라오고, 실제 우선순위(진짜 exe 우선)는
  // selectBinary 가 정한다 — 스캔은 후보 수집만 책임진다.
  assert.deepEqual(hits, [`${dir}\\codex.EXE`, `${dir}\\codex.CMD`]);
});

test('scanPathForBinary(Windows): 인용부호와 빈 항목(중복 구분자)을 안전하게 다룬다', () => {
  const hits = scanPathForBinary('codex', '"C:\\q tools";;C:\\plain;', {
    isWindows: true,
    pathExt: '.EXE',
    exists: () => true,
  });
  // 빈 항목은 "현재 디렉터리"로 새면 안 되고, 인용부호는 벗겨져야 한다.
  assert.deepEqual(hits, ['C:\\q tools\\codex.EXE', 'C:\\plain\\codex.EXE']);
});

test('scanPathForBinary: PATH 가 비어 있으면 빈 목록 — 절대 literal 로 추측하지 않는다', () => {
  assert.deepEqual(scanPathForBinary('codex', undefined, { isWindows: false, exists: () => true }), []);
  assert.deepEqual(scanPathForBinary('codex', '', { isWindows: true, exists: () => true }), []);
});

test('scanPathForBinary: 실제 PATH 상의 설치본을 서브프로세스 없이 찾아낸다', async () => {
  // shell lookup 이 timeout 으로 빈손이어도 이 스캔만으로 후보가 나온다는 것을
  // 실제 파일시스템으로 확인한다 — 호스트에 codex 가 깔려 있을 필요는 없다
  // (withCodexOnPath 가 임시 실행 가능 fixture 를 만들어 PATH 앞에 붙인다).
  await withCodexOnPath(({ executable }) => {
    const hits = scanPathForBinary('codex', process.env.PATH, {
      isWindows: process.platform === 'win32',
      pathExt: process.env.PATHEXT,
      exists: (p) => accessible(p),
    });
    // Windows 파일시스템은 대소문자를 구분하지 않고, 스캔은 확장자를 PATHEXT
    // 표기 그대로(`.EXE`) 붙인다 — fixture 는 `codex.exe` 다. 경로 비교를
    // 대소문자 구분으로 하면 제품이 멀쩡한데 테스트만 깨진다(Windows CI 실측).
    assert.ok(
      hits.some((hit) => samePath(hit, executable)),
      `PATH 스캔이 fixture 설치본을 찾아야 한다: ${JSON.stringify(hits)} 안에 ${executable}`,
    );
  });
});

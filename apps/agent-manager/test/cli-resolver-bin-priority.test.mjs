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
import {
  orderResolutionSources,
  resolveBinOverride,
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
  assert.equal(bin, '/opt/custom/codex-override');
  _resetResolverCache();
});

test('resolveCliBin: the codexBin sentinel default ("codex") is ignored, same as claudeBin\'s "claude"', () => {
  // DELEGATION_DEFAULTS.codexBin defaults to the literal CLI name "codex" —
  // resolveCliBin must treat that exactly like "no override provided", not
  // try to spawn a binary literally named "codex" as a relative-path override.
  _resetResolverCache();
  const withoutOverride = resolveCliBin('codex');
  _resetResolverCache();
  const withSentinel = resolveCliBin('codex', 'codex');
  assert.equal(withSentinel, withoutOverride);
  _resetResolverCache();
});

test('resolveCliBin hot-reload: override set/change/remove takes effect on the very next call, WITHOUT resetting the cache', () => {
  // 리뷰 지적(ce65cf25 라운드1): 캐시가 cliType으로만 키잉되면 codex가 한 번
  // resolve된 뒤 reload_config/SIGHUP으로 delegation.codexBin을 설정·변경·
  // 해제해도 다음 spawn까지 stale 캐시가 계속 반환됐다. 위의 다른 테스트들은
  // 매번 _resetResolverCache() 후 override를 넣어 이 실패를 가렸으므로, 이
  // 테스트는 의도적으로 리셋 없이 연속 호출만으로 hot-reload 시나리오를
  // 재현한다.
  _resetResolverCache();

  // 1) override 없이 한 번 resolve해 "no override" 캐시 엔트리를 채운다.
  const noOverride = resolveCliBin('codex');

  // 2) delegation.codexBin을 새 절대경로로 설정(reload_config 시뮬레이션) →
  //    리셋 없이 재호출해도 stale 캐시가 아니라 새 override 값을 즉시 반영.
  const overrideA = resolveCliBin('codex', '/custom/reload-a/codex');
  assert.equal(overrideA, '/custom/reload-a/codex');
  assert.notEqual(overrideA, noOverride);

  // 3) override 값을 다시 변경해도(리셋 없이) 최신 값을 반영해야 한다 — 첫
  //    override에 고착되면 안 된다.
  const overrideB = resolveCliBin('codex', '/custom/reload-b/codex');
  assert.equal(overrideB, '/custom/reload-b/codex');

  // 4) override 제거(override 없이 재호출) → 원래의 no-override 결과로
  //    정확히 복귀해야 한다 — 제거 후에도 override 캐시가 새면 안 된다.
  const afterRemoval = resolveCliBin('codex');
  assert.equal(afterRemoval, noOverride);

  _resetResolverCache();
});

test('resolveCliBin hot-reload: removing an override via the sentinel default resolves identically to true no-override, without a cache reset', () => {
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

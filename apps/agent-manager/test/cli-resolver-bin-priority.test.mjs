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

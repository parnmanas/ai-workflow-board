// fs-browser scope enforcement (2026-08-17 dependency security audit).
//
// 배경: fs-browser 는 AWB 서버가 SSE `fs_request` 로 구동하는 reverse-RPC 로,
// 매니저 호스트의 파일시스템을 읽는다. `fs_browser.roots` 를 설정하지 않으면
// 호스트 전체를 브라우징할 수 있는 것이 ST-7 의 의도된 기본값이다. 문제는
// 운영자가 roots 를 **명시했는데도** 스코프가 조용히 사라지던 두 경로였다:
//
//   1. resolveRootsSync(): 설정한 roots 가 하나도 realpath 되지 않으면
//      "falling back to unrestricted browsing" — 마운트 해제/디렉터리 개명 같은
//      일시적 사유로 정책이 증발하고 ~/.ssh, ~/.npmrc(NPM_TOKEN),
//      ~/.config/awb-agent-manager/config.json 까지 읽기 가능해졌다.
//   2. event-dispatcher 의 lazy-construct 폴백이 fsSection 으로 `null` 을 넘겨
//      설정된 roots 를 통째로 버렸다.
//
// 두 경로 모두 fail-closed 로 뒤집었고, 이 파일이 그것을 강제한다. 일시적
// 장애에서 자동 복구되는지(재해결)도 함께 검증한다.
//
// 실행: npm run build && node --test test/fs-browser-scope.test.mjs
// (agent-manager 의 `test` 스크립트는 test/*.test.mjs 글롭이라 별도 등록 불필요.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FsBrowser } from '../dist/lib/fs-browser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'lib');

/** FsBrowser ignores its first arg beyond passing it around; a stub is enough. */
const CFG = { url: 'http://localhost:7701', apiKey: 'k', agent_id: 'a' };

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'awb-fsb-'));
  const inside = join(base, 'scope');
  mkdirSync(inside);
  writeFileSync(join(inside, 'ok.txt'), 'in-scope');
  const secret = join(base, 'secret.txt');
  writeFileSync(secret, 'SHOULD-NOT-BE-READABLE');
  return { base, inside, secret };
}

test('pinned root: in-scope reads succeed, out-of-scope is denied', async () => {
  const { inside, secret } = sandbox();
  const fsb = new FsBrowser(CFG, { roots: [inside] });

  const ok = await fsb.handle({ op: 'read', path: join(inside, 'ok.txt') });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.content, 'in-scope');

  const denied = await fsb.handle({ op: 'read', path: secret });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'SCOPE_DENIED');
});

// 이 테스트가 회귀의 핵심이다. 수정 전에는 unrestricted 로 폴백해서 ok:true 였다.
test('pinned root that does not resolve DENIES everything (fail-closed, no unrestricted fallback)', async () => {
  const { base, secret } = sandbox();
  const missing = join(base, 'never-created');
  const fsb = new FsBrowser(CFG, { roots: [missing] });

  for (const op of ['read', 'list', 'stat']) {
    const r = await fsb.handle({ op, path: secret });
    assert.equal(r.ok, false, `${op} must not succeed while scope is unresolvable`);
    assert.equal(r.code, 'SCOPE_DENIED', `${op} → ${JSON.stringify(r)}`);
  }

  // mkdir 도 같은 게이트를 통과해야 한다 (쓰기 경로).
  const mk = await fsb.handle({ op: 'mkdir', path: base, name: 'evil' });
  assert.equal(mk.ok, false);
  assert.equal(mk.code, 'SCOPE_DENIED');
});

test('broken pinned scope advertises no roots (never $HOME/cwd)', async () => {
  const { base } = sandbox();
  const fsb = new FsBrowser(CFG, { roots: [join(base, 'never-created')] });

  const r = await fsb.handle({ op: 'roots' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.roots, [], 'must not advertise default starting points');
});

test('scope self-heals once the pinned root becomes reachable', async () => {
  const { base } = sandbox();
  const late = join(base, 'late');
  const fsb = new FsBrowser(CFG, { roots: [late] });

  const before = await fsb.handle({ op: 'list', path: base });
  assert.equal(before.code, 'SCOPE_DENIED');

  mkdirSync(late);
  writeFileSync(join(late, 'f.txt'), 'hello');

  const after = await fsb.handle({ op: 'read', path: join(late, 'f.txt') });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.data.content, 'hello');

  // 복구 후에도 스코프 밖은 여전히 거부.
  const still = await fsb.handle({ op: 'read', path: join(base, 'secret.txt') });
  assert.equal(still.code, 'SCOPE_DENIED');
});

test('symlink pointing outside the pinned root cannot escape', async () => {
  const { inside, secret } = sandbox();
  const link = join(inside, 'escape');
  symlinkSync(secret, link);
  const fsb = new FsBrowser(CFG, { roots: [inside] });

  const r = await fsb.handle({ op: 'read', path: link });
  assert.equal(r.ok, false, 'realpath must resolve the link before the scope check');
  assert.equal(r.code, 'SCOPE_DENIED');
});

test('mkdir name cannot smuggle a traversal out of the pinned root', async () => {
  const { inside } = sandbox();
  const fsb = new FsBrowser(CFG, { roots: [inside] });

  for (const name of ['../evil', '..', 'a/b', 'a\\b', '']) {
    const r = await fsb.handle({ op: 'mkdir', path: inside, name });
    assert.equal(r.ok, false, `name=${JSON.stringify(name)} must be rejected`);
    assert.equal(r.code, 'PATH_INVALID');
  }
});

test('no roots configured stays unrestricted (documented ST-7 default)', async () => {
  const { secret } = sandbox();
  const fsb = new FsBrowser(CFG, null);
  const r = await fsb.handle({ op: 'read', path: secret });
  assert.equal(r.ok, true, 'default must remain unrestricted — this fix only affects pinned scopes');
});

test('relative paths are rejected before any scope logic', async () => {
  const fsb = new FsBrowser(CFG, null);
  const r = await fsb.handle({ op: 'read', path: 'etc/passwd' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATH_INVALID');
});

// --- source-level guards: keep the two fail-open shapes from coming back ---

test('fs-browser.ts has no unrestricted fallback for a configured-but-unresolved scope', () => {
  const src = readFileSync(join(SRC, 'fs-browser.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.ok(
    !/falling back to unrestricted/i.test(code),
    'the unrestricted fallback for unresolved explicit roots must not return',
  );
  // 스코프 판정은 hasExplicitRoots 기준이어야 한다. roots.length 로 게이트하면
  // "해결된 root 가 0개" 가 다시 "스코프 없음 = 전부 허용" 으로 읽힌다.
  assert.ok(
    /this\.hasExplicitRoots\s*&&\s*!this\.inScope\(/.test(code),
    'scope check must gate on hasExplicitRoots, not on roots.length',
  );
});

test('event-dispatcher lazy FsBrowser fallback preserves configured roots', () => {
  const src = readFileSync(join(SRC, 'event-dispatcher.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // 인자 안에 `(this.#config as any)` 같은 괄호가 있으므로 `[^)]*` 로는 못 잡는다.
  const ctor = code.match(/new FsBrowser\(([\s\S]*?)\);/);
  assert.ok(ctor, 'expected a lazy `new FsBrowser(...)` in event-dispatcher.ts');
  assert.ok(
    /fs_browser/.test(ctor[1]),
    `lazy fallback must pass the config's fs_browser section, got: new FsBrowser(${ctor[1]})`,
  );
});

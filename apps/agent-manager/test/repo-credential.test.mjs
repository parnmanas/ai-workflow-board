// 공유 repo credential 헬퍼 테스트 (ticket 622bc350).
//
// worktree-manager / run-provisioner 가 각자 중복 구현하던 credential 주입을 단일
// repo-credential 모듈로 통합했다. 여기서 그 모듈의 4가지 관심사를 검증한다:
//   - authenticatedCloneUrl: https 토큰 주입 / 비-http·무토큰 무변경 (순수)
//   - maskCredential: 로그 문자열에서 토큰 마스킹 (순수)
//   - installRepoCredential + scrubOriginUrl: 실제 git repo 에 awb-credentials(owner
//     전용) + credential.helper=store 설치, origin 을 clean url 로 scrub, 무토큰 no-op
//   - 구조 가드: `git clone` 을 spawn 하는 모든 src/lib 파일이 이 헬퍼를 import 하는지
//     (새 clone 경로가 구조적으로 credential-blind 될 수 없게)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, statSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  authenticatedCloneUrl,
  installRepoCredential,
  scrubOriginUrl,
  maskCredential,
} from '../dist/lib/repo-credential.js';
import { URL as NodeURL } from 'node:url';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function gitTry(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}
async function makeRepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'awb-cred-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@awb.local']);
  git(root, ['config', 'user.name', 'AWB Test']);
  git(root, ['remote', 'add', 'origin', 'https://token-user:secret@git.example.test/acme/private.git']);
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function credentialFileFromHelper(helper) {
  const match = helper.match(/^store --file=("(?:\\.|[^"])*")$/);
  assert.ok(match, `helper 형식 불일치: ${helper}`);
  return JSON.parse(match[1]);
}

// ── authenticatedCloneUrl (순수) ─────────────────────────────────────────────

test('authenticatedCloneUrl: https 에 토큰 주입, username 기본값 x-access-token', () => {
  const url = authenticatedCloneUrl('https://git.example.test/acme/r.git', { token: 'tok' });
  assert.equal(url, 'https://x-access-token:tok@git.example.test/acme/r.git');
});

test('authenticatedCloneUrl: username 지정 시 그대로 사용', () => {
  const url = authenticatedCloneUrl('https://git.example.test/acme/r.git', {
    username: 'alice',
    token: 'tok',
  });
  assert.equal(url, 'https://alice:tok@git.example.test/acme/r.git');
});

test('authenticatedCloneUrl: 무토큰 / 비-http / null 은 원본 URL 그대로', () => {
  assert.equal(
    authenticatedCloneUrl('https://git.example.test/acme/r.git', null),
    'https://git.example.test/acme/r.git',
  );
  assert.equal(
    authenticatedCloneUrl('https://git.example.test/acme/r.git', { token: '' }),
    'https://git.example.test/acme/r.git',
  );
  // ssh/git 원격은 토큰 주입 대상이 아니다 (키 인증).
  assert.equal(
    authenticatedCloneUrl('git@github.com:acme/r.git', { token: 'tok' }),
    'git@github.com:acme/r.git',
  );
});

// ── maskCredential (순수) ────────────────────────────────────────────────────

test('maskCredential: 토큰 문자열을 *** 로 치환, 무토큰이면 원문', () => {
  const leaked = 'fatal: could not read Username for https://x-access-token:supersecret@h/r.git';
  const masked = maskCredential(leaked, { token: 'supersecret' });
  assert.ok(!masked.includes('supersecret'));
  assert.ok(masked.includes('***'));
  assert.equal(maskCredential('nothing here', null), 'nothing here');
  assert.equal(maskCredential('nothing here', { token: '' }), 'nothing here');
});

test('maskCredential: URL 예약문자 토큰의 percent-encoded 형태도 clone 실패 stderr 에서 제거', () => {
  // 토큰에 URL 예약문자(`:` `?` `#`)가 있으면 authenticatedCloneUrl 은 이를
  // percent-encode 해 심는다 → raw 토큰 치환만으로는 encoded 형태가 새어나간다.
  const token = 'tok:with?reserved#chars';
  // 실제 git 이 보게 될 인증 URL: authenticatedCloneUrl 과 동일 경로(URL.password)로 생성.
  const authUrl = authenticatedCloneUrl('https://git.example.test/acme/private.git', { token });
  const encoded = new NodeURL('https://x@h.invalid');
  encoded.password = token;
  // sanity: 인코딩이 실제로 일어났고 raw 토큰과 다르다.
  assert.ok(authUrl.includes(encoded.password), 'clone URL 에 encoded 토큰이 포함돼야 함');
  assert.notEqual(encoded.password, token, '예약문자 토큰은 percent-encode 되어야 함');

  const stderr =
    `Cloning into 'private'...\n` +
    `fatal: unable to access '${authUrl}/': The requested URL returned error: 403`;
  const masked = maskCredential(stderr, { token });

  // raw 형태·encoded 형태·전체 userinfo 어느 것도 남지 않아야 한다.
  assert.ok(!masked.includes(token), 'raw 토큰 노출');
  assert.ok(!masked.includes(encoded.password), 'percent-encoded 토큰 노출');
  assert.ok(!masked.includes('x-access-token:'), 'userinfo(username:token) 노출');
  assert.ok(masked.includes('***@git.example.test'), 'userinfo 가 *** 로 redact 되어야 함');
});

test('maskCredential: 무토큰이어도 URL userinfo 는 redact (구조적 방어선)', () => {
  const leaked = "fatal: unable to access 'https://x-access-token:leaked-token@h/r.git/': 403";
  const masked = maskCredential(leaked, null);
  assert.ok(!masked.includes('leaked-token'), 'userinfo 토큰 노출');
  assert.ok(masked.includes('https://***@h/r.git'), 'userinfo 가 *** 로 redact 되어야 함');
});

// ── installRepoCredential + scrubOriginUrl (실제 git repo) ────────────────────

test('installRepoCredential: awb-credentials(owner 전용) + credential.helper=store 설치', async () => {
  const repo = await makeRepo();
  try {
    await installRepoCredential(repo.root, 'https://git.example.test/acme/private.git', {
      username: 'token-user',
      token: 'container-secret',
    });
    const helper = git(repo.root, ['config', '--local', '--get', 'credential.helper']);
    const credFile = credentialFileFromHelper(helper);
    // 절대경로여야 링크된 worktree 에서도 해석된다.
    assert.ok(isAbsolute(credFile), `credential 파일이 절대경로가 아님: ${credFile}`);
    assert.equal(credFile, join(repo.root, '.git', 'awb-credentials'));
    assert.ok(statSync(credFile).isFile(), 'awb-credentials 파일이 생성돼야 함');
    // 내용에 인증 URL(토큰 포함), POSIX 에서는 파일권한도 owner 전용(그룹/other 비트 0).
    assert.match(readFileSync(credFile, 'utf8'), /token-user:container-secret@git\.example\.test/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(credFile).mode & 0o077, 0, 'awb-credentials 는 owner 전용이어야 함');
    }
  } finally {
    await repo.cleanup();
  }
});

test('installRepoCredential: 무토큰 / 비-https 는 no-op (helper 미설정)', async () => {
  const repo = await makeRepo();
  try {
    await installRepoCredential(repo.root, 'https://git.example.test/acme/private.git', null);
    assert.equal(gitTry(repo.root, ['config', '--local', '--get', 'credential.helper']), null);
    await installRepoCredential(repo.root, 'git@github.com:acme/r.git', { token: 'tok' });
    assert.equal(gitTry(repo.root, ['config', '--local', '--get', 'credential.helper']), null);
  } finally {
    await repo.cleanup();
  }
});

test('scrubOriginUrl: origin 을 토큰 없는 clean URL 로 되돌린다', async () => {
  const repo = await makeRepo();
  try {
    const cleanUrl = 'https://git.example.test/acme/private.git';
    await scrubOriginUrl(repo.root, cleanUrl);
    assert.equal(git(repo.root, ['remote', 'get-url', 'origin']), cleanUrl);
  } finally {
    await repo.cleanup();
  }
});

// ── 구조 가드: git clone spawn 경로는 반드시 헬퍼를 경유 ────────────────────────

test('구조 가드: `git clone` 을 spawn 하는 src/lib 파일은 repo-credential 을 import 한다', () => {
  const libDir = fileURLToPath(new URL('../src/lib', import.meta.url));
  const files = readdirSync(libDir).filter((f) => f.endsWith('.ts'));
  // git 인자 배열 리터럴 `['clone'` / `[ "clone"` 를 clone 프로비저닝의 판별자로 사용
  // (fetch/pull 전용 self-update·plugin 경로는 target repo 를 clone 하지 않으므로 제외).
  const clonesRepo = /\[\s*['"]clone['"]/;
  const offenders = [];
  for (const f of files) {
    if (f === 'repo-credential.ts') continue;
    const src = readFileSync(join(libDir, f), 'utf8');
    if (!clonesRepo.test(src)) continue;
    const routed =
      src.includes("from './repo-credential.js'") && src.includes('installRepoCredential');
    if (!routed) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `git clone 을 하면서 repo-credential 헬퍼를 경유하지 않는 파일: ${offenders.join(', ')}`,
  );
  // 가드 자체가 의미 없어지지 않도록: 최소한 두 프로비저너는 잡혀야 한다.
  const cloneFiles = files.filter(
    (f) => f !== 'repo-credential.ts' && clonesRepo.test(readFileSync(join(libDir, f), 'utf8')),
  );
  assert.ok(
    cloneFiles.includes('worktree-manager.ts') && cloneFiles.includes('run-provisioner.ts'),
    `clone 프로비저너 감지 실패: ${cloneFiles.join(', ')}`,
  );
});

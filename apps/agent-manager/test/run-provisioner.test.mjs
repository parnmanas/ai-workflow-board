// QA/security run-workspace provisioning (ticket 25db3cc6 4/5; rooting moved by
// worktree 규약 ③ ticket e8ee8ee6). Covers:
//   - parseRunProvision: defensive wire parse (valid / missing fields / bad repo)
//   - provisionRunWorkspace roots the run folder at the agent's WORKING_DIR
//     (규약 ③) — `<working_dir>/.awb/qa/<leaf>` — not the manager home
//   - reuse: first run clones, second run fetch+ff-pulls into the SAME folder
//     and picks up a new upstream commit
//   - fresh: wipes the folder and re-clones (a stray file is gone afterwards)
//   - no repo: just ensures the folder exists
//   - fallback: an empty baseWorkingDir falls back to AGENT_MANAGER_HOME
//   - path traversal: a ../ workspace_folder is rejected, never rm's outside root
//   - clone failure (bad url): ok=false with an error, no exception thrown
//   - concurrency (ticket 6254fb4e): two same-folder provisionings run at once are
//     SERIALIZED (no .git/index.lock race), and the later one surfaces a wait note
//   - stale index.lock recovery (ticket 6254fb4e): an aged crash-remnant lock is
//     swept proactively; a fresh lock actively blocking a git op is reclaimed
//     reactively (fail → remove → retry). Both surface the reason in notes.
//
// The provisioner reads AGENT_MANAGER_HOME from AWB_AGENT_MANAGER_HOME at module
// load (only used as the fallback root now), so it is dynamic-imported AFTER
// pointing that env at a temp dir. `BASE` stands in for the agent's working_dir
// that the dispatcher passes in. A local bare repo stands in for the remote so
// no network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'awb-runprov-home-'));
process.env.AWB_AGENT_MANAGER_HOME = HOME;
// The agent's working_dir the dispatcher passes as baseWorkingDir (규약 ③).
const BASE = mkdtempSync(join(tmpdir(), 'awb-runprov-base-'));

const { parseRunProvision, provisionRunWorkspace, reconcileRunBaseWorkingDir } = await import('../dist/lib/run-provisioner.js');

// ── Build a local bare "remote" with one commit, return its path + a push helper.
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString();
}

function makeRemote() {
  const root = mkdtempSync(join(tmpdir(), 'awb-runprov-remote-'));
  const bare = join(root, 'origin.git');
  git(root, ['init', '--bare', '-b', 'main', bare]);
  // Seed via a working clone.
  const seed = join(root, 'seed');
  git(root, ['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), 'v1\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'v1']);
  git(seed, ['push', 'origin', 'main']);
  return {
    url: bare,
    seed,
    pushFile(name, content) {
      writeFileSync(join(seed, name), content);
      git(seed, ['add', '.']);
      git(seed, ['commit', '-m', `add ${name}`]);
      git(seed, ['push', 'origin', 'main']);
    },
  };
}

test('parseRunProvision: valid object, missing fields, and bad repo', () => {
  const ok = parseRunProvision({
    kind: 'qa',
    run_id: 'r1',
    workspace_id: 'w1',
    workspace_folder: '.awb/qa/s1',
    checkout_mode: 'reuse',
    repo: { url: 'https://x/r.git', branch: 'dev' },
  });
  assert.equal(ok.kind, 'qa');
  assert.equal(ok.workspace_folder, '.awb/qa/s1');
  assert.equal(ok.checkout_mode, 'reuse');
  assert.deepEqual(ok.repo, { url: 'https://x/r.git', branch: 'dev' });

  // Defaults + coercion: unknown checkout_mode → reuse; security kind kept.
  const sec = parseRunProvision({ kind: 'security', run_id: 'r', workspace_id: 'w', workspace_folder: 'f', checkout_mode: 'weird' });
  assert.equal(sec.kind, 'security');
  assert.equal(sec.checkout_mode, 'reuse');
  assert.equal(sec.repo, null);

  // Missing required fields / wrong type → null (ordinary chat turn).
  assert.equal(parseRunProvision(null), null);
  assert.equal(parseRunProvision({}), null);
  assert.equal(parseRunProvision({ kind: 'qa', run_id: 'r', workspace_id: 'w' }), null); // no folder
  assert.equal(parseRunProvision({ kind: 'bogus', run_id: 'r', workspace_id: 'w', workspace_folder: 'f' }), null);

  // repo without a usable url → repo null.
  const noUrl = parseRunProvision({ kind: 'qa', run_id: 'r', workspace_id: 'w', workspace_folder: 'f', repo: { branch: 'x' } });
  assert.equal(noUrl.repo, null);
});

test('reuse: rooted at working_dir; first clones, second fetch+ff-pulls the same folder', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'r1', workspace_id: 'w1', workspace_folder: '.awb/qa/reuse-s', checkout_mode: 'reuse', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);
  // 규약 ③: the run folder is rooted at the agent working_dir, NOT the manager home.
  assert.equal(first.dir, join(BASE, '.awb/qa/reuse-s'));
  assert.ok(!first.dir.startsWith(HOME), 'not rooted under the manager home');
  assert.ok(existsSync(join(first.dir, '.git')), 'cloned');
  assert.ok(first.steps.some((s) => s.startsWith('clone')), 'first run clones');
  assert.equal(readFileSync(join(first.dir, 'README.md'), 'utf8'), 'v1\n');

  // New upstream commit, then a second reuse run must pull it in (same folder).
  remote.pushFile('NEW.txt', 'hello\n');
  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true);
  assert.equal(second.dir, first.dir, 'same folder reused');
  assert.ok(second.steps.some((s) => s.startsWith('fetch')), 'second run fetches');
  assert.ok(second.steps.some((s) => s.startsWith('pull --ff-only')), 'second run ff-pulls');
  assert.ok(existsSync(join(second.dir, 'NEW.txt')), 'pulled the new upstream commit');
});

test('fresh: wipes the folder and re-clones (a stray file is gone)', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'r2', workspace_id: 'w1', workspace_folder: '.awb/qa/fresh-s', checkout_mode: 'fresh', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);
  // Drop a stray file the next fresh run must wipe.
  writeFileSync(join(first.dir, 'STRAY.txt'), 'x');
  assert.ok(existsSync(join(first.dir, 'STRAY.txt')));

  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true);
  assert.ok(second.steps.some((s) => s.startsWith('wipe')), 'fresh wipes first');
  assert.ok(second.steps.some((s) => s.startsWith('clone')), 'fresh re-clones');
  assert.ok(!existsSync(join(second.dir, 'STRAY.txt')), 'stray file gone after wipe');
  assert.ok(existsSync(join(second.dir, '.git')), 're-cloned');
});

test('no repo: ensures the folder exists without cloning', async () => {
  const r = await provisionRunWorkspace({ kind: 'security', run_id: 'r3', workspace_id: 'w1', workspace_folder: '.awb/qa/p1', checkout_mode: 'reuse', repo: null }, BASE);
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(BASE, '.awb/qa/p1'), 'rooted at working_dir');
  assert.ok(existsSync(r.dir), 'folder created');
  assert.ok(!existsSync(join(r.dir, '.git')), 'nothing cloned');
  assert.ok(r.steps.some((s) => s.includes('no repo to clone')));
});

test('fallback: an empty baseWorkingDir roots at AGENT_MANAGER_HOME (degenerate dispatch) and WARNS', async () => {
  const r = await provisionRunWorkspace({ kind: 'qa', run_id: 'r6', workspace_id: 'w1', workspace_folder: '.awb/qa/fallback-s', checkout_mode: 'reuse', repo: null }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(HOME, '.awb/qa/fallback-s'), 'falls back to the manager home when no working_dir');
  assert.ok(existsSync(r.dir), 'folder created');
  // Scope 3: the silent-misplacement path must be loud — the warning shows up in
  // the returned steps (which surface in the failure/room message), not just logs.
  assert.ok(
    r.steps.some((s) => s.includes('AGENT_MANAGER_HOME') && /폴백|규약 ③/.test(s)),
    'fallback warning surfaced in steps',
  );
});

test('reconcileRunBaseWorkingDir: server value wins on drift; cache kept when server absent/equal', () => {
  // Drift → prefer server, flag drifted + serverAuthoritative.
  const drift = reconcileRunBaseWorkingDir('D:\\Repository\\txiv\\gameclient\\txiv', 'D:\\AWBAgents\\GameClient');
  assert.equal(drift.base, 'D:\\AWBAgents\\GameClient', 'server value is authoritative on drift');
  assert.equal(drift.drifted, true);
  assert.equal(drift.serverAuthoritative, true);

  // In sync → no drift, keep cache, but re-validation DID run (server present).
  const same = reconcileRunBaseWorkingDir('/home/a/ws', '/home/a/ws');
  assert.equal(same.base, '/home/a/ws');
  assert.equal(same.drifted, false);
  assert.equal(same.serverAuthoritative, true);

  // Trailing separator only → NOT a drift (no needless heal/warn loop).
  const trail = reconcileRunBaseWorkingDir('/home/a/ws', '/home/a/ws/');
  assert.equal(trail.drifted, false, 'trailing slash is not drift');

  // Server unavailable (fetch failed → null/empty) → availability-first, keep cache.
  for (const empty of [null, undefined, '', '   ']) {
    const r = reconcileRunBaseWorkingDir('/home/a/ws', empty);
    assert.equal(r.base, '/home/a/ws', 'cache kept when server record unavailable');
    assert.equal(r.drifted, false);
    assert.equal(r.serverAuthoritative, false, 're-validation did not run');
  }

  // Empty cache but server has a value → adopt server (heals a never-hydrated base).
  const adopt = reconcileRunBaseWorkingDir('', '/home/a/ws');
  assert.equal(adopt.base, '/home/a/ws');
  assert.equal(adopt.drifted, true);
});

test('path traversal: a ../ workspace_folder is rejected and does NOT rm outside the working_dir', async () => {
  // Stand up a victim dir OUTSIDE the working_dir; a fresh checkout (rm -rf) must
  // never wipe it. The workspace_folder climbs out of BASE via ../ then targets
  // the victim — enough `..` to escape any depth of BASE under /tmp.
  const victimRoot = mkdtempSync(join(tmpdir(), 'awb-runprov-victim-'));
  const victim = join(victimRoot, 'precious');
  writeFileSync(victim, 'do not delete\n');
  assert.ok(existsSync(victim));

  const r = await provisionRunWorkspace({
    kind: 'qa',
    run_id: 'r5',
    workspace_id: 'w1',
    workspace_folder: `../../../../../../../../../..${victimRoot}`,
    checkout_mode: 'fresh',
    repo: null,
  }, BASE);
  assert.equal(r.ok, false, 'traversal rejected');
  assert.ok(/traversal/i.test(r.error || ''), 'error names the traversal');
  assert.ok(existsSync(victim), 'victim file untouched — no rm outside the working_dir');
});

test('clone failure (bad url): ok=false with an error, no throw', async () => {
  const r = await provisionRunWorkspace({
    kind: 'qa',
    run_id: 'r4',
    workspace_id: 'w1',
    workspace_folder: '.awb/qa/badurl-s',
    checkout_mode: 'reuse',
    repo: { url: join(tmpdir(), 'definitely-not-a-repo-xyz.git') },
  }, BASE);
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0, 'error captured');
  assert.ok(r.steps.some((s) => s.includes('FAIL')), 'failure recorded in steps');
});

test('concurrency: two same-folder provisionings are serialized (no index.lock race; later run notes the wait)', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'cc1', workspace_id: 'w1', workspace_folder: '.awb/qa/concurrent-s', checkout_mode: 'reuse', repo: { url: remote.url } };

  // Fire two provisionings for the SAME folder at once. Without the per-folder
  // mutex their concurrent clone/fetch/pull would collide on .git/index.lock and
  // one would die; serialized, BOTH must succeed into the same folder.
  const [a, b] = await Promise.all([
    provisionRunWorkspace(base, BASE),
    provisionRunWorkspace(base, BASE),
  ]);

  assert.equal(a.ok, true, 'first concurrent run ok');
  assert.equal(b.ok, true, 'second concurrent run ok');
  assert.equal(a.dir, join(BASE, '.awb/qa/concurrent-s'));
  assert.equal(b.dir, a.dir, 'both resolve to the same scenario folder (warm reuse preserved)');
  assert.ok(existsSync(join(a.dir, '.git')), 'clone present');

  // Neither may report a FAILED git op (the reported crash surfaces as a
  // `checkout … → FAIL: … index.lock … File exists` step + error).
  for (const r of [a, b]) {
    assert.ok(!/FAIL/.test(JSON.stringify(r.steps)), 'no failed git op (no index.lock collision)');
    assert.equal(r.error, undefined, 'no provisioning error');
  }
  // Exactly one had to wait behind the other → a single surfaced serialize note.
  const waited = [a, b].filter((r) => (r.notes || []).some((n) => n.includes('직렬화 대기')));
  assert.equal(waited.length, 1, 'exactly one run serialized behind the other and surfaced a note');
});

test('stale index.lock (aged crash remnant) is swept proactively; run proceeds and notes it', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'lk1', workspace_id: 'w1', workspace_folder: '.awb/qa/lock-s', checkout_mode: 'reuse', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);
  assert.ok(existsSync(join(first.dir, '.git')));

  // Simulate a crash remnant: an index.lock left behind, aged past the staleness
  // threshold (10s) so the proactive sweep reclaims it before any git op.
  const lockPath = join(first.dir, '.git', 'index.lock');
  writeFileSync(lockPath, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  assert.ok(existsSync(lockPath), 'lock planted');

  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true, 'run proceeds after recovery (not permanently blocked)');
  assert.ok(!existsSync(lockPath), 'stale lock removed');
  assert.ok(
    (second.notes || []).some((n) => n.includes('index.lock') && /복구/.test(n)),
    'recovery reason surfaced in notes (not silently swallowed)',
  );
});

test('fresh index.lock actively blocking a git op is reclaimed reactively and retried', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'lk2', workspace_id: 'w1', workspace_folder: '.awb/qa/lock-reactive-s', checkout_mode: 'reuse', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);

  // A new upstream commit so the second run's `pull --ff-only` actually merges (and
  // thus takes .git/index.lock). Plant a FRESH lock (age ~0) — the proactive sweep
  // leaves it (looks live), so only the reactive path (op fails on index.lock →
  // reclaim → retry) can rescue the pull.
  remote.pushFile('REACTIVE.txt', 'x\n');
  const lockPath = join(first.dir, '.git', 'index.lock');
  writeFileSync(lockPath, '');

  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true, 'run proceeds after reactive recovery');
  assert.ok(!existsSync(lockPath), 'lock removed');
  assert.ok(existsSync(join(second.dir, 'REACTIVE.txt')), 'pulled the new commit after recovery');
  assert.ok(
    (second.notes || []).some((n) => n.includes('index.lock') && /차단/.test(n)),
    'reactive (blocking) recovery reason surfaced',
  );
});

// ── credential 주입 (ticket 622bc350: run-provisioner 도 공유 헬퍼 경유) ──────────
//
// 공유 repo-credential 헬퍼를 태워 fresh clone / reuse fetch 양쪽에서 private repo
// 를 인증하되, 토큰은 steps/log/origin 에 노출되지 않고 `.git/awb-credentials`(owner
// 전용)에만 남는지 검증한다. 실제 원격 대신 로컬 bare repo 를 쓰고, 서버가 실어보낼
// 인증 URL 을 GIT_CONFIG insteadOf 로 그 로컬 원격에 매핑한다(worktree 크리덴셜
// 회귀 테스트와 동일 기법). clean URL 도 매핑해 scrub 후 fetch 가 로컬 원격에 닿게 한다.

// Windows CI (ticket e09fa003): awb-credentials 의 POSIX owner-only 권한(mode & 0o077
// === 0)·credential.helper --file= 경로 왕복을 단언한다 — Windows 는 mode 비트/백슬래시
// 경로 규약이 달라 깨진다. windows-latest 를 직접 관찰 못 해 win32 에서 명시적 skip.
// 나머지 provisioning 테스트(parse/reuse/fresh/traversal/concurrency/index.lock)는 그대로 돈다.
test('provisionRunWorkspace: credential 주입 — fresh clone origin scrub + awb-credentials, reuse fetch 인증, 토큰 비노출', {
  skip: process.platform === 'win32' && 'POSIX credential-file 권한/경로 단언 — windows-latest 미검증 (ticket e09fa003)',
}, async () => {
  const remote = makeRemote();
  const workingDir = mkdtempSync(join(tmpdir(), 'awb-runprov-cred-'));
  const cleanUrl = 'https://git.example.test/acme/priv.git';
  const authedUrl = 'https://tok-user:sekret@git.example.test/acme/priv.git';
  const prev = {
    count: process.env.GIT_CONFIG_COUNT,
    k0: process.env.GIT_CONFIG_KEY_0,
    v0: process.env.GIT_CONFIG_VALUE_0,
    k1: process.env.GIT_CONFIG_KEY_1,
    v1: process.env.GIT_CONFIG_VALUE_1,
  };
  try {
    // authed URL(clone 이 사용)과 clean URL(scrub 후 fetch 가 사용) 모두 로컬 bare 원격에 매핑.
    process.env.GIT_CONFIG_COUNT = '2';
    process.env.GIT_CONFIG_KEY_0 = `url.${remote.url}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = authedUrl;
    process.env.GIT_CONFIG_KEY_1 = `url.${remote.url}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_1 = cleanUrl;

    const p = {
      kind: 'qa',
      run_id: 'cred1',
      workspace_id: 'w1',
      workspace_folder: '.awb/qa/cred-priv',
      checkout_mode: 'reuse',
      repo: { url: cleanUrl, branch: 'main', credential: { username: 'tok-user', token: 'sekret' } },
    };

    // 1) fresh clone
    const res1 = await provisionRunWorkspace(p, workingDir);
    assert.equal(res1.ok, true, `fresh clone 실패: ${res1.error || ''}`);
    const dir = res1.dir;
    // origin 에 토큰이 남지 않는다 (clean scrub).
    const origin = git(dir, ['remote', 'get-url', 'origin']).trim();
    assert.ok(!origin.includes('sekret') && !origin.includes('tok-user@'), `origin 토큰 노출: ${origin}`);
    // awb-credentials(owner 전용) + credential.helper=store 설치. (--local: 호스트 전역
    // credential.helper=cache 가 있어도 이 repo 가 설치한 값만 본다.)
    const helper = git(dir, ['config', '--local', '--get', 'credential.helper']).trim();
    const m = helper.match(/^store --file="(.+)"$/);
    assert.ok(m, `helper 형식 불일치: ${helper}`);
    assert.match(readFileSync(m[1], 'utf8'), /tok-user:sekret@git\.example\.test/);
    assert.equal(statSync(m[1]).mode & 0o077, 0, 'awb-credentials 는 owner 전용');
    // steps/notes 어디에도 토큰이 노출되지 않는다.
    assert.ok(!res1.steps.join('\n').includes('sekret'), 'steps 토큰 노출');
    assert.ok(!(res1.notes || []).join('\n').includes('sekret'), 'notes 토큰 노출');

    // 2) reuse fetch — 새 커밋을 인증된 origin 으로 당겨온다.
    remote.pushFile('CRED_NEW.md', 'x\n');
    const res2 = await provisionRunWorkspace(p, workingDir);
    assert.equal(res2.ok, true, `reuse fetch 실패: ${res2.error || ''}`);
    assert.ok(existsSync(join(dir, 'CRED_NEW.md')), 'reuse fetch 가 새 커밋을 인증해 당겨오지 못함');
    assert.ok(!res2.steps.join('\n').includes('sekret'), 'reuse steps 토큰 노출');
  } finally {
    for (const [name, value] of Object.entries({
      GIT_CONFIG_COUNT: prev.count,
      GIT_CONFIG_KEY_0: prev.k0,
      GIT_CONFIG_VALUE_0: prev.v0,
      GIT_CONFIG_KEY_1: prev.k1,
      GIT_CONFIG_VALUE_1: prev.v1,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('parseRunProvision: repo.credential 파싱 (유효 / 토큰 없음 / username 생략)', () => {
  const withCred = parseRunProvision({
    kind: 'qa',
    run_id: 'r',
    workspace_id: 'w',
    workspace_folder: '.awb/qa/s',
    checkout_mode: 'reuse',
    repo: { url: 'https://x/r.git', credential: { username: 'u', token: 't' } },
  });
  assert.deepEqual(withCred.repo.credential, { username: 'u', token: 't' });

  // username 생략 → token 만.
  const tokenOnly = parseRunProvision({
    kind: 'qa',
    run_id: 'r',
    workspace_id: 'w',
    workspace_folder: '.awb/qa/s',
    checkout_mode: 'reuse',
    repo: { url: 'https://x/r.git', credential: { token: 't' } },
  });
  assert.deepEqual(tokenOnly.repo.credential, { token: 't' });

  // 토큰 없음/빈 문자열/비객체 → credential 미설정.
  for (const bad of [{ username: 'u' }, { token: '' }, null, 'nope', 42]) {
    const r = parseRunProvision({
      kind: 'qa',
      run_id: 'r',
      workspace_id: 'w',
      workspace_folder: '.awb/qa/s',
      checkout_mode: 'reuse',
      repo: { url: 'https://x/r.git', credential: bad },
    });
    assert.equal(r.repo.credential, undefined, `credential 이 설정되면 안 됨: ${JSON.stringify(bad)}`);
  }
});

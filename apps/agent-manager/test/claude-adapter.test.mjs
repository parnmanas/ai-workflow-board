// 유닛 테스트 — Claude CLI 어댑터 argv shape (ticket 3feaf80f).
//
// commentSent가 절대 true가 되지 않던 버그의 회귀 가드: Claude one-shot
// 티켓-멘션 dispatch가 `--print --output-format json`(배치, result-only 모드)을
// 써서 매니저의 #wireStdioCapture가 turn별 `assistant`/tool_use 이벤트를 전혀
// 보지 못했고, add_comment/move_ticket이 실제로 성공해도 `_scanForCommentTool`이
// record.commentSent를 절대 켤 수 없었다. 그 결과 클린 실행마다 "exited without
// leaving a ticket comment" 오탐 경고가 붙었고, circuit breaker의
// recordSuccess() 게이트에도 같은 오신호가 들어갔다. 수정은
// `--output-format stream-json`(+ --print 모드에서 CLI가 함께 요구하는
// `--verbose`)으로 전환해, 영속 세션이 이미 내던 것과 동일한 turn별 shape을
// oneshot도 내게 만드는 것이다.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCliAdapter, resolveClaudeSessionId } from '../dist/lib/cli-adapters/claude.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';
import { resolveEffectivePermissionPolicy } from '../dist/lib/permission-policy.js';

const tempDirs = [];

async function makeTmpCliHome() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'claude-adapter-trust-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('Claude declares NATIVE_MCP + PERSISTENT_SESSION', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION), true);
});

test('buildOneshotSpawn requests stream-json (not the batch json mode)', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  const idx = descriptor.args.indexOf('--output-format');
  assert.ok(idx >= 0, '--output-format must be present');
  assert.equal(
    descriptor.args[idx + 1],
    'stream-json',
    'oneshot must stream per-turn events, not the single end-of-run json blob — ' +
      'otherwise _scanForCommentTool never observes a tool_use and commentSent stays false forever',
  );
});

test('buildOneshotSpawn pairs stream-json with --verbose (CLI hard-requirement in --print mode)', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(
    descriptor.args.includes('--verbose'),
    '`claude --print --output-format stream-json` without --verbose exits immediately with ' +
      '"Error: When using --print, --output-format=stream-json requires --verbose"',
  );
});

test('buildOneshotSpawn still runs single-turn (--print, no --input-format) — only the OUTPUT side streams', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'the actual task',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(descriptor.args.includes('--print'));
  assert.equal(descriptor.args.includes('--input-format'), false, 'oneshot has no follow-up turn to stream in');
  assert.equal(descriptor.args.at(-1), 'the actual task', 'prompt stays a positional arg, not piped via stdin');
});

test('buildSessionSpawn is unaffected — persistent sessions already used stream-json both ways', () => {
  const adapter = new ClaudeCliAdapter();
  const descriptor = adapter.buildSessionSpawn({
    rolePrompt: 'role',
    mcpConfigPath: '/tmp/mcp.json',
  });
  assert.ok(descriptor.args.includes('--verbose'));
  assert.deepEqual(
    [descriptor.args[descriptor.args.indexOf('--input-format') + 1], descriptor.args[descriptor.args.indexOf('--output-format') + 1]],
    ['stream-json', 'stream-json'],
  );
});

test('Claude session id 경계는 유효한 UUID를 그대로 보존한다', () => {
  const id = '6BA7B810-9DAD-41D1-80B4-00C04FD430C8';
  assert.equal(resolveClaudeSessionId(id), id);
  const adapter = new ClaudeCliAdapter();
  const persistentArgs = adapter.buildSessionSpawn({
    rolePrompt: 'role',
    mcpConfigPath: '/tmp/mcp.json',
    sessionMode: 'persistent',
    sessionId: id,
  }).args;
  const resumeArgs = adapter.buildSessionSpawn({
    rolePrompt: 'role',
    mcpConfigPath: '/tmp/mcp.json',
    sessionMode: 'resume',
    sessionId: id,
  }).args;
  assert.deepEqual(persistentArgs.slice(0, 2), ['--session-id', id]);
  assert.deepEqual(resumeArgs.slice(0, 2), ['--resume', id]);
});

test('legacy room/agent 복합 key는 재시작에도 안정적인 유효 UUID로 마이그레이션된다', () => {
  const legacy = '65d5775c-dd72-4ac8-8a11-9ceefce026cf:d84c48da-dd80-4062-b546-336357e2d28e';
  const migrated = resolveClaudeSessionId(legacy);
  assert.match(migrated, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(resolveClaudeSessionId(legacy), migrated, '동일 대화 매핑은 프로세스 재생성 뒤에도 유지되어야 한다');
  assert.notEqual(resolveClaudeSessionId(`${legacy}:other-room`), migrated, '동시 대화는 provider session을 공유하면 안 된다');
});

test('최초 persistent와 reconnect resume 모두 UUID만 Claude CLI 인자로 전달한다', () => {
  const adapter = new ClaudeCliAdapter();
  const legacy = 'ticket-id:assignee:agent-id';
  const expected = resolveClaudeSessionId(legacy);
  const persistent = adapter.buildSessionSpawn({
    rolePrompt: 'role', mcpConfigPath: '/tmp/mcp.json', sessionMode: 'persistent', sessionId: legacy,
  }).args;
  const resume = adapter.buildSessionSpawn({
    rolePrompt: 'role', mcpConfigPath: '/tmp/mcp.json', sessionMode: 'resume', sessionId: legacy,
  }).args;
  assert.deepEqual(persistent.slice(0, 2), ['--session-id', expected]);
  assert.deepEqual(resume.slice(0, 2), ['--resume', expected]);
});

test('Claude provider transcript 존재 여부로 최초 생성과 resume를 구분한다', async () => {
  const adapter = new ClaudeCliAdapter();
  const home = await makeTmpCliHome();
  const legacy = 'room-a|agent-a';
  const id = resolveClaudeSessionId(legacy);
  assert.equal(await adapter.hasPersistedSession(home, legacy), false);

  const projectDir = join(home, 'projects', '-workspace-a');
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.writeFile(join(projectDir, `${id}.jsonl`), '{"type":"user"}\n');

  assert.equal(await adapter.hasPersistedSession(home, legacy), true);
  assert.equal(await adapter.hasPersistedSession(home, 'room-b|agent-a'), false, '다른 room UUID는 격리된다');
});

// ── requiresWorkspaceTrust / readTrustMeta (ticket 48aeab6e dispatch preflight) ─
//
// ticket 5851e435: 인자가 harness 가 아니라 effective permission policy 다.
// 아래 policy() 헬퍼는 실제 디스패처가 쓰는 것과 같은 resolver 를 통과시킨다.

const policy = (harnessMode, trust) =>
  resolveEffectivePermissionPolicy({ harnessMode, trust });

test('requiresWorkspaceTrust: no harness permission_mode → false (the default --dangerously-skip-permissions bypasses the dialog)', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.requiresWorkspaceTrust(), false);
  assert.equal(adapter.requiresWorkspaceTrust(null), false);
  assert.equal(adapter.requiresWorkspaceTrust(policy()), false);
});

test('requiresWorkspaceTrust: permission_mode explicitly bypassPermissions → false (same effect as the skip flag)', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.requiresWorkspaceTrust(policy('bypassPermissions')), false);
});

test('requiresWorkspaceTrust: any OTHER permission_mode → true (skip flag dropped, dialog becomes load-bearing)', () => {
  const adapter = new ClaudeCliAdapter();
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    assert.equal(adapter.requiresWorkspaceTrust(policy(mode)), true, `mode=${mode}`);
  }
});

test('requiresWorkspaceTrust: trusted Agent 는 어떤 harness 값에서도 게이트에 걸리지 않는다 (ticket 5851e435)', () => {
  const adapter = new ClaudeCliAdapter();
  for (const mode of ['default', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'auto']) {
    assert.equal(
      adapter.requiresWorkspaceTrust(policy(mode, 'trusted')),
      false,
      `harness=${mode} 인데도 trusted Agent 가 대화형 trust 게이트에 걸렸다 — ` +
        '이 조합이 바로 티켓이 없애려는 Pending 경로다',
    );
  }
});

test('requiresWorkspaceTrust: Agent trust 만으로 등급이 내려간 경우엔 새 게이트를 만들지 않는다 (ticket 5851e435)', () => {
  const adapter = new ClaudeCliAdapter();
  // harness 를 건드린 적 없는 보드(= 운영자가 사람 trust 승인을 요구한 적이
  // 없다)에서 legacy 백필로 approve/strict 가 박힌 에이전트. 폴더 trust 는
  // 도구 권한과 별개 축이므로 게이트가 새로 생기면 안 된다.
  for (const trust of ['approve', 'strict']) {
    assert.equal(adapter.requiresWorkspaceTrust(policy(null, trust)), false, `trust=${trust}`);
    assert.equal(
      adapter.requiresWorkspaceTrust(policy('bypassPermissions', trust)),
      false,
      `trust=${trust} harness=bypassPermissions`,
    );
  }
});

test('requiresWorkspaceTrust: 미인식 harness 값은 argv 와 같은 판정을 받는다 (ticket 5851e435)', () => {
  const adapter = new ClaudeCliAdapter();
  // 예전 구현은 미인식 값에 true 를 냈지만 permissionArgs 는 같은 값에
  // --dangerously-skip-permissions 를 붙였다 — 게이트가 걸려도 실제 spawn 은
  // 대화상자를 우회하므로 순수 오탐 Pending 이었다.
  const adapterArgs = adapter.buildOneshotSpawn({
    rolePrompt: 'r',
    taskText: 't',
    mcpConfigPath: '/tmp/mcp.json',
    harness: { permission_mode: 'future-mode' },
  }).args;
  assert.ok(adapterArgs.includes('--dangerously-skip-permissions'));
  assert.equal(adapter.requiresWorkspaceTrust(policy('future-mode')), false);
});

test('readTrustMeta: no .claude.json at all → confident NOT trusted (never ran interactively)', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const meta = await adapter.readTrustMeta(cliHomeDir, '/some/cwd');
  assert.deepEqual(meta, { trusted: false });
});

test('readTrustMeta: .claude.json present but this cwd has no entry → NOT trusted', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  await fsp.writeFile(
    join(cliHomeDir, '.claude.json'),
    JSON.stringify({ projects: { '/some/other/cwd': { hasTrustDialogAccepted: true } } }),
  );
  const meta = await adapter.readTrustMeta(cliHomeDir, '/some/cwd');
  assert.deepEqual(meta, { trusted: false });
});

test('readTrustMeta: hasTrustDialogAccepted true for this exact cwd → trusted', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const cwd = '/mnt/data/awb-agents/awb.programmer/.awb/wt/repo/ticket';
  await fsp.writeFile(
    join(cliHomeDir, '.claude.json'),
    JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
  );
  const meta = await adapter.readTrustMeta(cliHomeDir, cwd);
  assert.deepEqual(meta, { trusted: true });
});

test('readTrustMeta: corrupt .claude.json → null (ambiguous, fail open — never wedges a ticket on a bad file)', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  await fsp.writeFile(join(cliHomeDir, '.claude.json'), '{ not valid json');
  const meta = await adapter.readTrustMeta(cliHomeDir, '/some/cwd');
  assert.equal(meta, null);
});

// ── ensureWorkspaceTrust (ticket 152e3606 — 프로비저닝 시점 trust 시딩) ──

test('ensureWorkspaceTrust: .claude.json이 아예 없음 → 새로 만들고, 이후 cwd가 trusted로 읽힘', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const cwd = '/mnt/data/awb-agents/awb/.awb/act/6158a5ff';
  await adapter.ensureWorkspaceTrust(cliHomeDir, cwd);
  const meta = await adapter.readTrustMeta(cliHomeDir, cwd);
  assert.deepEqual(meta, { trusted: true }, '방금 프로비저닝된 워크스페이스 폴더는 trusted로 읽혀야 한다');
});

test('ensureWorkspaceTrust: 무관한 project/key가 있는 기존 .claude.json → 이 cwd만 추가하고 나머지는 보존', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const path = join(cliHomeDir, '.claude.json');
  const otherCwd = '/mnt/data/awb-agents/awb/.awb/wt/repo/other-ticket';
  await fsp.writeFile(
    path,
    JSON.stringify({
      numStartups: 12,
      oauthAccount: { emailAddress: 'ops@example.com' },
      projects: { [otherCwd]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
    }),
  );
  const cwd = '/mnt/data/awb-agents/awb/.awb/act/new-run';
  await adapter.ensureWorkspaceTrust(cliHomeDir, cwd);

  const raw = JSON.parse(await fsp.readFile(path, 'utf8'));
  assert.equal(raw.numStartups, 12, '무관한 최상위 key는 시딩 후에도 살아남아야 한다');
  assert.equal(raw.oauthAccount.emailAddress, 'ops@example.com');
  assert.equal(raw.projects[otherCwd].hasTrustDialogAccepted, true, '다른 project는 건드리지 않아야 한다');
  assert.deepEqual(raw.projects[otherCwd].allowedTools, ['Bash'], '다른 project의 필드도 건드리지 않아야 한다');
  assert.equal(raw.projects[cwd].hasTrustDialogAccepted, true, '새로 프로비저닝된 cwd는 이제 trusted여야 한다');
});

test('ensureWorkspaceTrust: 이미 trusted인 cwd → 멱등 no-op(내용 불변)', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const cwd = '/mnt/data/awb-agents/awb/.awb/act/already-trusted';
  await fsp.writeFile(
    join(cliHomeDir, '.claude.json'),
    JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true, customField: 'keep-me' } } }),
  );
  await adapter.ensureWorkspaceTrust(cliHomeDir, cwd);
  const raw = JSON.parse(await fsp.readFile(join(cliHomeDir, '.claude.json'), 'utf8'));
  assert.equal(raw.projects[cwd].hasTrustDialogAccepted, true);
  assert.equal(raw.projects[cwd].customField, 'keep-me', '이미 trusted인 cwd를 다시 시딩해도 다른 필드를 잃으면 안 된다');
});

test('ensureWorkspaceTrust: .claude.json이 손상됨 → 손대지 않고 그대로 둠(실제 CLI 상태 파괴 위험 차단)', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const path = join(cliHomeDir, '.claude.json');
  const corrupt = '{ not valid json';
  await fsp.writeFile(path, corrupt);
  await adapter.ensureWorkspaceTrust(cliHomeDir, '/some/cwd');
  const after = await fsp.readFile(path, 'utf8');
  assert.equal(after, corrupt, '있지만 손상된 파일은 덮어쓰지 않고 정확히 그대로 남아있어야 한다');
});

test('ensureWorkspaceTrust: 같은 cli-home 아래 서로 다른 cwd를 동시에 시딩해도 어느 쪽도 유실되지 않음', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  const cwdA = '/mnt/data/awb-agents/awb/.awb/act/run-a';
  const cwdB = '/mnt/data/awb-agents/awb/.awb/qa/run-b';
  // 두 호출을 동시에 발사 — cliHomeDir별 뮤텍스가 없으면 한쪽의
  // read-modify-write가 다른 쪽과 겹쳐 쓰기 경쟁에서 진 entry를 잃을 수 있다.
  await Promise.all([
    adapter.ensureWorkspaceTrust(cliHomeDir, cwdA),
    adapter.ensureWorkspaceTrust(cliHomeDir, cwdB),
  ]);
  const raw = JSON.parse(await fsp.readFile(join(cliHomeDir, '.claude.json'), 'utf8'));
  assert.equal(raw.projects[cwdA]?.hasTrustDialogAccepted, true, 'cwd A는 동시 시딩에서도 살아남아야 한다');
  assert.equal(raw.projects[cwdB]?.hasTrustDialogAccepted, true, 'cwd B는 동시 시딩에서도 살아남아야 한다');
});

test('ensureWorkspaceTrust: 성공 후 임시(.tmp-*) 파일이 남지 않는다(원자적 rename 교체)', async () => {
  const adapter = new ClaudeCliAdapter();
  const cliHomeDir = await makeTmpCliHome();
  await adapter.ensureWorkspaceTrust(cliHomeDir, '/some/cwd');
  const entries = await fsp.readdir(cliHomeDir);
  assert.deepEqual(entries, ['.claude.json'], '임시 파일 없이 최종 파일만 남아있어야 한다');
});

test(
  'ensureWorkspaceTrust: 쓰기 실패(디렉터리 read-only) 시 원본 파일 내용이 그대로 보존된다',
  // win32는 디렉터리 chmod가 그 안의 새 파일 생성(임시 파일 쓰기)을 막지
  // 않는다 — POSIX 권한 모델이 없어 이 실패 주입 자체가 성립하지 않는다
  // (CI 2026-08-23: windows-latest에서 rejects 기대가 충족되지 않아 적발).
  { skip: process.platform === 'win32' && 'win32는 디렉터리 chmod로 쓰기를 막지 못해 이 실패 주입이 성립하지 않음' },
  async () => {
    const adapter = new ClaudeCliAdapter();
    const cliHomeDir = await makeTmpCliHome();
    const path = join(cliHomeDir, '.claude.json');
    const original = JSON.stringify({ projects: { '/other/cwd': { hasTrustDialogAccepted: true } } });
    await fsp.writeFile(path, original);
    await fsp.chmod(cliHomeDir, 0o500); // 디렉터리 쓰기 금지 → 임시 파일 생성 자체가 실패
    try {
      await assert.rejects(
        () => adapter.ensureWorkspaceTrust(cliHomeDir, '/mnt/data/awb-agents/awb/.awb/wt/repo/write-fail'),
        '디렉터리 쓰기 실패는 호출자에게 그대로 전파돼야 한다(best-effort 흡수는 event-dispatcher 쪽 책임)',
      );
      const after = await fsp.readFile(path, 'utf8');
      assert.equal(after, original, '임시 파일 쓰기가 실패해도 원본은 truncate조차 되지 않고 그대로 남아야 한다');
    } finally {
      await fsp.chmod(cliHomeDir, 0o700); // afterEach의 재귀 삭제가 지울 수 있도록 권한 복구
    }
  },
);

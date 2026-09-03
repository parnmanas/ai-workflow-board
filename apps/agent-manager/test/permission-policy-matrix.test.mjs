// 회귀 테스트 — Agent trust → CLI 실행 권한 플래그 매핑 (ticket 5851e435).
//
// 배경: Agent `runtime_config.permission_mode`(strict/approve/trusted)와
// board/workspace harness `permission_mode` 가 별도 계층으로 존재했고, CLI
// adapter 들은 후자만 봤다. 그래서 `trusted` 로 표시된 에이전트라도 보드에
// harness permission_mode 가 하나 걸려 있으면
//   - claude 는 `--dangerously-skip-permissions` 를 잃어 workspace trust
//     대화상자가 다시 load-bearing 이 되고(→ dispatch Pending),
//   - codex 는 `--dangerously-bypass-approvals-and-sandbox` 대신 제한
//     sandbox 로 내려갔다.
//
// 이 파일은 **실제 어댑터의 buildOneshotSpawn/buildSessionSpawn 이 만든 argv**
// 를 직접 단언한다(문자열 스캔이나 테스트 내부 argv 모사가 아니다). CLI ×
// strict/approve/trusted 전 조합, trusted × 충돌 harness 전 조합, 그리고 Agent
// trust 가 없던 시절의 legacy harness 경로까지 함께 고정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { DeepSeekCliAdapter } from '../dist/lib/cli-adapters/deepseek.js';
import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { AntigravityCliAdapter } from '../dist/lib/cli-adapters/antigravity.js';
import { PiCliAdapter } from '../dist/lib/cli-adapters/pi.js';
import { describeSpawnArgv } from '../dist/lib/cli-adapters/base.js';
import { createRuntimeCliAdapter, getRuntimeDescriptor } from '../dist/lib/runtime/runtime-registry.js';
import {
  PERMISSION_TIERS,
  describePermissionPolicy,
  describePermissionSupport,
  harnessModeTier,
  normalizeTrust,
  permissionPolicyOrDefault,
  resolveEffectivePermissionPolicy,
} from '../dist/lib/permission-policy.js';

const policy = (trust, harnessMode) => resolveEffectivePermissionPolicy({ trust, harnessMode });

function oneshot(adapter, permission, harness) {
  return adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: '/tmp/mcp.json',
    permission,
    harness,
  }).args;
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── 순수 resolver: precedence ──────────────────────────────────────────────

test('resolver: Agent trust 가 harness permission_mode 를 이긴다', () => {
  const p = policy('trusted', 'acceptEdits');
  assert.equal(p.tier, 'trusted');
  assert.equal(p.source, 'agent_trust');
  assert.equal(p.harnessMode, 'acceptEdits');
  assert.equal(p.harnessTier, 'approve');
  assert.equal(p.harnessOverridden, true, 'harness 가 실제로 덮어써졌다는 사실이 드러나야 한다');
});

test('resolver: Agent trust 가 없으면 legacy harness 규칙 그대로', () => {
  assert.deepEqual(
    { tier: policy(null, 'acceptEdits').tier, source: policy(null, 'acceptEdits').source },
    { tier: 'approve', source: 'harness' },
  );
  assert.equal(policy(null, 'plan').tier, 'strict');
  assert.equal(policy(null, 'bypassPermissions').tier, 'trusted');
  assert.equal(policy(null, null).tier, 'trusted');
  assert.equal(policy(null, null).source, 'default');
});

test('resolver: 미인식 harness 값은 이 티켓 이전 동작대로 최고 권한 폴백', () => {
  // 미인식 harness 문자열은 이 티켓 이전에도 claude/codex 모두 최고 권한으로
  // 폴백했다 — 그 동작을 그대로 고정한다.
  assert.equal(harnessModeTier('future-mode'), 'trusted');
  assert.equal(harnessModeTier(''), 'trusted');
  assert.equal(harnessModeTier(undefined), 'trusted');
});

test('resolver: 미인식 Agent trust 는 최소 권한으로 fail-closed 한다 (리뷰 지적 #3)', () => {
  // 손상된 config / 손으로 편집한 DB / 매니저보다 새 서버가 보낸 미지의 등급
  // 하나가 harness·기본값 폴백을 타고 최고 권한을 켜면 안 된다.
  for (const bad of ['supertrusted', 'TRUSTED ', 'trusted!', 'yes', '0', 'null', '{}']) {
    const p = policy(bad, null);
    assert.equal(p.tier, 'strict', `trust=${JSON.stringify(bad)} 가 최소 권한으로 내려가지 않았다`);
    assert.equal(p.source, 'invalid_trust', `trust=${JSON.stringify(bad)}`);
    assert.equal(p.trust, null);
    assert.ok(p.invalidTrust, '거부된 원본 값이 진단용으로 보존돼야 한다');
  }
});

test('resolver: 미인식 trust 는 harness 가 bypass 를 허용해도 최고 권한으로 새지 않는다', () => {
  const p = policy('supertrusted', 'bypassPermissions');
  assert.equal(p.tier, 'strict');
  assert.equal(p.source, 'invalid_trust');
  // harness 가 trusted 를 요구했더라도 fail-closed 가 이긴다.
  assert.equal(p.harnessTier, 'trusted');
});

test('resolver: 진짜 미설정(null/undefined/공백)은 fail-closed 대상이 아니다', () => {
  // legacy 에이전트를 미인식 값과 같이 취급하면 harness 없는 보드 전체가
  // strict 로 떨어져 이 티켓이 없애려는 실패 모드가 재현된다.
  for (const unset of [null, undefined, '', '   ']) {
    const p = policy(unset, null);
    assert.equal(p.tier, 'trusted', `trust=${JSON.stringify(unset)}`);
    assert.equal(p.source, 'default');
    assert.equal(p.invalidTrust, null);
  }
  assert.equal(policy('', 'acceptEdits').source, 'harness');
  assert.equal(policy('', 'acceptEdits').tier, 'approve');
  assert.equal(normalizeTrust('supertrusted'), null);
});

test('claude/codex: 미인식 trust 는 실제 argv 에서도 최소 권한이다 (리뷰 지적 #3)', () => {
  const claude = oneshot(new ClaudeCliAdapter(), policy('supertrusted', 'bypassPermissions'));
  assert.equal(flagValue(claude, '--permission-mode'), 'plan');
  assert.equal(claude.includes('--dangerously-skip-permissions'), false);

  const codex = oneshot(new CodexCliAdapter(), policy('supertrusted', 'bypassPermissions'));
  assert.equal(flagValue(codex, '--sandbox'), 'read-only');
  assert.equal(codex.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  for (const adapter of [new AntigravityCliAdapter(), new PiCliAdapter()]) {
    const args = oneshot(adapter, policy('supertrusted', 'bypassPermissions'));
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args.includes('--approve'), false);
  }
});

test('resolver: 같은 등급 안에서는 harness 가 구체적 모드를 계속 고른다', () => {
  const p = policy('approve', 'manual');
  assert.equal(p.tier, 'approve');
  assert.equal(p.harnessOverridden, false, '같은 등급이면 덮어쓴 게 아니다');
  assert.equal(p.harnessMode, 'manual');
});

test('permissionPolicyOrDefault: 정책이 없으면 harness 로, 둘 다 없으면 trusted', () => {
  assert.equal(permissionPolicyOrDefault(null, 'plan').tier, 'strict');
  assert.equal(permissionPolicyOrDefault(null, 'plan').source, 'harness');
  assert.equal(permissionPolicyOrDefault(null, null).tier, 'trusted');
  assert.equal(permissionPolicyOrDefault(policy('strict'), 'bypassPermissions').tier, 'strict',
    '명시된 정책이 있으면 harness 폴백은 쓰이지 않는다');
});

// ── CLI × tier 매트릭스: 실제 spawn args ───────────────────────────────────

test('claude: strict/approve/trusted 매트릭스가 실제 argv 로 내려간다', () => {
  const adapter = new ClaudeCliAdapter();

  const trusted = oneshot(adapter, policy('trusted'));
  assert.ok(trusted.includes('--dangerously-skip-permissions'), 'trusted 는 최고 권한 플래그');
  assert.equal(trusted.includes('--permission-mode'), false,
    '스킵 플래그가 bypassPermissions 를 핀하므로 --permission-mode 와 함께 나오면 안 된다');

  const approve = oneshot(adapter, policy('approve'));
  assert.equal(flagValue(approve, '--permission-mode'), 'acceptEdits');
  assert.equal(approve.includes('--dangerously-skip-permissions'), false);

  const strict = oneshot(adapter, policy('strict'));
  assert.equal(flagValue(strict, '--permission-mode'), 'plan');
  assert.equal(strict.includes('--dangerously-skip-permissions'), false);
});

test('claude: 세션 spawn 도 같은 매트릭스를 따른다', () => {
  const adapter = new ClaudeCliAdapter();
  const session = (permission) =>
    adapter.buildSessionSpawn({ rolePrompt: 'r', mcpConfigPath: '/tmp/mcp.json', permission }).args;

  assert.ok(session(policy('trusted')).includes('--dangerously-skip-permissions'));
  assert.equal(flagValue(session(policy('approve')), '--permission-mode'), 'acceptEdits');
  assert.equal(flagValue(session(policy('strict')), '--permission-mode'), 'plan');
  assert.equal(session(policy('strict')).includes('--dangerously-skip-permissions'), false);
});

test('deepseek: claude 어댑터를 상속하므로 동일한 매트릭스', () => {
  const adapter = new DeepSeekCliAdapter();
  assert.ok(oneshot(adapter, policy('trusted')).includes('--dangerously-skip-permissions'));
  assert.equal(flagValue(oneshot(adapter, policy('approve')), '--permission-mode'), 'acceptEdits');
  assert.equal(flagValue(oneshot(adapter, policy('strict')), '--permission-mode'), 'plan');
});

test('codex: strict/approve/trusted 매트릭스가 실제 argv 로 내려간다', () => {
  const adapter = new CodexCliAdapter();

  const trusted = oneshot(adapter, policy('trusted'));
  assert.ok(trusted.includes('--dangerously-bypass-approvals-and-sandbox'),
    'codex trusted 는 최고 권한 flag 가 보장돼야 한다');
  assert.equal(trusted.includes('--sandbox'), false);

  const approve = oneshot(adapter, policy('approve'));
  assert.equal(flagValue(approve, '--sandbox'), 'workspace-write');
  assert.ok(approve.includes('approval_policy="never"'),
    '비대화형 exec 이라 승인 프롬프트가 뜨면 답할 사람이 없다');
  assert.equal(approve.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  const strict = oneshot(adapter, policy('strict'));
  assert.equal(flagValue(strict, '--sandbox'), 'read-only');
  assert.ok(strict.includes('approval_policy="never"'));
  assert.equal(strict.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('antigravity: trusted 만 bypass 플래그를 받고 나머지는 명시적으로 뺀다', () => {
  const adapter = new AntigravityCliAdapter();
  assert.ok(oneshot(adapter, policy('trusted')).includes('--dangerously-skip-permissions'));
  for (const tier of ['approve', 'strict']) {
    assert.equal(
      oneshot(adapter, policy(tier)).includes('--dangerously-skip-permissions'),
      false,
      `tier=${tier} 인데 최고 권한 플래그가 그대로 붙었다 — 조용한 권한 상향이다`,
    );
  }
});

test('pi: trusted 만 --approve 를 받고, --no-session 은 모든 등급에서 유지된다', () => {
  const adapter = new PiCliAdapter();
  const trusted = oneshot(adapter, policy('trusted'));
  assert.ok(trusted.includes('--approve'));
  assert.ok(trusted.includes('--no-session'));
  for (const tier of ['approve', 'strict']) {
    const args = oneshot(adapter, policy(tier));
    assert.equal(args.includes('--approve'), false, `tier=${tier}`);
    assert.ok(args.includes('--no-session'), `tier=${tier} 에서도 세션 누적 방지는 유지된다`);
  }
});

// ── trusted × 충돌 harness: 어디서도 대화형으로 내려가지 않는다 ────────────

const CONFLICTING_HARNESS_MODES = ['default', 'acceptEdits', 'manual', 'auto', 'dontAsk', 'plan'];

test('trusted Agent 는 충돌하는 harness 값에서도 모든 CLI 에서 최고 권한을 유지한다', () => {
  const cases = [
    { adapter: new ClaudeCliAdapter(), flag: '--dangerously-skip-permissions' },
    { adapter: new DeepSeekCliAdapter(), flag: '--dangerously-skip-permissions' },
    { adapter: new CodexCliAdapter(), flag: '--dangerously-bypass-approvals-and-sandbox' },
    { adapter: new AntigravityCliAdapter(), flag: '--dangerously-skip-permissions' },
    { adapter: new PiCliAdapter(), flag: '--approve' },
  ];
  for (const { adapter, flag } of cases) {
    for (const mode of CONFLICTING_HARNESS_MODES) {
      const harness = { permission_mode: mode };
      const args = oneshot(adapter, policy('trusted', mode), harness);
      assert.ok(
        args.includes(flag),
        `cli=${adapter.constructor.cliType} harness=${mode}: trusted 인데 ${flag} 를 잃었다`,
      );
      assert.equal(
        args.includes('--permission-mode'),
        false,
        `cli=${adapter.constructor.cliType} harness=${mode}: 대화형 permission 모드로 내려갔다`,
      );
    }
  }
});

// ── legacy(=Agent trust 미설정) 경로: 기존 안전 경계 유지 ──────────────────

test('legacy: Agent trust 가 없으면 harness 문자열이 이 티켓 이전과 똑같은 argv 를 만든다', () => {
  const claude = new ClaudeCliAdapter();
  // 정책을 아예 넘기지 않는 호출자(어댑터 직접 호출)도 harness 를 존중한다.
  assert.equal(flagValue(oneshot(claude, undefined, { permission_mode: 'acceptEdits' }), '--permission-mode'), 'acceptEdits');
  assert.equal(flagValue(oneshot(claude, undefined, { permission_mode: 'default' }), '--permission-mode'), 'auto',
    'AWB 표기 default 는 CLI 가 아는 auto 로 정규화된다');
  assert.equal(flagValue(oneshot(claude, undefined, { permission_mode: 'manual' }), '--permission-mode'), 'manual');
  assert.equal(flagValue(oneshot(claude, undefined, { permission_mode: 'plan' }), '--permission-mode'), 'plan');
  assert.ok(oneshot(claude, undefined, { permission_mode: 'bypassPermissions' }).includes('--dangerously-skip-permissions'));
  assert.ok(oneshot(claude, undefined, { permission_mode: 'future-mode' }).includes('--dangerously-skip-permissions'),
    '미인식 값은 CLI 를 하드 실패시키지 않고 종전대로 스킵 플래그로 폴백한다');

  const codex = new CodexCliAdapter();
  assert.equal(flagValue(oneshot(codex, undefined, { permission_mode: 'plan' }), '--sandbox'), 'read-only');
  assert.equal(flagValue(oneshot(codex, undefined, { permission_mode: 'acceptEdits' }), '--sandbox'), 'workspace-write');
  assert.ok(oneshot(codex, undefined, { permission_mode: 'bypassPermissions' }).includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('legacy: 명시된 정책이 있으면 harness 폴백을 무시한다(정책이 기준)', () => {
  const claude = new ClaudeCliAdapter();
  const args = oneshot(claude, policy('trusted', 'plan'), { permission_mode: 'plan' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.equal(args.includes('--permission-mode'), false);
});

// ── capabilities: 근사/미지원을 조용히 넘기지 않는다 ───────────────────────

test('permissionCapabilities: 어떤 CLI 도 approve 를 native 로 주장하지 않는다 (리뷰 지적 #2)', () => {
  // approve 의 요구된 의미는 "AWB 에 승인을 요청한다"이다. CLI 어댑터에는 실행
  // 중 권한 요청을 밖으로 노출하는 훅이 없어 그 의미를 구현할 수 없으므로,
  // 전용 플래그가 있다는 이유로 native 라고 선언하면 능력을 과장하게 된다.
  for (const adapter of [
    new ClaudeCliAdapter(), new DeepSeekCliAdapter(), new CodexCliAdapter(),
    new AntigravityCliAdapter(), new PiCliAdapter(),
  ]) {
    const caps = adapter.permissionCapabilities();
    const cli = adapter.constructor.cliType;
    assert.equal(caps.native_approvals, false, `${cli}: CLI 는 승인 브릿지가 없다`);
    assert.notEqual(caps.tiers.approve, 'native', `${cli}: approve 를 native 로 주장하면 안 된다`);
    assert.ok(PERMISSION_TIERS.every((t) => caps.tiers[t]), `${cli}: 세 등급이 모두 선언돼야 한다`);
  }
});

test('permissionCapabilities: 등급별 표현력이 어댑터마다 정확히 선언돼 있다', () => {
  for (const adapter of [new ClaudeCliAdapter(), new DeepSeekCliAdapter(), new CodexCliAdapter()]) {
    const caps = adapter.permissionCapabilities();
    assert.deepEqual(caps.tiers, { strict: 'native', approve: 'approximated', trusted: 'native' },
      adapter.constructor.cliType);
  }
  for (const adapter of [new AntigravityCliAdapter(), new PiCliAdapter()]) {
    const caps = adapter.permissionCapabilities();
    assert.deepEqual(caps.tiers, { strict: 'approximated', approve: 'approximated', trusted: 'native' },
      adapter.constructor.cliType);
  }
});

test('permission_tiers: heartbeat 로 보고되는 런타임 capability 가 어댑터 선언과 일치한다', () => {
  // 운영자가 admin 에서 보는 능력 선언과 실제 spawn 동작이 어긋나면 안 되므로,
  // 두 곳이 같은 상수에서 나오는지 드리프트 가드를 건다.
  for (const id of ['claude', 'deepseek', 'codex', 'antigravity', 'pi']) {
    assert.deepEqual(
      getRuntimeDescriptor(id).capabilities.permission_tiers,
      createRuntimeCliAdapter(id).permissionCapabilities().tiers,
      `runtime=${id}`,
    );
  }
  // Hermes 는 CliAdapter 가 아니라 ACP 런타임이라 어댑터가 없다 — 유일하게
  // 세 등급을 요구된 의미 그대로 구현한다.
  const hermes = getRuntimeDescriptor('hermes').capabilities;
  assert.equal(hermes.native_approvals, true);
  assert.deepEqual(hermes.permission_tiers, { strict: 'native', approve: 'native', trusted: 'native' });
});

test('describePermissionSupport: approve 가 승인 요청을 만들지 못한다는 사실을 명시한다', () => {
  const agy = new AntigravityCliAdapter();
  assert.equal(
    describePermissionSupport('antigravity', policy('trusted'), agy.permissionCapabilities()),
    null,
    'native 등급은 잡음을 내지 않는다',
  );
  const gap = describePermissionSupport('antigravity', policy('strict'), agy.permissionCapabilities());
  assert.ok(gap && gap.includes('support=approximated'), gap ?? '(null)');

  const claude = new ClaudeCliAdapter();
  const approveGap = describePermissionSupport('claude', policy('approve'), claude.permissionCapabilities());
  assert.ok(approveGap && approveGap.includes('native_approvals=false'), approveGap ?? '(null)');
  assert.ok(approveGap.includes('support=approximated'), approveGap);
});

test('describePermissionPolicy: 진단 문자열에 등급/출처/충돌이 담긴다', () => {
  const line = describePermissionPolicy(policy('trusted', 'acceptEdits'));
  assert.ok(line.includes('tier=trusted'), line);
  assert.ok(line.includes('source=agent_trust'), line);
  assert.ok(line.includes('harness_mode=acceptEdits'), line);
  assert.ok(line.includes('harness_tier_overridden=approve'), line);
});

// ── spawn argv 진단 로그: secret 없이 남긴다 ──────────────────────────────

test('describeSpawnArgv: 플래그는 보이고 긴 프롬프트는 접힌다', () => {
  const claude = new ClaudeCliAdapter();
  const args = claude.buildOneshotSpawn({
    rolePrompt: 'r'.repeat(200),
    taskText: 't'.repeat(500),
    mcpConfigPath: '/tmp/mcp.json',
    permission: policy('trusted'),
  }).args;
  const rendered = describeSpawnArgv(args);

  assert.ok(rendered.includes('--dangerously-skip-permissions'),
    '권한 플래그가 실제로 붙었는지 로그만으로 확인할 수 있어야 한다');
  assert.ok(rendered.includes('--append-system-prompt'));
  assert.equal(rendered.includes('r'.repeat(200)), false, '역할 프롬프트 본문이 그대로 새면 안 된다');
  assert.equal(rendered.includes('t'.repeat(500)), false, 'task text 본문이 그대로 새면 안 된다');
  assert.ok(/<\d+ch>/.test(rendered), '접힌 값은 길이 표시로 남는다');
});

test('describeSpawnArgv: 짧은 프롬프트도 평문으로 남기지 않는다 (리뷰 지적 #1)', () => {
  // 길이 기반 휴리스틱("60자 이하면 평문")은 짧은 티켓/채팅 본문을 그대로
  // 노출한다. antigravity/pi 는 프롬프트를 argv 에 직접 싣는다.
  const secretish = '김철수 주민번호 알려줘';
  for (const adapter of [new AntigravityCliAdapter(), new PiCliAdapter()]) {
    const args = adapter.buildOneshotSpawn({
      rolePrompt: '',
      taskText: secretish,
      mcpConfigPath: null,
      permission: policy('trusted'),
    }).args;
    const rendered = describeSpawnArgv(args);
    assert.equal(
      rendered.includes(secretish),
      false,
      `${adapter.constructor.cliType}: 짧은 프롬프트가 로그에 평문으로 남았다 — ${rendered}`,
    );
    assert.ok(rendered.includes('-p'), '플래그 자체는 계속 보여야 한다');
  }

  // claude 의 마지막 positional(task text)도 마찬가지.
  const claudeArgs = new ClaudeCliAdapter().buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: secretish,
    mcpConfigPath: '/tmp/mcp.json',
    permission: policy('trusted'),
  }).args;
  assert.equal(describeSpawnArgv(claudeArgs).includes(secretish), false);
});

test('describeSpawnArgv: secret 키워드가 없는 짧은 토큰도 평문으로 남기지 않는다 (리뷰 지적 #1)', () => {
  // `sk-...` 류는 어떤 secret 키워드에도 걸리지 않는다 — 키워드 매칭이 아니라
  // allowlist 기반이어야만 막힌다.
  for (const token of ['sk-ant-api03-abc123', 'ghp_0123456789abcdef', 'eyJhbGciOiJIUzI1NiJ9.x.y']) {
    const rendered = describeSpawnArgv(['--some-flag', token, token]);
    assert.equal(rendered.includes(token), false, `토큰이 로그에 남았다: ${rendered}`);
    assert.ok(rendered.includes('--some-flag'), rendered);
  }
  // 결합형 `--flag=value` 도 값 부분이 접힌다.
  const inline = describeSpawnArgv(['--token=sk-ant-abc123']);
  assert.equal(inline.includes('sk-ant-abc123'), false, inline);
  assert.ok(inline.startsWith('--token=<'), inline);
});

test('describeSpawnArgv: 진단에 필요한 비민감 플래그 값만 allowlist 로 남는다', () => {
  const rendered = describeSpawnArgv([
    '--model', 'claude-opus-5',
    '--permission-mode', 'plan',
    '--sandbox', 'read-only',
    '--output-format', 'stream-json',
    '--effort', 'high',
  ]);
  for (const value of ['claude-opus-5', 'plan', 'read-only', 'stream-json', 'high']) {
    assert.ok(rendered.includes(value), `${value} 가 진단 로그에서 사라졌다: ${rendered}`);
  }
  // 도구 목록/경로처럼 allowlist 밖의 값은 길이만 남는다.
  const tools = describeSpawnArgv(['--allowedTools', 'mcp__awb__*,mcp__host__*']);
  assert.equal(tools.includes('mcp__awb__*'), false, tools);
  assert.ok(/^--allowedTools <\d+ch>$/.test(tools), tools);
});

test('describeSpawnArgv: codex -c 는 값 모양으로 판정한다', () => {
  // 같은 -c 로 approval_policy 도, MCP 헤더 테이블도 넘어간다.
  const policyArg = describeSpawnArgv(['-c', 'approval_policy="never"']);
  assert.ok(policyArg.includes('approval_policy="never"'), policyArg);

  const mcpTable = describeSpawnArgv(['-c', 'mcp_servers.awb={ "url" = "https://awb.example/mcp" }']);
  assert.equal(mcpTable.includes('awb.example'), false, mcpTable);
  assert.ok(/^-c <\d+ch>$/.test(mcpTable), mcpTable);

  // 서브커맨드는 명시 allowlist 로만 보인다.
  assert.ok(describeSpawnArgv(['exec', '--json']).startsWith('exec '));
});

test('describeSpawnArgv: secret 모양 토큰은 길이조차 남기지 않는다', () => {
  assert.equal(describeSpawnArgv(['--header', 'Authorization: Bearer abc']), '--header <redacted>');
  assert.equal(describeSpawnArgv(['-c', 'x_api_key="s3cr3t"']), '-c <redacted>');
});

test('describeSpawnArgv: 실제 codex/pi spawn argv 전체가 사용자 데이터를 남기지 않는다', () => {
  // 어댑터가 만든 진짜 argv를 통째로 통과시켜, 새 인자가 추가돼도 기본이
  // "차단"인지 확인한다.
  const prompt = 'secret-task-body-xyz';
  const cases = [
    new CodexCliAdapter().buildOneshotSpawn({
      rolePrompt: 'role-secret-abc', taskText: prompt, mcpConfigPath: null,
      cwd: '/ws/.awb/wt/t', permission: policy('approve'),
    }).args,
    new PiCliAdapter().buildOneshotSpawn({
      rolePrompt: 'role-secret-abc', taskText: prompt, mcpConfigPath: null,
      permission: policy('strict'),
    }).args,
  ];
  for (const args of cases) {
    const rendered = describeSpawnArgv(args);
    assert.equal(rendered.includes(prompt), false, rendered);
    assert.equal(rendered.includes('role-secret-abc'), false, rendered);
    assert.equal(rendered.includes('/ws/.awb/wt/t'), false, `cwd 경로도 값이다: ${rendered}`);
  }
});

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

test('resolver: 미인식 값은 조용히 다른 등급으로 새지 않는다', () => {
  // 미인식 harness 문자열은 이 티켓 이전에도 claude/codex 모두 최고 권한으로
  // 폴백했다 — 그 동작을 그대로 고정한다.
  assert.equal(harnessModeTier('future-mode'), 'trusted');
  assert.equal(harnessModeTier(''), 'trusted');
  assert.equal(harnessModeTier(undefined), 'trusted');
  // 미인식 trust 문자열은 trust 미설정으로 떨어져 harness 로 넘어간다.
  assert.equal(normalizeTrust('supertrusted'), null);
  assert.equal(policy('supertrusted', 'plan').tier, 'strict');
  assert.equal(policy('supertrusted', 'plan').source, 'harness');
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

test('permissionCapabilities: 어댑터별 등급 표현력이 선언돼 있다', () => {
  for (const adapter of [new ClaudeCliAdapter(), new DeepSeekCliAdapter(), new CodexCliAdapter()]) {
    const caps = adapter.permissionCapabilities();
    for (const tier of PERMISSION_TIERS) {
      assert.equal(caps.tiers[tier], 'native', `${adapter.constructor.cliType} tier=${tier}`);
    }
  }
  for (const adapter of [new AntigravityCliAdapter(), new PiCliAdapter()]) {
    const caps = adapter.permissionCapabilities();
    assert.equal(caps.tiers.trusted, 'native');
    assert.equal(caps.tiers.approve, 'approximated');
    assert.equal(caps.tiers.strict, 'approximated');
  }
});

test('describePermissionSupport: 근사 등급과 승인 브릿지 부재를 문장으로 드러낸다', () => {
  const agy = new AntigravityCliAdapter();
  assert.equal(
    describePermissionSupport('antigravity', policy('trusted'), agy.permissionCapabilities()),
    null,
    'native 등급은 잡음을 내지 않는다',
  );
  const gap = describePermissionSupport('antigravity', policy('strict'), agy.permissionCapabilities());
  assert.ok(gap && gap.includes('support=approximated'), gap ?? '(null)');

  // CLI 어댑터에는 실행 중 권한 요청을 AWB 승인으로 중계할 경로가 없다.
  // approve 등급을 CLI 에서 쓸 때 그 사실이 로그로 드러나야 한다.
  const claude = new ClaudeCliAdapter();
  const approveGap = describePermissionSupport('claude', policy('approve'), claude.permissionCapabilities());
  assert.ok(approveGap && approveGap.includes('native_approvals=false'), approveGap ?? '(null)');
  assert.equal(claude.permissionCapabilities().native_approvals, false);
});

test('describePermissionPolicy: 진단 문자열에 등급/출처/충돌이 담긴다', () => {
  const line = describePermissionPolicy(policy('trusted', 'acceptEdits'));
  assert.ok(line.includes('tier=trusted'), line);
  assert.ok(line.includes('source=agent_trust'), line);
  assert.ok(line.includes('harness_mode=acceptEdits'), line);
  assert.ok(line.includes('harness_tier_overridden=approve'), line);
});

// ── spawn argv 진단 로그: secret 없이 남긴다 ──────────────────────────────

test('describeSpawnArgv: 플래그는 보이고 프롬프트/secret 은 접힌다', () => {
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

  // secret 모양 토큰은 길이도 남기지 않는다.
  assert.equal(describeSpawnArgv(['--header', 'Authorization: Bearer abc']), '--header <redacted>');
  assert.equal(describeSpawnArgv(['-c', 'x_api_key="s3cr3t"']), '-c <redacted>');
});

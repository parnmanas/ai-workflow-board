// 회귀 테스트 — 실제 spawn 사양 기록 (ticket 20fff298 리뷰 2R).
//
// 배경: 계산된 projection 은 heartbeat 시점 정보만 쓰므로 디스패치 시점 입력
// (harness / 티켓 effort / 티켓별 프로파일)이 덮는 부분을 반영하지 못한다.
// 그래서 화면의 "예상 명령"이 바로 다음 실행과 다를 수 있었다. 이 기록이
// 실제 spawn 의 argv·env·cwd 를 ground truth 로 붙여 그 공백을 메운다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordActualLaunch,
  lastActualLaunch,
  _resetRecordedLaunches,
} from '../dist/lib/launch-spec-recorder.js';
import { computeAgentLaunchSpec } from '../dist/lib/launch-spec.js';

const SECRET = 'sk-ant-api03-RECORDER-SECRET';

function ctx(over = {}) {
  return {
    agent_id: 'agent-rec', workspace_id: 'ws', name: 'T', cli: 'claude',
    working_dir: '/srv/work', mcp_config_path: '/cfg/mcp.json', api_key: 'k',
    subagent_log_path: '/l', cli_home_dir: '/home/a/cli-home', model: 'claude-opus-5',
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
    registered_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('기록이 없으면 사양의 last_spawn 은 null 이다', () => {
  _resetRecordedLaunches();
  assert.equal(computeAgentLaunchSpec(ctx()).last_spawn, null);
});

test('실제 spawn 사양이 기록되어 사양에 실린다', () => {
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec',
    mode: 'session',
    bin: '/usr/local/bin/claude',
    args: ['--session-id', 'abc', '--effort', 'max', '--dangerously-skip-permissions'],
    cwd: '/srv/work/.awb/wt/repo/20fff298',
    env: { PATH: '/usr/bin', ANTHROPIC_MODEL: 'qwen3', AWB_API_KEY: SECRET },
    baseEnv: { PATH: '/usr/bin' },
    ticketId: '20fff298-e752-4b9a-92d9-3f37b7e355ea',
    role: 'assignee',
    harness: { permission_mode: 'plan', system_prompt_append: '…' },
    effort: 'max',
    runtimeProfileId: 'vllm-local',
    now: () => new Date('2026-02-02T03:04:05.000Z'),
  });

  const spec = computeAgentLaunchSpec(ctx());
  const actual = spec.last_spawn;
  assert.ok(actual, 'last_spawn 이 실려야 한다');
  assert.equal(actual.mode, 'session');
  assert.equal(actual.bin, '/usr/local/bin/claude');
  // 실제 프로세스 cwd — 추정의 base 경로가 아니라 티켓별 worktree 그대로.
  assert.equal(actual.cwd, '/srv/work/.awb/wt/repo/20fff298');
  assert.equal(actual.recorded_at, '2026-02-02T03:04:05.000Z');

  // 디스패치 시점 입력이 문맥으로 남아, 추정과 달라진 이유를 설명한다.
  assert.equal(actual.context.role, 'assignee');
  assert.equal(actual.context.effort, 'max');
  assert.equal(actual.context.runtime_profile_id, 'vllm-local');
  assert.deepEqual(actual.context.harness_keys, ['permission_mode', 'system_prompt_append']);

  // 추정에는 없는 것이 실제에는 있다 — 이 대비가 이 기능의 존재 이유다.
  const projected = spec.modes.find((m) => m.mode === 'session').args.map((a) => a.value);
  assert.equal(projected.includes('--effort'), false, '추정은 티켓 effort 를 모른다');
  assert.ok(actual.args.map((a) => a.value).includes('--effort'), '실제에는 effort 가 붙었다');
});

test('harness 값 본문과 자격증명은 기록에 실리지 않는다', () => {
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec',
    mode: 'oneshot',
    bin: '/bin/claude',
    args: ['--append-system-prompt', '역할 프롬프트 본문 전체가 여기 들어온다', SECRET],
    cwd: '/w',
    env: { PATH: '/usr/bin', AWB_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET },
    baseEnv: { PATH: '/usr/bin' },
    harness: { system_prompt_append: '보드 프롬프트 본문' },
  });
  const actual = lastActualLaunch('agent-rec');
  const blob = JSON.stringify(actual);

  assert.equal(blob.includes(SECRET), false, '자격증명이 기록에 실렸다');
  assert.equal(blob.includes('역할 프롬프트 본문'), false, '프롬프트 본문이 기록에 실렸다');
  assert.equal(blob.includes('보드 프롬프트 본문'), false, 'harness 값 본문이 기록에 실렸다');
  // harness 는 키 이름만 남는다.
  assert.deepEqual(actual.context.harness_keys, ['system_prompt_append']);
  // 플래그 이름은 남아야 진단이 된다.
  assert.ok(actual.args.map((a) => a.value).includes('--append-system-prompt'));
});

test('상속된 env 는 제외하고 매니저가 덧붙인 키만 기록한다', () => {
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec', mode: 'oneshot', bin: '/b', args: [], cwd: '/w',
    // PATH·HOME 은 상속분(동일값)이라 제외, LANG 은 값이 달라 포함.
    env: { PATH: '/usr/bin', HOME: '/home/a', LANG: 'ko_KR.UTF-8', CLAUDE_CONFIG_DIR: '/home/a/cli-home' },
    baseEnv: { PATH: '/usr/bin', HOME: '/home/a', LANG: 'C' },
  });
  const keys = lastActualLaunch('agent-rec').env.map((e) => e.key);
  assert.deepEqual(keys, ['CLAUDE_CONFIG_DIR', 'LANG']);
  assert.equal(keys.includes('PATH'), false, '상속 env 가 화면을 덮으면 안 된다');
});

test('기록은 절대 throw 하지 않는다 (spawn 경로를 깨뜨릴 수 없다)', () => {
  _resetRecordedLaunches();
  // agentId 없음 → 조용히 무시
  assert.doesNotThrow(() => recordActualLaunch({
    agentId: null, mode: 'oneshot', bin: null, args: [], cwd: null, env: undefined, baseEnv: undefined,
  }));
  assert.equal(lastActualLaunch('agent-rec'), null);

  // env/args 가 이상해도 throw 하지 않는다
  assert.doesNotThrow(() => recordActualLaunch({
    agentId: 'agent-rec', mode: 'session', bin: '/b',
    args: [undefined, null, 123], cwd: undefined, env: undefined, baseEnv: undefined,
  }));
  assert.ok(lastActualLaunch('agent-rec'));
});

test('에이전트별로 마지막 기록만 유지한다', () => {
  _resetRecordedLaunches();
  // 알려진 플래그를 쓴다 — 마스킹이 기본 차단이라 임의 플래그는 `<Nch>` 로
  // 접히고, 그러면 "어느 기록이 남았나" 대신 마스킹을 단언하게 된다.
  const base = { mode: 'oneshot', bin: '/b', cwd: '/w', env: {}, baseEnv: {} };
  recordActualLaunch({ ...base, agentId: 'a', args: ['--print'] });
  recordActualLaunch({ ...base, agentId: 'a', args: ['--verbose'] });
  recordActualLaunch({ ...base, agentId: 'b', args: ['--json'] });
  assert.deepEqual(lastActualLaunch('a').args.map((x) => x.value), ['--verbose']);
  assert.deepEqual(lastActualLaunch('b').args.map((x) => x.value), ['--json']);
});

// ── 인자별 출처 귀속 (리뷰 3R) ───────────────────────────────────────────────
//
// 리뷰 지적: 기록이 "실제 argv" 이기만 하고 출처가 전부 `unattributed` 라면,
// 출처가 붙은 쪽은 디스패치 입력을 반영하지 못하는 추정뿐이라 요구사항의
// "실효 실행 인자 전체 + 인자별 출처" 가 어느 블록에서도 충족되지 않는다.
//
// 아래 테스트는 **실제 어댑터 빌더**로 argv 를 만들고 그 spec 을 귀속 입력으로
// 넘겨, harness·effort·permission·model·runtime_profile 이 실제 토큰에
// 귀속되는지 확인한다. 플래그 철자를 여기에 다시 적지 않고 위치로 찾는다 —
// 어댑터가 이름을 바꿔도 이 테스트는 따라간다.

const ROLE_PROMPT = '역할 프롬프트 본문 전체가 여기 들어온다';
const TASK_TEXT = '작업 내용 본문이 여기 들어온다';

/** 실제 claude 어댑터로 oneshot argv 를 만들고, 그 spec 을 귀속 입력으로 기록한다. */
async function recordWithAttribution(over = {}) {
  const { createAdapter } = await import('../dist/lib/cli-adapters/index.js');
  const adapter = createAdapter('claude');
  const spec = {
    rolePrompt: ROLE_PROMPT,
    taskText: TASK_TEXT,
    mcpConfigPath: '/tmp/awb/cfg-1738-abc.json',
    cwd: '/srv/work/.awb/wt/repo/20fff298',
    cliHomeDir: '/home/a/cli-home',
    model: 'claude-opus-5',
    harness: { allowed_tools: ['Read', 'Bash'], disallowed_tools: ['WebFetch'], permission_mode: 'plan' },
    effort: 'max',
    ultracode: false,
    permission: { tier: 'trusted', source: 'agent_trust', harnessMode: 'plan', harnessTier: 'strict' },
    ...over,
  };
  const build = (s) => adapter.buildOneshotSpawn(s).args;
  const profileArgs = ['--settings', '/etc/awb/profile.json'];
  const args = [...build(spec), ...profileArgs];
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec',
    mode: 'oneshot',
    bin: '/usr/local/bin/claude',
    args,
    cwd: spec.cwd,
    env: { PATH: '/usr/bin' },
    baseEnv: { PATH: '/usr/bin' },
    harness: spec.harness,
    effort: spec.effort,
    runtimeProfileId: 'vllm-local',
    attribution: { spec, build, profileArgs },
  });
  return { spec, args, recorded: lastActualLaunch('agent-rec') };
}

/** 어떤 출처로 귀속된 토큰들의 표시값. */
const valuesOf = (recorded, source) =>
  recorded.args.filter((a) => a.source === source).map((a) => a.value);

test('실제 argv 의 인자별 출처가 붙는다 — model / effort / permission', async () => {
  const { recorded } = await recordWithAttribution();
  assert.equal(recorded.args_attributed, true, '귀속에 성공했어야 한다');

  // 모델 — 플래그와 값이 함께 model 로 귀속된다.
  assert.deepEqual(valuesOf(recorded, 'model'), ['--model', 'claude-opus-5']);
  // 티켓 effort preset — **추정에는 존재할 수 없는** 디스패치 입력이다.
  assert.deepEqual(valuesOf(recorded, 'effort'), ['--effort', 'max']);
  // trust 기반 권한 플래그.
  assert.deepEqual(valuesOf(recorded, 'permission'), ['--dangerously-skip-permissions']);
});

test('실제 argv 의 인자별 출처가 붙는다 — harness / runtime_profile', async () => {
  const { recorded } = await recordWithAttribution();

  // harness 가 만든 토큰: allowedTools 값(도구 2개가 덧붙음)과 disallowedTools 한 쌍.
  const harnessValues = valuesOf(recorded, 'harness');
  assert.ok(harnessValues.length >= 2, `harness 귀속이 비었다: ${JSON.stringify(recorded.args)}`);
  assert.ok(
    harnessValues.includes('--disallowedTools'),
    `harness 가 만든 플래그가 귀속되지 않았다: ${harnessValues.join(' ')}`,
  );
  // harness 가 실어 보낸 **값**은 운영자 자유 입력이라 공용 마스킹을 그대로
  // 탄다 — 플래그 이름만 드러나고 값은 길이로 접힌다.
  assert.ok(
    harnessValues.some((v) => /^<\d+ch>$/.test(v)),
    `harness 값이 원문으로 노출됐다: ${harnessValues.join(' ')}`,
  );

  // 프로파일 인자는 descriptor **뒤**에 push 되므로 위치로 귀속되고, 그 자리가
  // argv 의 마지막이어야 한다(실제 spawn 사이트가 그렇게 만든다).
  // 값(`/etc/...`)은 프로파일 설정도 자유 입력이라 마스킹된다.
  assert.deepEqual(valuesOf(recorded, 'runtime_profile'), ['--settings', '<21ch>']);
  assert.deepEqual(
    recorded.args.slice(-2).map((a) => a.source),
    ['runtime_profile', 'runtime_profile'],
  );
});

test('프롬프트 본문은 귀속되어 자리표시자로 접히고 원문이 기록에 남지 않는다', async () => {
  const { recorded } = await recordWithAttribution();
  const blob = JSON.stringify(recorded);
  assert.equal(blob.includes(ROLE_PROMPT), false, '역할 프롬프트 원문이 기록에 실렸다');
  assert.equal(blob.includes(TASK_TEXT), false, 'task text 원문이 기록에 실렸다');

  // 본문이 실려 있던 자리는 prompt 로 귀속되고 자리표시자로 표시된다 —
  // `<Nch>` 로 길이만 흘리는 것도 피한다.
  const promptEntries = recorded.args.filter((a) => a.source === 'prompt');
  assert.ok(promptEntries.length >= 2, `프롬프트 귀속이 비었다: ${JSON.stringify(recorded.args)}`);
  for (const e of promptEntries) {
    assert.equal(e.placeholder, true, `프롬프트 토큰이 자리표시자로 표시되지 않았다: ${e.value}`);
    assert.match(e.value, /프롬프트 본문/);
  }
});

test('실제 MCP 설정 경로는 확정값이라 접지 않고 그대로 보고한다', async () => {
  // 추정에서는 spawn 시점에 만들어질 값이라 자리표시자로 접지만, 기록에서 접으면
  // 운영자가 정작 확인해야 할 실제 파일 경로를 잃는다. (플래그 이름은 어댑터가
  // 경로 유무와 무관하게 항상 넣으므로 `adapter` 로 남는 것이 맞다.)
  const { recorded } = await recordWithAttribution();
  assert.deepEqual(valuesOf(recorded, 'mcp'), ['/tmp/awb/cfg-1738-abc.json']);
  const flagIndex = recorded.args.findIndex((a) => a.value === '--mcp-config');
  assert.ok(flagIndex >= 0, 'MCP 플래그가 사라졌다');
  assert.equal(recorded.args[flagIndex + 1].source, 'mcp');
});

test('재구성한 argv 가 실제와 다르면 출처를 지어내지 않는다', async () => {
  const { createAdapter } = await import('../dist/lib/cli-adapters/index.js');
  const adapter = createAdapter('claude');
  const spec = {
    rolePrompt: 'r', taskText: 't', mcpConfigPath: '/cfg.json', cwd: '/w',
    cliHomeDir: null, model: 'claude-opus-5', harness: null, effort: null,
    ultracode: false, permission: { tier: 'trusted', source: 'agent_trust', harnessMode: null },
  };
  const build = (s) => adapter.buildOneshotSpawn(s).args;
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec', mode: 'oneshot', bin: '/b',
    // spawn 된 argv 에 spec 으로 설명되지 않는 토큰이 하나 더 있다.
    args: [...build(spec), '--verbose'],
    cwd: '/w', env: {}, baseEnv: {},
    attribution: { spec, build, profileArgs: [] },
  });
  const recorded = lastActualLaunch('agent-rec');
  assert.equal(recorded.args_attributed, false, '실제와 다른 argv 에 출처를 붙였다');
  assert.deepEqual([...new Set(recorded.args.map((a) => a.source))], ['unattributed']);
  // 그래도 실제 argv 자체는 기록된다 — ground truth 를 잃지 않는다.
  assert.equal(recorded.args.length, build(spec).length + 1);
});

test('귀속 입력이 없으면 args_attributed 는 false 다 (구버전 호출부 호환)', () => {
  _resetRecordedLaunches();
  recordActualLaunch({
    agentId: 'agent-rec', mode: 'session', bin: '/b', args: ['--verbose'],
    cwd: '/w', env: {}, baseEnv: {},
  });
  const recorded = lastActualLaunch('agent-rec');
  assert.equal(recorded.args_attributed, false);
  assert.deepEqual(recorded.args.map((a) => a.source), ['unattributed']);
});

test('빌더가 throw 해도 기록은 남고 귀속만 포기한다', () => {
  _resetRecordedLaunches();
  assert.doesNotThrow(() => recordActualLaunch({
    agentId: 'agent-rec', mode: 'oneshot', bin: '/b', args: ['--print'],
    cwd: '/w', env: {}, baseEnv: {},
    attribution: { spec: {}, build: () => { throw new Error('어댑터 폭발'); }, profileArgs: [] },
  }));
  const recorded = lastActualLaunch('agent-rec');
  assert.ok(recorded, '빌더 실패가 기록 자체를 삼켰다');
  assert.equal(recorded.args_attributed, false);
  assert.deepEqual(recorded.args.map((a) => a.value), ['--print']);
});

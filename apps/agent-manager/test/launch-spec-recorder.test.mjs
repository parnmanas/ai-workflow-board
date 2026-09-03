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

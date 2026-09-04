// 회귀 테스트 — 실효 실행 사양(effective launch spec) 계산 (ticket 20fff298).
//
// 배경: 어떤 CLI 인자가 실제로 붙는지 UI 로 확인할 방법이 없었다. adapter 가
// 만든 argv 는 로그에만 남고 wire 에는 필드 자체가 없었다.
//
// 이 파일이 지키는 계약 세 가지:
//   1. 보고되는 argv 는 **어댑터의 실제 빌더 출력**이다. 이 모듈이 플래그를
//      재조립한 것이 아니다 — 재조립이면 어댑터가 바뀔 때 화면이 조용히
//      거짓말을 하게 된다. spawn 경로가 둘(session / oneshot)이고 argv 모양이
//      다르므로 **둘 다** 보고해야 한다: persistentTicketSessions 기본값이
//      true 라 claude 티켓 디스패치의 실제 경로는 session 쪽이고, oneshot 만
//      보고하면 화면이 실행되지 않는 명령(`--print`)을 보여준다.
//   2. 인자별 출처는 **입력을 뺀 변형과의 차집합**으로 정해진다. 플래그
//      철자를 하드코딩하지 않는다.
//   3. 자격증명/토큰은 args 에도 env 에도 원문으로 나오지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAgentLaunchSpec, computeAgentLaunchSpecs } from '../dist/lib/launch-spec.js';
import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { resolveModelChain } from '../dist/lib/cli-adapters/base.js';

const SECRET = 'sk-ant-api03-SUPERSECRETVALUE';

function ctx(over = {}) {
  return {
    agent_id: 'agent-1',
    workspace_id: 'ws-1',
    name: '테스트 에이전트',
    cli: 'claude',
    working_dir: '/srv/work',
    mcp_config_path: '/cfg/mcp.json',
    api_key: SECRET,
    subagent_log_path: '/var/log/sub.log',
    cli_home_dir: '/home/agent/cli-home',
    model: 'claude-opus-5',
    runtime_config: { strategy: 'direct', permission_mode: 'trusted' },
    registered_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** 사양의 토큰들을 한 문자열로 — "어디에도 안 나온다" 단언용. */
function allText(spec) {
  return JSON.stringify(spec);
}

/** 특정 모드의 인자 목록. */
function argsOf(spec, mode) {
  const m = spec.modes.find((x) => x.mode === mode);
  assert.ok(m, `${mode} 모드가 보고되지 않았다`);
  return m.args;
}

const TRUSTED = {
  tier: 'trusted', source: 'agent_trust', trust: 'trusted', harnessMode: null,
  harnessTier: 'trusted', harnessOverridden: false, invalidTrustDigest: null,
};

test('보고되는 argv 는 어댑터의 실제 빌더 출력과 토큰 수가 같다 (두 모드 모두)', () => {
  const spec = computeAgentLaunchSpec(ctx());
  const adapter = new ClaudeCliAdapter();
  const common = {
    rolePrompt: 'x', mcpConfigPath: '/cfg/mcp.json', model: 'claude-opus-5',
    harness: null, effort: null, permission: TRUSTED,
  };
  // 같은 입력으로 어댑터를 직접 돌린 결과와 길이를 맞춘다. launch-spec 이
  // 인자를 스스로 만들어 넣거나 빠뜨리면 여기서 깨진다.
  assert.equal(
    argsOf(spec, 'oneshot').length,
    adapter.buildOneshotSpawn({ ...common, taskText: 'y' }).args.length,
  );
  assert.equal(
    argsOf(spec, 'session').length,
    adapter.buildSessionSpawn({ ...common, sessionMode: 'persistent', sessionId: 'sentinel' }).args.length,
  );
  // 플래그 이름은 그대로 보여야 권한/모델 확인이라는 목적을 달성한다.
  const flags = argsOf(spec, 'session').map((a) => a.value);
  assert.ok(flags.includes('--dangerously-skip-permissions'));
  assert.ok(flags.includes('--model'));
  assert.ok(flags.includes('--mcp-config'));
});

test('session 모드가 먼저 보고되고 oneshot 과 argv 모양이 다르다', () => {
  const spec = computeAgentLaunchSpec(ctx());
  // persistentTicketSessions 기본값이 true 이므로 실제 티켓 디스패치 경로인
  // session 이 앞에 와야 한다 — UI 는 첫 항목을 기본으로 보여준다.
  assert.deepEqual(spec.modes.map((m) => m.mode), ['session', 'oneshot']);

  const session = argsOf(spec, 'session').map((a) => a.value);
  const oneshot = argsOf(spec, 'oneshot').map((a) => a.value);
  // 실제로 도는 프로세스에는 --print 가 없고 --session-id / --input-format 이 있다.
  assert.ok(session.includes('--session-id'));
  assert.ok(session.includes('--input-format'));
  assert.equal(session.includes('--print'), false);
  // oneshot 은 반대다 — 이 둘을 한 목록으로 뭉개면 어느 쪽도 실제 명령이 아니다.
  assert.ok(oneshot.includes('--print'));
  assert.equal(oneshot.includes('--session-id'), false);

  // 세션 id 는 spawn 시점에 생기므로 가짜 UUID 대신 자리표시자여야 한다.
  const sessionArgs = argsOf(spec, 'session');
  const idIdx = sessionArgs.findIndex((a) => a.value === '--session-id') + 1;
  assert.equal(sessionArgs[idIdx].source, 'session');
  assert.equal(sessionArgs[idIdx].placeholder, true);
  assert.match(sessionArgs[idIdx].value, /세션 id/);
  assert.doesNotMatch(sessionArgs[idIdx].value, /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test('persistent session 을 끄거나 지원하지 않으면 oneshot 만 보고한다', () => {
  // 오퍼레이터가 끈 경우 — spawn 사이트의 게이트와 같은 조건이다.
  const off = computeAgentLaunchSpec(ctx(), { delegation: { persistentTicketSessions: false } });
  assert.deepEqual(off.modes.map((m) => m.mode), ['oneshot']);

  // 어댑터가 persistent session capability 를 선언하지 않는 경우.
  const codex = computeAgentLaunchSpec(ctx({ cli: 'codex', model: 'gpt-5-codex' }));
  assert.deepEqual(codex.modes.map((m) => m.mode), ['oneshot']);
});

test('출처 귀속 — 모델 / 권한 / MCP 가 각자 자기 인자를 가져간다', () => {
  const spec = computeAgentLaunchSpec(ctx());
  const bySource = (s) => argsOf(spec, 'oneshot').filter((a) => a.source === s).map((a) => a.value);

  assert.deepEqual(bySource('model'), ['--model', 'claude-opus-5']);
  assert.deepEqual(bySource('permission'), ['--dangerously-skip-permissions']);
  // 값은 자리표시자다 — 실제 파일이 spawn 시점에 만들어지기 때문(전용 테스트 참조).
  assert.deepEqual(bySource('mcp'), ['<MCP 설정: spawn 시 생성>']);
  // `--mcp-config` 플래그 자체는 mcpConfigPath 가 없어도 어댑터가 항상 내므로
  // 어댑터 기본값이 맞다 — 값만 mcp 로 귀속된다.
  assert.ok(bySource('adapter').includes('--mcp-config'));
  assert.equal(argsOf(spec, 'oneshot').some((a) => a.source === 'unattributed'), false);
  assert.equal(argsOf(spec, 'session').some((a) => a.source === 'unattributed'), false);
});

test('권한 등급이 바뀌면 permission 으로 귀속되는 인자도 따라 바뀐다', () => {
  const trusted = computeAgentLaunchSpec(ctx({ runtime_config: { strategy: 'direct', permission_mode: 'trusted' } }));
  const approve = computeAgentLaunchSpec(ctx({ runtime_config: { strategy: 'direct', permission_mode: 'approve' } }));
  const strict = computeAgentLaunchSpec(ctx({ runtime_config: { strategy: 'direct', permission_mode: 'strict' } }));

  const perm = (s) => argsOf(s, 'session').filter((a) => a.source === 'permission').map((a) => a.value);
  assert.deepEqual(perm(trusted), ['--dangerously-skip-permissions']);
  assert.deepEqual(perm(approve), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(perm(strict), ['--permission-mode', 'plan']);

  assert.equal(trusted.permission.tier, 'trusted');
  assert.equal(approve.permission.source, 'agent_trust');
  // trust 미설정이면 등급의 출처가 'default' 여야 한다 — UI 가 "에이전트가
  // 정한 값"과 "매니저 기본값"을 구분할 수 있어야 하기 때문이다.
  const none = computeAgentLaunchSpec(ctx({ runtime_config: null }));
  assert.equal(none.permission.source, 'default');
});

test('런타임 프로파일 인자는 descriptor 뒤에 붙고 runtime_profile 로 귀속된다', () => {
  const spec = computeAgentLaunchSpec(ctx(), {
    runtimeProfileOverride: {
      id: 'vllm-local',
      protocol: 'openai-compatible',
      base_url: 'http://127.0.0.1:8000',
      model: 'qwen3-coder',
      args: ['--settings', '/etc/awb/vllm.json'],
      env: { AWB_PROFILE_TOKEN: SECRET },
    },
  });
  const tail = argsOf(spec, 'session').slice(-2);
  assert.deepEqual(tail.map((a) => a.source), ['runtime_profile', 'runtime_profile']);
  assert.equal(tail[0].value, '--settings');
  assert.deepEqual(spec.runtime_profile, {
    id: 'vllm-local',
    protocol: 'openai-compatible',
    model: 'qwen3-coder',
    arg_count: 2,
  });
  // `--model` 은 프로파일 활성 시 **비어야** 한다 — 아래 전용 테스트 참조.
  assert.equal(spec.model, null);
  assert.equal(spec.runtime_profile.model, 'qwen3-coder');
});

test('프로파일 활성 시 raw profile model 이 argv 에 오르지 않는다', () => {
  // 리뷰 P1. spawn 사이트 둘 다 `effectiveModel = claudeRuntimeProfile ? null : …` 라
  // `--model` 을 의도적으로 생략한다(ticket 41dc37cb round 3) — profile.model 은
  // raw provider id 라 CLI 가 `--model` 값으로 거부하고, 실제 라우팅은
  // ANTHROPIC_MODEL 계열 env 로 간다. 여기에 profile.model 을 넣으면 화면이
  // 실제로는 붙지 않는 플래그를 실행 명령이라고 주장하게 된다.
  const RAW = 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8';
  const spec = computeAgentLaunchSpec(ctx(), {
    runtimeProfileOverride: {
      id: 'vllm', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:8000',
      model: RAW,
      // 폴백 후보가 있어도 프로파일 활성 세션에서는 무시된다(아래 체인 단언).
    },
  });

  assert.equal(spec.model, null, '프로파일 활성인데 --model 값이 잡혔다');
  for (const mode of spec.modes) {
    assert.equal(mode.args.some((a) => a.value === '--model'), false, `${mode.mode} 에 --model 이 붙었다`);
    assert.equal(mode.args.some((a) => a.value.includes('Qwen')), false, `${mode.mode} argv 에 raw model 이 샜다`);
    assert.equal(mode.args.some((a) => a.source === 'model'), false);
  }
  // 서빙 모델은 사라지지 않고 backend 메타데이터로 남는다.
  assert.equal(spec.runtime_profile.model, RAW);
  // 그리고 CLI 가 실제로 model 을 받는 경로(env)가 화면에 드러나야 "왜 --model 이
  // 없는지"가 설명된다.
  const envKeys = spec.env.filter((e) => e.source === 'runtime_profile').map((e) => e.key);
  assert.ok(envKeys.includes('ANTHROPIC_MODEL'));
  // env 값도 원문을 싣지 않는다.
  assert.equal(spec.env.some((e) => e.value.includes('Qwen')), false);
});

test('폴백 재시도 경로에서도 raw profile model 이 argv 후보에 없다', () => {
  // 리뷰 P1 — 최초 spawn 만이 아니라 fallback-eligible 재시도까지 봐야 한다.
  // 제품의 실제 헬퍼를 그대로 호출해 불변식을 고정한다: 프로파일이 있으면
  // resolveModelChain 이 harness.fallback_models 를 통째로 버리고 `[null]` 만
  // 남기므로, 어떤 재시도도 raw model 을 argv 에 올리지 못한다.
  const profile = {
    id: 'vllm', protocol: 'openai-compatible', base_url: 'http://x', model: 'raw-served-model',
  };
  const chain = resolveModelChain(null, profile, ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(chain, [null], '프로파일 활성 시 모델 체인은 [null] 이어야 한다');
  assert.equal(chain.some((m) => m === 'raw-served-model'), false);

  // 프로파일이 없을 때는 폴백이 살아 있어야 한다(이 테스트가 공허하지 않다는 증명).
  assert.deepEqual(
    resolveModelChain('claude-opus-5', null, ['claude-sonnet-5']),
    ['claude-opus-5', 'claude-sonnet-5'],
  );
});

test('MCP 설정 경로는 어느 경로에서도 정적 경로를 실행 명령에 넣지 않는다', () => {
  // 리뷰 P1. persistent session 은 **항상** per-process 임시 사본을 쓰고,
  // one-shot 도 티켓+역할 디스패치면 매번 새 임시 설정을 만든다. 정적 설정을
  // 그대로 쓰는 건 역할 없는 채팅 one-shot 뿐이라, 복사 가능한 명령에 정적
  // 경로를 넣으면 운영자가 그 값을 실효값으로 읽는다.
  const spec = computeAgentLaunchSpec(ctx());

  for (const mode of spec.modes) {
    const i = mode.args.findIndex((a) => a.value === '--mcp-config');
    assert.ok(i >= 0, `${mode.mode} 에 --mcp-config 가 없다`);
    const value = mode.args[i + 1];
    assert.equal(value.source, 'mcp');
    assert.equal(value.placeholder, true, `${mode.mode} 의 MCP 값이 자리표시자가 아니다`);
    assert.match(value.value, /spawn 시 생성/);
    assert.equal(
      mode.args.some((a) => a.value === '/cfg/mcp.json'),
      false,
      `${mode.mode} 실행 명령에 정적 MCP 경로가 들어갔다`,
    );
    // 두 경로가 어떻게 다른지는 argv 로 드러나지 않으므로 note 로 구분한다.
    assert.ok(mode.notes.length > 0);
  }
  // 정적 경로 자체는 사라지지 않는다 — 채팅 one-shot 이 실제로 쓰는 값이다.
  assert.equal(spec.mcp_config_path, '/cfg/mcp.json');
  const oneshotNotes = spec.modes.find((m) => m.mode === 'oneshot').notes.join(' ');
  assert.match(oneshotNotes, /채팅 one-shot/);
  assert.match(oneshotNotes, /임시 MCP 설정/);
});

test('두 경로의 argv 가 실제 spawn 사이트 입력으로 만든 descriptor 와 일치한다', () => {
  // 리뷰 요청: "두 경로를 실제 spawn descriptor 와 대조". spawn 사이트가
  // 어댑터에 넘기는 값(프로파일 있으면 model=null, MCP 는 spawn 시 만든 경로)을
  // 그대로 재현해 어댑터를 직접 돌리고, launch-spec 의 렌더 결과와 토큰 골격을
  // 맞춘다. 여기가 어긋나면 화면이 실제로 안 도는 명령을 보여 준다는 뜻이다.
  const adapter = new ClaudeCliAdapter();
  const profile = {
    id: 'vllm', protocol: 'openai-compatible', base_url: 'http://x', model: 'raw-served-model',
  };
  const spec = computeAgentLaunchSpec(ctx(), { runtimeProfileOverride: profile });

  const spawnSiteSpec = {
    rolePrompt: 'role',
    mcpConfigPath: '/run/agent/cfg-1730000000-abc.json', // spawn 시 만들어지는 임시 경로
    model: null,                                          // effectiveModel = profile ? null : …
    harness: null,
    effort: null,
    permission: TRUSTED,
  };
  const realSession = adapter.buildSessionSpawn({
    ...spawnSiteSpec, sessionMode: 'persistent', sessionId: 'sid',
  }).args;
  const realOneshot = adapter.buildOneshotSpawn({ ...spawnSiteSpec, taskText: 'task' }).args;

  // 프로파일 인자는 spawn 사이트가 descriptor 뒤에 push 하므로 길이에 포함된다.
  const profileArgCount = (profile.args ?? []).length;
  assert.equal(argsOf(spec, 'session').length, realSession.length + profileArgCount);
  assert.equal(argsOf(spec, 'oneshot').length, realOneshot.length + profileArgCount);

  // 플래그 골격(값 자리를 뺀 알려진 플래그들)이 동일해야 한다.
  const flagsOf = (list) => list.filter((v) => /^--[a-z]/i.test(v));
  assert.deepEqual(flagsOf(argsOf(spec, 'session').map((a) => a.value)), flagsOf(realSession));
  assert.deepEqual(flagsOf(argsOf(spec, 'oneshot').map((a) => a.value)), flagsOf(realOneshot));
});

test('cwd 는 프로파일이 고정했을 때만 exact 이고 그 외에는 base 다', () => {
  // 티켓 디스패치의 실제 프로세스 cwd 는 working_dir 아래 **티켓별 worktree** 다
  // (base-session-manager 의 effectiveCwd = agentContext.cwd = repository.cwd).
  // 그래서 working_dir 를 그대로 "작업 폴더"라고 부르면 argv 옆 경로가 실제
  // 프로세스 cwd 로 읽힌다 — 구분이 필요하다.
  const plain = computeAgentLaunchSpec(ctx());
  assert.equal(plain.cwd, '/srv/work');
  assert.equal(plain.cwd_kind, 'base');
  assert.ok(plain.varies_per_dispatch.some((v) => v.includes('worktree')));

  // 런타임 프로파일이 cwd 를 고정하면 그 값이 실제 cwd 다 — spawn 사이트도
  // `claudeRuntimeProfile?.cwd || effectiveCwd` 로 프로파일을 먼저 본다.
  const pinned = computeAgentLaunchSpec(ctx(), {
    runtimeProfileOverride: {
      id: 'p', protocol: 'openai-compatible', base_url: 'http://x',
      model: 'm', cwd: '/opt/pinned',
    },
  });
  assert.equal(pinned.cwd, '/opt/pinned');
  assert.equal(pinned.cwd_kind, 'exact');
});

test('마스킹 — 자격증명이 args·env 어디에도 원문으로 나오지 않는다', () => {
  const spec = computeAgentLaunchSpec(
    ctx({ extra_env: { ANTHROPIC_API_KEY: SECRET, AWB_PLAIN: 'plain-value-0123' } }),
    {
      runtimeProfileOverride: {
        id: 'p', protocol: 'openai-compatible', base_url: 'http://x', model: 'm',
        args: [], env: { PROFILE_AUTH_TOKEN: SECRET },
      },
    },
  );

  // 요구사항의 마스킹 범위는 "인자·환경값" 이다. 사양 전체를 직렬화해 훑는
  // 이유는, 앞으로 필드가 늘어도 자격증명이 어느 필드로든 새면 걸리게 하기 위함.
  assert.equal(allText(spec).includes(SECRET), false, '자격증명 원문이 사양에 실렸다');
  assert.equal(spec.modes.some((m) => m.args.some((a) => a.value.includes(SECRET))), false);
  assert.equal(spec.env.some((e) => e.value.includes(SECRET)), false);

  const env = Object.fromEntries(spec.env.map((e) => [e.key, e.value]));
  assert.equal(env.ANTHROPIC_API_KEY, '<redacted>');
  assert.equal(env.PROFILE_AUTH_TOKEN, '<redacted>');
  // secret 모양이 아닌 값도 원문을 싣지 않는다 — env 는 길이만 남긴다.
  assert.equal(env.AWB_PLAIN, `<${'plain-value-0123'.length}ch>`);
  // cli-home 경로는 비밀이 아니고 UI 가 이미 다른 곳에서 보여주므로 그대로 남는다.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/agent/cli-home');
  // 프로파일이 활성이면 모델 라우팅 env(ANTHROPIC_MODEL 계열 4개)가 함께 실린다 —
  // CLI 가 model 을 받는 실제 경로라 `--model` 부재를 설명하는 값이다.
  const bySrc = (src) => spec.env.filter((e) => e.source === src).map((e) => e.key);
  assert.deepEqual(bySrc('cli_home'), ['CLAUDE_CONFIG_DIR']);
  assert.deepEqual(bySrc('credential').sort(), ['ANTHROPIC_API_KEY', 'AWB_PLAIN']);
  assert.ok(bySrc('runtime_profile').includes('ANTHROPIC_MODEL'));
  assert.ok(bySrc('runtime_profile').includes('PROFILE_AUTH_TOKEN'));
});

test('마스킹 — 알려진 안전값이라도 secret 모양이면 가린다', () => {
  // model / cwd 는 "매니저가 구조적으로 아는 값"이라 평소엔 argv 에 그대로
  // 보여주지만, secret 안전망이 그 통과 판정보다 **먼저** 적용되어야 한다.
  // 이 순서가 뒤집히면 경로나 모델 id 에 토큰을 담은 설정이 그대로 노출된다.
  const claude = computeAgentLaunchSpec(ctx({ model: 'model-with-secret-inside' }));
  for (const mode of claude.modes) {
    assert.equal(mode.args.some((a) => a.value === 'model-with-secret-inside'), false);
    assert.equal(mode.args.find((a) => a.source === 'model' && a.value !== '--model').value, '<redacted>');
  }

  // codex 는 cwd 를 `--cd <path>` 로 argv 에 싣는다 — 안전값 통과 경로가 실제로
  // 도는 자리라 여기서 순서를 검증해야 의미가 있다.
  const codex = computeAgentLaunchSpec(ctx({ cli: 'codex', working_dir: '/srv/api_key/leak' }));
  const codexArgs = argsOf(codex, 'oneshot');
  const cdIndex = codexArgs.findIndex((a) => a.value === '--cd');
  assert.ok(cdIndex >= 0, 'codex 는 --cd 를 실어야 한다');
  assert.equal(codexArgs[cdIndex + 1].value, '<redacted>');
  assert.equal(codexArgs.some((a) => a.value.includes('/srv/api_key/leak')), false);
});

test('프롬프트 본문은 실리지 않고 자리표시자로 표시된다', () => {
  const spec = computeAgentLaunchSpec(ctx());
  const placeholders = argsOf(spec, 'oneshot').filter((a) => a.placeholder === true);
  // 역할 프롬프트 + task text + MCP 설정 경로 세 자리.
  assert.deepEqual(placeholders.map((a) => a.source).sort(), ['adapter', 'adapter', 'mcp']);
  for (const p of placeholders) assert.match(p.value, /디스패치 시 생성|spawn 시 생성/);
  // 프롬프트 자리 둘은 여전히 본문이 아니라 자리표시자다.
  assert.equal(
    placeholders.filter((a) => /디스패치 시 생성/.test(a.value)).length,
    2,
  );
  // 실행 시점 입력은 지어내지 않고 이름만 보고한다.
  assert.ok(spec.varies_per_dispatch.length > 0);
  assert.ok(spec.varies_per_dispatch.some((v) => v.includes('harness')));
});

test('어댑터가 없는 CLI 여도 throw 하지 않고 사유를 표면화한다', () => {
  const spec = computeAgentLaunchSpec(ctx({ cli: 'does-not-exist' }));
  assert.equal(spec.agent_id, 'agent-1');
  assert.deepEqual(spec.modes, []);
  assert.ok(spec.bin_error, 'bin_error 로 사유가 보여야 한다');
});

test('한 에이전트가 실패해도 나머지 에이전트 사양은 보고된다', () => {
  const specs = computeAgentLaunchSpecs([
    ctx({ agent_id: 'ok-1' }),
    ctx({ agent_id: 'broken', cli: 'does-not-exist' }),
    ctx({ agent_id: 'ok-2' }),
    // agent_id 없는 행은 조용히 건너뛴다.
    ctx({ agent_id: '' }),
  ]);
  assert.deepEqual(specs.map((s) => s.agent_id), ['ok-1', 'broken', 'ok-2']);
  assert.ok(specs[0].modes.length > 0);
  assert.deepEqual(specs[1].modes, []);
});

test('claude 가 아닌 CLI 에는 claude 런타임 프로파일이 적용되지 않는다', () => {
  // spawn 사이트의 `adapter.cliType === 'claude' ? runtimeProfile : null` 과
  // 같은 게이팅. 이게 없으면 codex 에이전트 화면에 claude 프로파일 인자가
  // 붙은 것처럼 보인다.
  const spec = computeAgentLaunchSpec(ctx({ cli: 'codex', model: 'gpt-5-codex' }), {
    runtimeProfileOverride: {
      id: 'vllm', protocol: 'openai-compatible', base_url: 'http://x',
      model: 'qwen3', args: ['--settings', '/etc/x.json'],
    },
  });
  assert.equal(spec.runtime_profile, null);
  assert.equal(spec.modes.some((m) => m.args.some((a) => a.source === 'runtime_profile')), false);
  assert.equal(spec.model, 'gpt-5-codex');
});

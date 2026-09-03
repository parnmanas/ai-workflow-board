/**
 * 실효 실행 사양(effective launch spec) — ticket 20fff298.
 *
 * 관리 대상 에이전트 하나가 **다음에 spawn 될 때 실제로 받게 될** 실행 파일과
 * argv 를, 출처를 붙여 계산한다. heartbeat 에 실려 AWB 로 올라가고 Agent
 * details 화면의 "실행 인자" 섹션이 이 값을 그대로 보여준다.
 *
 * ## 왜 argv 를 다시 조립하지 않는가
 *
 * 이 모듈은 플래그 이름을 하나도 알지 못한다 — 어댑터의 **실제** 빌더
 * (`buildOneshotSpawn` / `buildSessionSpawn`)를 호출해 나온 descriptor 를 읽을
 * 뿐이다. 여기서 "claude 면 --model, codex 면 -c ..." 식으로 argv 를 재구성했다면
 * 어댑터가 바뀔 때마다 조용히 어긋나고, 화면은 실제로 실행되지 않는 명령을
 * 보여주게 된다. 화면의 목적이 "실제로 뭐가 붙었는지 확인"인 이상 그건 버그보다
 * 나쁘다.
 *
 * ## 왜 모드가 둘인가
 *
 * spawn 경로가 실제로 둘이고 **argv 모양이 다르다**:
 *   - `session` — persistent 티켓/채팅 세션. `delegation.persistentTicketSessions`
 *     기본값이 true 라 claude 계열 티켓 디스패치의 **기본 경로**다
 *     (`base-session-manager.ts` → `buildSessionSpawn`). `--session-id` 와
 *     `--input-format stream-json` 이 붙고 `--print` 는 없다.
 *   - `oneshot` — 일회성 실행 (`subagent-manager.ts` → `buildOneshotSpawn`).
 *     `--print` 가 붙고 task text 가 positional 로 들어간다.
 *
 * 하나만 보고하면 나머지 경로에서는 **실행되지 않는 명령**을 보여주게 된다.
 * 그래서 지원하는 모드를 전부, 기본 경로를 앞에 두고 보고한다.
 *
 * ## 출처는 어떻게 붙이는가
 *
 * 출처도 하드코딩하지 않는다. 입력 하나를 뺀 **변형(variant)** 을 같은 빌더로
 * 다시 만들어, 원본에는 있는데 변형에는 없는 토큰을 그 입력의 것으로 귀속한다
 * ({@link attributeBy}). 어댑터가 플래그 철자를 바꿔도 귀속은 따라간다.
 *
 * ## 무엇이 여기 없는가
 *
 * 프롬프트 본문·task text·세션 id 는 실행 시점에만 정해지므로 자리표시자를
 * 넣고 `placeholder` 로 표시한다. 보드/워크스페이스 harness 와 티켓 effort
 * preset, 티켓별 `cli_runtime_profile` 도 **디스패치 시점** 입력이라 heartbeat
 * 시점에는 알 수 없다 — 지어내지 않고 `varies_per_dispatch` 에 이름만 남긴다.
 */

import { createAdapter } from './cli-adapters/index.js';
import {
  ADAPTER_CAPABILITIES,
  type OneshotSpec,
  type SessionSpec,
  type RuntimeProfileSpec,
} from './cli-adapters/base.js';
// 귀속·마스킹·렌더는 실제 spawn 기록(`launch-spec-recorder.ts`)과 **같은 규칙**을
// 써야 하므로 공용 모듈에 둔다 — 두 곳이 각자 구현하면 화면의 "추정"과 "실제"
// 블록이 같은 토큰을 다르게 접어 보여준다(ticket 20fff298 리뷰 3R).
import {
  PLACEHOLDERS,
  maskEnvValue,
  renderModeArgs,
  type LaunchArgEntry,
  type LaunchArgSource,
  type LaunchEnvEntry,
  type LaunchModeSpec,
} from './launch-spec-render.js';
import { resolveBinOverride } from './cli-resolver.js';
import { MODEL_ROUTING_ENV_KEYS } from './runtime-profiles.js';
import {
  resolveEffectivePermissionPolicy,
  type EffectivePermissionPolicy,
} from './permission-policy.js';
import type { ManagedAgentContext } from './managed-agent-context.js';
import { lastActualLaunch, type RecordedLaunchSpec } from './launch-spec-recorder.js';

export type { RecordedLaunchSpec };
// 소비자(서버 wire 타입 대조 테스트 등)가 이 모듈 하나만 보고도 사양 전체를
// 읽을 수 있게 재수출한다.
export type { LaunchArgEntry, LaunchArgSource, LaunchEnvEntry, LaunchModeSpec };

export interface AgentLaunchSpecEntry {
  agent_id: string;
  cli: string;
  /** 해석된 실행 파일 절대경로. resolve 가 실패하면 null 이고 사유가 아래에. */
  bin: string | null;
  bin_error: string | null;
  /** 이 CLI 가 지원하는 spawn 경로들. **첫 항목이 기본 경로**다. */
  modes: LaunchModeSpec[];
  cwd: string | null;
  /** `cwd` 의 의미 (ticket 20fff298).
   *
   *  - `'exact'` — 이 경로에서 그대로 돈다. 런타임 프로파일이 `cwd` 를 고정한
   *    경우로, 프로파일 값이 다른 모든 것을 이긴다.
   *  - `'base'` — **기준** 경로다. 티켓 디스패치는 이 아래 티켓별 worktree
   *    (`<working_dir>/.awb/wt/<repo>/<ticket>`)에서 돌기 때문에 실제 프로세스
   *    cwd 는 매번 다르다. 이걸 구분하지 않고 "작업 폴더"라고만 쓰면 argv 옆에
   *    붙은 경로가 실제 프로세스 cwd 라고 읽히는데, 그건 틀린 정보다. */
  cwd_kind: 'exact' | 'base';
  mcp_config_path: string | null;
  /** 이 spawn 에 적용될 모델 id. 미설정이면 null(= CLI 자체 기본값). */
  model: string | null;
  permission: {
    tier: EffectivePermissionPolicy['tier'];
    source: EffectivePermissionPolicy['source'];
    harness_mode: string | null;
  };
  runtime_profile: {
    id: string;
    protocol: string;
    model: string | null;
    /** 이 프로파일이 descriptor 뒤에 덧붙이는 인자 개수. */
    arg_count: number;
  } | null;
  env: LaunchEnvEntry[];
  /** **마지막으로 실제 spawn 된** 사양 (ticket 20fff298 리뷰 2R).
   *
   *  위 `modes` 는 heartbeat 시점 정보만으로 만든 **추정**이라, 디스패치 시점
   *  입력(harness / 티켓 effort / 티켓별 프로파일)이 덮는 부분을 반영하지 못한다.
   *  이 필드는 실제 spawn 사이트가 argv·env·cwd 를 확정한 직후 기록한
   *  ground truth 이므로, 화면이 추정과 실제를 나란히 놓고 차이를 보여 줄 수 있다.
   *  아직 spawn 된 적이 없으면 null. */
  last_spawn: RecordedLaunchSpec | null;
  /** 디스패치 시점에만 정해져 **추정(`modes`)** 에 반영되지 않은 입력들의 이름.
   *  `last_spawn` 이 있으면 그쪽에는 이미 반영되어 있다. */
  varies_per_dispatch: string[];
  /** 사양을 계산한 시각(ISO). */
  computed_at: string;
}

/** session 변형을 만들기 위한 sentinel. 어댑터가 이 값을 자기 형식(claude 는
 *  UUID)으로 정규화하므로 결과 토큰을 문자열로 예측하지 않고, `sessionId: null`
 *  변형과의 차집합으로 위치만 찾아낸다. */
const SESSION_ID_SENTINEL = 'awb-launch-spec-session-sentinel';

/** MCP 설정 경로 변형을 만들기 위한 sentinel. 실제 경로를 넣지 않는 이유는
 *  {@link PLACEHOLDERS.mcpConfig} 주석 참조 — 어느 spawn 경로든 이 값은
 *  spawn 시점에 만들어지는 파일이라 정적 경로를 보여 주면 안 된다. */
const MCP_CONFIG_SENTINEL = '/awb-launch-spec-mcp-sentinel.json';

/** 경로별 단서. argv 만 봐서는 드러나지 않는 조건부 동작을 적는다. */
const MODE_NOTES: Record<'session' | 'oneshot', string[]> = {
  session: [
    'MCP 설정은 spawn 마다 프로파일별 공유 설정을 복사한 per-process 임시 경로입니다 — 항상 새로 만들어집니다.',
  ],
  oneshot: [
    '티켓과 역할이 지정된 디스패치는 spawn 마다 임시 MCP 설정을 새로 만듭니다(역할별 헤더가 들어가야 하므로 정적 설정을 재사용할 수 없습니다).',
    '역할 없는 채팅 one-shot 만 아래 "MCP 설정" 의 정적 경로를 그대로 사용합니다.',
  ],
};

/** 디스패치 시점에만 정해지는 입력들. 이름만 보고하고 값은 지어내지 않는다. */
const PER_DISPATCH_INPUTS = Object.freeze([
  '보드·워크스페이스 harness (harness_config)',
  '티켓 effort preset',
  '티켓별 cli_runtime_profile',
  '프롬프트 본문 · task text',
  'spawn 마다 새로 만들어지는 MCP 설정 사본 경로',
  '티켓별 worktree 경로 (cwd 가 base 일 때 실제 프로세스 cwd)',
]);

export interface ComputeLaunchSpecDeps {
  /** `config.delegation` — CLI 별 오퍼레이터 바이너리 override 와 세션 정책. */
  delegation?: {
    claudeBin?: string | null;
    codexBin?: string | null;
    persistentTicketSessions?: boolean;
  } | null;
  /** 인스턴스 단위 `--runtime-profile` 오버라이드. 티켓별 프로파일이 오면
   *  디스패치 시점에 대체되므로 `varies_per_dispatch` 에도 적힌다. */
  runtimeProfileOverride?: RuntimeProfileSpec | null;
  /** 테스트 주입용 시계. */
  now?: () => Date;
}

/**
 * 관리 대상 에이전트 하나의 실효 실행 사양을 계산한다.
 *
 * 계약: **절대 throw 하지 않는다.** heartbeat provider 안에서 도는 코드이므로
 * 어댑터 하나가 터져도 나머지 에이전트의 사양과 heartbeat 자체를 막으면 안
 * 된다. 실패는 `bin_error` 로 표면화하고 계산 가능한 만큼만 보고한다.
 */
export function computeAgentLaunchSpec(
  ctx: ManagedAgentContext,
  deps: ComputeLaunchSpecDeps = {},
): AgentLaunchSpecEntry {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const profile = ctx.cli === 'claude' ? (deps.runtimeProfileOverride ?? null) : null;
  const permission = resolveEffectivePermissionPolicy({
    trust: ctx.runtime_config?.permission_mode ?? null,
    // harness 는 디스패치 시점 입력이라 여기서는 비어 있다. 지어내지 않는다 —
    // 그래서 이 사양의 permission.source 는 'agent_trust' 아니면 'default' 다.
    harnessMode: null,
  });
  // `--model` 로 실제 내려가는 값. **프로파일이 있으면 null 이다** — 리뷰 P1.
  //
  // spawn 사이트 둘 다 `effectiveModel = claudeRuntimeProfile ? null : (...)` 다
  // (`subagent-manager.ts` / `base-session-manager.ts`). 프로파일이 서빙하는
  // model 은 raw provider id 라 CLI 가 `--model` 값으로 거부하므로, 대신
  // `RuntimeLease.claudeEnv()` 가 ANTHROPIC_MODEL 계열 env 로 라우팅한다
  // (ticket 41dc37cb round 3). 여기서 `profile.model` 을 `--model` 자리에 넣으면
  // 실제로는 붙지 않는 플래그를 실행 명령이라고 보여 주게 된다.
  //
  // 폴백 체인도 같다: `resolveModelChain()` 이 프로파일 활성 시
  // `buildModelChain(null, null)` → `[null]` 이라, 재시도 spawn 에서도 raw
  // profile model 이 argv 에 오르지 않는다.
  const model = profile ? null : (ctx.model || null);
  // 프로파일이 서빙하는 backend model. argv 가 아니라 env 라우팅으로 전달되므로
  // `model` 과 분리해 메타데이터로만 노출한다.
  const servedModel = profile?.model || null;

  const base: AgentLaunchSpecEntry = {
    agent_id: ctx.agent_id,
    cli: ctx.cli,
    bin: null,
    bin_error: null,
    modes: [],
    cwd: profile?.cwd || ctx.working_dir || null,
    cwd_kind: profile?.cwd ? 'exact' : 'base',
    mcp_config_path: ctx.mcp_config_path || null,
    model,
    permission: {
      tier: permission.tier,
      source: permission.source,
      harness_mode: permission.harnessMode,
    },
    runtime_profile: profile
      ? {
          id: profile.id,
          protocol: profile.protocol,
          // backend 가 서빙하는 model. **argv 가 아니라 env 로 전달된다** —
          // `--model` 자리에는 오지 않으므로 위 `model` 과 혼동하면 안 된다.
          model: servedModel,
          arg_count: profile.args?.length ?? 0,
        }
      : null,
    env: [],
    last_spawn: lastActualLaunch(ctx.agent_id),
    varies_per_dispatch: [...PER_DISPATCH_INPUTS],
    computed_at: now,
  };

  let adapter;
  try {
    adapter = createAdapter(ctx.cli);
  } catch (err: any) {
    base.bin_error = `어댑터를 만들 수 없음: ${err?.message ?? err}`;
    return base;
  }

  // 실행 파일 해석 — spawn 사이트와 같은 override 우선순위를 쓴다. runtime
  // lease 의 claudeExecutable() 은 lease 를 잡은 뒤에만 존재하므로 여기서는
  // 프로파일이 선언한 claude_executable 이 그 자리를 대신한다.
  try {
    const override = resolveBinOverride(ctx.cli, deps.delegation ?? null, profile?.claude_executable ?? null);
    base.bin = adapter.resolveBin(override);
  } catch (err: any) {
    base.bin_error = String(err?.message ?? err);
  }

  const profileArgs = (profile?.args ?? []).map((a) => String(a ?? ''));
  // 정적 MCP 경로는 **의도적으로 빠져 있다** — 어느 spawn 경로도 그 값을 argv 에
  // 쓰지 않으므로(commonSpec 주석) 표시 가능 집합에 남겨 둘 이유가 없고, 남겨 두면
  // 귀속이 어긋난 토큰이 정적 경로와 우연히 일치할 때 그대로 렌더된다.
  const structuralSafe = [model, base.cwd, ctx.cli_home_dir];
  // 권한은 "빼는" 변형이 성립하지 않는다 — null 을 넘기면 어댑터가 기본
  // 등급(trusted)으로 폴백해 결국 어떤 권한 플래그든 다시 붙기 때문이다.
  // 대신 **다른 등급**으로 지어 비교하면 등급에 따라 달라지는 토큰만 정확히
  // 남는다. 두 등급 모두 아무 플래그도 안 내는 어댑터라면 차집합이 비고,
  // 그건 "이 CLI 에서 권한은 인자로 표현되지 않는다"는 올바른 답이다.
  const otherTier = permission.tier === 'trusted' ? ('strict' as const) : ('trusted' as const);

  // MCP 설정 경로에 정적 `ctx.mcp_config_path` 를 넣지 않는다 — 리뷰 P1.
  //
  // 실제 경로는 spawn 시점에 만들어진다: persistent session 은 **항상** 프로파일별
  // 공유 설정을 per-process 임시 파일로 복사해 쓰고(`base-session-manager.ts`),
  // one-shot 은 티켓+역할이 지정된 디스패치(`needsSessionPin`)면 매번 새 임시
  // 설정을 쓴다(`subagent-manager.ts`). 정적 설정을 그대로 쓰는 건 역할 없는
  // 채팅 one-shot 뿐이다. 복사 가능한 "실행 명령"에 정적 경로가 들어가면
  // 운영자가 그 값을 실효값으로 읽으므로, sentinel 을 넣고 렌더 단계에서
  // 자리표시자로 바꾼다(정적 경로는 `mcp_config_path` 필드로 따로 남는다).
  const commonSpec = {
    rolePrompt: PLACEHOLDERS.rolePrompt,
    mcpConfigPath: MCP_CONFIG_SENTINEL,
    model,
    harness: null,
    effort: null,
    permission,
  };

  // ── session 모드 (기본 경로) ────────────────────────────────────────────
  // `persistentTicketSessions` 기본값이 true 라 claude 계열은 이쪽으로 뜬다.
  // 오퍼레이터가 껐거나 어댑터가 persistent session 을 지원하지 않으면 생략한다.
  const sessionEnabled =
    deps.delegation?.persistentTicketSessions !== false
    && adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION);
  if (sessionEnabled) {
    const sessionSpecOf = (over: Partial<SessionSpec>): SessionSpec => ({
      ...commonSpec,
      sessionMode: 'persistent',
      sessionId: SESSION_ID_SENTINEL,
      ...over,
    });
    const buildSession = (over: Partial<SessionSpec>): string[] | null => {
      try {
        return [...adapter.buildSessionSpawn(sessionSpecOf(over)).args].map((a) => String(a ?? ''));
      } catch {
        return null;
      }
    };
    const full = buildSession({});
    if (full) {
      base.modes.push({
        mode: 'session',
        notes: [...MODE_NOTES.session],
        args: renderModeArgs({
          full,
          variants: [
            ['permission', buildSession({ permission: { ...permission, tier: otherTier } })],
            ['model', buildSession({ model: null })],
            ['mcp', buildSession({ mcpConfigPath: null })],
            ['session', buildSession({ sessionId: undefined })],
          ],
          bare: buildSession({ model: null, mcpConfigPath: null, sessionId: undefined }),
          profileArgs,
          structuralSafe,
        }),
      });
    }
  }

  // ── oneshot 모드 ────────────────────────────────────────────────────────
  const oneshotSpecOf = (over: Partial<OneshotSpec>): OneshotSpec => ({
    ...commonSpec,
    taskText: PLACEHOLDERS.taskText,
    cwd: base.cwd,
    cliHomeDir: ctx.cli_home_dir || null,
    ...over,
  });
  const buildOneshot = (over: Partial<OneshotSpec>): string[] | null => {
    try {
      return [...adapter.buildOneshotSpawn(oneshotSpecOf(over)).args].map((a) => String(a ?? ''));
    } catch {
      return null;
    }
  };
  const oneshotFull = buildOneshot({});
  if (oneshotFull) {
    base.modes.push({
      mode: 'oneshot',
      notes: [...MODE_NOTES.oneshot],
      args: renderModeArgs({
        full: oneshotFull,
        variants: [
          ['permission', buildOneshot({ permission: { ...permission, tier: otherTier } })],
          ['model', buildOneshot({ model: null })],
          ['mcp', buildOneshot({ mcpConfigPath: null })],
        ],
        bare: buildOneshot({ model: null, mcpConfigPath: null, cwd: null, cliHomeDir: null }),
        profileArgs,
        structuralSafe,
      }),
    });
  }

  if (base.modes.length === 0 && !base.bin_error) {
    base.bin_error = '이 CLI 어댑터에서 실행 인자를 계산할 수 없습니다.';
  }

  const env: LaunchEnvEntry[] = [];
  const cliHomeEnvKey = adapter.configDirEnv();
  if (cliHomeEnvKey && ctx.cli_home_dir) {
    // cli-home 경로는 비밀이 아니고 UI 가 이미 다른 곳에서 보여주므로 값을 남긴다.
    env.push({ key: cliHomeEnvKey, value: ctx.cli_home_dir, source: 'cli_home' });
  }
  for (const key of Object.keys(ctx.extra_env ?? {}).sort()) {
    env.push({ key, value: maskEnvValue(String(ctx.extra_env?.[key] ?? '')), source: 'credential' });
  }
  if (profile) {
    // 프로파일이 활성일 때 CLI 가 model 을 받는 **실제 경로**는 이 env 다
    // (`RuntimeLease.claudeEnv()`). `--model` 이 왜 없는지 화면에서 설명이
    // 되려면 여기 함께 보여야 한다. 값은 다른 env 와 같은 규칙으로 마스킹된다.
    for (const key of MODEL_ROUTING_ENV_KEYS) {
      env.push({ key, value: maskEnvValue(servedModel ?? ''), source: 'runtime_profile' });
    }
  }
  for (const key of Object.keys(profile?.env ?? {}).sort()) {
    env.push({ key, value: maskEnvValue(String(profile?.env?.[key] ?? '')), source: 'runtime_profile' });
  }
  base.env = env;

  return base;
}

/**
 * heartbeat 의 `agent_launch_specs` 필드를 만든다. 에이전트 하나가 터져도
 * 나머지는 보고되도록 개별적으로 감싼다.
 */
export function computeAgentLaunchSpecs(
  contexts: readonly ManagedAgentContext[],
  deps: ComputeLaunchSpecDeps = {},
): AgentLaunchSpecEntry[] {
  const out: AgentLaunchSpecEntry[] = [];
  for (const ctx of contexts) {
    if (!ctx?.agent_id) continue;
    try {
      out.push(computeAgentLaunchSpec(ctx, deps));
    } catch {
      // computeAgentLaunchSpec 자체가 throw 하지 않기로 되어 있지만, 그
      // 계약이 깨져도 heartbeat 은 계속 나가야 한다.
    }
  }
  return out;
}

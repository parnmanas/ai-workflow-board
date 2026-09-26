// CLI 모듈 계약 — 한 LLM CLI(claude / codex / opencode / …)가 agent-manager 안에서
// 알아야 하는 **모든** 것을 한 객체에 모은다.
//
// 이전에는 어댑터(spawn/parse)만 `RuntimePluginManifest` 로 등록되고, 나머지
// 관심사 — 바이너리 후보 경로, 자격증명 provider 표, device-auth 로그인, Agent
// Session 의 ACP 명령·기록 스캐너, effort preset 슬라이스, 디스패치 게이트 — 는
// 소비자 파일마다 `if (cli === 'claude')` 분기로 흩어져 있었다. CLI 하나를 더하려면
// 7~16 개 파일을 손대야 했고, 빠뜨린 분기는 컴파일 에러 없이 조용히 빠졌다.
//
// 이제 소비자는 이름을 비교하지 않고 `cliModule(id)` 로 모듈을 얻어 슬라이스를
// 본다. 슬라이스가 `undefined` 면 "이 CLI 는 그 기능을 지원하지 않는다" 이고,
// 소비자는 그 사실을 조용히 무시하지 말고 그대로 드러낸다(이전과 같은 오류 문구).
//
// 새 CLI 추가 절차는 docs/cli-modules.md 참조 — 요약: `clis/<id>/index.ts` 하나를
// 만들고 `clis/builtin.ts` 목록에 넣는다. 그 외 파일은 건드리지 않는다.
//
// 이 파일은 **타입만** 담는다(런타임 import 없음). 슬라이스 구현이 서로를,
// 그리고 소비자 파일을 import 하면 순환이 생기므로, 여기서 쓰는 보조 타입은
// 전부 구조적(structural)으로 정의한다.

import type { SessionUsage } from '../session-usage.js';
import type { RuntimePluginManifest } from '../runtime/composition/plugin-manifest.js';

// ─── binary ────────────────────────────────────────────────────────────────

/** 실행 파일을 찾는 규칙. `cli-resolver.ts` 가 이 표만 보고 후보를 열거한다. */
export interface CliBinarySpec {
  /** 실행 파일 basename — 후보 경로 열거와 PATH 탐색에 쓰인다(`agy` 처럼 CLI id 와
   *  다를 수 있다). */
  readonly name: string;
  /** 다른 CLI 의 바이너리를 빌려 쓰는 경우 그 CLI id(deepseek → claude). 설치/
   *  업데이트/최신 버전 판정은 빌려 준 쪽 기준 하나로 접힌다. */
  readonly borrowsFrom?: string;
  /** well-known 설치 경로. PATH 보다 먼저 본다(ticket ce65cf25 — PATH 에 낀
   *  구버전 snap 을 이긴다). 비우면 PATH lookup 만 한다. */
  readonly unixCandidates?: (home: string) => string[];
  readonly windowsCandidates?: (home: string) => string[];
  /** Linux 에서 부모 프로세스 실행 파일이 이 CLI 면 그것을 쓴다(claude 레거시
   *  proxy 용). */
  readonly parentExePattern?: RegExp;
  /** `config.delegation.<key>` 운영자 override 키(`claudeBin`, `codexBin`). */
  readonly delegationKey?: string;
  /** 부팅 시 `--version` 보조 프로브 대상(gh/git 과 함께 로그에 찍힌다). */
  readonly bootVersionProbe?: boolean;
}

// ─── credentials ───────────────────────────────────────────────────────────

export interface CliCredentialProviderSpec {
  /** `Credential.provider` 값. 반드시 `<cli id>_` 접두어로 시작한다. */
  readonly id: string;
  readonly label: string;
  /** 서버 credentials.controller 의 PROVIDER_FIELDS 와 같은 필드 목록. */
  readonly fields: readonly string[];
  /** 비어 있으면 spawn 을 거부하고 운영자 홈으로 fallback 하는 필드. */
  readonly required: readonly string[];
  /** 하트비트 `agent_credentials.kind` 분류. 생략 시 id 접미어로 추론
   *  (`_subscription` / `_api_key` / `_oauth_token`→api_key). */
  readonly kind?: 'subscription' | 'api_key';
}

export interface CliCredentialSpec {
  /** 이 CLI 가 받을 수 있는 provider 접두어(`claude_`). 서버/클라이언트와 같은 규약. */
  readonly prefix: string;
  readonly providers: readonly CliCredentialProviderSpec[];
}

// ─── login (device-auth) ───────────────────────────────────────────────────

export interface CliLoginPlanArgs {
  /** 이 로그인 세션 전용 격리 홈. 끝나면 통째로 지워진다. */
  readonly homeDir: string;
  /** provider 단위 로그인 CLI(opencode)만 쓴다. */
  readonly cliProvider?: string;
  readonly cliMethod?: string;
}

export interface CliLoginPlan {
  readonly spawnArgs: readonly string[];
  /** 격리 홈을 가리키도록 덮어쓸 env. `process.env` 위에 얹힌다. */
  readonly env: Readonly<Record<string, string>>;
}

/** 로그인 stdout 한 줄을 보고 서버에 알릴 것이 있으면 돌려준다. */
export interface CliLoginParsed {
  readonly verification_url?: string;
  readonly user_code?: string;
}

export interface CliLoginSpec {
  /** 수확한 credential 의 provider id(`claude_subscription`). */
  readonly harvestProvider: string;
  /** CLI 자신이 아니라 그 안의 provider 로 로그인하는가(opencode). 그러면
   *  `cliProvider`/`cliMethod` 가 둘 다 있어야 한다. */
  readonly providerScoped?: boolean;
  /** 실행 계획. 인자가 모자라면 throw — 격리 홈을 만들기 전에 끝난다. */
  plan(args: CliLoginPlanArgs): CliLoginPlan;
  /** 세션마다 새 파서를 만든다(줄 사이 상태를 가진다). `null` 은 "이 줄에는
   *  보고할 것이 없다". */
  createLineParser(): (line: string) => CliLoginParsed | null;
  /** 프로세스가 0 으로 끝난 뒤 격리 홈에서 credential 필드를 거둔다. 파일이
   *  없으면 throw(메시지가 그대로 error_detail 이 된다). */
  harvest(homeDir: string): Promise<Record<string, string>>;
}

// ─── sessions (Agent Sessions — ACP 직접 세션) ─────────────────────────────

export interface CliAcpCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** 세션 기록 스캐너가 쓰는 공용 타입 — `agent-session-history.ts` 의 것과 구조가
 *  같다(순환을 피하려고 여기서 다시 선언). */
export interface CliSessionSummary {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string | null;
  updated_at: string;
  source: 'cli' | 'awb';
  size_bytes?: number;
}

export interface CliSessionHistoryEvent {
  /** 스캐너는 비워 둔다 — 절대 위치 번호는 호출자(AgentSessionStore)가 매긴다. */
  id: string;
  seq: number;
  turn_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** 스캐너가 돌려주는 기록 원본. 번호 매기기·바이트 상한·생략 안내는 호출자가 한다. */
export interface CliSessionHistoryRead {
  events: CliSessionHistoryEvent[];
  /** 생략분까지 포함한 전체 개수. */
  total: number;
  /** `events[0]` 의 절대 인덱스(0-based). */
  offset: number;
  title: string;
  cwd: string;
  createdAt: string | null;
  updatedAt: string | null;
  sizeBytes?: number;
}

export interface CliSessionIndexEntry {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 기록 스캐너에 주입되는 컨텍스트(테스트가 홈/한도/외부 명령을 바꿔 끼운다). */
export interface CliSessionStoreContext {
  /** 이 CLI 의 운영자 홈(`operatorHome()` 결과 또는 테스트 주입값). */
  readonly home: string;
  readonly listLimit: number;
  readonly historyLimit: number;
  /** 외부 명령 실행 seam(opencode `db` 질의 등). 실패는 throw. */
  readonly exec: (bin: string, args: string[]) => Promise<string>;
}

export interface CliSessionStoreDriver {
  /** CLI 자체 기록에서 세션을 열거한다(AWB 인덱스는 호출자가 합친다). 절대 throw 하지
   *  않는다 — 못 읽으면 빈 목록. */
  listSessions(ctx: CliSessionStoreContext): Promise<CliSessionSummary[]>;
  /** 기록을 읽는다. 세션도 기록도 없으면 `null` — 호출자가 AWB 인덱스만으로 답한다.
   *  sessionId 는 호출자가 이미 형식 검사를 마친 값이다. */
  readHistory(
    ctx: CliSessionStoreContext,
    sessionId: string,
    indexEntry: CliSessionIndexEntry | null,
  ): Promise<CliSessionHistoryRead | null>;
  /** 기록 파일 경로(파일 기반 CLI 만). */
  findSessionFile?(ctx: CliSessionStoreContext, sessionId: string): Promise<string | null>;
  /**
   * 이 세션에서 **가장 최근에 기록된** 토큰 사용량. 라이브 턴이 끝났는데 ACP 어댑터가
   * usage 를 주지 않았을 때의 메꿈용이다 — CLI 자신의 기록 파일이 언제나 권위 있는
   * 출처이고, 어댑터가 무엇을 보고하든 그건 변하지 않는다.
   *
   * 없으면 그 CLI 는 라이브 usage 를 어댑터에만 의존한다(hermes — 기록 저장소 자체가 없다).
   * 절대 throw 하지 않는다 — 못 읽으면 `null`.
   */
  readLatestUsage?(ctx: CliSessionStoreContext, sessionId: string): Promise<SessionUsage | null>;
}

export interface CliSessionSpec {
  /** 이 장비에서 세션을 열 수 있는가 — PATH 만 본다(spawn 없음). */
  detect(env: NodeJS.ProcessEnv, findOnPath: (name: string) => Promise<string | null>): Promise<boolean>;
  /** ACP 어댑터 명령. `AWB_ACP_COMMAND_<CLI>` env override 는 호출자가 먼저 본다. */
  resolveAcpCommand(findOnPath: (name: string) => Promise<string | null>): Promise<CliAcpCommand>;
  /** 운영자 홈(기록이 있는 곳). `CLAUDE_CONFIG_DIR` 같은 홈 변수를 존중한다. */
  operatorHome(env: NodeJS.ProcessEnv): string;
  /** 세션 전용 cli-home 안에서 운영자 홈으로 링크할 기록 하위 디렉터리. 없으면
   *  기록을 공유하지 않는다. */
  readonly storeSubdir?: string;
  /** spawn env 보정(codex `NO_BROWSER=1`). 있는 값은 덮지 않는다. */
  adjustEnv?(env: Record<string, string>): void;
  /** Claude backend profile 을 세션에 적용할 수 있는가. */
  readonly supportsBackendProfile?: boolean;
  /** 기록 스캐너. 없으면 목록/기록은 AWB 인덱스만으로 답한다(hermes). */
  readonly store?: CliSessionStoreDriver;
}

// ─── effort preset ─────────────────────────────────────────────────────────

export type CliEffortKey = 'model' | 'effort' | 'ultracode';

export interface CliEffortSpec {
  /** preset 의 어느 슬라이스 키를 읽는가. 기본은 자기 id(deepseek → `claude`). */
  readonly sliceKey?: string;
  /** 표현 가능한 키. 나머지는 조용히 버린다(codex 는 model 만). */
  readonly keys: readonly CliEffortKey[];
}

// ─── dispatch gates ────────────────────────────────────────────────────────

export interface CliDispatchSpec {
  /** 티켓 dispatch 를 막고 pend 시킨다(pi — MCP 툴 없이 티켓을 못 닫는다). */
  readonly ticketDispatch?: 'allowed' | 'blocked';
  /** 채팅 첨부 이미지를 vision 블록으로 인라인 전달할 수 있는가(claude). */
  readonly inlineImages?: boolean;
  /** `update_plugins` 커맨드 대상인가(claude 마켓플레이스 플러그인). */
  readonly pluginUpdates?: boolean;
  /** cli-home 준비 실패를 등록 실패로 승격한다(codex — config.toml 없이는
   *  MCP 가 붙지 않아 조용히 망가진다). */
  readonly cliHomePrepFatal?: boolean;
  /** Claude backend runtime profile 을 받을 수 있는가. */
  readonly runtimeProfile?: boolean;
  /** stderr 도 툴 호출 sentinel 로 훑는다(pi — MCP 브리지 확장이 stderr 로 신호한다). */
  readonly scanStderrForTools?: boolean;
}

// ─── the module ────────────────────────────────────────────────────────────

export interface CliModule extends RuntimePluginManifest {
  /** 사람이 보는 이름(로그·오류 문구). */
  readonly label: string;
  /** 런타임이 이름 붙은 프로필을 갖는다면(hermes) 그 목록. 하트비트
   *  `runtime_capabilities.<id>.profiles` 로 실린다. best-effort — 실패는 빈 목록. */
  listProfiles?(): Promise<string[]>;
  readonly binary?: CliBinarySpec;
  readonly credentials?: CliCredentialSpec;
  readonly login?: CliLoginSpec;
  readonly sessions?: CliSessionSpec;
  readonly effort?: CliEffortSpec;
  readonly dispatch?: CliDispatchSpec;
}

/** 선언을 고정한다. `RuntimePluginManifest` 의 `defineRuntimePlugin` 과 같은
 *  역할이며 등록 시 검증은 registry 가 한다. */
export function defineCliModule(module: CliModule): CliModule {
  const prefix = module.credentials?.prefix;
  if (prefix !== undefined) {
    if (prefix !== `${module.id}_`) {
      throw new Error(`CLI module ${module.id}: credentials.prefix must be "${module.id}_" (got "${prefix}")`);
    }
    for (const p of module.credentials!.providers) {
      if (!p.id.startsWith(prefix)) {
        throw new Error(`CLI module ${module.id}: credential provider "${p.id}" must start with "${prefix}"`);
      }
      for (const r of p.required) {
        if (!p.fields.includes(r)) {
          throw new Error(`CLI module ${module.id}: provider "${p.id}" requires unknown field "${r}"`);
        }
      }
    }
  }
  if (module.login) {
    const providers = module.credentials?.providers.map((p) => p.id) ?? [];
    if (!providers.includes(module.login.harvestProvider)) {
      throw new Error(
        `CLI module ${module.id}: login.harvestProvider "${module.login.harvestProvider}" is not a declared credential provider`,
      );
    }
  }
  return Object.freeze({ ...module, capabilities: Object.freeze(module.capabilities) });
}

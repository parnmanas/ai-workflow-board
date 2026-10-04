// Agent Session (CLI 직접 세션) 러너 — docs/agent-sessions.md.
//
// 세션의 단위는 **(이 Runtime Host, CLI, CLI 네이티브 세션 id)** 다. AWB 서버는
// `agent_session_request` SSE 로 (1) list / history / open 을 RPC 로 묻고, (2) prompt /
// permission / cancel / set_mode / close 를 fire-and-forget 으로 보낸다. 러너는
//   - 목록·기록은 AgentSessionStore(CLI 홈의 세션 파일)에서 읽어 RPC 로 응답하고,
//   - 세션당 하나의 ACP 어댑터 프로세스(claude-agent-acp / codex-acp / hermes-acp /
//     사용자 지정)를 띄워 **운영자의 CLI 홈 그대로** session/load 또는 session/new 로 연 뒤,
//   - 스트림(text · reasoning · tool call · permission · usage)을 가공 없이 서버로 중계한다.
//
// 기존 chat/ticket 세션 매니저와 달리 AWB Agent identity·프롬프트 래핑·히스토리 재조립이
// 없다. 답변은 MCP 툴 호출이 아니라 agent_message_chunk 스트림이다.

import { access, constants as fsConstants, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { AgentSessionStore, type HistoryEvent, type SessionSummary } from './agent-session-store.js';
import { normalizeSessionUsage, usageEventPayload } from './session-usage.js';
import { describeSessionFailure } from './session-failure.js';
import { cliModulesWith, cliSessions, findCliModule, requiredCredentialFields } from './clis/index.js';
import { findOnPath } from './find-on-path.js';
import { describeHolders, findLockHolders, killHolder, selectKillTargets, type LockHolder } from './file-lock-holders.js';
import { AGENT_MANAGER_HOME } from './constants.js';
import { normalizeCredentialFields } from './credential-fields.js';
import { log } from './logging.js';
import { terminateDetachedProcessTree } from './process-tree.js';
import { checkSessionProgress, type ProgressCheckResult } from './session-progress.js';
import { LocalImageError, readLocalImage } from './session-local-image.js';
import {
  fetchSessionCredential,
  patchAgentSessionState,
  postAgentSessionEvents,
  postAgentSessionRpcResponse,
  type AgentSessionAuthPatch,
  type AgentSessionConfigOptionPatch,
  type AgentSessionEventInput,
  type AgentSessionRef,
  type AgentSessionStatePatch,
  type AwbConfig,
} from './rest.js';
import { createRuntimeCliAdapter } from './runtime/runtime-registry.js';
import {
  runtimeCredentialEnv,
  startRuntimeProfile,
  validateRuntimeProfile,
  type RuntimeLease,
} from './runtime-profiles.js';
import type { RuntimeProfileSpec } from './cli-adapters/base.js';
import { AcpClient } from './runtime/acp/acp-client.js';
import type {
  AcpAuthStatus,
  AcpElicitationOutcome,
  AcpElicitationRequest,
  AcpMcpServer,
  AcpPermissionOutcome,
  AcpPermissionRequest,
} from './runtime/acp/acp-types.js';
import type { RuntimeEvent } from './runtime/runtime-events.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts AgentSessionRequestPayload). */
export interface AgentSessionRequest {
  manager_id: string;
  workspace_id?: string;
  cli: string;
  /** 서버의 `AGENT_SESSION_REQUEST_OPS`(apps/server/src/common/types/agent-sessions.ts)를
   *  그대로 비춘다. agent-manager 는 별도 패키지라 그 타입을 import 할 수 없어 사본이
   *  불가피하다 — op 를 추가할 때는 **양쪽을 같은 PR 로** 고칠 것. */
  op: 'list' | 'history' | 'open' | 'prompt' | 'permission' | 'elicitation' | 'cancel' | 'set_mode' | 'set_config_option' | 'close' | 'restart' | 'image' | 'local_image';
  request_id?: string;
  session_id?: string | null;
  cwd?: string;
  title?: string;
  turn_id?: string;
  text?: string;
  /**
   * prompt — 사용자가 함께 보내는 이미지. base64 바이트를 그대로 싣는다.
   * ACP `session/prompt` 의 Image 블록으로 변환된다 — opencode 가 `promptCapabilities.image`
   * 를 광고하는(1.18.34 실측) 네이티브 경로라 MCP 같은 우회가 필요 없다. vision 을 모르는
   * 모델은 어댑터·모델이 직접 거절/무시한다(실측: "this model doesn't support image input").
   */
  images?: { base64?: string; mime_type?: string }[];
  permission_request_id?: string;
  option_id?: string | null;
  mode_id?: string;
  /** image — 보관된 이미지 참조(이벤트 payload 의 `image_ref`). */
  image_ref?: string;
  /** local_image — 에이전트가 답에 적은 미리보기 파일 경로(`![alt](path)` 이미지·html·md). 상대 경로는 세션 cwd 기준. */
  image_path?: string;
  /** set_config_option */
  config_id?: string;
  config_value?: string | boolean;
  /** open/prompt — 세션이 열린 직후 다시 걸 설정(`{ [configId]: value }`, `__mode` 는 레거시 set_mode). */
  config_defaults?: Record<string, string | boolean>;
  /** CLI 설정에서 고른 Claude backend profile — 그 엔드포인트·모델로 세션을 띄운다. */
  runtime_profile?: RuntimeProfileSpec | null;
  /** elicitation — 에이전트 질문/폼에 대한 답 */
  elicitation_id?: string;
  elicitation_action?: 'accept' | 'decline' | 'cancel';
  elicitation_content?: Record<string, unknown> | null;
  /** CLI 설정에 묶인 워크스페이스 Credential(open/prompt). 없으면 운영자 로그인 그대로. */
  credential_id?: string | null;
  /** open — 세션 잠금을 쥔 **외부** 프로세스까지 종료하고 연다.
   *
   *  기본(false)에서도 AWB 가 띄운 유령 ACP 어댑터는 알아서 정리한다. 이 플래그가 여는
   *  것은 그 너머, 운영자의 Codex 앱이나 터미널처럼 AWB 것이 아닌 프로세스를 죽이는
   *  경우다 — 그쪽은 이 세션 하나가 아니라 그 앱의 다른 대화까지 함께 내려가므로,
   *  화면이 주인의 이름·PID 를 보여 주고 확인을 받은 뒤에만 켜서 보낸다. */
  force?: boolean;
  driver_user_id: string;
  issued_at: string;
}

export interface ResolvedAcpCommand {
  command: string;
  args: string[];
}

export interface AgentSessionRunnerOptions {
  /** 매니저 자신의 agent identity — 서버 라우팅/응답 소유 검증에 쓴다. */
  getManagerId: () => string;
  store?: AgentSessionStore;
  /** 30분 유휴 시 프로세스 회수(세션은 CLI 홈에 남아 있으므로 다음 prompt 가 다시 연다). */
  idleMinutes?: number;
  permissionTimeoutMs?: number;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** 턴이 아무 이벤트도 못 내보낸 채 이만큼 지나면 트랜스크립트에 한 줄 알린다. */
  silenceWarnMs?: number;
  flushIntervalMs?: number;
  /** 테스트용 명령 해석 override. */
  commandResolver?: (cli: string) => Promise<ResolvedAcpCommand>;
  baseEnv?: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** 세션 프로세스에 주입할 AWB MCP 서버 — 기본은 매니저 키로 인증하는 http 서버. */
  mcpServers?: (sessionId: string) => AcpMcpServer[];
  /** credential 이 묶인 세션의 전용 cli-home 루트. 기본 `$AWB_AGENT_MANAGER_HOME/session-homes`. */
  sessionHomesDir?: string;
  /** 테스트용 credential 조회 override. */
  credentialFetcher?: (credentialId: string, workspaceId: string) => Promise<SessionCredential | null>;
  /** stdout 한 줄 상한 override — 테스트가 64MiB 를 쓰지 않고 초과 경로를 돌기 위한 주입점. */
  maxLineBytes?: number;
}

export interface SessionCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}

/** `config_defaults` 의 예약 키 — 레거시 `session/set_mode`(config option 이 아닌 modes). 서버와 같은 값. */
const MODE_DEFAULT_KEY = '__mode';

/** 세션에 AWB credential 을 묶을 수 있는 CLI 의 provider 접두어(서버 SESSION_CLI_CREDENTIAL_PREFIX
 *  와 같은 규약) — 세션 슬라이스와 credential 슬라이스를 **둘 다** 가진 모듈만. */
export function sessionCredentialPrefix(cli: string): string | null {
  const module = findCliModule(cli);
  if (!module?.sessions || !module.credentials) return null;
  return module.credentials.prefix;
}

/** 위 함수의 표 형태 — 테스트·로그용. */
export const SESSION_CLI_CREDENTIAL_PREFIX: Record<string, string> = Object.fromEntries(
  cliModulesWith('sessions')
    .filter((m) => m.credentials)
    .map((m) => [m.id, m.credentials!.prefix]),
);

/**
 * 오류 문구에서 bearer 토큰/API 키를 가린다. CLI/SDK 오류가 헤더 값을 그대로 인용하는
 * 경우가 있어(예: 잘못된 헤더 값 오류에 토큰 전체가 실린다) 그대로 중계하면 트랜스크립트와
 * 로그에 비밀이 남는다.
 */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer <redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-<redacted>')
    .replace(/(api[_-]?key|oauth[_-]?token|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
}

interface SessionAuth {
  label: string;
  /** backend profile 이 걸렸으면 그 lease — 세션이 닫힐 때 반납한다(어댑터 사이드카가 있으면 함께 정리). */
  runtimeLease?: RuntimeLease | null;
  /** 자격증명의 출처 — 워크스페이스 Credential 인지, 그 장비 운영자의 CLI 로그인인지. */
  source: 'credential' | 'operator';
  env: Record<string, string>;
  stripEnvKeys: string[];
  cliHome: string | null;
}

/** 서버로 이미 보낸(seq/id 가 찍힌) 이벤트 행. */
type StampedEvent = AgentSessionEventInput & { seq: number; id: string; created_at: string };

interface PendingPermission {
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
  /** 중계했던 permission_request 행 — history RPC 가 미결 요청을 다시 실어 보낸다(같은 id 라 UI 가 중복을 거른다). */
  event: StampedEvent;
}

/** 어댑터의 `elicitation/create`(질문/폼) — 사용자가 답할 때까지 JSON-RPC 요청을 열어 둔다. */
interface PendingElicitation {
  resolve: (outcome: AcpElicitationOutcome) => void;
  timer: NodeJS.Timeout;
  event: StampedEvent;
}

type CommandPatch = { name: string; description: string; input_hint?: string };

interface LiveSession {
  cli: string;
  sessionId: string;
  /** 이 프로세스의 MCP 연결이 `X-AWB-Session-Id` 로 보내는 값 — 불러온 세션은 세션 id, 새 세션은 `pending-<uuid>`. */
  mcpSessionRef: string;
  cwd: string;
  title: string;
  /** Only a newly created session may derive its initial title from a prompt. */
  allowPromptTitle: boolean;
  client: AcpClient;
  loadSupported: boolean;
  /** session/load 가 기록을 재생하는 동안 true — 재생 이벤트는 UI 가 이미 history 로 가졌으므로 버린다. */
  loading: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingElicitations: Map<string, PendingElicitation>;
  /** 세션 id 를 알기 전(session/new 응답 전)에 어댑터가 보낸 행 — 열리는 즉시 순서대로 흘려보낸다. */
  preSessionEvents: AgentSessionEventInput[];
  /** 어댑터가 준 세션 설정(모델·reasoning …)·slash command·모드 — history RPC 의 `live` 로 서버가 다시 받는다. */
  configOptions: AgentSessionConfigOptionPatch[];
  availableCommands: CommandPatch[];
  currentMode: string | null;
  availableModes: Array<{ id: string; name: string; description?: string }>;
  /** `sawUsage` — 이 턴에 어댑터가 사용량을 보고했는가(안 했으면 기록에서 메꾼다). */
  turn: { turnId: string; startedAt: number; sawUsage?: boolean } | null;
  textBuffer: string;
  reasoningBuffer: string;
  flushTimer: NodeJS.Timeout | null;
  /** 턴이 조용한 동안 도는 감시 타이머 — 이벤트가 하나라도 나오면 꺼진다. */
  silenceTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  postChain: Promise<void>;
  seq: number;
  /** 프로세스마다 다른 id 접두어 — 라이브 seq 는 프로세스마다 1 부터라 id 만으로 중복을 걸러야 한다. */
  nonce: string;
  /** 이 프로세스에 적용된 CLI 설정 credential('' = 운영자 로그인). 바인딩이 바뀌면 재오픈한다. */
  credentialId: string;
  /** 자격증명의 출처 — 매니저가 아는 사실. 어댑터가 알려 주는 신원과 합쳐 `auth` 로 보고한다. */
  authSource: 'credential' | 'operator';
  /** 어댑터가 `_auth/status_update` 로 알려 준 신원. 안 알려 주면 null("모른다"). */
  authStatus: AgentSessionAuthPatch | null;
  /** backend profile lease — 프로세스를 회수할 때 같이 반납한다. */
  runtimeLease: RuntimeLease | null;
  /** 이미 발행한 이미지(`<tool_call_id>:<ref>`) — 같은 tool 결과가 업데이트로 다시 와도 한 번만. */
  emittedImages: Set<string>;
  /** 이 프로세스의 cli-home(세션 전용 홈, 운영자 로그인이면 null). 진행 신호 3
   *  (cli-home 서브트리 mtime)의 스캔 루트다 — 없으면 그 신호만 건너뛴다. */
  cliHome: string | null;
  /** 어댑터가 **무엇이든** 내보낸 마지막 시각(epoch ms). 진행 신호 1.
   *  `#enqueue` 한 곳에서만 찍는다 — 모든 이벤트가 그 깔때기를 지난다. */
  lastOutputAtMs: number | null;
  closing: boolean;
  exited: boolean;
}

/**
 * Agent Session 의 유휴 회수 창 — 기본 3시간.
 *
 * 예전에는 30분이었고, 판정이 `live.turn` 과 대기 중 권한/질문만 봤다. 그래서 세션이 들고
 * 있는 자식들(서브에이전트 · 백그라운드 셸 · 긴 빌드)을 보지 못해 **일하고 있는 세션을
 * 죽였다**. 그 기본값을 한 번 0(끔)으로 내렸다가, 이제 chat/ticket 세션이 이미 쓰고 있는
 * 3-신호 진행 gate(`session-progress.ts`, 티켓 6ff827cb)를 붙이고 다시 켠다.
 *
 * 지배 원칙은 그 모듈이 정한 그대로다: **타이머 만료는 CHECK 이고 KILL 이 아니다.** 시계가
 * 흘렀다는 것은 증거가 아니고, 죽이는 근거는 진행 증거의 *부재* 뿐이다(`#reapIfIdle`).
 * 게다가 이 타이머는 턴이 도는 동안에는 아예 걸리지 않으므로, 회수 후보는 "턴도 없고,
 * 출력도 없고, 자손 프로세스도 없고, cli-home 에 쓰기도 없는" 세션뿐이다.
 *
 * 창을 30분이 아니라 3시간으로 둔 이유: 회수가 공짜가 아니다. 전사는 디스크에 남아
 * `--resume` 으로 복원되지만 CLI 의 따뜻한 컨텍스트는 사라진다. 자원 회수의 이득이
 * 그 비용을 넘는 지점은 "잠깐 자리를 비웠다" 가 아니라 "사실상 버려졌다" 쪽이다.
 *
 * `agent_sessions.idle_minutes` 로 조절하고, **0 이하면 타이머를 아예 걸지 않는다**(완전 끔).
 */
const DEFAULT_IDLE_MINUTES = 180;
const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;
/**
 * 턴이 **아무것도** 내보내지 않은 채 이만큼 지나면 화면에 한 줄 알린다.
 *
 * 건강한 긴 턴은 조용하지 않다 — 생각이든 도구 호출이든 계속 흘린다. 반대로 CLI 가
 * 업스트림 오류(무료 한도 429 등)를 **조용히 재시도**하면 ACP 응답도, stderr 도, 이벤트도
 * 없이 프롬프트 타임아웃(기본 6시간)까지 멎는다(실측: opencode 1.18.32 + `opencode/big-pickle`
 * 무료 모델 — "Working" 인 채로 영원히). 그때 사용자에게 보이는 것이 아무것도 없으면
 * 세션이 고장 난 것과 구분되지 않으므로, 턴은 그대로 두고 사실만 알린다(Stop 은 사용자 몫).
 */
const SILENT_TURN_WARN_MS = 90_000;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
const MAX_TOOL_TEXT_CHARS = 16_000;
/**
 * 세션 어댑터의 stdout 한 줄 상한. 기본값(4MiB)은 세션에는 작다 — 큰 파일 읽기나 긴 명령
 * 출력이 한 줄짜리 알림으로 오면 그 줄 하나가 프로세스를 통째로 죽였다("ACP stdout line
 * exceeds the configured byte limit" → SIGTERM). 넉넉히 올리되 무한 버퍼는 만들지 않고,
 * 넘치면 그 줄만 버리고 스트림은 이어 간다(skipOversizedLines).
 */
const SESSION_MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 200_000;
/** 이미지 참조 = base64 의 sha256 앞 32자. 라이브와 기록이 같은 이미지에 같은 참조를 쓴다. */
function imageRefOf(base64: string): string {
  return createHash('sha256').update(base64).digest('hex').slice(0, 32);
}

/** 보관·전달할 이미지 한 장의 상한. 넘으면 사실을 알리고 버린다 — 조용히 사라지는 것보다 낫다. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOW_KINDS = new Set(['allow_once', 'allow_always', 'allow_session']);
/** Agent Session 을 열 수 있는 CLI(세션 슬라이스를 선언한 모듈). */
export const ACP_SESSION_CLIS: readonly string[] = cliModulesWith('sessions').map((m) => m.id);

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]` : value;
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return truncateText(value, MAX_TOOL_TEXT_CHARS);
  if (typeof value !== 'object' || value === null) return value;
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => boundedValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[key] = boundedValue(entry, depth + 1);
  }
  return out;
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedValue(payload) as Record<string, unknown>;
  const serialized = JSON.stringify(bounded);
  if (serialized.length <= MAX_PAYLOAD_CHARS) return bounded;
  return { truncated: true, preview: serialized.slice(0, 4_000) };
}

/** ACP SessionConfigOption[] → 서버 패치 모양. 그룹(`{group, name, options}`)은 평탄화하고 group 라벨을 남긴다. */
export function parseConfigOptions(raw: unknown): AgentSessionConfigOptionPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSessionConfigOptionPatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    // 실제 어댑터(codex-acp 1.12, claude-agent-acp 0.79)는 SDK 1.x 스키마의 `id` 로 보낸다. v2 초안은 `configId`.
    const configId = typeof o.configId === 'string' ? o.configId : typeof o.id === 'string' ? o.id : typeof o.config_id === 'string' ? o.config_id : '';
    if (!configId) continue;
    const type = typeof o.type === 'string' ? o.type : (typeof o.currentValue === 'boolean' ? 'boolean' : 'select');
    const options: AgentSessionConfigOptionPatch['options'] = [];
    const pushOption = (v: unknown, group?: string) => {
      if (!v || typeof v !== 'object') return;
      const opt = v as Record<string, unknown>;
      const value = typeof opt.value === 'string' ? opt.value : typeof opt.id === 'string' ? opt.id : '';
      if (!value) return;
      options.push({
        value,
        name: typeof opt.name === 'string' && opt.name ? opt.name : value,
        ...(typeof opt.description === 'string' && opt.description ? { description: opt.description } : {}),
        ...(group ? { group } : {}),
      });
    };
    if (Array.isArray(o.options)) {
      for (const v of o.options) {
        const g = v as Record<string, unknown> | null;
        if (g && typeof g === 'object' && Array.isArray(g.options)) {
          const label = typeof g.name === 'string' ? g.name : typeof g.group === 'string' ? g.group : '';
          for (const inner of g.options) pushOption(inner, label || undefined);
        } else {
          pushOption(v);
        }
      }
    }
    const current = o.currentValue ?? o.current_value;
    out.push({
      config_id: configId,
      name: typeof o.name === 'string' && o.name ? o.name : configId,
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      category: typeof o.category === 'string' && o.category ? o.category : 'unknown',
      type,
      current_value: typeof current === 'boolean' ? current : typeof current === 'string' ? current : null,
      options,
    });
  }
  return out;
}

/** ACP AvailableCommand[] → `{ name, description, input_hint? }`. */
export function parseCommands(raw: unknown): CommandPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandPatch[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim().replace(/^\//, '') : '';
    if (!name || /\s/.test(name) || names.has(name)) continue;
    names.add(name);
    const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : null;
    const hint = input && typeof input.hint === 'string' ? input.hint : typeof c.input_hint === 'string' ? c.input_hint : '';
    out.push({ name, description: typeof c.description === 'string' ? c.description : '', ...(hint ? { input_hint: hint } : {}) });
  }
  return out;
}

/** ACP Plan / PlanUpdate(items) entries → `{ content, priority, status }[]`. 항목이 없으면 null. */
export function parsePlanEntries(raw: unknown): Array<{ content: string; priority: string; status: string }> | null {
  if (!Array.isArray(raw)) return null;
  const entries = raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      content: typeof e.content === 'string' ? e.content.slice(0, 2_000) : '',
      priority: typeof e.priority === 'string' ? e.priority : 'medium',
      status: typeof e.status === 'string' ? e.status : 'pending',
    }))
    .filter((e) => e.content);
  return entries;
}

/** `mcp_startup.<server>` (codex-acp 의 MCP 연결 알림) 이면 서버 이름, 아니면 null. */
export function mcpStartupServerOf(toolCallId: string): string | null {
  const m = /^mcp_startup\.(.+)$/.exec(String(toolCallId || ''));
  return m ? m[1] : null;
}

export { findOnPath };

function parseCommandLine(line: string): ResolvedAcpCommand {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] || '', args: parts.slice(1) };
}

/**
 * CLI 별 ACP 어댑터 명령. 우선순위:
 *   1. env AWB_ACP_COMMAND_<CLI> (예: AWB_ACP_COMMAND_CLAUDE="node /opt/acp.js")
 *   2. 모듈의 `sessions.resolveAcpCommand` (PATH 의 어댑터 바이너리 → npx 패키지 등)
 */
export async function resolveAcpCommandForCli(cli: string): Promise<ResolvedAcpCommand> {
  const envOverride = process.env[`AWB_ACP_COMMAND_${cli.toUpperCase()}`]?.trim();
  if (envOverride) return parseCommandLine(envOverride);
  const sessions = cliSessions(cli);
  if (!sessions) throw new Error(`No ACP adapter is known for CLI "${cli}".`);
  const resolved = await sessions.resolveAcpCommand(findOnPath);
  return { command: resolved.command, args: [...resolved.args] };
}

/** 이 장비에서 세션을 열 수 있는 CLI — 하트비트 `acp_session_clis`. PATH 만 본다(spawn 없음).
 *  `env` 는 override 변수(`AWB_ACP_COMMAND_<CLI>`, `HERMES_ACP_COMMAND`)를 읽는 곳이고,
 *  실행 파일 탐색은 언제나 프로세스의 PATH 를 쓴다(예전 동작 그대로). */
export async function detectAcpSessionClis(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const out: string[] = [];
  for (const module of cliModulesWith('sessions')) {
    if (env[`AWB_ACP_COMMAND_${module.id.toUpperCase()}`] || (await module.sessions.detect(env, (name) => findOnPath(name)))) {
      out.push(module.id);
    }
  }
  return out;
}


export class AgentSessionRunner {
  readonly #config: AwbConfig;
  /** 진행 중인 이미지 파일 쓰기 — 이벤트를 먼저 보내므로 읽기가 이걸 기다린다. */
  readonly #imageWrites = new Map<string, Promise<void>>();
  readonly #options: Required<Pick<AgentSessionRunnerOptions, 'idleMinutes' | 'permissionTimeoutMs' | 'requestTimeoutMs' | 'promptTimeoutMs' | 'flushIntervalMs' | 'sessionHomesDir' | 'silenceWarnMs'>>
    & Pick<AgentSessionRunnerOptions, 'commandResolver' | 'baseEnv' | 'clientVersion' | 'mcpServers' | 'getManagerId' | 'credentialFetcher' | 'maxLineBytes'>;
  readonly #store: AgentSessionStore;
  readonly #live = new Map<string, LiveSession>();
  readonly #opening = new Map<string, Promise<LiveSession>>();
  /** 프로세스가 먼저 죽어 #live 에서 빠진 세션 — stopAll 이 마지막 상태 전송까지 기다린다. */
  readonly #exited: LiveSession[] = [];

  constructor(config: AwbConfig, options: AgentSessionRunnerOptions) {
    this.#config = config;
    this.#store = options.store ?? new AgentSessionStore();
    // 기록에서 다시 읽은 이미지도 라이브와 같은 scratch·같은 참조 규칙으로 보관한다.
    this.#store.setImageSink?.((cli, sessionId, base64) => this.storeHistoryImage(cli, sessionId, base64));
    this.#options = {
      getManagerId: options.getManagerId,
      idleMinutes: options.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      permissionTimeoutMs: options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      silenceWarnMs: options.silenceWarnMs ?? SILENT_TURN_WARN_MS,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      commandResolver: options.commandResolver,
      baseEnv: options.baseEnv,
      clientVersion: options.clientVersion,
      mcpServers: options.mcpServers,
      sessionHomesDir: options.sessionHomesDir ?? join(AGENT_MANAGER_HOME, 'session-homes'),
      credentialFetcher: options.credentialFetcher,
      maxLineBytes: options.maxLineBytes,
    };
  }

  get store(): AgentSessionStore {
    return this.#store;
  }

  _snapshot(): Array<{ cli: string; session_id: string; busy: boolean; pid: number | null }> {
    return Array.from(this.#live.values()).map((live) => ({
      cli: live.cli,
      session_id: live.sessionId,
      busy: live.turn !== null || live.pendingPermissions.size > 0 || live.pendingElicitations.size > 0,
      pid: live.client.process.pid ?? null,
    }));
  }

  countInFlight(): number {
    return this._snapshot().filter((s) => s.busy).length;
  }

  /**
   * 하트비트용 — 살아 있는 세션 전체와 서버 contract 의 status. 닫히는 중/죽은 것은 뺀다. MCP 연결이 세션 id 가
   * 아닌 참조값으로 붙은 세션(새로 만든 세션)은 그 참조도 싣는다 — 서버가 그 연결이 어느 세션인지 안다.
   */
  liveStates(): Array<{ cli: string; session_id: string; status: string; mcp_session_ref?: string }> {
    return Array.from(this.#live.values())
      .filter((live) => !live.exited && !live.closing && !!live.sessionId)
      .map((live) => ({
        cli: live.cli,
        session_id: live.sessionId,
        status: this.#statusOf(live),
        ...(live.mcpSessionRef && live.mcpSessionRef !== live.sessionId ? { mcp_session_ref: live.mcpSessionRef } : {}),
      }));
  }

  #ref(cli: string, sessionId: string): AgentSessionRef {
    return { manager_id: this.#options.getManagerId(), cli, session_id: sessionId };
  }

  #key(cli: string, sessionId: string): string {
    return `${cli}:${sessionId}`;
  }

  // ─── 디스패처 진입점 ──────────────────────────────────────────────────

  async handle(request: AgentSessionRequest): Promise<void> {
    const cli = String(request.cli || '').toLowerCase();
    const sessionId = request.session_id || '';
    const tag = `[agent-session ${cli}${sessionId ? ` ${sessionId.slice(0, 8)}` : ''}]`;
    if (request.request_id) {
      await this.#handleRpc(request, cli, sessionId, tag);
      return;
    }
    const liveBefore = sessionId ? this.#live.get(this.#key(cli, sessionId)) : undefined;
    try {
      switch (request.op) {
        case 'prompt': {
          if (!sessionId) return;
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await this.#runPrompt(live, request.turn_id || randomUUID(), request.text || '', request.images);
          return;
        }
        case 'permission':
          this.#resolvePermission(cli, sessionId, request.permission_request_id || '', request.option_id ?? null);
          return;
        case 'elicitation':
          this.#resolveElicitation(cli, sessionId, request.elicitation_id || '', request.elicitation_action || 'cancel', request.elicitation_content ?? null);
          return;
        case 'set_config_option': {
          if (!sessionId || !request.config_id || request.config_value === undefined) return;
          // 살아 있지 않으면 먼저 연다 — 목록에서 들어온 기존 세션도 프롬프트 전에 모델을 바꿀 수 있다.
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await this.#setConfigOption(live, request.config_id, request.config_value);
          return;
        }
        case 'cancel': {
          const live = this.#live.get(this.#key(cli, sessionId));
          if (live) await live.client.cancel(live.sessionId).catch(() => undefined);
          return;
        }
        case 'set_mode': {
          const modeId = request.mode_id || '';
          if (!sessionId || !modeId) return;
          // 살아 있지 않으면 먼저 연다(prompt 와 같다) — 첫 프롬프트 전에 approval 모드를 고를 수 있어야 한다.
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await live.client.request('session/set_mode', { sessionId: live.sessionId, modeId }, { timeoutMs: this.#options.requestTimeoutMs });
          live.currentMode = modeId;
          const modeName = live.availableModes.find((m) => m.id === modeId)?.name || modeId;
          this.#enqueue(live, [{ type: 'system', payload: { text: `Mode set to ${modeName}.` } }], { current_mode: modeId, reason: 'mode' });
          return;
        }
        case 'close':
          await this.#closeLive(cli, sessionId, 'closed');
          return;
        case 'restart': {
          // 프로세스만 죽이고 **같은 세션 id 로** 다시 연다. 기록은 CLI 홈에 있으므로
          // 대화는 이어지고, 새 프로세스는 지금 디스크에 있는 바이너리를 쓴다 —
          // 그래서 CLI 를 올린 뒤 모델 목록·기능이 비로소 갱신된다(살아 있는
          // 프로세스는 기동 시점의 CLI 상태를 계속 물고 있다).
          if (!sessionId) throw new Error('restart requires an existing session id');
          await this.#closeLive(cli, sessionId, 'idle', 'restart');
          const restarted = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          this.#enqueue(
            restarted,
            [{ type: 'system', payload: { text: 'Session process restarted — it now runs the CLI currently on disk.' } }],
            { reason: 'restart' },
          );
          return;
        }
        default:
          log(`${tag} unknown op ${String(request.op)}`);
      }
      const settled = this.#live.get(this.#key(cli, sessionId)) ?? liveBefore;
      if (settled) await settled.postChain;
    } catch (err: any) {
      const message = redactSecrets(err?.message ?? String(err));
      log(`${tag} ${request.op} failed: ${message}`);
      const live = this.#live.get(this.#key(cli, sessionId));
      const failure: AgentSessionEventInput = { type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: request.turn_id };
      const state: AgentSessionStatePatch = { status: live?.turn ? 'busy' : 'error', last_error: message, reason: `${request.op}_failed` };
      if (live) {
        this.#enqueue(live, [failure], state);
        await live.postChain;
      } else if (sessionId) {
        await postAgentSessionEvents(this.#config, this.#ref(cli, sessionId), [{ ...failure, seq: 0, id: `${sessionId}:err:${Date.now()}`, created_at: new Date().toISOString() }], state);
      }
    }
  }

  async #handleRpc(request: AgentSessionRequest, cli: string, sessionId: string, tag: string): Promise<void> {
    const requestId = request.request_id!;
    const managerId = this.#options.getManagerId();
    try {
      switch (request.op) {
        case 'list': {
          const sessions = await this.#store.listSessions(cli);
          const withLive = sessions.map((s) => ({ ...s, live_status: this.#live.get(this.#key(cli, s.session_id)) ? this.#statusOf(this.#live.get(this.#key(cli, s.session_id))!) : undefined }));
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: true, result: { sessions: withLive } });
          return;
        }
        case 'image': {
          // 보관된 이미지 한 장의 바이트. 세션이 살아 있지 않아도 답한다 — 화면을 다시
          // 열면 전사의 이미지도 다시 그려져야 하고, 바이트는 프로세스가 아니라 디스크에 있다.
          if (!sessionId) throw Object.assign(new Error('session_id is required'), { code: 'not_found' });
          const stored = await this.readStoredImage(cli, sessionId, String(request.image_ref || ''));
          if (!stored) {
            await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: 'Image not found on this Runtime Host.', code: 'not_found' });
            return;
          }
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: true, result: { base64: stored.base64 } });
          return;
        }
        case 'local_image': {
          // 에이전트가 답에 적은 경로의 미리보기 파일(Codex 앱이 `![alt](E:/…png)` 를 그리는 것과 같은 일).
          // 이미지뿐 아니라 html/md 도 같은 통으로 읽는다 — 상대 경로의 기준은 살아 있는 세션의 cwd,
          // 없으면 화면이 아는 cwd 다.
          const live = sessionId ? this.#live.get(this.#key(cli, sessionId)) : undefined;
          try {
            const image = await readLocalImage(String(request.image_path || ''), live?.cwd || request.cwd || '');
            await postAgentSessionRpcResponse(this.#config, managerId, requestId, {
              ok: true,
              result: { base64: image.bytes.toString('base64'), mime_type: image.mimeType, path: image.path },
            });
          } catch (err: any) {
            if (!(err instanceof LocalImageError)) throw err;
            await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: err.message, code: err.code });
          }
          return;
        }
        case 'history': {
          if (!sessionId) throw Object.assign(new Error('session_id is required'), { code: 'not_found' });
          const history = await this.#store.readHistory(cli, sessionId);
          const live = this.#live.get(this.#key(cli, sessionId));
          if (!history.session && !live) {
            await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: 'Session not found on this Runtime Host.', code: 'not_found' });
            return;
          }
          // 아직 결정되지 않은 permission 요청은 CLI 홈 파일에 없다(SSE 로만 흘렀다). 화면을
          // 다시 열거나 새로고침한 사용자가 "Needs your approval" 만 보고 카드는 못 보는 일이
          // 없도록 기록 끝에 다시 실어 보낸다 — id 가 같아 라이브로 이미 받은 행과 겹치지 않는다.
          const pending = live
            ? [...Array.from(live.pendingPermissions.values()), ...Array.from(live.pendingElicitations.values())].map((p) => p.event)
            : [];
          const events = pending.length
            ? [...history.events, ...pending.map((e, i) => ({ ...e, seq: history.events.length + i + 1 }))]
            : history.events;
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, {
            ok: true,
            result: {
              session: history.session ?? (live ? this.#summaryOf(live) : null),
              events,
              truncated: history.truncated,
              live: live ? this.#stateOf(live) : null,
            },
          });
          return;
        }
        case 'open': {
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: true, result: this.#stateOf(live) });
          return;
        }
        default:
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: `Unknown RPC op ${String(request.op)}`, code: 'bad_request' });
      }
    } catch (err: any) {
      const message = redactSecrets(err?.message ?? String(err));
      log(`${tag} ${request.op} rpc failed: ${message}`);
      await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: message, code: err?.code ?? 'manager_error' });
    }
  }

  async stopAll(reason = 'manager_shutdown'): Promise<void> {
    const keys = Array.from(this.#live.values()).map((l) => [l.cli, l.sessionId] as const);
    await Promise.all(keys.map(([cli, id]) => this.#closeLive(cli, id, 'idle', reason).catch(() => undefined)));
    // systemd 는 SIGTERM 을 cgroup 전체에 보내므로 세션 프로세스가 매니저보다 먼저 죽는 일이
    // 흔하다. 그 세션은 #onProcessExit 로 이미 #live 에서 빠졌지만 마지막 상태(idle) 전송이
    // 아직 날아가는 중일 수 있다 — 매니저가 그걸 끊고 종료하면 서버에는 busy/awaiting_permission
    // 유령이 남는다. 잠깐(최대 3s) 기다려 준다.
    const drains = this.#exited.splice(0).map((l) => l.postChain);
    if (drains.length) {
      await Promise.race([Promise.all(drains), new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.())]);
    }
  }

  // ─── 프로세스/세션 열기 ───────────────────────────────────────────────

  async #ensureLive(cli: string, sessionId: string, cwd: string, title: string, request: AgentSessionRequest): Promise<LiveSession> {
    if (sessionId) {
      const existing = this.#live.get(this.#key(cli, sessionId));
      if (existing && !existing.exited && !existing.closing) {
        // CLI 설정이 바뀌었으면(credential 을 묶거나 풀었으면) 살아 있는 프로세스는 옛
        // 인증으로 떠 있는 것이다 — 턴 중이 아니면 닫고 새 인증으로 다시 연다.
        const wanted = request.credential_id || '';
        if (existing.credentialId === wanted || existing.turn) return existing;
        log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] credential binding changed (${existing.credentialId || 'operator-login'} → ${wanted || 'operator-login'}); reopening`);
        await this.#closeLive(cli, sessionId, 'idle', 'credential_changed');
      }
      const inFlight = this.#opening.get(this.#key(cli, sessionId));
      if (inFlight) return inFlight;
    }
    const opening = this.#open(cli, sessionId, cwd, title, request);
    if (sessionId) {
      this.#opening.set(this.#key(cli, sessionId), opening);
      opening.finally(() => this.#opening.delete(this.#key(cli, sessionId))).catch(() => undefined);
    }
    return opening;
  }

  async #open(cli: string, requestedSessionId: string, requestedCwd: string, title: string, request: AgentSessionRequest): Promise<LiveSession> {
    const tag = `[agent-session ${cli}${requestedSessionId ? ` ${requestedSessionId.slice(0, 8)}` : ' new'}]`;
    let cwd = requestedCwd.trim();
    if (requestedSessionId) {
      // Restore metadata even when the caller already supplied a working directory.
      const history = await this.#store.readHistory(cli, requestedSessionId).catch(() => null);
      cwd ||= history?.session?.cwd || '';
      title = history?.session?.title || title;
    }
    if (!cwd) throw new Error('No working directory: pass cwd for a new session.');
    try {
      await access(cwd, fsConstants.R_OK);
    } catch {
      throw new Error(`Working directory does not exist on this Runtime Host: ${cwd}`);
    }
    const resolver = this.#options.commandResolver ?? resolveAcpCommandForCli;
    const { command, args } = await resolver(cli);
    const auth = await this.#prepareAuth(cli, cwd, request);
    log(`${tag} spawning ACP adapter cmd=${command} ${args.join(' ')} cwd=${cwd} auth=${auth.label}`);

    let live: LiveSession | null = null;
    const env = this.#buildEnv(cli, requestedSessionId || 'new', auth);
    const client = await AcpClient.spawn({
      command,
      args,
      cwd,
      env,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onEvent: (event) => { if (live) this.#onEvent(live, event); },
      onPermissionRequest: (permission) => (live ? this.#onPermission(live, permission) : Promise.resolve({ outcome: 'cancelled' as const })),
      onElicitation: (elicitation) => (live ? this.#onElicitation(live, elicitation) : Promise.resolve({ action: 'cancel' as const })),
      onAuthStatus: (status) => { if (live) this.#onAuthStatus(live, status); },
      // 한 줄이 상한을 넘으면 그 메시지만 버리고 세션은 살려 둔다 — 잃는 것은 그 출력 하나다.
      maxLineBytes: this.#options.maxLineBytes ?? SESSION_MAX_LINE_BYTES,
      maxMessageBytes: this.#options.maxLineBytes ?? SESSION_MAX_LINE_BYTES,
      skipOversizedLines: true,
      onOversizedLine: (bytes) => {
        const mib = Math.round(bytes / (1024 * 1024));
        log(`${tag} dropped an oversized ACP message (${mib} MiB) — the session continues`);
        if (live) {
          this.#enqueue(live, [{
            type: 'system',
            payload: { text: `The agent sent a ${mib} MiB message, larger than this session can relay. That one message was dropped; the session is still running.` },
            turn_id: live.turn?.turnId,
          }]);
        }
      },
      onStderr: (line) => log(`${tag} stderr: ${redactSecrets(line)}`),
      spawnOptions: { detached: process.platform !== 'win32' },
    });

    try {
      const initialized = await client.initialize({
        clientInfo: { name: 'awb-agent-session', version: this.#options.clientVersion || '1' },
        // elicitation(form/url): 에이전트의 질문·폼(claude AskUserQuestion 등)을 카드로 받는다.
        // session.configOptions.boolean / plan: 어댑터가 boolean 설정과 plan 업데이트를 보내도 된다는 뜻.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {}, url: {} },
          session: { configOptions: { boolean: {} } },
          plan: {},
        },
      });
      const caps = (initialized?.agentCapabilities ?? {}) as Record<string, unknown>;
      const loadSupported = caps.loadSession === true;
      const authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
      // MCP 헤더(`X-AWB-Session-Id`)는 프로세스를 띄울 때 고정되는데, 새 세션의 id 는 session/new 가 끝나야 나온다.
      // 그래서 새 세션은 고유한 참조값으로 연결하고, 하트비트(`agent_sessions[].mcp_session_ref`)로 서버에 "이 참조는
      // 이 세션" 을 알린다 — 서버가 operator 세션의 연결을 알아보는 근거다(server `operator-config.ts`). 예전에는
      // 글자 그대로 'new' 를 보내서, AWB 에서 새로 연 세션은 다시 띄우기 전까지 어느 세션의 연결인지 알 수 없었다.
      const sessionIdForMcp = requestedSessionId || `pending-${randomUUID()}`;
      const mcpServers = this.#options.mcpServers ? this.#options.mcpServers(sessionIdForMcp) : this.#defaultMcpServers(sessionIdForMcp);

      live = {
        cli,
        sessionId: requestedSessionId,
        mcpSessionRef: sessionIdForMcp,
        cwd,
        title,
        allowPromptTitle: !requestedSessionId,
        client,
        loadSupported,
        loading: false,
        pendingPermissions: new Map(),
        pendingElicitations: new Map(),
        preSessionEvents: [],
        configOptions: [],
        availableCommands: [],
        currentMode: null,
        availableModes: [],
        turn: null,
        textBuffer: '',
        reasoningBuffer: '',
        flushTimer: null,
        silenceTimer: null,
        idleTimer: null,
        postChain: Promise.resolve(),
        seq: 0,
        nonce: randomUUID().slice(0, 8),
        credentialId: request.credential_id || '',
        authSource: auth.source,
        authStatus: null,
        runtimeLease: auth.runtimeLease ?? null,
        cliHome: auth.cliHome,
        lastOutputAtMs: null,
        emittedImages: new Set(),
        closing: false,
        exited: false,
      };

      let modes: unknown;
      let configOptions: unknown;
      let resumed = false;
      if (requestedSessionId) {
        if (!loadSupported) {
          throw Object.assign(new Error(`The ${cli} ACP adapter cannot resume existing sessions (no loadSession capability).`), { code: 'resume_unsupported' });
        }
        const attemptLoad = () => this.#withAuthRetry(client, cli, authMethods, env, () => client.loadSession({ sessionId: requestedSessionId, cwd, mcpServers }));
        live.loading = true;
        try {
          let loaded: unknown;
          try {
            loaded = await attemptLoad();
          } catch (err: any) {
            // 거절 사유를 다듬고, 잠금 때문이라면 주인을 찾아 정책대로 회복해 본다.
            loaded = await this.#recoverFailedResume(err, {
              cli, sessionId: requestedSessionId, cliHome: auth.cliHome, force: request.force === true, tag, retry: attemptLoad,
            });
          }
          modes = (loaded as any)?.modes;
          configOptions = (loaded as any)?.configOptions;
          resumed = true;
        } finally {
          live.loading = false;
        }
      } else {
        const created = await this.#withAuthRetry(client, cli, authMethods, env, () => client.newSession({ cwd, mcpServers }));
        live.sessionId = created.sessionId;
        modes = created.modes;
        configOptions = created.configOptions;
        await this.#store.recordAwbSession({ cli, session_id: live.sessionId, cwd, title: live.title }).catch(() => undefined);
      }
      if (!live.sessionId) throw new Error('ACP adapter returned no session id.');
      if (resumed && live.title) {
        await this.#store.touchAwbSession(cli, live.sessionId, { title: live.title }).catch(() => undefined);
      }
      const key = this.#key(cli, live.sessionId);
      this.#live.set(key, live);
      client.process.once('exit', (code, signal) => this.#onProcessExit(key, code, signal));
      if (live.preSessionEvents.length) {
        const buffered = live.preSessionEvents.splice(0);
        this.#enqueue(live, buffered);
      }
      const modeInfo = this.#parseModes(modes);
      live.currentMode = modeInfo.current;
      live.availableModes = modeInfo.available;
      live.configOptions = parseConfigOptions(configOptions);
      this.#enqueue(live, [{
        type: 'system',
        payload: {
          text: resumed ? `Session resumed (${cli}, ${cwd}).` : `Session opened (${cli}, ${cwd}).`,
          cli, cwd, resumed, command: `${command} ${args.join(' ')}`.trim(),
        },
      }], {
        status: 'ready',
        cwd,
        ...(live.title ? { title: live.title } : {}),
        current_mode: modeInfo.current,
        available_modes: modeInfo.available,
        config_options: live.configOptions,
        available_commands: live.availableCommands,
        // 어댑터가 initialize 직후 신원을 밀어 주면 여기 이미 차 있다 — 없으면 나중 push 가 채운다.
        ...(live.authStatus ? { auth: live.authStatus } : {}),
        resume_supported: loadSupported,
        last_error: null,
        reason: resumed ? 'resumed' : 'opened',
      });
      // 기억된 설정(approval 모드·모델 …)을 다시 건다 — 어댑터는 프로세스마다 기본값으로 시작하므로
      // 이걸 하지 않으면 유휴 회수·재접속 때마다 사용자의 선택이 사라진다. 실패해도 세션은 연다.
      await this.#applyConfigDefaults(live, request.config_defaults);
      this.#touch(live);
      return live;
    } catch (err) {
      const child = client.process;
      client.close();
      if (child?.pid) await terminateDetachedProcessTree(child.pid, 250, { child }).catch(() => undefined);
      await auth.runtimeLease?.close().catch(() => undefined);
      throw err;
    }
  }

  #buildEnv(cli: string, sessionId: string, auth: SessionAuth): NodeJS.ProcessEnv {
    // 기본은 운영자의 CLI 홈 그대로 — 장비에 이미 있는 세션을 그 CLI 로 이어 쓰는 것이
    // 목적이다. CLI 설정에 credential 이 묶여 있으면 세션 전용 cli-home(기록 디렉터리만
    // 운영자 홈으로 링크)과 credential env 로 바꿔 끼운다.
    const env: NodeJS.ProcessEnv = { ...(this.#options.baseEnv ?? process.env) };
    for (const key of auth.stripEnvKeys) delete env[key];
    Object.assign(env, auth.env);
    env.AWB_URL = this.#config.url;
    // 세션 홈의 `config.toml` 은 awb MCP 서버를 `bearer_token_env_var = "AWB_API_KEY"` 로 적고
    // `required = true` 로 표시한다(cli-adapters/codex.ts). 이 값이 없으면 codex 가 세션 초기화를
    // 통째로 중단한다 — 재개는 **그 대화에 기록된** MCP 설정을 다시 띄우므로 지금 config 를 고쳐도
    // 옛 대화는 계속 막힌다. 매니저 키는 이미 ACP mcpServers 의 Authorization 헤더로 같은 세션에
    // 넘어가므로 새로 노출되는 비밀은 없다(managed agent 경로도 같은 변수를 쓴다).
    env.AWB_API_KEY = this.#config.apiKey;
    env.AWB_MANAGER_ID = this.#options.getManagerId();
    env.AWB_SESSION_CLI = cli;
    env.AWB_SESSION_ID = sessionId;
    // CLI 별 env 보정(codex-acp 의 NO_BROWSER 등)은 모듈이 선언한다.
    cliSessions(cli)?.adjustEnv?.(env as Record<string, string>);
    return env;
  }

  /**
   * `session/new` / `session/load` 가 "authentication required"(-32000) 로 거부되면 ACP `authenticate`
   * 를 한 번 시도한다. 환경에 API 키가 있으면 api-key 계열 method, 없으면 남은 method 를 이름으로
   * 안내하는 오류를 낸다 — 장비에서 `<cli> login` 하거나 CLI 설정에 credential 을 묶으라는 뜻이다.
   */
  async #withAuthRetry<T>(client: AcpClient, cli: string, authMethods: unknown[], env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err: any) {
      const rpcCode = err?.rpcCode ?? err?.code;
      const message = String(err?.message ?? '');
      const authRequired = rpcCode === -32000 || /auth(entication)? required|not (logged|signed) in|unauthenticated/i.test(message);
      if (!authRequired) throw err;
      const methods = authMethods
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? m.id ?? ''), type: String(m.type ?? '') }))
        .filter((m) => m.id);
      const hasApiKey = !!(env.CODEX_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
      const apiKeyMethod = methods.find((m) => /api[-_]?key|token/i.test(m.id) || /api[-_]?key|token/i.test(m.name));
      if (hasApiKey && apiKeyMethod) {
        log(`[agent-session ${cli}] authentication required — trying ACP auth method ${apiKeyMethod.id}`);
        await client.authenticate(apiKeyMethod.id, { timeoutMs: this.#options.requestTimeoutMs });
        return await run();
      }
      const listed = methods.length ? ` Available methods: ${methods.map((m) => m.name || m.id).join(', ')}.` : '';
      throw Object.assign(
        new Error(`Authentication required for ${cli} on this Runtime Host — run \`${cli} login\` there, or bind a credential in CLI settings.${listed}`),
        { code: 'auth_required' },
      );
    }
  }

  /**
   * 어댑터가 알려 준 로그인 신원(`_auth/status_update`). 연결 단위 알림이고 바뀔 때만 오므로,
   * 받은 그대로 상태에 얹어 화면이 "이 세션은 누구로 도는가" 를 보여 줄 수 있게 한다.
   * 출처(`source`)는 어댑터가 모르는 사실이라 매니저가 채운다.
   */
  #onAuthStatus(live: LiveSession, status: AcpAuthStatus): void {
    const account = status.account && typeof status.account === 'object' ? status.account : undefined;
    const next: AgentSessionAuthPatch = {
      source: live.authSource,
      kind: typeof status.kind === 'string' ? status.kind : 'unknown',
      label: typeof status.label === 'string' ? status.label : '',
      ...(typeof status.detail === 'string' && status.detail ? { detail: status.detail } : {}),
      ...(account ? {
        account: {
          ...(typeof account.email === 'string' ? { email: account.email } : {}),
          ...(typeof account.organization === 'string' ? { organization: account.organization } : {}),
          ...(typeof account.plan === 'string' ? { plan: account.plan } : {}),
        },
      } : {}),
    };
    if (JSON.stringify(live.authStatus) === JSON.stringify(next)) return;
    live.authStatus = next;
    this.#enqueue(live, [], { auth: next, reason: 'auth' });
  }

  /**
   * 서버가 기억해 둔 설정을 세션에 다시 건다. 어댑터가 이미 그 값이면 건너뛴다(불필요한 왕복·system 행 방지).
   * 목록에 없는 키는 조용히 무시한다 — 어댑터를 바꾸거나 업그레이드하면 없어진 옵션이 있을 수 있다.
   */
  async #applyConfigDefaults(live: LiveSession, defaults: Record<string, string | boolean> | undefined): Promise<void> {
    if (!defaults) return;
    for (const [key, value] of Object.entries(defaults)) {
      try {
        if (key === MODE_DEFAULT_KEY) {
          if (typeof value !== 'string' || !value || live.currentMode === value) continue;
          if (!live.availableModes.some((m) => m.id === value)) continue;
          await live.client.request('session/set_mode', { sessionId: live.sessionId, modeId: value }, { timeoutMs: this.#options.requestTimeoutMs });
          live.currentMode = value;
          continue;
        }
        const option = live.configOptions.find((o) => o.config_id === key);
        if (!option || option.current_value === value) continue;
        if (option.type === 'select' && (typeof value !== 'string' || (option.options.length > 0 && !option.options.some((o) => o.value === value)))) continue;
        if (option.type === 'boolean' && typeof value !== 'boolean') continue;
        await this.#setConfigOption(live, key, value);
      } catch (err: any) {
        log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] could not restore ${key}: ${redactSecrets(err?.message ?? String(err))}`);
      }
    }
  }

  /** ACP `session/set_config_option` — 응답의 전체 목록으로 상태를 갱신하고 system 행으로 남긴다. */
  async #setConfigOption(live: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const before = live.configOptions.find((o) => o.config_id === configId);
    const response = await live.client.setConfigOption(
      typeof value === 'boolean'
        ? { sessionId: live.sessionId, configId, type: 'boolean', value }
        : { sessionId: live.sessionId, configId, type: 'id', value },
      { timeoutMs: this.#options.requestTimeoutMs },
    );
    if (Array.isArray(response?.configOptions)) live.configOptions = parseConfigOptions(response.configOptions);
    else if (before) {
      before.current_value = value;
    }
    const after = live.configOptions.find((o) => o.config_id === configId);
    // codex-acp 는 approval 모드를 config option(category 'mode') 으로도 노출한다 — legacy current_mode 와 맞춘다.
    if (after?.category === 'mode' && typeof after.current_value === 'string') live.currentMode = after.current_value;
    const label = after?.name || before?.name || configId;
    const chosen = typeof value === 'boolean'
      ? (value ? 'on' : 'off')
      : (after?.options.find((o) => o.value === value)?.name || String(value));
    this.#enqueue(live, [{ type: 'system', payload: { text: `${label} set to ${chosen}.` } }], {
      config_options: live.configOptions,
      ...(after?.category === 'mode' ? { current_mode: live.currentMode } : {}),
      reason: 'config_option',
    });
  }

  // ─── 세션 잠금 회복 ────────────────────────────────────────────────────

  /**
   * 재개가 거절됐을 때의 회복 경로. 성공하면 load 결과를, 아니면 **사람이 읽을 사유가
   * 담긴** 오류를 던진다.
   *
   * 잠금이 원인이면 주인을 찾아 정책을 적용한다:
   *   - AWB 가 띄운 유령 ACP 어댑터 → 항상 정리한다. 잃는 것은 그 어댑터 프로세스뿐이다
   *     (매니저가 재시작하면 이전 어댑터가 고아로 남아 잠금을 계속 쥐고 있는다).
   *   - 그 밖의 프로세스 → `force` 없이는 손대지 않는다. 실측상 codex 의 잠금 주인은
   *     스레드 전용 프로세스가 아니라 Codex 데스크톱 앱의 공용 `app-server` 였다 —
   *     죽이면 이 세션만이 아니라 그 앱의 **다른 대화까지** 함께 끊긴다. 그래서 이름과
   *     PID 를 오류 문구에 실어 보내고, 화면의 확인을 거친 재요청(`force`)만 종료한다.
   *
   * 무언가 놓아 줬으면 **한 번만** 다시 시도한다. 재시도도 실패하면 그 실패 사유를 말한다
   * — "정리했다" 로 끝내면 사용자는 여전히 왜 안 되는지 모른다.
   */
  async #recoverFailedResume(
    err: any,
    ctx: { cli: string; sessionId: string; cliHome: string | null; force: boolean; tag: string; retry: () => Promise<unknown> },
  ): Promise<unknown> {
    if (err?.code === 'auth_required') throw err;
    // 어댑터는 `Internal error` 한 줄만 내고 진짜 이유는 `data.details` 에 담는다
    // (예: `no rollout found for thread id …`). 그것까지 사용자에게 보여 준다.
    const details = (err?.data as { details?: unknown } | undefined)?.details;
    const detail = redactSecrets(String(details || err?.message || err));
    const fail = (message: string, code: string, cause: unknown): never => {
      throw Object.assign(new Error(`${ctx.cli} could not resume this session: ${message}`), { code, cause });
    };

    // 잠금과 무관한 거절(존재하지 않는 스레드 등)은 여기서 끝난다.
    if (!/already has an active writer/i.test(detail)) {
      return fail(`${detail}. Fix that and reload, or start a new session in the same folder.`, 'resume_failed', err);
    }

    const { holders, killed } = await this.#reclaimSessionLock(ctx);
    if (killed.length) {
      try {
        return await ctx.retry();
      } catch (retryErr: any) {
        const retryDetail = redactSecrets(String(
          (retryErr?.data as { details?: unknown } | undefined)?.details || retryErr?.message || retryErr,
        ));
        return fail(
          `${retryDetail}. 잠금을 쥐고 있던 ${describeHolders(killed)} 을(를) 종료했는데도 재개가 거절됐습니다.`,
          'resume_failed',
          retryErr,
        );
      }
    }

    const remaining = holders.filter((h) => h.kind === 'external');
    if (remaining.length) {
      // 주인을 특정했다 — 화면이 이름·PID 를 보여 주고 확인을 받을 수 있다.
      return fail(
        `${detail}. 이 세션의 잠금을 ${describeHolders(remaining)} 이(가) 쥐고 있습니다.`
        + ' 거기서 닫으면 바로 열립니다. 강제로 열면 그 프로세스를 종료하는데,'
        + ' 같은 프로세스가 보고 있던 다른 작업도 함께 끊깁니다.',
        'resume_locked_external',
        err,
      );
    }
    // 주인을 못 찾았다. "아무도 안 쥐었다" 가 아니라 "모른다" 이므로 강제 열기를 권하지 않는다.
    return fail(
      `${detail}. 이 세션이 그 장비의 다른 곳(터미널 또는 Codex 앱)에서 아직 열려 있습니다.`
      + ' 거기서 닫은 뒤 다시 Connect 하세요.',
      'resume_locked',
      err,
    );
  }

  /** 이 세션의 잠금 파일 후보. 운영자 홈과(credential 을 묶었다면) 세션 전용 홈 양쪽을 본다. */
  #sessionLockPaths(cli: string, sessionId: string, cliHome: string | null): string[] {
    const spec = cliSessions(cli);
    const rel = spec?.lockRelativePath?.(sessionId);
    if (!rel) return [];
    const homes = new Set<string>();
    const operator = spec?.operatorHome(process.env);
    if (operator) homes.add(operator);
    if (cliHome) homes.add(cliHome);
    return [...homes].map((home) => join(home, rel));
  }

  async #reclaimSessionLock(
    ctx: { cli: string; sessionId: string; cliHome: string | null; force: boolean; tag: string },
  ): Promise<{ holders: LockHolder[]; killed: LockHolder[] }> {
    const paths = this.#sessionLockPaths(ctx.cli, ctx.sessionId, ctx.cliHome);
    if (!paths.length) return { holders: [], killed: [] };
    const byPid = new Map<number, LockHolder>();
    for (const path of paths) {
      for (const holder of await findLockHolders(path, { log })) byPid.set(holder.pid, holder);
    }
    const holders = [...byPid.values()].filter((h) => h.pid !== process.pid);
    if (!holders.length) return { holders, killed: [] };
    log(`${ctx.tag} session lock held by ${describeHolders(holders)}`);
    const killed = selectKillTargets(holders, { force: ctx.force }).filter((h) => killHolder(h.pid, log));
    if (killed.length) {
      log(`${ctx.tag} reclaimed the session lock from ${describeHolders(killed)}`);
      // 핸들이 실제로 닫히기까지 한 박자 준다. 바로 재시도하면 같은 잠금에 또 걸린다.
      await new Promise<void>((resolve) => { setTimeout(resolve, 500).unref?.(); });
    }
    return { holders, killed };
  }

  /**
   * CLI 설정의 credential 을 세션 프로세스에 적용한다. 운영자 홈의 로그인 파일은 절대
   * 건드리지 않는다: credential 이 있으면 `<session-homes>/<cli>/<credential_id>` 를
   * 세션 전용 cli-home 으로 만들고(어댑터 prepareCliHome 이 자격증명 파일/env 를
   * 만든다), 그 안의 기록 디렉터리(projects / sessions)만 운영자 홈으로 심볼릭 링크해
   * 기존 세션이 그대로 보이고 이어지게 한다.
   */
  async #prepareAuth(cli: string, cwd: string, request: AgentSessionRequest): Promise<SessionAuth> {
    const none: SessionAuth = { label: 'operator-login', source: 'operator', env: {}, stripEnvKeys: [], cliHome: null };
    const credentialId = request.credential_id || '';
    if (!credentialId) return this.#withBackend(cli, request, none, '', undefined);
    const prefix = sessionCredentialPrefix(cli);
    if (!prefix) throw Object.assign(new Error(`${cli} sessions cannot use an AWB credential.`), { code: 'credential_unsupported' });
    const fetcher = this.#options.credentialFetcher
      ?? ((id: string, ws: string) => fetchSessionCredential(this.#config, this.#options.getManagerId(), id, ws));
    const fetched = await fetcher(credentialId, request.workspace_id || '');
    if (!fetched) throw Object.assign(new Error('The credential assigned in CLI settings could not be fetched from AWB.'), { code: 'credential_unavailable' });
    if (!fetched.provider.startsWith(prefix)) {
      throw Object.assign(new Error(`CLI settings credential provider ${fetched.provider} does not match ${cli}.`), { code: 'credential_provider_mismatch' });
    }
    // 줄바꿈 등 공백이 섞인 토큰(터미널에서 접혀 복사된 `claude setup-token` 값)은 헤더
    // 생성부터 실패한다 — managed-agent 경로와 같은 규칙으로 정리한다.
    const { fields, repaired } = normalizeCredentialFields(fetched.fields);
    if (repaired.length) log(`[agent-session ${cli}] credential ${fetched.credential_id.slice(0, 8)} whitespace repaired in: ${repaired.join(', ')}`);
    const missing = (requiredCredentialFields(fetched.provider) ?? []).filter((key) => !fields[key]);
    if (missing.length) {
      throw Object.assign(new Error(`CLI settings credential ${fetched.provider} is missing ${missing.join(', ')} — re-save it in Settings → Credentials.`), { code: 'credential_incomplete' });
    }
    const credential: SessionCredential = { ...fetched, fields };
    const adapter = createRuntimeCliAdapter(cli);
    const cliHome = join(this.#options.sessionHomesDir, cli, credential.credential_id);
    await mkdir(cliHome, { recursive: true, mode: 0o700 });
    await this.#linkSessionStore(cli, cliHome);
    const prep = await adapter.prepareCliHome(cliHome, credential, { url: this.#config.url, apiKey: this.#config.apiKey });
    const env: Record<string, string> = { ...(prep.extraEnv ?? {}) };
    const configDirEnv = adapter.configDirEnv();
    if (configDirEnv) env[configDirEnv] = cliHome;
    // 운영자 셸의 API 키(ANTHROPIC_API_KEY / OPENAI_API_KEY …)가 credential 을 덮지 않게 걷어낸다.
    const stripEnvKeys = adapter.authEnvKeys().filter((key) => !(key in env));
    await adapter.ensureWorkspaceTrust(cliHome, cwd).catch((err: any) => log(`[agent-session ${cli}] trust seed failed: ${err?.message ?? err}`));
    const auth: SessionAuth = { label: `credential:${credential.provider}`, source: 'credential', env, stripEnvKeys, cliHome };
    return this.#withBackend(cli, request, auth, credentialId, prep.extraEnv ?? {});
  }

  /**
   * CLI 설정에서 고른 Claude backend profile 을 세션에 건다. 디스패치 경로와 같은 기계를 쓴다
   * (`startRuntimeProfile` → `lease.claudeEnv()`): 엔드포인트·모델 env 를 얹고, 프로필이 어댑터
   * 사이드카를 요구하면 그 프로세스도 lease 가 관리한다. 세션이 닫힐 때 반납한다.
   *
   * 비밀은 **CLI 설정에 묶인 credential** 에서 온다 — 프로필이 특정 credential 을 가리키는데
   * 다른 것이 묶여 있으면 `runtimeCredentialEnv` 가 거부한다. 그 편이 조용히 엉뚱한 키로 붙는 것보다 낫다.
   */
  async #withBackend(
    cli: string,
    request: AgentSessionRequest,
    auth: SessionAuth,
    credentialId: string,
    credentialEnv: Record<string, string> | undefined,
  ): Promise<SessionAuth> {
    const profile = request.runtime_profile;
    if (!profile) return auth;
    if (!cliSessions(cli)?.supportsBackendProfile) {
      throw Object.assign(new Error(`A Claude backend profile cannot be applied to ${cli} sessions.`), { code: 'backend_unsupported' });
    }
    try {
      validateRuntimeProfile(profile);
    } catch (err: any) {
      throw Object.assign(new Error(`Claude backend profile "${profile.id}" is unusable: ${err?.message ?? err}`), { code: 'backend_invalid' });
    }
    const lease = await startRuntimeProfile(profile, runtimeCredentialEnv(profile, credentialId || null, credentialEnv));
    log(`[agent-session ${cli}] backend profile ${profile.id} → ${profile.base_url} (${profile.model})`);
    return {
      ...auth,
      label: `${auth.label} backend:${profile.id}`,
      runtimeLease: lease,
      // 프로필 env 가 credential env 위에 얹힌다 — 엔드포인트를 고른 쪽이 이긴다.
      env: { ...auth.env, ...lease.claudeEnv() },
    };
  }

  /**
   * 링크가 실제로 운영자의 기록을 **보여 주는가**. 존재 여부만으로는 알 수 없다 — Windows junction 은
   * 끊어져도 경로가 그대로 남아 빈 디렉터리처럼 보인다(실측: ralf 의 credential 홈에서 `sessions` 는
   * 있는데 그 아래가 통째로 비어 codex 가 `no rollout found for thread id` 로 재개를 거부했다).
   * 대상의 첫 항목이 링크를 통해 보이는지로 판정한다. 대상이 비어 있으면 판정할 수 없으므로 건드리지 않는다.
   */
  async #sessionStoreVisible(linkPath: string, target: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch {
      return true;
    }
    if (!entries.length) return true;
    try {
      await stat(join(linkPath, entries[0]));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 세션 전용 cli-home 의 기록 디렉터리를 운영자 홈으로 링크한다(멱등).
   * 이미 있으면 **내용이 보이는지 확인하고**, 끊어져 있으면 다시 만든다 — 예전에는 경로가 존재하기만
   * 하면 성공으로 보고 넘어가서, 한 번 끊어진 링크가 영영 고쳐지지 않았다(그 credential 로 여는 모든
   * 세션의 재개가 실패했다). 링크가 아니라 진짜 디렉터리가 들어 있으면 지우지 않는다 — 운영자의 자료일 수 있다.
   */
  async #linkSessionStore(cli: string, cliHome: string): Promise<void> {
    const sessions = cliSessions(cli);
    const subdir = sessions?.storeSubdir;
    if (!sessions || !subdir) return;
    const env = this.#options.baseEnv ?? process.env;
    const operatorHome = sessions.operatorHome(env);
    const target = join(operatorHome, subdir);
    const linkPath = join(cliHome, subdir);
    await mkdir(target, { recursive: true });
    let existing: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      existing = await lstat(linkPath);
    } catch {
      /* 없음 → 만든다 */
    }
    if (existing) {
      if (await this.#sessionStoreVisible(linkPath, target)) return;
      // 지워도 되는 경우만 지운다: 링크이거나(끊어진 junction 포함), 내용이 없는 디렉터리.
      // 내용이 있는 진짜 디렉터리는 운영자의 자료일 수 있으므로 손대지 않는다.
      const empty = (await readdir(linkPath).catch(() => [] as string[])).length === 0;
      if (!existing.isSymbolicLink() && !empty) {
        log(`[agent-session ${cli}] ${linkPath} is a real directory that does not mirror ${target} — leaving it alone (sessions started elsewhere will not resume here)`);
        return;
      }
      log(`[agent-session ${cli}] session store link was broken (${linkPath} → ${target}); recreating`);
      await rm(linkPath, { recursive: true, force: true });
    }
    // storeSubdir 는 한 단계(claude `projects`, codex `sessions`)일 수도, 중첩(opencode
    // `.local/share/opencode`)일 수도 있다. 부모가 없으면 symlink 가 ENOENT 로 죽고 — 그
    // credential 로 여는 **모든** opencode 세션의 open/new 가 실패했다(rolf 실측).
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  }

  #defaultMcpServers(sessionId: string): AcpMcpServer[] {
    return [{
      type: 'http',
      name: 'awb',
      url: `${this.#config.url.replace(/\/$/, '')}/mcp`,
      headers: [
        { name: 'Authorization', value: `Bearer ${this.#config.apiKey}` },
        { name: 'X-AWB-Client-Type', value: 'agent-session' },
        { name: 'X-AWB-Session-Id', value: sessionId },
      ],
    }];
  }

  #parseModes(modes: unknown): { current: string | null; available: Array<{ id: string; name: string; description?: string }> } {
    if (!modes || typeof modes !== 'object') return { current: null, available: [] };
    const m = modes as Record<string, unknown>;
    const current = typeof m.currentModeId === 'string' ? m.currentModeId
      : typeof m.current_mode_id === 'string' ? m.current_mode_id : null;
    const list = Array.isArray(m.availableModes) ? m.availableModes : Array.isArray(m.available_modes) ? m.available_modes : [];
    const available = list
      .filter((entry: any) => entry && typeof entry.id === 'string')
      .map((entry: any) => ({
        id: entry.id as string,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        description: typeof entry.description === 'string' ? entry.description : undefined,
      }));
    return { current, available };
  }

  #statusOf(live: LiveSession): string {
    if (live.exited || live.closing) return 'idle';
    if (live.pendingPermissions.size > 0) return 'awaiting_permission';
    if (live.pendingElicitations.size > 0) return 'awaiting_input';
    if (live.turn) return 'busy';
    return 'ready';
  }

  #summaryOf(live: LiveSession): SessionSummary {
    const now = new Date().toISOString();
    return { cli: live.cli, session_id: live.sessionId, cwd: live.cwd, title: live.title, created_at: now, updated_at: now, source: 'awb' };
  }

  #stateOf(live: LiveSession): Record<string, unknown> {
    return {
      session_id: live.sessionId,
      cwd: live.cwd,
      title: live.title,
      status: this.#statusOf(live),
      resume_supported: live.loadSupported,
      auth: live.authStatus,
      current_mode: live.currentMode,
      available_modes: live.availableModes,
      config_options: live.configOptions,
      available_commands: live.availableCommands,
    };
  }

  // ─── 턴 실행 ──────────────────────────────────────────────────────────

  /**
   * prompt 첨부 이미지의 mime — 미리보기 파이프라인(`local_image`, `image` 이벤트)과 같은
   * 집합만 받는다. SVG 는 화면에 그릴 수 없어(Blob origin 스크립트 실행) 여기서도 받지 않는다.
   */
  #promptImageMime(mime: unknown): string | null {
    if (typeof mime !== 'string') return null;
    const m = mime.trim().toLowerCase();
    if (m === 'image/svg+xml') return null;
    return /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(m) ? m : null;
  }

  async #runPrompt(live: LiveSession, turnId: string, text: string, images?: { base64?: string; mime_type?: string }[] | null): Promise<void> {
    if (live.turn) {
      this.#enqueue(live, [{ type: 'error', payload: { message: 'A turn is already in progress.', code: 'turn_in_progress' }, turn_id: turnId }]);
      return;
    }
    const blocks: { type: string; text?: string; data?: string; mimeType?: string }[] = [{ type: 'text', text }];
    const validImages: { mimeType: string; data: string }[] = [];
    for (const image of Array.isArray(images) ? images : []) {
      const base64 = typeof image?.base64 === 'string' ? image.base64.replace(/\s+/g, '') : '';
      const mimeType = this.#promptImageMime(image?.mime_type);
      let size = 0;
      try {
        size = Buffer.from(base64, 'base64').length;
      } catch {
        size = 0;
      }
      if (!base64 || !mimeType || size === 0 || size > MAX_IMAGE_BYTES) {
        // 한 장이 문제여도 턴 전체를 죽이지 않는다 — 무엇이 빠졌는지만 남긴다.
        this.#enqueue(live, [{
          type: 'system',
          payload: {
            text: `Skipped an attached image (${!mimeType ? 'unsupported type' : size > MAX_IMAGE_BYTES ? 'over the 8MB cap' : 'empty data'}) — the text was still sent.`,
            code: 'prompt_image_skipped',
          },
          turn_id: turnId,
        }]);
        continue;
      }
      validImages.push({ mimeType, data: base64 });
      blocks.push({ type: 'image', data: base64, mimeType });
    }
    if (!text.trim() && blocks.length <= 1) {
      this.#enqueue(live, [{ type: 'error', payload: { message: 'A prompt needs text or at least one image.', code: 'prompt_empty' }, turn_id: turnId }]);
      return;
    }
    live.turn = { turnId, startedAt: Date.now(), sawUsage: false };
    this.#clearIdle(live);
    if (!live.title && live.allowPromptTitle) {
      const titleText = text.trim() || (blocks.length > 1 ? `${blocks.length - 1} image(s)` : '');
      live.title = titleText.replace(/\s+/g, ' ').slice(0, 80);
      await this.#store.touchAwbSession(live.cli, live.sessionId, { title: live.title }).catch(() => undefined);
    }
    this.#enqueue(live, [{ type: 'turn', payload: { phase: 'started' }, turn_id: turnId }], { status: 'busy', title: live.title, reason: 'turn_started' });
    // 보낸 이미지는 에코로 그린다 — 받은 이미지와 같은 `image` 파이프라인이라 전사·다시열기·
    // 이미지 RPC 가 그대로 동작한다(다시열기는 opencode `file` 파트에서 같은 그림을 복원한다).
    for (const valid of validImages) this.#emitImage(live, { ...valid, uri: '' }, turnId);
    this.#armSilenceWatch(live, turnId);
    try {
      const response = await live.client.prompt(
        { sessionId: live.sessionId, prompt: blocks },
        { timeoutMs: this.#options.promptTimeoutMs },
      );
      this.#flushBuffers(live, turnId);
      const events: AgentSessionEventInput[] = [];
      const responseUsage = normalizeSessionUsage({
        inputTokens: response?.usage?.inputTokens,
        outputTokens: response?.usage?.outputTokens,
        cachedReadTokens: response?.usage?.cachedReadTokens,
        cacheWriteTokens: (response?.usage as any)?.cacheWriteTokens,
        reasoningTokens: response?.usage?.thoughtTokens,
        totalTokens: response?.usage?.totalTokens,
      });
      if (responseUsage) {
        live.turn = live.turn ? { ...live.turn, sawUsage: true } : live.turn;
        events.push({ type: 'usage', payload: usageEventPayload(responseUsage), turn_id: turnId });
      }
      // ACP 어댑터가 사용량을 아예 보고하지 않는 CLI 가 있다(claude-agent-acp). 그때는
      // CLI 자신의 기록에서 읽어 메꾼다 — 그 파일에는 항상 usage 가 남아 있다.
      const fallbackUsage = live.turn?.sawUsage || responseUsage
        ? null
        : await this.#store.readLatestUsage(live.cli, live.sessionId).catch(() => null);
      if (fallbackUsage) {
        events.push({ type: 'usage', payload: usageEventPayload(fallbackUsage), turn_id: turnId });
      }
      events.push({ type: 'turn', payload: { phase: 'finished', stop_reason: response?.stopReason || 'end_turn' }, turn_id: turnId });
      this.#enqueue(live, events, { status: 'ready', last_error: null, reason: 'turn_finished' });
      await this.#store.touchAwbSession(live.cli, live.sessionId).catch(() => undefined);
    } catch (err: any) {
      this.#flushBuffers(live, turnId);
      const native = err?.code === 'acp_remote_error'
        ? await this.#store.readTurnFailure(live.cli, live.sessionId, live.turn?.startedAt ?? Date.now()).catch(() => null)
        : null;
      const message = redactSecrets(describeSessionFailure(err instanceof Error ? err : { message: String(err) }, native));
      this.#enqueue(live, [
        { type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: turnId },
        { type: 'turn', payload: { phase: 'finished', stop_reason: 'error' }, turn_id: turnId },
      ], { status: live.exited ? 'idle' : 'error', last_error: message, reason: 'turn_failed' });
    } finally {
      this.#clearSilenceWatch(live);
      live.turn = null;
      this.#touch(live);
      await live.postChain;
    }
  }

  /**
   * 조용한 턴 감시. 턴이 시작될 때 걸고, 이벤트가 하나라도 나오면(#onEvent) 끈다 —
   * 즉 경고는 "이 턴은 처음부터 끝까지 아무 말이 없었다" 일 때만 한 번 나간다.
   * 턴을 죽이지는 않는다: 느린 것과 멎은 것을 여기서 구분할 수 없고, 멀쩡한 턴을
   * 끊는 쪽이 더 나쁘다. 사용자가 Stop 을 누를 수 있게 사실만 알린다.
   */
  #armSilenceWatch(live: LiveSession, turnId: string): void {
    this.#clearSilenceWatch(live);
    const waitMs = this.#options.silenceWarnMs;
    if (waitMs <= 0) return;
    live.silenceTimer = setTimeout(() => {
      live.silenceTimer = null;
      if (live.turn?.turnId !== turnId) return;
      const seconds = Math.round(waitMs / 1000);
      this.#enqueue(live, [{
        type: 'system',
        payload: {
          text: `${live.cli} has sent nothing for ${seconds}s — no output, no tool call, no error. `
            + 'It is most likely retrying an upstream failure in silence (a rate limit or an unusable model '
            + 'does this), so the turn can hang until the prompt timeout. Stop it and try another model if '
            + 'nothing follows.',
          code: 'turn_silent',
        },
        turn_id: turnId,
      }]);
    }, waitMs);
    live.silenceTimer.unref?.();
  }

  #clearSilenceWatch(live: LiveSession): void {
    if (live.silenceTimer) {
      clearTimeout(live.silenceTimer);
      live.silenceTimer = null;
    }
  }

  // ─── ACP 스트림 → 서버 ───────────────────────────────────────────────

  #onEvent(live: LiveSession, event: RuntimeEvent): void {
    // Metadata is live control state even during session/load replay, or before
    // session/new has returned an id. Publish it with the opening snapshot.
    if (event.type === 'diagnostic' && event.method === 'session/update') {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const update = data.sessionUpdate ?? data.session_update;
      if (update === 'session_info_update') {
        const title = typeof data.title === 'string' ? data.title.trim().slice(0, 200) : '';
        if (title && title !== live.title) {
          live.title = title;
          if (!live.loading && live.sessionId) {
            this.#enqueue(live, [], { title, reason: 'title' });
            void this.#store.touchAwbSession(live.cli, live.sessionId, { title }).catch(() => undefined);
          }
        }
        return;
      }
      if (update === 'available_commands_update') {
        live.availableCommands = parseCommands(data.availableCommands ?? data.available_commands);
        if (!live.loading) this.#enqueue(live, [], { available_commands: live.availableCommands, reason: 'commands' });
        return;
      }
    }
    if (live.loading) return; // session/load 재생분 — history 가 이미 UI 에 있다
    // 무엇이든 하나 왔으면 이 턴은 조용하지 않다.
    this.#clearSilenceWatch(live);
    const turnId = live.turn?.turnId;
    switch (event.type) {
      case 'message_delta':
        live.textBuffer += event.text;
        this.#scheduleFlush(live);
        return;
      case 'image_block': {
        // 바이트는 이벤트에 싣지 않는다 — base64 는 1.33배로 불어나 스크린샷 한 장이
        // payload 상한을 넘기고, 그러면 `{truncated:true}` 가 되어 이미지가 조용히
        // 사라진다. 디스크에 두고 작은 참조만 보낸다(`image` RPC 로 바이트를 받는다).
        //
        // 텍스트 버퍼를 먼저 비운다 — 이미지는 대화 흐름의 한 자리를 차지하므로,
        // 앞서 흐르던 문장 뒤에 와야 순서가 맞는다.
        this.#flushBuffers(live, turnId);
        this.#emitImage(live, event, turnId);
        return;
      }
      case 'reasoning_delta':
        live.reasoningBuffer += event.text;
        this.#scheduleFlush(live);
        return;
      case 'tool_started':
      case 'child_started': {
        const startupServer = event.type === 'tool_started' ? mcpStartupServerOf(event.toolCallId) : null;
        if (startupServer !== null) {
          // codex-acp 는 MCP 서버 연결을 `mcp_startup.<server>` 라는 한 번짜리 tool_call 로 알린다
          // (update 가 따라오지 않는다). 에이전트가 한 일이 아니라 세션이 열리는 과정이므로 카드로
          // 띄우지 않는다 — 성공은 조용히 버리고, 실패만 "툴을 못 쓴다" 는 사실이라 system 으로 남긴다.
          if (event.type === 'tool_started' && event.status === 'failed') {
            this.#flushBuffers(live, turnId);
            this.#enqueue(live, [{
              type: 'system',
              payload: { text: `MCP server "${startupServer}" did not connect — its tools are unavailable in this session.` },
              turn_id: turnId,
            }]);
          }
          return;
        }
        this.#flushBuffers(live, turnId);
        const id = event.type === 'tool_started' ? event.toolCallId : event.childRunId;
        // 초기 status 를 그대로 싣는다 — codex-acp 의 `mcp_startup.<server>` 처럼 update 없이 한 번에
        // failed/completed 로 오는 호출이 있어, 없으면 화면이 영원히 "running" 으로 남는다.
        const status = event.type === 'tool_started' && event.status ? event.status : undefined;
        this.#enqueue(live, [{
          type: 'tool_call',
          payload: { tool_call_id: id, title: event.title, kind: event.kind, input: boundedValue(event.input), delegated: event.type === 'child_started' || undefined, ...(status ? { status } : {}) },
          turn_id: turnId,
        }]);
        return;
      }
      case 'tool_updated':
      case 'tool_completed':
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{
          type: 'tool_update',
          payload: { tool_call_id: event.toolCallId, status: event.status ?? (event.type === 'tool_completed' ? 'completed' : 'in_progress'), output: boundedValue(event.output) },
          turn_id: turnId,
        }]);
        // tool 결과 이미지(PNG 를 Read 한 경우 등)는 그 tool 카드 바로 뒤에 그린다. 예전에는 버려지고
        // 모델용 주석(`[Image: original …]`)만 남았다.
        for (const image of event.images ?? []) this.#emitImage(live, image, turnId, event.toolCallId);
        return;
      case 'child_finished':
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{ type: 'tool_update', payload: { tool_call_id: event.childRunId, status: event.status, output: boundedValue(event.output) }, turn_id: turnId }]);
        return;
      case 'usage': {
        // 어댑터가 준 값도 공용 계약으로 접는다 — CLI 별로 뜻이 다른 숫자가 그대로
        // 화면에 나가면 "어떤 CLI 는 잘 나오고 어떤 건 이상하다"가 된다.
        const usage = normalizeSessionUsage({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedReadTokens: event.cachedReadTokens,
          cacheWriteTokens: (event as any).cacheWriteTokens,
          reasoningTokens: event.thoughtTokens,
          totalTokens: event.totalTokens,
        });
        if (!usage) return;
        if (live.turn) live.turn.sawUsage = true;
        this.#enqueue(live, [{ type: 'usage', payload: usageEventPayload(usage), turn_id: turnId }]);
        return;
      }
      case 'diagnostic': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const kind = String(data.sessionUpdate ?? data.session_update ?? '');
        if (event.method === 'session/update') {
          switch (kind) {
            case 'current_mode_update': {
              const modeId = String(data.currentModeId ?? data.current_mode_id ?? '');
              if (modeId) {
                live.currentMode = modeId;
                this.#enqueue(live, [], { current_mode: modeId, reason: 'mode' });
              }
              return;
            }
            case 'config_option_update':
              live.configOptions = parseConfigOptions(data.configOptions ?? data.config_options);
              this.#enqueue(live, [], { config_options: live.configOptions, reason: 'config_option' });
              return;
            case 'plan':
            case 'plan_update': {
              const entries = parsePlanEntries(kind === 'plan' ? data.entries : (data.plan as any)?.entries ?? data.entries);
              if (entries) {
                this.#flushBuffers(live, turnId);
                this.#enqueue(live, [{ type: 'plan', payload: { entries }, turn_id: turnId }]);
              }
              return;
            }
            case 'plan_removed':
              return;
            default:
              break;
          }
        }
        if (event.method === 'elicitation/complete') {
          // URL 방식 elicitation 이 끝났다는 어댑터의 알림 — 카드를 '완료' 로 닫는다.
          const elicitationId = String(data.elicitationId ?? data.elicitation_id ?? '');
          if (elicitationId) {
            this.#enqueue(live, [{ type: 'elicitation_decision', payload: { elicitation_id: elicitationId, action: 'accept', decided_by: 'agent' }, turn_id: turnId }]);
          }
          return;
        }
        log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] diagnostic ${event.method}${kind ? ` (${kind})` : ''}`);
        return;
      }
      default:
        return;
    }
  }

  async #onPermission(live: LiveSession, permission: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    if (live.loading) return { outcome: 'cancelled' };
    const turnId = live.turn?.turnId;
    this.#flushBuffers(live, turnId);
    const requestId = randomUUID();
    const options = (permission.options ?? []).map((o) => ({ option_id: o.optionId, name: o.name, kind: o.kind }));
    const meta = (permission._meta?.permission ?? null) as Record<string, unknown> | null;
    const title = permission.title || permission.toolCall?.title || (typeof meta?.title === 'string' ? meta.title : '');
    const description = permission.description || (typeof meta?.description === 'string' ? meta.description : '');
    const [requestEvent] = this.#enqueue(live, [{
      type: 'permission_request',
      payload: {
        request_id: requestId,
        tool_call_id: permission.toolCall?.toolCallId ?? permission.subject?.toolCallId ?? '',
        title,
        ...(description ? { description } : {}),
        kind: permission.toolCall?.kind ?? '',
        options,
        raw_input: boundedValue((permission.toolCall as any)?.rawInput ?? (permission.toolCall as any)?.raw_input),
      },
      turn_id: turnId,
    }], { status: 'awaiting_permission', reason: 'permission' });
    return new Promise<AcpPermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        live.pendingPermissions.delete(requestId);
        this.#enqueue(live, [{
          type: 'permission_decision',
          payload: { request_id: requestId, outcome: 'cancelled', option_id: null, decided_by: 'timeout' },
          turn_id: live.turn?.turnId,
        }], { status: 'busy', reason: 'permission_timeout' });
        resolve({ outcome: 'cancelled' });
      }, this.#options.permissionTimeoutMs);
      timer.unref?.();
      live.pendingPermissions.set(requestId, { resolve, timer, event: requestEvent });
    });
  }

  /**
   * 미결 permission 을 전부 cancelled 로 푼다(프로세스 종료·close·credential 재오픈). 결정 행을
   * 같이 중계해야 화면의 권한 카드가 "대기 중" 으로 영원히 남지 않는다 — 결정자는 사용자가
   * 아니므로 `decided_by: 'system'`.
   */
  #cancelPendingPermissions(live: LiveSession): void {
    const events: AgentSessionEventInput[] = [];
    for (const [requestId, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      live.pendingPermissions.delete(requestId);
      events.push({
        type: 'permission_decision',
        payload: { request_id: requestId, outcome: 'cancelled', option_id: null, decided_by: 'system' },
        turn_id: live.turn?.turnId,
      });
      pending.resolve({ outcome: 'cancelled' });
    }
    for (const [elicitationId, pending] of live.pendingElicitations) {
      clearTimeout(pending.timer);
      live.pendingElicitations.delete(elicitationId);
      events.push({
        type: 'elicitation_decision',
        payload: { elicitation_id: elicitationId, action: 'cancel', decided_by: 'system' },
        turn_id: live.turn?.turnId,
      });
      pending.resolve({ action: 'cancel' });
    }
    if (events.length) this.#enqueue(live, events);
  }

  /**
   * 어댑터의 `elicitation/create` — 에이전트가 사용자에게 구조화된 입력을 요청한다(claude 의
   * AskUserQuestion, codex 의 질문 등). form 은 JSON Schema 를 그대로 카드로 넘기고 답이 올 때까지
   * 요청을 연다. url 은 링크 카드만 남기고 바로 accept 한다(완료는 `elicitation/complete` 로 온다).
   */
  async #onElicitation(live: LiveSession, request: AcpElicitationRequest): Promise<AcpElicitationOutcome> {
    if (live.loading) return { action: 'cancel' };
    const turnId = live.turn?.turnId;
    this.#flushBuffers(live, turnId);
    const mode = request.mode === 'url' ? 'url' : 'form';
    const elicitationId = (mode === 'url' && typeof request.elicitationId === 'string' && request.elicitationId) ? request.elicitationId : randomUUID();
    const payload: Record<string, unknown> = {
      elicitation_id: elicitationId,
      mode,
      message: typeof request.message === 'string' ? request.message.slice(0, 8_000) : '',
      tool_call_id: typeof request.toolCallId === 'string' ? request.toolCallId : '',
    };
    if (mode === 'form') payload.schema = boundedValue(request.requestedSchema ?? {});
    if (mode === 'url') payload.url = typeof request.url === 'string' ? request.url.slice(0, 2_048) : '';
    if (mode === 'url') {
      this.#enqueue(live, [{ type: 'elicitation_request', payload, turn_id: turnId }]);
      return { action: 'accept' };
    }
    const [requestEvent] = this.#enqueue(live, [{ type: 'elicitation_request', payload, turn_id: turnId }], { status: 'awaiting_input', reason: 'elicitation' });
    return new Promise<AcpElicitationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        live.pendingElicitations.delete(elicitationId);
        this.#enqueue(live, [{
          type: 'elicitation_decision',
          payload: { elicitation_id: elicitationId, action: 'cancel', decided_by: 'timeout' },
          turn_id: live.turn?.turnId,
        }], { status: this.#statusOf(live) === 'awaiting_input' ? 'busy' : this.#statusOf(live), reason: 'elicitation_timeout' });
        resolve({ action: 'cancel' });
      }, this.#options.permissionTimeoutMs);
      timer.unref?.();
      live.pendingElicitations.set(elicitationId, { resolve, timer, event: requestEvent });
    });
  }

  #resolveElicitation(cli: string, sessionId: string, elicitationId: string, action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> | null): void {
    const live = this.#live.get(this.#key(cli, sessionId));
    if (!live) return;
    const pending = live.pendingElicitations.get(elicitationId);
    if (!pending) {
      log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] elicitation ${elicitationId.slice(0, 8)} not pending (late or duplicate answer)`);
      return;
    }
    clearTimeout(pending.timer);
    live.pendingElicitations.delete(elicitationId);
    this.#enqueue(live, [{
      type: 'elicitation_decision',
      payload: { elicitation_id: elicitationId, action, ...(action === 'accept' ? { content: boundedValue(content ?? {}) } : {}), decided_by: 'user' },
      turn_id: live.turn?.turnId,
    }], { status: live.pendingPermissions.size > 0 ? 'awaiting_permission' : 'busy', reason: `elicitation_${action}` });
    pending.resolve(action === 'accept' ? { action: 'accept', content: content ?? {} } : { action });
  }

  #resolvePermission(cli: string, sessionId: string, requestId: string, optionId: string | null): void {
    const live = this.#live.get(this.#key(cli, sessionId));
    if (!live) return;
    const pending = live.pendingPermissions.get(requestId);
    if (!pending) {
      log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] permission ${requestId.slice(0, 8)} not pending (late or duplicate decision)`);
      return;
    }
    clearTimeout(pending.timer);
    live.pendingPermissions.delete(requestId);
    const allowed = !!optionId && (ALLOW_KINDS.size > 0);
    this.#enqueue(live, [{
      type: 'permission_decision',
      payload: { request_id: requestId, outcome: optionId ? 'selected' : 'cancelled', option_id: optionId, decided_by: 'user' },
      turn_id: live.turn?.turnId,
    }], { status: 'busy', reason: allowed ? 'permission_allowed' : 'permission_denied' });
    pending.resolve(optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' });
  }

  // ─── 버퍼/전송 ────────────────────────────────────────────────────────

  #scheduleFlush(live: LiveSession): void {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = null;
      this.#flushBuffers(live, live.turn?.turnId);
    }, this.#options.flushIntervalMs);
  }

  #flushBuffers(live: LiveSession, turnId: string | undefined): void {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
    const events: AgentSessionEventInput[] = [];
    if (live.reasoningBuffer) {
      events.push({ type: 'reasoning', payload: { text: live.reasoningBuffer }, turn_id: turnId });
      live.reasoningBuffer = '';
    }
    if (live.textBuffer) {
      events.push({ type: 'text', payload: { text: live.textBuffer }, turn_id: turnId });
      live.textBuffer = '';
    }
    if (events.length) this.#enqueue(live, events);
  }

  /** 세션당 FIFO — 서버는 저장하지 않지만 소유자 UI 는 seq 순서로 병합한다. 찍힌 행을 돌려준다. */
  /**
   * 에이전트가 내보낸 이미지 — **참조만** 이벤트로 보내고 바이트는 디스크에 둔다.
   *
   * 이벤트는 **동기로** 찍는다. 예전 구현은 파일 쓰기를 await 한 뒤 enqueue 했는데, seq 는
   * enqueue 시점에 매겨지므로 이미지가 전사의 **맨 뒤로 밀렸다** — 문장 중간에 있어야 할
   * 그림이 대화 끝에 붙었다(회귀 테스트가 이것을 잡았다). 그래서 참조를 먼저 발급해 순서를
   * 확정하고, 쓰기는 뒤따라 돌린다. 아직 쓰는 중인 ref 를 화면이 먼저 요청할 수 있으므로
   * `readStoredImage` 가 그 약속을 기다린다.
   *
   * AWB 는 이 바이트를 저장하지 않는다 — 장비에 남고 요청마다 매니저가 읽어 준다.
   */
  #emitImage(
    live: LiveSession,
    event: { mimeType: string; data: string; uri: string },
    turnId: string | undefined,
    toolCallId?: string,
  ): void {
    const mimeType = event.mimeType || 'application/octet-stream';
    // 어댑터가 URL 로 준 경우 — 바이트가 없으니 참조만 넘긴다.
    if (!event.data && event.uri) {
      this.#enqueue(live, [{
        type: 'image',
        payload: { image_ref: '', mime_type: mimeType, size: 0, uri: event.uri, ...(toolCallId ? { tool_call_id: toolCallId } : {}) },
        turn_id: turnId,
      }]);
      return;
    }
    if (!event.data) return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(event.data, 'base64');
    } catch {
      return;
    }
    if (bytes.length === 0) return;
    if (bytes.length > MAX_IMAGE_BYTES) {
      // 버리더라도 **조용히** 버리지 않는다 — 조용한 소실이 이 버그의 본질이었다.
      this.#enqueue(live, [{
        type: 'system',
        payload: {
          text: `Agent sent a ${Math.round(bytes.length / 1024)}KB image — too large to show (cap ${Math.round(MAX_IMAGE_BYTES / 1024)}KB).`,
          code: 'image_too_large',
        },
        turn_id: turnId,
      }]);
      return;
    }
    const ref = imageRefOf(event.data);
    // 같은 tool 결과가 업데이트로 다시 와도 한 번만 그린다.
    // 메시지 이미지는 같은 그림이 다른 턴에 다시 나올 수 있으므로 턴까지 키에 넣는다.
    const seenKey = `${toolCallId ?? `turn:${turnId ?? ''}`}:${ref}`;
    if (live.emittedImages.has(seenKey)) return;
    live.emittedImages.add(seenKey);
    void this.#persistImage(live.cli, live.sessionId, ref, bytes);
    this.#enqueue(live, [{
      type: 'image',
      payload: { image_ref: ref, mime_type: mimeType, size: bytes.length, ...(toolCallId ? { tool_call_id: toolCallId } : {}) },
      turn_id: turnId,
    }]);
  }

  /**
   * 이미지 바이트를 이 세션의 scratch 에 쓴다. 참조는 **내용 주소**(sha256)라 같은 이미지는 같은
   * 파일이다 — 라이브로 받은 것과 나중에 기록에서 다시 읽은 것이 같은 참조가 되어, 두 번 저장하지도
   * 화면이 서로 다른 참조를 들고 헤매지도 않는다. 쓰기는 기다리지 않고 돌리며(순서를 지키려고 이벤트를
   * 먼저 보낸다), 읽기가 진행 중인 쓰기를 기다린다.
   */
  #persistImage(cli: string, sessionId: string, ref: string, bytes: Buffer): Promise<void> {
    const key = `${this.#key(cli, sessionId)}:${ref}`;
    const pending = this.#imageWrites.get(key);
    if (pending) return pending;
    const dir = this.#imageDir(cli, sessionId);
    const path = join(dir, ref);
    const write = (async () => {
      // 이미 있으면 다시 쓰지 않는다 — 내용 주소라 같은 바이트다.
      if (await stat(path).then(() => true, () => false)) return;
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
    })();
    this.#imageWrites.set(key, write);
    void write
      .catch((err: any) => {
        log(`[agent-session] image write failed ${cli}/${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
      })
      .finally(() => {
        if (this.#imageWrites.get(key) === write) this.#imageWrites.delete(key);
      });
    return write.catch(() => undefined);
  }

  /**
   * 기록 파서용 이미지 저장 통로. 세션을 다시 열면 전사는 CLI 홈의 기록 파일에서 다시 만들어지는데,
   * 그 파일에 들어 있는 이미지(tool 결과의 PNG 등)도 같은 경로로 보이게 한다. 참조를 돌려준다.
   */
  async storeHistoryImage(cli: string, sessionId: string, base64: string): Promise<{ ref: string; size: number } | null> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return null;
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const ref = imageRefOf(base64);
    await this.#persistImage(cli, sessionId, ref, bytes);
    return { ref, size: bytes.length };
  }

  /** 이 세션의 이미지 보관 디렉터리. 세션 단위로 나눠 두어 close 때 통째로 지운다. */
  #imageDir(cli: string, sessionId: string): string {
    return join(this.#options.sessionHomesDir, '..', 'session-images', cli, sessionId);
  }

  /** `image` RPC — 보관된 이미지 한 장의 바이트. 참조는 경로 조작이 불가능한 모양만 받는다. */
  async readStoredImage(cli: string, sessionId: string, ref: string): Promise<{ mimeType: string; base64: string } | null> {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(ref)) return null;
    // 화면이 이벤트를 받자마자 요청하면 쓰기가 아직 끝나지 않았을 수 있다 — 순서를 지키려고
    // 이벤트를 먼저 보내기 때문이다. 그 약속을 기다린 뒤에 읽는다(실패해도 아래 read 가 판정).
    await this.#imageWrites.get(`${this.#key(cli, sessionId)}:${ref}`)?.catch(() => undefined);
    try {
      const bytes = await readFile(join(this.#imageDir(cli, sessionId), ref));
      return { mimeType: '', base64: bytes.toString('base64') };
    } catch {
      return null;
    }
  }

  #enqueue(live: LiveSession, events: AgentSessionEventInput[], state?: AgentSessionStatePatch): StampedEvent[] {
    // 세션 id 가 정해지기 전(session/new 응답 전)에 어댑터가 보내는 알림은 보낼 곳이 없다. 예전엔
    // seq 만 올리고 버려서 이후 행의 seq 가 한 칸씩 어긋났고, UI 의 유실 감지(hasSeqGap)가 계속
    // 재조회를 돌게 했다. 아예 세지 않는다.
    // 세션 id 가 정해지기 전(session/new 응답 전)에 어댑터가 보내는 행은 보낼 곳이 없다 — 예전엔
    // seq 만 올리고 버려서 이후 행의 seq 가 한 칸씩 어긋났다(UI 의 유실 감지가 계속 재조회를 돌았다).
    // 세지 말고 모아 뒀다가 세션이 열리면 순서대로 내보낸다(MCP 연결 실패 안내가 여기 실린다).
    if (!live.sessionId) {
      live.preSessionEvents.push(...events);
      return [];
    }
    // 진행 신호 1 — 어댑터가 무엇이든 내보냈다. 모든 이벤트가 이 깔때기를 지나므로
    // 여기서만 찍으면 된다(throttle 하지 않는다 — idle gate 의 증거라 한 줄도 놓치면 안 된다).
    if (events.length) live.lastOutputAtMs = Date.now();
    const now = new Date().toISOString();
    const stamped: StampedEvent[] = events.map((e) => {
      live.seq += 1;
      return { ...e, payload: boundedPayload(e.payload), seq: live.seq, id: `${live.sessionId}:live:${live.nonce}:${live.seq}`, created_at: now };
    });
    const ref = this.#ref(live.cli, live.sessionId);
    live.postChain = live.postChain
      .then(() => (stamped.length || state
        ? postAgentSessionEvents(this.#config, ref, stamped, state ?? null)
        : Promise.resolve({ ok: true, status: 204 })))
      .then(() => undefined, () => undefined);
    return stamped;
  }

  // ─── 수명주기 ─────────────────────────────────────────────────────────

  #touch(live: LiveSession): void {
    this.#clearIdle(live);
    if (live.turn) return;
    const ms = this.#options.idleMinutes * 60_000;
    if (ms <= 0) return;
    live.idleTimer = setTimeout(() => {
      // **타이머 만료는 CHECK 이고 KILL 이 아니다** (session-progress.ts 의 지배 원칙).
      // 시계가 흘렀다는 것 자체는 증거가 아니다 — 죽이는 근거는 진행 증거의 *부재* 뿐이다.
      void this.#reapIfIdle(live, ms);
    }, ms);
    live.idleTimer.unref?.();
  }

  /**
   * 유휴 타이머가 만료됐다 — **회수해도 되는지 확인한다.**
   *
   * 턴·대기 중 권한/질문만 보던 예전 판정은 세션이 들고 있는 자식들을 보지 못해, 서브에이전트나
   * 백그라운드 빌드가 도는 세션을 죽였다. chat/ticket 세션 쪽은 이 문제를 이미 3-신호 gate 로
   * 풀어 놨으므로(`session-progress.ts`, 티켓 6ff827cb) 같은 판정을 그대로 쓴다 — 두 세션 타입이
   * 한 규칙을 공유하니 한쪽만 고쳐지는 드리프트도 없다. 신호 셋 중 **하나라도** 신선하면 살아있다:
   *
   *   1. 어댑터 출력(`lastOutputAtMs`)
   *   2. 살아있는 비-benign 자손 프로세스 — 에이전트가 띄워 기다리는 긴 빌드·테스트
   *   3. cli-home 서브트리 mtime — **같은 OS 프로세스 안에서 도는 서브에이전트/Workflow**.
   *      그건 stdout 도 자식 프로세스도 만들지 않지만 transcript 파일은 계속 자란다.
   *
   * 신호가 하나도 없으면 "죽었다" 가 아니라 "관측 가능한 증거가 없다" 다 — 순수한 외부 대기는
   * 어느 신호에도 안 걸린다(session-progress.ts 의 gap 3). 그래서 이 경로는 기본으로 꺼져 있고
   * (`agent_sessions.idle_minutes` 기본 0), 켠 호스트에서만 돈다.
   */
  async #reapIfIdle(live: LiveSession, freshMs: number): Promise<void> {
    if (live.closing || live.exited) return;
    // 턴·승인 대기는 gate 를 돌릴 필요도 없는 확정 신호다.
    if (live.turn || live.pendingPermissions.size > 0 || live.pendingElicitations.size > 0) {
      this.#touch(live);
      return;
    }
    const pid = live.client.process?.pid ?? null;
    if (pid) {
      let progress: ProgressCheckResult | null = null;
      try {
        progress = await checkSessionProgress(
          { pid, cliHomeDir: live.cliHome, cwd: live.cwd, freshMs },
          live.lastOutputAtMs,
        );
      } catch (err: any) {
        // 판정을 못 했으면 **죽이지 않는다** — 증거 없음과 확인 실패는 다르다.
        log(`[agent-session] idle gate failed ${live.cli}/${live.sessionId.slice(0, 8)}: ${err?.message ?? err} — keeping the session`);
        this.#touch(live);
        return;
      }
      if (progress.alive) {
        log(`[agent-session] idle timer fired but ${live.cli}/${live.sessionId.slice(0, 8)} is alive (${progress.reasons.join('; ')}) — re-arming`);
        this.#touch(live);
        return;
      }
    }
    await this.#closeLive(live.cli, live.sessionId, 'idle', 'idle');
  }

  #clearIdle(live: LiveSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
  }

  #onProcessExit(key: string, code: number | null, signal: NodeJS.Signals | null): void {
    const live = this.#live.get(key);
    if (!live) return;
    live.exited = true;
    this.#clearIdle(live);
    if (live.closing) {
      this.#cancelPendingPermissions(live);
      return;
    }
    this.#live.delete(key);
    void live.runtimeLease?.close().catch(() => undefined);
    const detail = `Agent process exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`;
    log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] ${detail}`);
    this.#flushBuffers(live, live.turn?.turnId);
    this.#cancelPendingPermissions(live);
    // 프로세스가 없으니 상태는 무조건 idle 이다 — 턴 중이었어도 마찬가지(#runPrompt 의 catch 가
    // 곧 error 행 + turn(finished) 을 덧붙이고 같은 idle 을 다시 보낸다). 예전엔 턴 중이면 상태를
    // 안 보냈고, 그 사이 매니저가 종료되면 서버에 busy/awaiting_permission 이 그대로 남았다.
    this.#enqueue(live, [{ type: 'system', payload: { text: `${detail} The next prompt reopens the session.` } }],
      { status: 'idle', reason: 'process_exit' });
    this.#exited.push(live);
    if (this.#exited.length > 50) this.#exited.splice(0, this.#exited.length - 50);
  }

  async #closeLive(cli: string, sessionId: string, finalStatus: 'closed' | 'idle', reason: string = finalStatus): Promise<void> {
    const key = this.#key(cli, sessionId);
    const live = this.#live.get(key);
    if (!live) return;
    live.closing = true;
    this.#clearIdle(live);
    this.#cancelPendingPermissions(live);
    if (live.turn) await live.client.cancel(live.sessionId).catch(() => undefined);
    this.#flushBuffers(live, live.turn?.turnId);
    if (!live.exited) await live.client.closeSession(live.sessionId).catch(() => undefined);
    this.#live.delete(key);
    const child = live.client.process;
    const pid = child?.pid;
    live.client.close();
    if (pid && child) await terminateDetachedProcessTree(pid, 250, { child }).catch(() => undefined);
    await live.runtimeLease?.close().catch(() => undefined);
    const text = finalStatus === 'closed'
      ? 'Agent process stopped.'
      : reason === 'idle'
        ? `No progress for ${this.#options.idleMinutes} min (no output, no background task, no cli-home activity) `
          + '— agent process stopped. The next prompt reopens the session.'
        : reason === 'credential_changed'
          ? 'CLI settings changed — reopening the session with the new credential.'
          : `Agent process stopped (${reason}). The next prompt reopens the session.`;
    this.#enqueue(live, [{ type: 'system', payload: { text } }], { status: finalStatus, reason });
    await live.postChain;
  }
}

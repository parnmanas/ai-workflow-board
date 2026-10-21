/**
 * CLI Memory(LLM CLI 의 메모리 파일) 공유 상수·타입 — docs/cli-memory.md.
 *
 * 메모리의 원본은 **Runtime Host 장비의 파일**이다: Claude Code 의 `CLAUDE.md` · rules · auto
 * memory(`~/.claude/projects/<key>/memory/`), Codex 의 `AGENTS.md` · `memories/`, Hermes 의
 * `§` 로 나뉜 `MEMORY.md` / `USER.md` 처럼 CLI 마다 위치와 형식이 다르다. 어디에 무엇이 있는지는
 * 매니저의 CLI 모듈(`memory` 슬라이스)이 선언하고, 서버는 아무것도 저장하지 않는 중계자다.
 * 분석·변환(이관/적용/import)은 화면이 스냅샷 위에서 한다.
 *
 * 서버 모듈(modules/cli-memory), SSE contract(stream-events.ts), agent-manager
 * (apps/agent-manager/src/lib/cli-memory-runner.ts)가 같은 문자열 집합을 본다.
 * 값 추가/변경은 서버·agent-manager 를 같은 PR 로.
 */

/** 서버 → 매니저 요청. 전부 RPC 다(`POST /api/agent/cli-memory/rpc/:id` 로 답한다). */
export const MEMORY_REQUEST_OPS = [
  'scan',          // 이 장비의 모든 메모리 CLI × 홈의 파일·생성 가능 위치·내용
  'read',          // 파일 하나 전문
  'write',         // 쓰기(이전 내용을 백업한 뒤 원자적 교체). base_hash 로 동시 편집을 막는다
  'delete',        // 지우기(백업한 뒤)
  'history',       // 그 파일의 백업 버전 목록
  'read_version',  // 백업 버전 하나의 내용
  'restore',       // 백업 버전으로 되돌리기(현재 내용도 백업한다)
  'link',          // 세션 홈의 빈 자리를 운영자 홈 파일로 심볼릭 링크(Windows 는 복사)
  'batch',         // write/delete/link 여러 개를 순서대로 — import · 여러 CLI 에 적용 · 일괄 수정
] as const;
export type MemoryRequestOp = (typeof MEMORY_REQUEST_OPS)[number];

/** 이 매니저 빌드가 메모리 RPC 를 안다 — 하트비트 `manager_capabilities` 에 실린다. */
export const MANAGER_CAPABILITY_CLI_MEMORY = 'cli_memory';

export const MEMORY_SCOPES = ['global', 'project'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * 파일의 역할.
 *   instructions — 사람이 쓰는 지침(CLAUDE.md / AGENTS.md / GEMINI.md)
 *   rules        — 주제별 규칙 파일(`.claude/rules/*.md`, `.agent/rules/*.md`)
 *   auto_index   — CLI 가 스스로 유지하는 메모리의 색인(Claude `MEMORY.md`)
 *   auto_topic   — 그 색인이 가리키는 주제 파일
 *   entries      — `§` 로 나뉜 항목 목록(Hermes MEMORY.md / USER.md)
 *   persona      — 정체성 프롬프트(Hermes SOUL.md)
 *   generated    — CLI 가 생성·재생성하는 요약(Codex memories)
 *   knowledge    — CLI 가 모은 지식 항목(Antigravity knowledge)
 */
export const MEMORY_KINDS = [
  'instructions',
  'rules',
  'auto_index',
  'auto_topic',
  'entries',
  'persona',
  'generated',
  'knowledge',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** markdown 그대로, 또는 `\n§\n` 로 나뉜 항목 목록(Hermes). */
export const MEMORY_FORMATS = ['markdown', 'section_entries'] as const;
export type MemoryFormat = (typeof MEMORY_FORMATS)[number];

/**
 * 세션 컨텍스트에 언제 들어가는가 — 분석이 "매 세션이 내는 비용" 을 셀 때 쓴다.
 *   always      — 세션 시작 때 전문이 들어간다
 *   index_head  — 앞부분만(`load_limit_lines` 줄) 들어간다(Claude auto memory 색인)
 *   conditional — 조건이 맞을 때만(`paths:` frontmatter 가 있는 Claude rules)
 *   on_demand   — 에이전트가 필요할 때 읽는다
 */
export const MEMORY_LOAD_MODES = ['always', 'index_head', 'conditional', 'on_demand'] as const;
export type MemoryLoadMode = (typeof MEMORY_LOAD_MODES)[number];

/** CLI 홈 하나. 운영자 홈 + AWB 세션 전용 홈(credential 별) + 런타임 프로필(Hermes). */
export interface MemoryHomeInfo {
  /** `operator` | `session:<credential_id>` | `profile:<name>` */
  id: string;
  kind: 'operator' | 'session' | 'profile';
  path: string;
  display_path: string;
  credential_id: string | null;
  /** 서버가 채운다(credential 이름). 지워진 credential 이면 null. */
  credential_name?: string | null;
  profile: string | null;
  exists: boolean;
}

export interface MemoryFileInfo {
  home_id: string;
  /** 절대 경로 — 쓰기 요청이 그대로 싣는다. 매니저가 선언된 위치인지 다시 확인한다. */
  path: string;
  /** `~` 로 줄인 경로(표시용). */
  display_path: string;
  scope: MemoryScope;
  kind: MemoryKind;
  format: MemoryFormat;
  label: string;
  /** 화면이 묶어 보이는 단위(`global` / `project:<dir>` / `auto:<key>` / `memories`). */
  group: string;
  project_dir: string | null;
  loaded: MemoryLoadMode;
  /** index_head 일 때 들어가는 줄 수(Claude MEMORY.md = 200). */
  load_limit_lines: number | null;
  /** 글자 수 상한(Hermes: config.yaml `memory_char_limit` / `user_char_limit`). */
  char_limit: number | null;
  editable: boolean;
  exists: boolean;
  size: number;
  mtime: string | null;
  /** 내용 sha256 앞 16자. 없는 파일이면 null. 쓰기의 `base_hash` 가 이 값이다. */
  hash: string | null;
  /** 없는 파일이거나 생략됐으면 null. */
  content: string | null;
  /** 스캔 상한(MEMORY_SCAN_FILE_MAX_BYTES)에서 잘렸다 — 화면은 read 로 전문을 다시 읽는다. */
  truncated: boolean;
  /** 응답 전체 상한 때문에 내용을 싣지 않았다 — read 로 읽는다. */
  omitted: boolean;
  /** 심볼릭 링크면 그 대상. */
  link_target: string | null;
  /** 같은 실제 파일이 다른 홈에서 이미 나왔으면 그 홈 id — 내용은 그쪽에만 싣는다. */
  shared_with: string | null;
  /** 내용이 가리키는 경로 중 이 장비에 없는 것(scan `check_paths`). */
  missing_paths?: string[];
}

/** 새 파일을 만들 수 있는 디렉터리(rules · auto memory 주제 파일). */
export interface MemoryDirInfo {
  home_id: string;
  path: string;
  display_path: string;
  scope: MemoryScope;
  kind: MemoryKind;
  label: string;
  group: string;
  project_dir: string | null;
  exists: boolean;
}

export interface CliMemorySnapshot {
  cli: string;
  label: string;
  /** 이 CLI 가 메모리를 어떻게 쓰는지 한두 문장(화면 머리말). */
  summary: string;
  /** 이 장비에 그 CLI 의 홈이 있는가. 없으면 화면은 접어 둔다. */
  detected: boolean;
  homes: MemoryHomeInfo[];
  files: MemoryFileInfo[];
  dirs: MemoryDirInfo[];
  /** CLI 설정에서 읽은 메모리 관련 값(`memory_enabled`, `memory_char_limit` …). 모르면 키가 없다. */
  settings: Record<string, string | number | boolean | null>;
}

export interface MemoryProjectDir {
  path: string;
  project_id: string;
  project_name: string;
}

export interface MemoryHostSnapshot {
  manager_id: string;
  manager_name: string;
  hostname: string;
  platform: string;
  generated_at: string;
  project_dirs: MemoryProjectDir[];
  clis: CliMemorySnapshot[];
  /** 응답 상한에 걸려 일부 내용이 생략됐다(`omitted`). */
  content_budget_exhausted: boolean;
}

export interface MemoryVersionInfo {
  version_id: string;
  created_at: string;
  size: number;
  hash: string;
  /** 어떤 동작 직전에 떠 둔 사본인가. */
  reason: string;
}

/** batch 안의 한 동작. `base_hash` 의 뜻은 write 와 같다. */
export interface MemoryBatchOp {
  op: 'write' | 'delete' | 'link';
  cli: string;
  path: string;
  content?: string;
  /** 문자열 = 지금 내용이 이 해시여야 한다 / null = 파일이 없어야 한다 / 생략 = 확인 안 함(force). */
  base_hash?: string | null;
  /** link — 운영자 홈의 원본 파일. */
  target?: string;
  /** 백업에 남기는 사유(`import` / `apply` / `fix` …). */
  reason?: string;
}

export interface MemoryBatchResultItem {
  ok: boolean;
  op: string;
  path: string;
  file?: MemoryFileInfo | null;
  error?: string;
  code?: string;
}

export interface MemoryHostInfo {
  manager_id: string;
  name: string;
  hostname: string;
  platform: string;
  plugin_version: string;
  last_seen_at: string;
  /** 이 매니저가 메모리 RPC 를 아는가. 모르면 화면이 업데이트를 안내한다. */
  supported: boolean;
  /** 이 장비에 폴더가 등록된 프로젝트 수(project 범위 메모리를 찾는 근거). */
  project_count: number;
}

/** 스캔 때 파일 하나에 싣는 내용 상한. 넘으면 앞부분만 싣고 `truncated`. */
export const MEMORY_SCAN_FILE_MAX_BYTES = 256 * 1024;
/** 스캔 응답 전체의 내용 상한. 넘으면 남은 파일은 `omitted`. */
export const MEMORY_SCAN_TOTAL_MAX_BYTES = 6 * 1024 * 1024;
/** read 한 번의 상한. */
export const MEMORY_READ_MAX_BYTES = 2 * 1024 * 1024;
/** 쓰기 한 번의 상한(글자 수가 아니라 UTF-8 바이트). */
export const MEMORY_WRITE_MAX_BYTES = 1024 * 1024;
/** CLI × 홈 하나에서 나열하는 파일 수 상한. */
export const MEMORY_FILES_MAX = 2000;
export const MEMORY_BATCH_MAX = 200;
/** 파일 하나당 남겨 두는 백업 버전 수. */
export const MEMORY_VERSIONS_KEEP = 30;
export const MEMORY_PATH_MAX = 4096;

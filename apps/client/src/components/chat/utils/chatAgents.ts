// New Chat / Add People 의 Agent 목록 규칙 (React 없음 — test/chat-invite-participants.test.mjs).
//
// 채팅의 Agent 참여자는 Agent 행이 아니라 RuntimeSpec 이고, 서버는 그 실행 신원
// `runtimeIdentityKey(spec)` = cli + working_dir + credential 로 참여자를 매긴 뒤 같은 키를
// **조용히 하나로 합친다**(room-crud.service createRoom 의 dedupe). 모델·label 은 신원이
// 아니다. 그래서 모델만 다른 두 Agent 를 같은 폴더에 넣으면 방에는 하나만 들어간다 —
// 피커가 그 조합을 미리 막아야 사용자가 "둘을 넣었는데 하나만 있다"를 겪지 않는다.

export interface ChatAgentSpec {
  manager_agent_id?: string | null;
  cli?: string | null;
  model?: string | null;
  working_dir?: string | null;
  credential_id?: string | null;
  label?: string | null;
}

/** 서버 runtimeIdentityKey 와 같은 입력(정규화 포함) — 해시 대신 튜플로 비교한다. */
export function chatAgentIdentity(spec: ChatAgentSpec): string {
  const norm = (v: string | null | undefined) => (v || '').trim();
  return `${norm(spec.cli).toLowerCase()}\0${norm(spec.working_dir)}\0${norm(spec.credential_id)}`;
}

/**
 * `spec` 과 실행 신원이 같은 Agent — 없으면 null. 편집 중인 항목 자신(`exceptKey`)은 뺀다.
 */
export function findSameRuntimeAgent<T extends { key: string; spec: ChatAgentSpec }>(
  agents: T[],
  spec: ChatAgentSpec,
  exceptKey?: string | null,
): T | null {
  const identity = chatAgentIdentity(spec);
  return agents.find((a) => a.key !== exceptKey && chatAgentIdentity(a.spec) === identity) ?? null;
}

/**
 * 만들어질 방의 모양 — 제출 버튼 라벨과 안내 문구가 같은 판정을 쓴다. 서버도 참여자
 * 수로 정한다(나 포함 2명 = dm, 3명 이상 = group). DM 의 Agent 는 모든 메시지에 답하고,
 * group 의 Agent 는 @멘션을 받았을 때만 답한다(room-messaging.service).
 */
export function newChatShape(counts: { agents: number; people: number }): 'empty' | 'dm' | 'group' {
  const total = counts.agents + counts.people;
  if (total === 0) return 'empty';
  return total === 1 ? 'dm' : 'group';
}

// ─── 기본 채팅 폴더 ───────────────────────────────────────────────────────
// 채팅 Agent 의 작업 폴더는 선택이다. 비우면 그 Runtime Host 매니저가 알린 채팅 전용 루트
// (`chat_workdir_root`, agent-manager chat-workdirs.ts) 아래 `<이름>` 을 쓴다 — 매니저가 첫 디스패치
// 때 만든다. 폴더는 여전히 CLI 의 cwd 이자 실행 신원의 일부라서, 같은 방에서 겹치면 `-2`, `-3` 을
// 붙여 다른 신원으로 만든다. 같은 이름이면 다른 방에서도 같은 폴더(같은 신원)를 다시 쓴다.

/** 폴더 이름으로 쓸 조각 — 영숫자·한글·`.`·`-`·`_` 만, 비면 `agent`. */
export function chatFolderSlug(name: string | null | undefined): string {
  const slug = (name || '').trim().toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'agent';
}

function hostSeparator(root: string): '/' | '\\' {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

/** root 아래 경로인가(기본 채팅 폴더를 카드에서 짧게 보이기 위해). */
export function isChatWorkdir(dir: string | null | undefined, root: string | null | undefined): boolean {
  if (!dir || !root) return false;
  const sep = hostSeparator(root);
  const base = root.endsWith(sep) ? root : root + sep;
  return dir.startsWith(base) && dir.length > base.length;
}

/**
 * 비워 둔 폴더의 기본값. `taken(dir)` 이 true 면(같은 방의 다른 Agent 와 신원이 겹치면) 번호를 붙인다.
 * root 가 없으면(꺼진 Host · 구버전 매니저) null — 그때는 폴더를 직접 적어야 한다.
 */
export function defaultChatWorkdir(
  root: string | null | undefined,
  name: string | null | undefined,
  taken: (dir: string) => boolean,
): { dir: string; n: number } | null {
  const trimmed = (root || '').trim();
  if (!trimmed) return null;
  const sep = hostSeparator(trimmed);
  const base = trimmed.endsWith(sep) ? trimmed.slice(0, -1) : trimmed;
  const slug = chatFolderSlug(name);
  for (let n = 1; n < 100; n += 1) {
    const dir = `${base}${sep}${n === 1 ? slug : `${slug}-${n}`}`;
    if (!taken(dir)) return { dir, n };
  }
  return null;
}

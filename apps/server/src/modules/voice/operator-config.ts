import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

/**
 * Operators — 사이트를 관리하는 에이전트들(docs/voice-operator.md "Operator").
 *
 * 하나하나의 실체는 **고정(pin)된 Agent Session** 이다: 운영자가 Runtime Host · CLI 를 골라 세션을 띄우고
 * (agent-manager 가 실행한다) 그 세션에 이름을 붙여 operator 로 등록한다. 여기에는 세션의 주소와 이름만
 * 둔다 — 세션 내용은 AWB 가 저장하지 않는다는 Agent Session 의 원칙 그대로다.
 *
 * 이름은 부르는 말(웨이크워드)이다: "헤이 자비스" 하고 부르면 그 operator 가 깨어난다. 음성 인식이 이름을
 * 다른 철자로 적을 수 있어서(`Jarvis` 를 `자비스` 로) 별칭을 함께 둔다. 이름과 별칭은 operator 끼리
 * 겹칠 수 없다 — 누구를 불렀는지 모호해지므로.
 *
 * 저장은 SystemSettings 한 행(`operator.sessions`, JSON 배열). Admin Settings 의 정의 목록에는 넣지
 * 않는다 — 운영자가 손으로 고칠 값이 아니라 세션 화면·Voice 화면이 쓰는 값이다. 한 개만 두던 시절의
 * `operator.session` 은 처음 읽을 때 목록으로 옮긴다.
 */

export const OPERATORS_SETTING_KEY = 'operator.sessions';
export const LEGACY_OPERATOR_SETTING_KEY = 'operator.session';
export const MAX_OPERATORS = 12;
export const MAX_OPERATOR_ALIASES = 8;
const MAX_NAME_CHARS = 32;

export interface OperatorEntry {
  id: string;
  /** 부르는 이름 — "헤이 <name>". */
  name: string;
  /** 음성 인식이 이름을 적을 수 있는 다른 철자들. */
  aliases: string[];
  manager_id: string;
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string;
  created_by: string;
  updated_at: string;
}

function str(v: unknown, max = 512): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * 이름 비교 키 — 대소문자·공백·문장부호를 무시한다("Jarvis" = "jarvis" = "JAR VIS").
 * 화면의 웨이크워드 매칭(`apps/client/src/voice/wake.logic.ts` `compactKey`)과 같은 규칙이다.
 */
export function operatorNameKey(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function parseName(v: unknown): string {
  return str(v, MAX_NAME_CHARS * 2).replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS);
}

/** 배열이든 쉼표 구분 문자열이든 받는다. 이름과 같은 것·빈 것·중복은 버린다. */
function parseAliases(v: unknown, name: string): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [];
  const seen = new Set<string>([operatorNameKey(name)]);
  const out: string[] = [];
  for (const item of raw) {
    const alias = parseName(item);
    const key = operatorNameKey(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_OPERATOR_ALIASES) break;
  }
  return out;
}

function sanitizeEntry(raw: any): OperatorEntry | null {
  const name = parseName(raw?.name);
  const entry: OperatorEntry = {
    id: str(raw?.id, 64),
    name,
    aliases: parseAliases(raw?.aliases, name),
    manager_id: str(raw?.manager_id, 128),
    cli: str(raw?.cli, 64),
    session_id: str(raw?.session_id, 256),
    cwd: str(raw?.cwd, 1024),
    title: str(raw?.title, 256),
    created_at: str(raw?.created_at, 64),
    created_by: str(raw?.created_by, 128),
    updated_at: str(raw?.updated_at, 64) || str(raw?.created_at, 64),
  };
  return entry.id && entry.name && entry.manager_id && entry.cli && entry.session_id ? entry : null;
}

export class OperatorInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorInputError';
  }
}

/** 다른 operator 의 이름·별칭과 겹치면 던진다. */
function assertNamesFree(candidate: Pick<OperatorEntry, 'id' | 'name' | 'aliases'>, list: OperatorEntry[]): void {
  const taken = new Map<string, string>();
  for (const op of list) {
    if (op.id === candidate.id) continue;
    for (const n of [op.name, ...op.aliases]) taken.set(operatorNameKey(n), op.name);
  }
  for (const n of [candidate.name, ...candidate.aliases]) {
    const owner = taken.get(operatorNameKey(n));
    if (owner) {
      throw new OperatorInputError(409, 'operator_name_taken', `"${n}" is already used by the operator "${owner}" — each name and alias must call exactly one operator.`);
    }
  }
}

/** 등록 요청 → 새 항목. 같은 세션이 이미 operator 거나 이름이 겹치면 던진다. */
export function createOperatorEntry(body: any, createdBy: string, list: OperatorEntry[], now: Date = new Date()): OperatorEntry {
  const name = parseName(body?.name);
  if (!operatorNameKey(name)) throw new OperatorInputError(400, 'operator_name_required', 'Give the operator a name — it is what you call to wake it.');
  const manager_id = str(body?.manager_id, 128);
  const cli = str(body?.cli, 64);
  const session_id = str(body?.session_id, 256);
  if (!manager_id || !cli || !session_id) {
    throw new OperatorInputError(400, 'operator_session_required', 'manager_id, cli and session_id are required.');
  }
  const same = list.find((op) => op.manager_id === manager_id && op.cli === cli && op.session_id === session_id);
  if (same) throw new OperatorInputError(409, 'operator_session_taken', `This session is already the operator "${same.name}".`);
  if (list.length >= MAX_OPERATORS) throw new OperatorInputError(409, 'operator_limit', `At most ${MAX_OPERATORS} operators.`);
  const at = now.toISOString();
  const entry: OperatorEntry = {
    id: randomUUID(),
    name,
    aliases: parseAliases(body?.aliases, name),
    manager_id,
    cli,
    session_id,
    cwd: str(body?.cwd, 1024),
    title: str(body?.title, 256),
    created_at: at,
    created_by: createdBy,
    updated_at: at,
  };
  assertNamesFree(entry, list);
  return entry;
}

/** 이름·별칭·제목만 바꾼다. 세션 주소는 바꾸지 않는다 — 다른 세션이면 새로 등록한다. */
export function patchOperatorEntry(current: OperatorEntry, body: any, list: OperatorEntry[], now: Date = new Date()): OperatorEntry {
  const name = body?.name !== undefined ? parseName(body.name) : current.name;
  if (!operatorNameKey(name)) throw new OperatorInputError(400, 'operator_name_required', 'Give the operator a name — it is what you call to wake it.');
  const next: OperatorEntry = {
    ...current,
    name,
    aliases: parseAliases(body?.aliases !== undefined ? body.aliases : current.aliases, name),
    title: body?.title !== undefined ? str(body.title, 256) : current.title,
    updated_at: now.toISOString(),
  };
  assertNamesFree(next, list);
  return next;
}

// ─── 저장 ─────────────────────────────────────────────────────────────────

async function readSetting(dataSource: DataSource, key: string): Promise<any> {
  return dataSource.getRepository('SystemSetting').findOne({ where: { key } });
}

/** 한 개만 두던 시절의 값 → 목록의 한 항목. id 는 세션 주소에서 정해진다(두 번 옮겨도 같다). */
function fromLegacy(raw: string): OperatorEntry | null {
  try {
    const old = JSON.parse(raw);
    if (!old?.manager_id || !old?.cli || !old?.session_id) return null;
    const id = `op-${createHash('sha256').update(`${old.manager_id}/${old.cli}/${old.session_id}`).digest('hex').slice(0, 24)}`;
    return sanitizeEntry({
      ...old,
      id,
      name: 'Operator',
      aliases: ['오퍼레이터'],
      created_at: old.pinned_at,
      created_by: old.pinned_by,
    });
  } catch {
    return null;
  }
}

export async function readOperators(dataSource: DataSource): Promise<OperatorEntry[]> {
  const row: any = await readSetting(dataSource, OPERATORS_SETTING_KEY);
  if (row) {
    try {
      const parsed = JSON.parse(row.value || '[]');
      return Array.isArray(parsed) ? parsed.map(sanitizeEntry).filter((e): e is OperatorEntry => !!e) : [];
    } catch {
      return [];
    }
  }
  const legacy: any = await readSetting(dataSource, LEGACY_OPERATOR_SETTING_KEY);
  const migrated = legacy?.value ? fromLegacy(legacy.value) : null;
  if (!legacy) return [];
  await writeOperators(dataSource, migrated ? [migrated] : []);
  return migrated ? [migrated] : [];
}

export async function writeOperators(dataSource: DataSource, list: OperatorEntry[]): Promise<void> {
  invalidateOperatorCache();
  const repo = dataSource.getRepository('SystemSetting');
  const value = JSON.stringify(list);
  const existing: any = await readSetting(dataSource, OPERATORS_SETTING_KEY);
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key: OPERATORS_SETTING_KEY, value }));
  }
  // 옛 단일 값은 옮겨진 뒤 남기지 않는다 — 두 곳에 있으면 어느 쪽이 맞는지 다시 물어야 한다.
  const legacy: any = await readSetting(dataSource, LEGACY_OPERATOR_SETTING_KEY);
  if (legacy) await repo.remove(legacy);
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 읽고-고치고-쓰기를 한 줄로 세운다 — 두 등록이 겹쳐 한쪽이 다른 쪽을 덮어쓰지 않게(한 프로세스 안).
 * `fn` 이 던지면 아무것도 쓰지 않는다.
 */
export function updateOperators<T>(dataSource: DataSource, fn: (list: OperatorEntry[]) => { next: OperatorEntry[]; result: T }): Promise<T> {
  const run = writeChain.then(async () => {
    const { next, result } = fn(await readOperators(dataSource));
    await writeOperators(dataSource, next);
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

const OPERATOR_CACHE_MS = 5_000;
let operatorCache: { at: number; value: OperatorEntry[] } | null = null;

export function invalidateOperatorCache(): void {
  operatorCache = null;
}

/** MCP 요청마다·전사마다 읽으므로 잠깐 캐시한다. 쓰기는 캐시를 곧바로 버린다. */
export async function cachedOperators(dataSource: DataSource): Promise<OperatorEntry[]> {
  const now = Date.now();
  if (operatorCache && now - operatorCache.at < OPERATOR_CACHE_MS) return operatorCache.value;
  const value = await readOperators(dataSource);
  operatorCache = { at: now, value };
  return value;
}

/** 음성 인식 용어집에 더할 이름들 — 부르는 이름을 엔진이 알아듣게. */
export async function operatorVocabulary(dataSource: DataSource): Promise<string[]> {
  return (await cachedOperators(dataSource)).flatMap((op) => [op.name, ...op.aliases]);
}

// ─── 사이트 전체 권한 ─────────────────────────────────────────────────────

/**
 * operator 세션의 AWB MCP 연결은 **워크스페이스에 묶지 않는다** — 사이트 전체를 관리하는 에이전트다
 * (docs/voice-operator.md "권한").
 *
 * 세션의 MCP 는 그 장비 매니저의 키로 주입되고(agent-session-runner `#defaultMcpServers`), 그 키는
 * 페어링 때 한 워크스페이스에 묶인다. operator 로 등록된 세션의 연결만 그 묶음을 푼다 — 조건은 셋이 다:
 *   1. 매니저가 Agent Session 에 주입한 연결이다(`X-AWB-Client-Type: agent-session`),
 *   2. `X-AWB-Session-Id` 가 등록된 operator 세션 중 하나다,
 *   3. 키가 그 operator 의 Host 의 full 키다.
 * 풀린 연결은 Host 신원(장비 단위, 워크스페이스 없음)으로 판정된다(`authz.ts` `callerCanAccessWorkspace`).
 *
 * 신뢰 경계는 그 장비의 사용자다: 같은 장비의 다른 프로세스도 매니저 키를 읽고 같은 헤더를 만들 수 있다.
 * operator 등록이 admin 전용인 이유이고, 풀릴 때마다 로그를 남긴다.
 */
export interface OperatorConnectionAuth {
  source: string;
  agentId?: string;
  scope?: string;
  workspaceId?: string;
}

export async function isOperatorConnection(
  dataSource: DataSource,
  auth: OperatorConnectionAuth,
  headers: Record<string, string | string[] | undefined>,
): Promise<boolean> {
  if (auth.source !== 'db' || !auth.agentId || auth.scope !== 'full') return false;
  const header = (name: string) => {
    const v = headers[name];
    return String(Array.isArray(v) ? v[0] : v ?? '').trim();
  };
  if (header('x-awb-client-type').toLowerCase() !== 'agent-session') return false;
  const sessionId = header('x-awb-session-id');
  if (!sessionId) return false;
  const operators = await cachedOperators(dataSource);
  return operators.some((op) => op.session_id === sessionId && op.manager_id === auth.agentId);
}

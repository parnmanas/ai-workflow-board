import { stripDirectWorkPolicy } from './ticket-creation-policy.js';
// Agent Session 기록 스캐너들이 공유하는 순수 헬퍼 — CLI 이름을 모른다.
//
// `agent-session-store.ts` 가 CLI 별 스캐너(`clis/<id>/sessions.ts`)를 레지스트리로
// 찾아 호출하고, 스캐너는 여기 헬퍼로 파일/DB 를 읽는다. 스캐너가 store 를 import
// 하면 순환이 되므로(store → clis/index → 스캐너 → store) 공용 코드는 이 leaf 에 둔다.

import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 64 * 1024;
export const TITLE_MAX = 120;
export const TOOL_TEXT_MAX = 16_000;
/**
 * 기록 이벤트 하나가 직렬화됐을 때의 상한. codex 의 tool 출력은 문자열이 아니라 content block
 * 배열로 오는데, 그 경로가 잘리지 않아 이벤트 하나가 1.3MiB 를 넘기도 했다. 응답 전체는 서버의
 * JSON 본문 상한(10MB)을 넘으면 413 으로 버려지고 화면은 타임아웃 에러만 본다.
 */
export const HISTORY_EVENT_PAYLOAD_MAX_CHARS = 32_000;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface HistoryEvent {
  id: string;
  seq: number;
  turn_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export function cleanTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** 프롬프트 텍스트로 쓸 수 없는 CLI 내부 마크업(명령 XML, 환경 컨텍스트, 지침 주입). */
export function isSyntheticPrompt(text: string): boolean {
  const t = stripDirectWorkPolicy(text).trimStart();
  return !t || t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('[Request interrupted');
}

export function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.thinking === 'string') return block.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** JSON 문자열 컬럼(드라이버에 따라 이미 객체로 올 수도 있어 둘 다 받는다). 못 읽으면 null. */
export function parseJsonObject(value: unknown): Record<string, any> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** epoch ms 정수 컬럼. 숫자로 못 읽히면 null. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export async function readChunk(path: string, position: number, length: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export function parseLines(chunk: string, dropFirst = false, dropLast = false): Record<string, any>[] {
  const lines = chunk.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out: Record<string, any>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      /* partial / non-JSON line */
    }
  }
  return out;
}

export async function walkJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, depth - 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

export async function* readJsonlRecords(path: string): AsyncGenerator<Record<string, any>> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) yield parsed;
    } catch {
      /* skip */
    }
  }
}

/** 실행 설정을 찾을 때 한 번에 읽는 조각 — 한 줄짜리 큰 tool 출력 몇 개가 64KiB 꼬리를 다 채우기도 한다. */
export const SETTINGS_CHUNK_BYTES = 1024 * 1024;
/** 끝에서부터 이만큼까지만 읽는다 — 그 앞에만 있는 칸은 "기록에 없음" 으로 둔다. */
export const SETTINGS_SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 레코드마다 `pick` 이 돌려준 칸을 모아 **칸마다 가장 나중 값**을 만든다. 파일 끝에서부터 조각씩 거꾸로 읽고,
 * `required` 칸을 다 채우면 멈춘다. claude 의 권한 모드처럼 사람이 쓴 프롬프트에만 실리는 칸은 긴 tool 출력 뒤로
 * 한참 앞에 있을 수 있어서 꼬리 하나로는 모자란다. 조각은 줄바꿈(0x0A) 에서만 자르므로 UTF-8 문자가 갈리지 않는다.
 */
export async function latestRecordFields<T extends object>(
  path: string,
  size: number,
  required: ReadonlyArray<keyof T>,
  pick: (rec: Record<string, any>) => Partial<T> | null,
): Promise<Partial<T>> {
  const out: Partial<T> = {};
  const fh = await open(path, 'r');
  try {
    let end = size;
    // 앞 조각과 이어 붙일, 이미 읽은 조각의 첫 (잘린) 줄.
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < SETTINGS_SCAN_MAX_BYTES) {
      const len = Math.min(end, SETTINGS_CHUNK_BYTES);
      const start = end - len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      let block = Buffer.concat([buf.subarray(0, bytesRead), carry]);
      if (start > 0) {
        const firstNewline = block.indexOf(0x0a);
        carry = firstNewline === -1 ? block : block.subarray(0, firstNewline);
        block = firstNewline === -1 ? Buffer.alloc(0) : block.subarray(firstNewline + 1);
      } else {
        carry = Buffer.alloc(0);
      }
      const records = parseLines(block.toString('utf8'));
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const fields = pick(records[i]);
        if (!fields) continue;
        for (const [key, value] of Object.entries(fields) as Array<[keyof T, T[keyof T]]>) {
          if (value !== undefined && out[key] === undefined) out[key] = value;
        }
      }
      if (required.every((key) => out[key] !== undefined)) break;
      end = start;
    }
  } finally {
    await fh.close();
  }
  return out;
}

/** 기록의 문자열 칸 — 비었거나 문자열이 아니면 없음. */
export function recordString(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/**
 * 이벤트 payload 를 크기 안으로 접는다. 문자열은 자르고, 배열·객체는 개수를 제한한다.
 * (러너의 boundedValue 와 같은 규칙 — 그쪽은 라이브 스트림, 이쪽은 CLI 홈 기록이다.)
 */
export function boundHistoryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundValue(payload, 0) as Record<string, unknown>;
  if (JSON.stringify(bounded).length <= HISTORY_EVENT_PAYLOAD_MAX_CHARS) return bounded;
  // 구조를 아무리 접어도 큰 경우(거대한 배열 등) — 내용을 미리보기로 대체한다.
  const preview = JSON.stringify(bounded).slice(0, 4_000);
  return { truncated: true, preview };
}

function boundValue(value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return truncate(value, TOOL_TEXT_MAX);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[key] = boundValue(entry, depth + 1);
  }
  return out;
}

/**
 * 마지막 `limit` 건만 들고 있는 링 버퍼. 기록 파일은 수백 MB 까지 자라는데(실측: codex rollout 353MB)
 * 어차피 화면은 최근 것만 쓴다 — 전부 배열에 쌓은 뒤 잘라내면 파일 크기에 비례해 메모리를 먹는다
 * (353MB 파일에서 최대 RSS 586MB). 파싱하면서 창(window) 밖으로 나간 건 즉시 버린다.
 * `total` 은 버린 것까지 포함한 전체 개수 — seq 를 절대 위치로 유지하고 생략 건수를 세는 데 쓴다.
 */
export class BoundedHistory<T> {
  #items: T[] = [];
  #start = 0;
  #total = 0;
  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.#total += 1;
    if (this.limit <= 0) return;
    this.#items.push(item);
    if (this.#items.length > this.limit) {
      // 앞을 자주 shift 하면 O(n²) 가 되므로 창의 두 배까지 모았다가 한 번에 접는다.
      this.#start += 1;
      if (this.#start >= this.limit) {
        this.#items = this.#items.slice(this.#start);
        this.#start = 0;
      }
    }
  }

  /** 남아 있는(최근) 항목. */
  items(): T[] {
    return this.#start > 0 ? this.#items.slice(this.#start) : this.#items;
  }

  /** 버려진 것까지 포함한 전체 개수. */
  get total(): number {
    return this.#total;
  }

  /** 남아 있는 첫 항목의 절대 인덱스(0-based). */
  get offset(): number {
    return this.#total - (this.#items.length - this.#start);
  }
}

/**
 * 직렬화 바이트가 상한에 들어오도록 **오래된 것부터** 버린다 — 화면은 끝(최근)부터 읽으므로
 * 최근 대화를 지키는 편이 쓸모 있다. 한 건도 못 담을 만큼 큰 이벤트만 남는 경우에도 최소 한 건은 남긴다.
 */
export function fitHistoryBytes<T extends { payload: Record<string, unknown> }>(events: T[], maxBytes: number): T[] {
  let total = 0;
  let firstKept = events.length;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(JSON.stringify(events[i])) + 1;
    if (total + size > maxBytes && firstKept < events.length) break;
    total += size;
    firstKept = i;
    if (total > maxBytes) break;
  }
  return events.slice(firstKept);
}

/** jsonl 파일 목록을 mtime 내림차순으로 stat 한다(빈 파일 제외). */
export async function statJsonlFiles(
  paths: string[],
  statFn: (p: string) => Promise<{ size: number; mtimeMs: number }>,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const path of paths) {
    try {
      const st = await statFn(path);
      if (st.size > 0) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

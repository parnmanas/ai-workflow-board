// CLI 메모리 슬라이스(docs/cli-memory.md)가 같이 쓰는 파일 탐색 조각.
//
// 슬라이스는 "어디에 무엇이 있는가" 만 선언하고, 읽기·쓰기·백업은 `cli-memory-runner.ts` 가
// 한다. 그래서 여기 함수들은 전부 **던지지 않는다** — 못 읽는 디렉터리는 빈 목록이다.

import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { CliMemoryHome } from './cli-module.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 디렉터리 바로 아래 하위 디렉터리 이름(정렬). */
export async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * `.md` 파일 절대 경로(정렬). `depth` 만큼 하위 디렉터리로 내려간다(0 = 그 디렉터리만).
 * 숨김 파일과 `.awb-*` 같은 우리 흔적은 건너뛴다.
 */
export async function listMarkdown(dir: string, depth = 0, limit = 2000): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, left: number): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full);
      else if (entry.isDirectory() && left > 0) await walk(full, left - 1);
    }
  }
  await walk(dir, depth);
  return out;
}

/** 파일 앞부분(UTF-8). 없거나 못 읽으면 ''. */
export async function readHead(path: string, bytes = 4096): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** markdown frontmatter(`---` … `---`) 안에 이 키가 있는가. */
export async function frontmatterHasKey(path: string, key: string): Promise<boolean> {
  const head = await readHead(path, 4096);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return false;
  return new RegExp(`^${key}\\s*:`, 'm').test(m[1]);
}

/** 파일 이름에서 `.md` 를 뗀 것 — 라벨용. */
export function stem(path: string): string {
  return basename(path).replace(/\.md$/i, '');
}

/**
 * AWB 세션 전용 cli-home(`<session-homes>/<cli>/<credential_id>`, agent-session-runner.ts
 * `#prepareAuth`)을 홈 목록으로. credential id 가 아닌 디렉터리는 세션 홈이 아니다.
 */
export async function sessionHomesUnder(sessionHomesDir: string, cli: string): Promise<CliMemoryHome[]> {
  const root = join(sessionHomesDir, cli);
  const names = await listSubdirs(root);
  return names
    .filter((name) => UUID_RE.test(name))
    .map((name) => ({ id: `session:${name}`, kind: 'session' as const, path: join(root, name), credentialId: name, profile: null }));
}

/** 정수 설정값 하나(`key: 123` / `key = 123`). 없으면 undefined. */
export function matchInt(text: string, key: string): number | undefined {
  const m = new RegExp(`^\\s*${key}\\s*[:=]\\s*(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : undefined;
}

/** 불리언 설정값 하나(`key: true` / `key = false`). 없으면 undefined. */
export function matchBool(text: string, key: string): boolean | undefined {
  const m = new RegExp(`^\\s*${key}\\s*[:=]\\s*(true|false)\\b`, 'mi').exec(text);
  return m ? m[1].toLowerCase() === 'true' : undefined;
}

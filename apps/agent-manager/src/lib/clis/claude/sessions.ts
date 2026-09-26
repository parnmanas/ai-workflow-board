// Claude Code 세션 기록 스캐너 — `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`.

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  BoundedHistory,
  boundHistoryPayload,
  cleanTitle,
  HEAD_BYTES,
  type HistoryEvent,
  isRecord,
  isSyntheticPrompt,
  parseLines,
  readChunk,
  readJsonlRecords,
  SESSION_ID_RE,
  statJsonlFiles,
  TAIL_BYTES,
  textOfBlocks,
  TOOL_TEXT_MAX,
  truncate,
} from '../../agent-session-history.js';
import { normalizeSessionUsage, addSessionUsage, usageEventPayload, type SessionUsage } from '../../session-usage.js';
import type { CliSessionStoreContext, CliSessionStoreDriver, CliSessionSummary } from '../cli-module.js';

/**
 * claude 기록의 `message.usage` → 공용 계약.
 *
 * `input_tokens` 는 캐시를 **제외한** 신규 입력이다(전형적으로 1~5). 그래서 이 값만
 * 화면에 내면 "2 토큰 썼다"가 되어 실제 컨텍스트(수만 토큰)를 완전히 감춘다 —
 * 운영자가 보고한 "claude 는 제대로 안 나온다"가 정확히 이것이다. 캐시 읽기/쓰기를
 * 함께 실어야 합이 맞는다.
 */
export function claudeUsageFromMessage(message: Record<string, any> | null): SessionUsage | null {
  const usage = message && isRecord(message.usage) ? message.usage : null;
  if (!usage) return null;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return normalizeSessionUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    reasoningTokens: details.thinking_tokens,
  });
}

/** Claude 툴 이름 → ACP 툴 kind 근사치. */
export function claudeToolKind(name: string): string {
  switch (name) {
    case 'Read': case 'Glob': case 'NotebookRead': case 'LS': return 'read';
    case 'Grep': case 'WebSearch': return 'search';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'edit';
    case 'Bash': case 'BashOutput': case 'KillShell': return 'execute';
    case 'WebFetch': return 'fetch';
    case 'Task': case 'Agent': return 'delegate';
    case 'TodoWrite': case 'ExitPlanMode': case 'EnterPlanMode': return 'think';
    default: return name.startsWith('mcp__') ? 'other' : 'other';
  }
}

async function claudeMeta(path: string, size: number): Promise<{ sessionId: string; cwd: string; title: string; createdAt: string | null } | null> {
  const headLen = Math.min(size, HEAD_BYTES);
  const head = parseLines(await readChunk(path, 0, headLen), false, size > headLen);
  let sessionId = '';
  let cwd = '';
  let createdAt: string | null = null;
  let firstPrompt = '';
  let customTitle = '';
  const absorb = (rec: Record<string, any>) => {
    if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (!createdAt && typeof rec.timestamp === 'string') createdAt = rec.timestamp;
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle;
    if (rec.type === 'summary' && typeof rec.summary === 'string' && !customTitle) customTitle = rec.summary;
    if (!firstPrompt && rec.type === 'user' && !rec.isSidechain && isRecord(rec.message)) {
      const text = textOfBlocks(rec.message.content);
      if (text && !isSyntheticPrompt(text)) firstPrompt = text;
    }
  };
  for (const rec of head) absorb(rec);
  if (size > headLen) {
    const tailLen = Math.min(size - headLen, TAIL_BYTES);
    const tail = parseLines(await readChunk(path, size - tailLen, tailLen), true, false);
    for (const rec of tail) absorb(rec);
  }
  if (!sessionId) sessionId = basename(path, '.jsonl');
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (!firstPrompt && !customTitle) return null; // 빈 세션(프롬프트 없음)
  return { sessionId, cwd, title: cleanTitle(customTitle || firstPrompt), createdAt };
}

async function findSessionFile(ctx: CliSessionStoreContext, sessionId: string): Promise<string | null> {
  const projectsDir = join(ctx.home, 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

export const claudeSessionStore: CliSessionStoreDriver = {
  findSessionFile,

  /**
   * 파일 **꼬리만** 읽어 마지막 assistant 레코드의 usage 를 돌려준다. 라이브 턴이
   * 끝났는데 ACP 어댑터(`claude-agent-acp`)가 usage 를 보고하지 않았을 때 쓰는
   * 메꿈용이다 — 어댑터가 무엇을 주든 claude 자신의 기록은 항상 usage 를 남긴다.
   */
  async readLatestUsage(ctx, sessionId) {
    const path = await findSessionFile(ctx, sessionId);
    if (!path) return null;
    try {
      const st = await stat(path);
      const len = Math.min(st.size, TAIL_BYTES);
      const records = parseLines(await readChunk(path, st.size - len, len), st.size > len, false);
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const rec = records[i];
        if (rec?.type !== 'assistant' || rec.isSidechain) continue;
        const usage = claudeUsageFromMessage(isRecord(rec.message) ? rec.message : null);
        if (usage) return usage;
      }
      return null;
    } catch {
      return null;
    }
  },

  async listSessions(ctx) {
    const projectsDir = join(ctx.home, 'projects');
    let dirs: string[];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      return [];
    }
    const paths: string[] = [];
    for (const dir of dirs) {
      const full = join(projectsDir, dir);
      let entries;
      try {
        entries = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        // agent-*.jsonl 은 서브에이전트(sidechain) 전용 파일이라 세션이 아니다.
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue;
        paths.push(join(full, entry.name));
      }
    }
    const files = await statJsonlFiles(paths, stat);
    const out: CliSessionSummary[] = [];
    for (const file of files) {
      if (out.length >= ctx.listLimit) break;
      const meta = await claudeMeta(file.path, file.size);
      if (!meta) continue;
      out.push({
        cli: 'claude',
        session_id: meta.sessionId,
        cwd: meta.cwd,
        title: meta.title,
        created_at: meta.createdAt,
        updated_at: new Date(file.mtimeMs).toISOString(),
        source: 'cli',
        size_bytes: file.size,
      });
    }
    return out;
  },

  async readHistory(ctx, sessionId) {
    const path = await findSessionFile(ctx, sessionId);
    if (!path) return null;
    const st = await stat(path);
    const events = new BoundedHistory<HistoryEvent>(ctx.historyLimit);
    let title = '';
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    // payload 크기는 **담는 시점에** 정리한다 — 나중에 한 번에 하면 창 안에 원본 blob 이 그대로 남아
    // 파일이 클수록 메모리를 먹는다(353MB 세션에서 최대 RSS 584MB). 파서가 갈래마다 따로 자르다
    // 하나를 빠뜨렸던 전례가 있어(codex 배열형 tool 출력) 갈래가 아니라 이 한 줄에서만 자른다.
    const push = (type: string, payload: Record<string, unknown>, createdAtRec: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload: boundHistoryPayload(payload), created_at: createdAtRec || createdAt || new Date().toISOString() });
    };
    // claude 는 한 턴에 여러 API 호출을 한다(툴 왕복마다 하나). 호출마다 usage 를
    // 뿌리면 전사가 숫자로 뒤덮이므로 턴 단위로 합쳐 턴이 끝날 때 한 번 낸다.
    let turnUsage: SessionUsage | null = null;
    let turnUsageAt: string | undefined;
    const flushUsage = () => {
      if (!turnUsage) return;
      push('usage', usageEventPayload(turnUsage), turnUsageAt);
      turnUsage = null;
      turnUsageAt = undefined;
    };
    for await (const rec of readJsonlRecords(path)) {
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (!createdAt && typeof rec.timestamp === 'string') createdAt = rec.timestamp;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') { title = rec.customTitle; continue; }
      if (rec.type === 'summary' && typeof rec.summary === 'string' && !title) { title = rec.summary; continue; }
      if (rec.isSidechain) continue;
      const message = isRecord(rec.message) ? rec.message : null;
      if (!message) continue;
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      if (rec.type === 'user') {
        const content = message.content;
        if (typeof content === 'string') {
          if (isSyntheticPrompt(content)) continue;
          flushUsage(); // 이전 턴의 합계를 새 프롬프트 앞에 남긴다
          turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
          if (!firstPrompt) firstPrompt = content;
          push('user_prompt', { text: content }, ts);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            if (isSyntheticPrompt(block.text)) continue;
            flushUsage();
            turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
            if (!firstPrompt) firstPrompt = block.text;
            push('user_prompt', { text: block.text }, ts);
          } else if (block.type === 'tool_result') {
            push('tool_update', {
              tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              status: block.is_error ? 'failed' : 'completed',
              output: truncate(textOfBlocks(block.content), TOOL_TEXT_MAX),
            }, ts);
          }
        }
        continue;
      }
      if (rec.type === 'assistant') {
        const usage = claudeUsageFromMessage(message);
        if (usage) {
          turnUsage = addSessionUsage(turnUsage, usage);
          turnUsageAt = ts || turnUsageAt;
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            push('text', { text: block.text }, ts);
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            push('reasoning', { text: truncate(block.thinking, TOOL_TEXT_MAX) }, ts);
          } else if (block.type === 'tool_use') {
            const name = typeof block.name === 'string' ? block.name : 'tool';
            push('tool_call', {
              tool_call_id: typeof block.id === 'string' ? block.id : '',
              title: name,
              kind: claudeToolKind(name),
              input: block.input,
            }, ts);
          }
        }
      }
    }
    flushUsage();
    return {
      events: events.items(),
      total: events.total,
      offset: events.offset,
      title: cleanTitle(title || firstPrompt),
      cwd,
      createdAt,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      sizeBytes: st.size,
    };
  },
};

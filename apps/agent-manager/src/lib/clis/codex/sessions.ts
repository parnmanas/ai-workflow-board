// Codex 세션 기록 스캐너 — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.

import { stat } from 'node:fs/promises';
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
  walkJsonl,
} from '../../agent-session-history.js';
import { normalizeSessionUsage, usageEventPayload, type SessionUsage } from '../../session-usage.js';
import type { CliSessionStoreContext, CliSessionStoreDriver, CliSessionSummary } from '../cli-module.js';

/**
 * codex `token_count` / `token_usage_record` payload → 공용 계약.
 *
 * codex 의 `input_tokens` 는 캐시 히트를 **포함한** 값이고 `cached_input_tokens` 가
 * 그 내역이다(실측: input 15358 / cached 12160 / output 207 / total 15565 =
 * 15358 + 207). 공용 계약의 `input_tokens` 는 캐시 제외이므로 여기서 빼서 넘긴다 —
 * 빼지 않으면 캐시가 두 번 세어져 claude 와 같은 뜻이 되지 않는다.
 *
 * `last_token_usage` 가 그 턴의 값, `total_token_usage` 는 세션 누적이다. 전사는
 * 턴 단위로 보여 주므로 last 를 쓰고, 누적은 컨텍스트 점유로 따로 싣는다.
 */
export function codexUsageFromInfo(info: Record<string, any> | null): SessionUsage | null {
  if (!info) return null;
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : null;
  const total = isRecord(info.total_token_usage) ? info.total_token_usage : null;
  const turn = last ?? total;
  if (!turn) return null;
  const cached = typeof turn.cached_input_tokens === 'number' ? turn.cached_input_tokens : 0;
  const input = typeof turn.input_tokens === 'number' ? turn.input_tokens : 0;
  return normalizeSessionUsage({
    inputTokens: Math.max(0, input - cached),
    outputTokens: turn.output_tokens,
    cachedReadTokens: cached,
    cacheWriteTokens: turn.cache_write_input_tokens,
    reasoningTokens: turn.reasoning_output_tokens,
    totalTokens: turn.total_tokens,
    // 세션 누적 total 이 곧 현재 컨텍스트 점유에 가장 가까운 값이다.
    contextTokens: total?.total_tokens,
    contextWindow: info.model_context_window,
  });
}

/** 한 레코드에서 usage 를 뽑는다(event_msg `token_count` / `token_usage_record` 둘 다). */
function codexUsageFromRecord(rec: Record<string, any>): SessionUsage | null {
  const payload = isRecord(rec.payload) ? rec.payload : null;
  if (!payload) return null;
  if (rec.type === 'event_msg' && payload.type === 'token_count') {
    return codexUsageFromInfo(isRecord(payload.info) ? payload.info : null);
  }
  if (rec.type === 'token_usage_record') {
    return codexUsageFromInfo({
      last_token_usage: payload.turn_token_usage ?? payload.usage,
      total_token_usage: payload.total_token_usage ?? payload.thread_token_usage,
    });
  }
  return null;
}

export function codexToolKind(name: string): string {
  if (/shell|exec|command|bash/i.test(name)) return 'execute';
  if (/read|view|cat|list|ls/i.test(name)) return 'read';
  if (/search|grep|find/i.test(name)) return 'search';
  if (/edit|write|patch|apply/i.test(name)) return 'edit';
  if (/fetch|web|http/i.test(name)) return 'fetch';
  return 'other';
}

async function codexMeta(path: string, size: number): Promise<{ sessionId: string; cwd: string; title: string; createdAt: string | null } | null> {
  const headLen = Math.min(size, HEAD_BYTES);
  const head = parseLines(await readChunk(path, 0, headLen), false, size > headLen);
  let sessionId = '';
  let cwd = '';
  let createdAt: string | null = null;
  let firstPrompt = '';
  for (const rec of head) {
    const payload = isRecord(rec.payload) ? rec.payload : {};
    if (rec.type === 'session_meta') {
      sessionId = typeof payload.id === 'string' ? payload.id : sessionId;
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
      createdAt = typeof payload.timestamp === 'string' ? payload.timestamp : createdAt;
    } else if (!firstPrompt && rec.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = textOfBlocks(payload.content);
      if (text && !isSyntheticPrompt(text)) firstPrompt = text;
    } else if (!firstPrompt && rec.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      if (!isSyntheticPrompt(payload.message)) firstPrompt = payload.message;
    }
  }
  if (!sessionId) {
    const match = basename(path, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (match) sessionId = match[1];
  }
  if (!SESSION_ID_RE.test(sessionId) || !cwd) return null;
  if (!firstPrompt) return null;
  return { sessionId, cwd, title: cleanTitle(firstPrompt), createdAt };
}

async function findSessionFile(ctx: CliSessionStoreContext, sessionId: string): Promise<string | null> {
  const paths: string[] = [];
  await walkJsonl(join(ctx.home, 'sessions'), 4, paths);
  return paths.find((p) => basename(p, '.jsonl').endsWith(`-${sessionId}`)) ?? null;
}

export const codexSessionStore: CliSessionStoreDriver = {
  findSessionFile,

  /** 파일 꼬리에서 마지막 token_count 를 읽는다(ACP 어댑터가 usage 를 안 줄 때의 메꿈). */
  async readLatestUsage(ctx, sessionId) {
    const path = await findSessionFile(ctx, sessionId);
    if (!path) return null;
    try {
      const st = await stat(path);
      const len = Math.min(st.size, TAIL_BYTES);
      const records = parseLines(await readChunk(path, st.size - len, len), st.size > len, false);
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const usage = codexUsageFromRecord(records[i] ?? {});
        if (usage) return usage;
      }
      return null;
    } catch {
      return null;
    }
  },

  async listSessions(ctx) {
    const paths: string[] = [];
    await walkJsonl(join(ctx.home, 'sessions'), 4, paths);
    const files = await statJsonlFiles(paths.filter((p) => basename(p).startsWith('rollout-')), stat);
    const out: CliSessionSummary[] = [];
    for (const file of files) {
      if (out.length >= ctx.listLimit) break;
      const meta = await codexMeta(file.path, file.size);
      if (!meta) continue;
      out.push({
        cli: 'codex',
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
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    let turnCounter = 0;
    // payload 크기는 담는 시점에 정리한다 — 이유는 claude 스캐너의 같은 자리 주석 참조.
    const push = (type: string, payload: Record<string, unknown>, ts: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload: boundHistoryPayload(payload), created_at: ts || createdAt || new Date().toISOString() });
    };
    let pendingUsage: SessionUsage | null = null;
    let pendingUsageAt: string | undefined;
    const flushUsage = () => {
      if (!pendingUsage) return;
      push('usage', usageEventPayload(pendingUsage), pendingUsageAt);
      pendingUsage = null;
      pendingUsageAt = undefined;
    };
    for await (const rec of readJsonlRecords(path)) {
      const payload = isRecord(rec.payload) ? rec.payload : {};
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      if (rec.type === 'session_meta') {
        cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
        createdAt = typeof payload.timestamp === 'string' ? payload.timestamp : createdAt;
        continue;
      }
      if (rec.type === 'response_item') {
        switch (payload.type) {
          case 'message': {
            const text = textOfBlocks(payload.content);
            if (!text) break;
            if (payload.role === 'user') {
              if (isSyntheticPrompt(text)) break;
              turnCounter += 1;
              turnId = `turn-${turnCounter}`;
              if (!firstPrompt) firstPrompt = text;
              push('user_prompt', { text }, ts);
            } else if (payload.role === 'assistant') {
              push('text', { text }, ts);
            }
            break;
          }
          case 'reasoning': {
            const text = textOfBlocks(payload.summary) || textOfBlocks(payload.content);
            if (text) push('reasoning', { text: truncate(text, TOOL_TEXT_MAX) }, ts);
            break;
          }
          case 'function_call':
          case 'custom_tool_call': {
            const name = typeof payload.name === 'string' ? payload.name : 'tool';
            let input: unknown = payload.arguments ?? payload.input;
            if (typeof input === 'string') {
              const raw: string = input;
              try { input = JSON.parse(raw); } catch { input = truncate(raw, TOOL_TEXT_MAX); }
            }
            push('tool_call', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : '',
              title: name,
              kind: codexToolKind(name),
              input,
              // codex 는 호출 행에 자기 status 를 남긴다(completed/failed). 결과 행이 없는 호출도
              // 있으므로(중단된 턴 등) 이걸 무시하면 기록이 영원히 "running" 으로 보인다.
              ...(typeof payload.status === 'string' && payload.status ? { status: payload.status } : {}),
            }, ts);
            break;
          }
          case 'local_shell_call': {
            const action = isRecord(payload.action) ? payload.action : {};
            const command = Array.isArray(action.command) ? action.command.join(' ') : '';
            push('tool_call', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : (typeof payload.id === 'string' ? payload.id : ''),
              title: command || 'shell',
              kind: 'execute',
              input: action,
            }, ts);
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const output = typeof payload.output === 'string' ? truncate(payload.output, TOOL_TEXT_MAX) : payload.output;
            push('tool_update', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : '',
              status: 'completed',
              output,
            }, ts);
            break;
          }
          default:
            break;
        }
        continue;
      }
      if (rec.type === 'event_msg' || rec.type === 'token_usage_record') {
        // codex 는 API 호출마다 token_count 를 남긴다 — 턴의 마지막 것이 그 턴의 값이라
        // 턴 종료 때 한 번만 낸다(호출마다 내면 전사가 숫자로 뒤덮인다).
        const usage = codexUsageFromRecord(rec);
        if (usage) { pendingUsage = usage; pendingUsageAt = ts; }
        if (payload.type === 'task_complete') {
          flushUsage();
          push('turn', { phase: 'finished', stop_reason: 'end_turn' }, ts);
        } else if (payload.type === 'turn_aborted') {
          flushUsage();
          push('turn', { phase: 'finished', stop_reason: 'cancelled' }, ts);
        }
      }
    }
    flushUsage();
    return {
      events: events.items(),
      total: events.total,
      offset: events.offset,
      title: cleanTitle(firstPrompt),
      cwd,
      createdAt,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      sizeBytes: st.size,
    };
  },
};

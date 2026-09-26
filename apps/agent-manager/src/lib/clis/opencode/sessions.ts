// opencode 세션 기록 스캐너.
//
// opencode 는 파일이 아니라 SQLite(`~/.local/share/opencode/opencode.db`, WAL)에 세션을
// 넣는다. 그 파일을 직접 열지 않고 opencode 자신의 `opencode db <SQL> --format json` 으로
// 질의한다 — (1) 스키마가 opencode 것이고 (2) WAL 락을 그쪽이 관리하며 (3) agent-manager
// 에 sqlite 의존성을 새로 들이지 않아도 되기 때문이다.
//
// 실패(미설치·스키마 변경·타임아웃)는 빈 결과로 접는다 — 목록 조회 하나가 세션 화면
// 전체를 못 쓰게 만들면 안 되고, 세션 화면은 기록이 없어도 열려야 한다(프롬프트는 보낼 수 있다).

import {
  boundHistoryPayload,
  type HistoryEvent,
  isRecord,
  isSyntheticPrompt,
  parseJsonObject,
  toEpochMs,
} from '../../agent-session-history.js';
import { normalizeSessionUsage, usageEventPayload, type SessionUsage } from '../../session-usage.js';
import type { CliSessionStoreContext, CliSessionStoreDriver, CliSessionSummary } from '../cli-module.js';

/**
 * opencode `step-finish` part → 공용 계약. 모양은 `run --format json` 의 그것과 같다
 * (cli-adapters/opencode.ts 의 extractUsage 가 같은 키를 읽는다): `tokens.{input,
 * output, reasoning, cache:{read, write}}` + `cost`. `tokens.input` 은 캐시를
 * 제외한 값이라 그대로 넘긴다. `reasoning` 은 output 의 내역이다.
 */
export function opencodeUsageFromPart(part: Record<string, any> | null): SessionUsage | null {
  const tokens = part && isRecord(part.tokens) ? part.tokens : null;
  if (!tokens) return null;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return normalizeSessionUsage({
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cachedReadTokens: cache.read,
    cacheWriteTokens: cache.write,
    reasoningTokens: tokens.reasoning,
    costUsd: part?.cost,
  });
}

async function query<T>(ctx: CliSessionStoreContext, sql: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await ctx.exec('opencode', ['db', sql, '--format', 'json', '--log-level', 'ERROR']));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export const opencodeSessionStore: CliSessionStoreDriver = {
  /** 마지막 step-finish 하나만 질의한다(ACP 어댑터가 usage 를 안 줄 때의 메꿈). */
  async readLatestUsage(ctx, sessionId) {
    const rows = await query<Record<string, unknown>>(
      ctx,
      "SELECT data FROM part WHERE session_id = '" + sessionId + "' AND data LIKE '%step-finish%' "
      + 'ORDER BY time_created DESC, id DESC LIMIT 1',
    );
    for (const row of rows) {
      const usage = opencodeUsageFromPart(parseJsonObject(row?.data));
      if (usage) return usage;
    }
    return null;
  },

  /** `time_archived` 가 찍힌 세션은 opencode 에서 보관 처리된 것이므로 제외한다. */
  async listSessions(ctx) {
    const rows = await query<Record<string, unknown>>(
      ctx,
      'SELECT id, directory, title, time_created, time_updated FROM session '
      + 'WHERE time_archived IS NULL AND parent_id IS NULL '
      + `ORDER BY time_updated DESC LIMIT ${ctx.listLimit}`,
    );
    const out: CliSessionSummary[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = typeof row.id === 'string' ? row.id : '';
      const cwd = typeof row.directory === 'string' ? row.directory : '';
      if (!id || !cwd) continue;
      // 시각은 epoch ms 정수다. 못 읽으면 그 세션만 버리지 말고 updated 를 created 로,
      // 둘 다 없으면 0 으로 접어 목록에는 남긴다(정렬 맨 뒤로 간다).
      const created = toEpochMs(row.time_created);
      const updated = toEpochMs(row.time_updated) ?? created ?? 0;
      out.push({
        cli: 'opencode',
        session_id: id,
        cwd,
        title: (typeof row.title === 'string' && row.title.trim()) || '(제목 없음)',
        created_at: created === null ? null : new Date(created).toISOString(),
        updated_at: new Date(updated).toISOString(),
        source: 'cli',
      });
    }
    return out;
  },

  /**
   * 기록은 `message`(역할) + `part`(내용) 로 들어 있다. `part.data` 의 모양은
   * `run --format json` 의 `tool_use.part` 와 **같은 객체**다(cli-adapters/opencode.ts 의
   * parseProgressEvent 가 이미 그 모양을 파싱한다) — 그래서 tool 은 거기서 쓰는
   * `tool` / `callID` / `state{status,input,output}` 를 그대로 읽는다.
   */
  async readHistory(ctx, sessionId, indexEntry) {
    const [session] = await query<Record<string, unknown>>(
      ctx,
      `SELECT id, directory, title, time_created, time_updated FROM session WHERE id = '${sessionId}' LIMIT 1`,
    );
    if (!session && !indexEntry) return null;

    // 끝에서부터 historyLimit 건만 읽되 seq 는 절대 위치를 유지한다 — 파일 파서와 같은 규약이라
    // 같은 세션을 다시 읽어도 앞부분이 변하지 않는 한 같은 이벤트가 같은 id 를 갖는다.
    const [countRow] = await query<Record<string, unknown>>(ctx, `SELECT count(*) AS n FROM part WHERE session_id = '${sessionId}'`);
    const total = Number(countRow?.n ?? 0) || 0;
    const offset = Math.max(0, total - ctx.historyLimit);
    const rows = await query<Record<string, unknown>>(
      ctx,
      'SELECT p.id AS part_id, p.message_id AS message_id, p.time_created AS part_time, p.data AS part_data, m.data AS message_data '
      + 'FROM part p JOIN message m ON m.id = p.message_id '
      + `WHERE p.session_id = '${sessionId}' `
      // id 는 시간순으로 증가하는 ULID 계열이라 같은 ms 에 찍힌 part 의 순서까지 고정해 준다.
      + `ORDER BY p.time_created ASC, p.id ASC LIMIT ${ctx.historyLimit} OFFSET ${offset}`,
    );

    const events: HistoryEvent[] = [];
    for (const row of rows) {
      const part = parseJsonObject(row.part_data);
      const message = parseJsonObject(row.message_data);
      if (!part) continue;
      const turnId = typeof row.message_id === 'string' ? row.message_id : '';
      const createdAt = new Date(toEpochMs(row.part_time) ?? Date.now()).toISOString();
      const push = (type: string, payload: Record<string, unknown>) => {
        events.push({ id: '', seq: 0, turn_id: turnId, type, payload: boundHistoryPayload(payload), created_at: createdAt });
      };
      const role = typeof message?.role === 'string' ? message.role : 'assistant';
      switch (part.type) {
        case 'text': {
          const text = typeof part.text === 'string' ? part.text : '';
          if (!text.trim()) break;
          // 사용자 턴에 CLI 가 끼워 넣는 컨텍스트(지침·환경 블록)는 프롬프트가 아니다.
          if (role === 'user') {
            if (!isSyntheticPrompt(text)) push('user_prompt', { text });
          } else {
            push('text', { text });
          }
          break;
        }
        case 'reasoning': {
          const text = typeof part.text === 'string' ? part.text : '';
          // 빈 reasoning 은 실제로 흔하다(암호화된 추론만 있고 본문이 없는 경우).
          if (text.trim()) push('reasoning', { text });
          break;
        }
        case 'tool': {
          const state = isRecord(part.state) ? part.state : {};
          const toolName = typeof part.tool === 'string' ? part.tool : 'tool';
          const callId = typeof part.callID === 'string' ? part.callID : (typeof row.part_id === 'string' ? row.part_id : toolName);
          push('tool_call', { tool_call_id: callId, title: toolName, ...(state.input !== undefined ? { input: state.input } : {}) });
          if (state.status !== undefined || state.output !== undefined) {
            push('tool_update', {
              tool_call_id: callId,
              ...(typeof state.status === 'string' ? { status: state.status } : {}),
              ...(state.output !== undefined ? { output: state.output } : {}),
            });
          }
          break;
        }
        case 'step-finish': {
          // 여기에만 토큰/비용이 있다. 예전엔 이 갈래를 "보일 것이 없다"로 버려서
          // opencode 세션 전사에 사용량이 한 번도 나오지 않았다.
          const usage = opencodeUsageFromPart(part);
          if (usage) push('usage', usageEventPayload(usage));
          break;
        }
        default:
          // step-start / file / snapshot … — 트랜스크립트에 보일 것이 없다.
          break;
      }
    }

    const created = toEpochMs(session?.time_created);
    const updated = toEpochMs(session?.time_updated) ?? created;
    return {
      events,
      // seq 는 **부분(part) 위치** 기준의 절대값이다 — 화면에 안 그리는 part(step-start 등)를
      // 건너뛰어 생기는 구멍은 신경 쓰지 않는다. 재조회 때 같은 이벤트가 같은 id 를 갖는 것이 목적.
      total,
      offset,
      title: (typeof session?.title === 'string' ? session.title : '') || '(제목 없음)',
      cwd: (typeof session?.directory === 'string' && session.directory) || '',
      createdAt: created === null || created === undefined ? null : new Date(created).toISOString(),
      updatedAt: updated === null || updated === undefined ? null : new Date(updated).toISOString(),
    };
  },
};

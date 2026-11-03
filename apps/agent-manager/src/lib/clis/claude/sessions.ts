import { stripDirectWorkPolicy } from '../../ticket-creation-policy.js';
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
  latestRecordFields,
  parseLines,
  readChunk,
  readJsonlRecords,
  recordString,
  SESSION_ID_RE,
  statJsonlFiles,
  TAIL_BYTES,
  textOfBlocks,
  TOOL_TEXT_MAX,
  truncate,
} from '../../agent-session-history.js';
import { normalizeSessionUsage, addSessionUsage, usageEventPayload, type SessionUsage } from '../../session-usage.js';
import type { CliSessionRecordSettings, CliSessionStoreContext, CliSessionStoreDriver, CliSessionSummary } from '../cli-module.js';

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

/**
 * 압축(compaction) 카드의 제목·kind — 라이브 어댑터(claude-agent-acp)가 보내는 카드와 같게 해서, 진행 중에 본
 * 카드가 기록을 다시 읽어도 같은 카드로 남는다.
 */
const COMPACTION_TITLE = 'Compact conversation';
const COMPACT_SUMMARY_PREAMBLE = /^\s*This session is being continued from a previous conversation[^\n]*\n+Summary:[ \t]*\r?\n/;
const COMPACT_SUMMARY_TRAILERS = [
  '\nIf you need specific details from before compaction',
  '\nContinue the conversation from where it left off',
];

/**
 * 압축 요약(`isCompactSummary`)에서 모델에게 하는 말을 떼고 요약 본문만 남긴다. 기록은 요약을 머리말
 * ("This session is being continued … Summary:")과 꼬리(원본 기록 경로 안내, "Continue the conversation …" 지시,
 * 보존한 메시지 안내)로 감싼다. 꼬리는 **마지막** 등장에서 자른다 — 요약이 이 문구를 인용해도 본문이 잘리지 않게.
 * 모르는 틀이면 그대로 둔다(요약을 잃는 것보다 지시문이 남는 편이 낫다).
 */
function compactSummaryText(raw: string): string {
  let text = raw.replace(COMPACT_SUMMARY_PREAMBLE, '');
  for (const marker of COMPACT_SUMMARY_TRAILERS) {
    const at = text.lastIndexOf(marker);
    if (at >= 0) {
      text = text.slice(0, at);
      break;
    }
  }
  return text.trim();
}

/** `compact_boundary.compactMetadata` 중 카드에 보일 사실 — 이름은 라이브 카드 출력과 같다. */
function compactionFacts(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;
  const facts: Record<string, unknown> = {};
  if (typeof meta.trigger === 'string') facts.trigger = meta.trigger === 'auto' ? 'automatic' : meta.trigger;
  for (const key of ['preTokens', 'postTokens', 'durationMs']) {
    if (typeof meta[key] === 'number') facts[key] = meta[key];
  }
  return Object.keys(facts).length ? facts : null;
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
    if (!firstPrompt && rec.type === 'user' && !rec.isSidechain && !rec.isMeta && !rec.isCompactSummary && isRecord(rec.message)) {
      const text = stripDirectWorkPolicy(textOfBlocks(rec.message.content));
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

/**
 * 레코드 하나에 실린 실행 설정. 모델은 API 가 답한 `message.model` 이 먼저다(backend profile 이면
 * 고른 이름과 다르다) — 오류 같은 합성 답은 `<synthetic>` 이라 고른 `requestedModel` 로 떨어진다.
 * 권한 모드는 사용자 레코드에, effort 는 assistant 레코드에 실린다.
 */
function claudeSettingsOf(rec: Record<string, any>): Partial<CliSessionRecordSettings> | null {
  if (rec.isSidechain) return null;
  const out: Partial<CliSessionRecordSettings> = {
    mode: recordString(rec.permissionMode),
    cli_version: recordString(rec.version),
    git_branch: recordString(rec.gitBranch),
    client: recordString(rec.entrypoint),
    last_record_at: recordString(rec.timestamp),
  };
  if (rec.type === 'assistant') {
    const answered = isRecord(rec.message) ? recordString(rec.message.model) : undefined;
    out.model = answered && answered !== '<synthetic>' ? answered : recordString(rec.requestedModel);
    out.effort = recordString(rec.effort) ?? recordString(rec.perTurnEffort);
  }
  return out;
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

  async readSessionInfo(ctx, sessionId) {
    const path = await findSessionFile(ctx, sessionId);
    if (!path) return null;
    const st = await stat(path);
    const meta = await claudeMeta(path, st.size);
    if (!meta) return null;
    return {
      summary: {
        cli: 'claude',
        session_id: meta.sessionId,
        cwd: meta.cwd,
        title: meta.title,
        created_at: meta.createdAt,
        updated_at: new Date(st.mtimeMs).toISOString(),
        source: 'cli',
        size_bytes: st.size,
      },
      settings: await latestRecordFields<CliSessionRecordSettings>(path, st.size, ['model', 'mode'], claudeSettingsOf),
    };
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
    // 이미지 블록 → 보관 후 참조만 이벤트로. 바이트를 payload 에 실으면 상한에 걸려 잘리고, 창 안에
    // 원본 blob 이 남아 메모리도 먹는다. 보관 통로가 없으면(테스트·구버전 호출자) 건너뛴다.
    const pushImage = async (block: unknown, toolCallId: string, ts: string | undefined): Promise<void> => {
      if (!isRecord(block) || block.type !== 'image' || !ctx.storeImage) return;
      const source = isRecord(block.source) ? block.source : null;
      if (!source || source.type !== 'base64' || typeof source.data !== 'string' || !source.data) return;
      const stored = await ctx.storeImage(sessionId, source.data).catch(() => null);
      if (!stored) return;
      push('image', {
        image_ref: stored.ref,
        mime_type: typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream',
        size: stored.size,
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      }, ts);
    };
    // 바로 앞 대화 행의 역할 — 모델에게만 보낸 글(isMeta)이 모델이 말을 마친 뒤에 왔는지 가린다.
    let lastRole = '';
    // 압축 경계(`compact_boundary`)의 사실 — 뒤따르는 요약 행이 카드에 싣는다.
    let compaction: { id: string; facts: Record<string, unknown> | null } | null = null;
    for await (const rec of readJsonlRecords(path)) {
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (!createdAt && typeof rec.timestamp === 'string') createdAt = rec.timestamp;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') { title = rec.customTitle; continue; }
      if (rec.type === 'summary' && typeof rec.summary === 'string' && !title) { title = rec.summary; continue; }
      if (rec.isSidechain) continue;
      if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
        compaction = { id: typeof rec.uuid === 'string' ? rec.uuid : '', facts: compactionFacts(rec.compactMetadata) };
        continue;
      }
      const message = isRecord(rec.message) ? rec.message : null;
      if (!message) continue;
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      const afterAssistant = lastRole === 'assistant';
      lastRole = typeof rec.type === 'string' ? rec.type : '';
      if (rec.type === 'user' && rec.isCompactSummary === true) {
        // 컨텍스트가 차서 Claude Code 가 앞 대화를 요약한 것 — 이후 모델은 이 요약만 본다. 모델에게 넘기느라 user 행으로
        // 남지만 사람이 친 말이 아니다. 예전에는 "This session is being continued …" 전문이 사용자 말풍선으로 나오고
        // 그 자리에서 턴이 갈렸다. 라이브와 같은 카드로 그린다(입력: 압축 사실, 출력: 요약). 턴은 그대로 잇는다.
        const id = compaction?.id || (typeof rec.uuid === 'string' ? rec.uuid : '') || `compact-${events.total}`;
        const summary = compactSummaryText(textOfBlocks(message.content));
        push('tool_call', { tool_call_id: id, title: COMPACTION_TITLE, kind: 'think', ...(compaction?.facts ? { input: compaction.facts } : {}) }, ts);
        push('tool_update', { tool_call_id: id, status: 'completed', ...(summary ? { output: summary } : {}) }, ts);
        compaction = null;
        continue;
      }
      if (rec.type === 'user') {
        // Claude Code 가 모델에게만 보낸 글(`isMeta` — 이미지 주석, skill 본문, hook 피드백, 다른 세션의 메시지,
        // "Continue from where you left off.")은 CLI 화면처럼 그리지 않는다. 사람이 친 말로 보이면 안 된다.
        // 모델이 말을 마친 뒤에 온 것이면 그 뒤의 답은 새 턴이다 — 같은 턴에 두면 앞 답과 한 말풍선으로 붙는다.
        const meta = rec.isMeta === true;
        if (meta && afterAssistant) {
          flushUsage();
          turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
        }
        const content = typeof message.content === 'string' ? stripDirectWorkPolicy(message.content) : message.content;
        if (typeof content === 'string') {
          if (meta || isSyntheticPrompt(content)) continue;
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
            const text = stripDirectWorkPolicy(block.text);
            if (meta || isSyntheticPrompt(text)) continue;
            flushUsage();
            turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
            if (!firstPrompt) firstPrompt = text;
            push('user_prompt', { text }, ts);
          } else if (block.type === 'image') {
            // 사용자가 붙여 넣은 이미지.
            await pushImage(block, '', ts);
          } else if (block.type === 'tool_result') {
            const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
            push('tool_update', {
              tool_call_id: toolCallId,
              status: block.is_error ? 'failed' : 'completed',
              output: truncate(textOfBlocks(block.content), TOOL_TEXT_MAX),
            }, ts);
            // tool 결과 이미지(PNG 를 Read 한 경우 등). 예전에는 textOfBlocks 가 텍스트만 뽑아 이미지는
            // 사라지고 모델용 주석(`[Image: original 3437x674 …]`)만 전사에 남았다.
            if (Array.isArray(block.content)) {
              for (const inner of block.content) await pushImage(inner, toolCallId, ts);
            }
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

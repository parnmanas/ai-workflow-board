// Scans the local agent-manager.log for error/warn/fatal lines since the last
// upload marker and POSTs them to AWB's /api/agent/error-logs so they show up
// in the admin Agent Logs viewer. Dormant for success-only sessions.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_MANAGER_HOME, LOG_PATH } from './constants.js';
import { log } from './logging.js';
import { drainEvents } from './event-log-recorder.js';
import type { AwbConfig } from './rest.js';

const MARKER_PATH = join(AGENT_MANAGER_HOME, 'error-upload.json');

const LINE_RE = /^\[([^\]]+)\] \[pid=([^\]]+)\] (.+)$/;
const MAX_ENTRIES = 500;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface UploadEntry {
  occurred_at: string;
  level: 'fatal' | 'error' | 'warn' | 'info';
  category: string;
  message: string;
  raw_line: string;
  pid: string;
}

/**
 * 원시 로그 메시지를 분류한다. null 을 반환하면 skip(성공/노이즈)한다.
 *
 * 단위 테스트용으로 export (test/error-log-uploader.test.mjs 참조).
 */
export function classify(
  msg: string,
): { level: UploadEntry['level']; category: string } | null {
  // Skip our own uploader traces BEFORE the /error|failed/i catch-all.
  if (/^\[uploader\]/.test(msg)) return null;
  if (/^\[DIAG\]/.test(msg)) return null;
  if (/^\[claude-bin\]/.test(msg)) return null;

  if (/^Uncaught error:|^Unhandled rejection:/.test(msg))
    return { level: 'fatal', category: 'crash' };
  if (/^EXIT code=[1-9]/.test(msg)) return { level: 'fatal', category: 'crash' };
  if (/^SSE error:/.test(msg)) return { level: 'error', category: 'sse' };
  if (/^Presence ping failed:/.test(msg)) return { level: 'error', category: 'presence' };
  if (/stdout error:|EPIPE/.test(msg)) return { level: 'error', category: 'ipc' };
  if (/result subtype=error|is_error=true/.test(msg))
    return { level: 'error', category: 'subagent' };

  // 구조화된 성공/무실패 신호는 아래 느슨한 catch-all 보다 우선한다. 멀쩡한
  // 로그도 "error"/"failed" 부분문자열을 포함할 수 있다:
  //   "result subtype=success is_error=false"        (정상 종료한 턴)
  //   "restart_all_agents → 4 restarted, 0 failed"   (실패 0건인 재시작)
  // 기존 /error|failed/i catch-all 이 이 둘을 에러로 오분류해, 채팅/서브에이전트
  // 턴과 에이전트 재시작마다 last_error_upload_at 을 갱신 → 매니저가 영구
  // DEGRADED 배지에 고정됐다 (ticket 04d22ec0). 부분문자열 대신 명시적
  // 플래그/제로카운트를 신뢰해 여기서 skip 한다. 실제 실패(is_error=true,
  // subtype=error 는 위에서, "N failed" N>0 은 아래 catch-all 에서)는 그대로다.
  if (/is_error=false|subtype=success|\b0 (?:failed|errors?)\b/.test(msg)) return null;

  if (/error|failed/i.test(msg)) return { level: 'warn', category: 'misc' };
  return null;
}

export async function scanErrorsSince(
  logPath: string,
  sinceMs: number,
): Promise<UploadEntry[]> {
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  const out: UploadEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, isoTs, pid, msg] = m;
    const ms = Date.parse(isoTs);
    if (!Number.isFinite(ms) || ms <= sinceMs) continue;
    const klass = classify(msg);
    if (!klass) continue;
    out.push({
      occurred_at: new Date(ms).toISOString(),
      level: klass.level,
      category: klass.category,
      message: msg.slice(0, 2000),
      raw_line: line.slice(0, 4000),
      pid,
    });
  }
  return out.slice(-MAX_ENTRIES); // keep last N if oversized
}

async function readMarker(): Promise<number | null> {
  try {
    const raw = await readFile(MARKER_PATH, 'utf8');
    const j = JSON.parse(raw);
    return typeof j.last_occurred_at === 'string'
      ? Date.parse(j.last_occurred_at)
      : null;
  } catch {
    return null;
  }
}

async function writeMarker(
  agentId: string,
  lastOccurredAt: string,
  uploadedAt: string,
): Promise<void> {
  try {
    await writeFile(
      MARKER_PATH,
      JSON.stringify(
        {
          agent_id: agentId,
          last_occurred_at: lastOccurredAt,
          last_uploaded_at: uploadedAt,
        },
        null,
        2,
      ),
    );
  } catch (err: any) {
    log(`[uploader] marker write failed: ${err?.message ?? err}`);
  }
}

export interface UploadResult {
  uploaded: number;
  errors?: number;
  events?: number;
  last_occurred_at?: string | null;
  reason?: string;
}

export async function uploadIfNewErrors(
  config: AwbConfig | null | undefined,
  agentId: string | null | undefined,
  pluginVersion: string,
): Promise<UploadResult> {
  if (!config?.url || !config?.apiKey || !agentId)
    return { uploaded: 0, reason: 'missing_config' };
  const markerMs = await readMarker();
  const sinceMs = markerMs ?? Date.now() - DEFAULT_LOOKBACK_MS;
  const errorEntries = await scanErrorsSince(LOG_PATH, sinceMs);
  const eventEntries = drainEvents();
  const combined: UploadEntry[] = errorEntries
    .concat(eventEntries as unknown as UploadEntry[])
    .slice(0, MAX_ENTRIES);
  if (combined.length === 0) return { uploaded: 0, reason: 'no_new_entries' };

  const url = `${config.url.replace(/\/$/, '')}/api/agent/error-logs`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': config.apiKey,
      },
      body: JSON.stringify({
        agent_id: agentId,
        workspace_id: (config.workspace_id as string) ?? null,
        plugin_version: pluginVersion,
        entries: combined,
      }),
    });
    if (!resp.ok) {
      log(`[uploader] upload failed: HTTP ${resp.status}`);
      return { uploaded: 0, reason: `http_${resp.status}` };
    }
    const data: any = await resp.json().catch(() => ({}));
    // Marker advances ONLY on error timestamps — event entries are drained
    // on send and have no persistent replay, so they must not move the marker
    // (otherwise a busy event burst would blind us to new errors after it).
    const lastErrorOccurredAt =
      errorEntries.length > 0 ? errorEntries[errorEntries.length - 1].occurred_at : null;
    const uploadedAt = data.uploaded_at ?? new Date().toISOString();
    if (lastErrorOccurredAt) {
      await writeMarker(agentId, lastErrorOccurredAt, uploadedAt);
    }
    log(
      `[uploader] uploaded ${data.accepted ?? combined.length} entries (errors=${errorEntries.length} events=${eventEntries.length}), marker=${lastErrorOccurredAt ?? '(unchanged)'}`,
    );
    return {
      uploaded: combined.length,
      errors: errorEntries.length,
      events: eventEntries.length,
      last_occurred_at: lastErrorOccurredAt,
    };
  } catch (err: any) {
    log(`[uploader] upload error: ${err?.message ?? err}`);
    return { uploaded: 0, reason: 'network_error' };
  }
}

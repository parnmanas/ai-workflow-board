import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSession } from '../../entities/AgentSession';
import { AgentSessionEvent } from '../../entities/AgentSessionEvent';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { resolveAgentDisplayNamesByIds } from '../../utils/agent-name';
import {
  AGENT_SESSION_EVENT_BATCH_MAX,
  AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS,
  AGENT_SESSION_EVENT_TYPES,
  AGENT_SESSION_PERMISSION_POLICIES,
  AGENT_SESSION_PROMPT_MAX_CHARS,
  AGENT_SESSION_STATUSES,
  agentSessionAcceptsPrompt,
  resolveAgentSessionRuntime,
} from '../../common/types/agent-sessions';
import type {
  AgentSessionEventRecord,
  AgentSessionModeOption,
  AgentSessionRequestPayload,
  AgentSessionSnapshot,
} from '../../common/types/stream-events';

/** 컨트롤러가 HTTP 상태로 옮기는 도메인 오류. */
export class AgentSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
    this.name = 'AgentSessionError';
  }
}

export interface SessionAgentOption {
  id: string;
  /** `<Manager>/<Agent>` 표시명. */
  name: string;
  type: string;
  working_dir: string;
  is_online: number;
  manager_agent_id: string | null;
  supported: boolean;
  reason: string | null;
}

export interface AppendEventInput {
  type: string;
  payload: Record<string, unknown>;
  turn_id?: string;
}

export interface ManagerPatchInput {
  status?: string;
  native_session_id?: string | null;
  resume_supported?: boolean;
  current_mode?: string | null;
  available_modes?: AgentSessionModeOption[] | null;
  last_error?: string | null;
  reason?: string;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_SESSION_EVENT_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set(AGENT_SESSION_STATUSES);
const POLICY_SET: ReadonlySet<string> = new Set(AGENT_SESSION_PERMISSION_POLICIES);
const TITLE_MAX = 200;
const CWD_MAX = 1024;
const LIST_LIMIT = 200;
const EVENTS_PAGE_DEFAULT = 500;
const EVENTS_PAGE_MAX = 2000;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseModes(raw: string | null): AgentSessionModeOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, description: typeof m.description === 'string' ? m.description : undefined }));
  } catch {
    return [];
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Agent Session(CLI 직접 세션) 도메인 서비스.
 *
 * 쓰기 경로는 두 갈래다:
 *   - 사용자(소유자): create / prompt / permission / cancel / set_mode / rename / close / remove
 *     → 레코드를 바꾸고 `agent_session_request` SSE 로 매니저에게 일을 시킨다.
 *   - agent-manager: appendEvents / applyManagerPatch
 *     → ACP 스트림을 append-only 트랜스크립트로 쌓고 `agent_session_event` /
 *       `agent_session_update` SSE 로 소유자 UI 에 흘린다.
 */
@Injectable()
export class AgentSessionsService {
  constructor(
    @InjectRepository(AgentSession) private readonly sessions: Repository<AgentSession>,
    @InjectRepository(AgentSessionEvent) private readonly events: Repository<AgentSessionEvent>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  // ─── 읽기 ────────────────────────────────────────────────────────────────

  async listSessionAgents(workspaceId: string): Promise<SessionAgentOption[]> {
    const rows = await this.agents.find({ where: { workspace_id: workspaceId, is_active: 1 } });
    const candidates = rows.filter((a) => a.type !== 'manager');
    const names = await resolveAgentDisplayNamesByIds(this.agents, candidates.map((a) => a.id));
    return candidates
      .map((a) => {
        const resolution = resolveAgentSessionRuntime(a);
        return {
          id: a.id,
          name: names.get(a.id) ?? a.name,
          type: a.type,
          working_dir: a.working_dir || '',
          is_online: (a as any).is_online ?? 0,
          manager_agent_id: a.manager_agent_id ?? null,
          supported: resolution.supported,
          reason: resolution.reason,
        };
      })
      .sort((x, y) => Number(y.supported) - Number(x.supported) || x.name.localeCompare(y.name));
  }

  async listForOwner(workspaceId: string, userId: string): Promise<AgentSessionSnapshot[]> {
    const rows = await this.sessions.find({
      where: { workspace_id: workspaceId, owner_user_id: userId },
      order: { updated_at: 'DESC' },
      take: LIST_LIMIT,
    });
    // 최근 활동 우선, 활동 없는(막 만든) 세션은 생성 시각으로.
    rows.sort((a, b) => {
      const ta = (a.last_activity_at ?? a.created_at)?.getTime?.() ?? 0;
      const tb = (b.last_activity_at ?? b.created_at)?.getTime?.() ?? 0;
      return tb - ta;
    });
    const names = await resolveAgentDisplayNamesByIds(this.agents, rows.map((r) => r.agent_id));
    return rows.map((r) => this.snapshot(r, names.get(r.agent_id) ?? null));
  }

  async getOwned(sessionId: string, userId: string): Promise<AgentSession> {
    const row = await this.sessions.findOne({ where: { id: sessionId } });
    // 남의 세션은 존재 자체를 드러내지 않는다.
    if (!row || row.owner_user_id !== userId) throw new AgentSessionError(404, 'session_not_found');
    return row;
  }

  async getOwnedSnapshot(sessionId: string, userId: string): Promise<AgentSessionSnapshot> {
    const row = await this.getOwned(sessionId, userId);
    return this.snapshot(row, await this.agentName(row.agent_id));
  }

  async listEvents(
    sessionId: string,
    userId: string,
    afterSeq: number,
    limit: number,
  ): Promise<AgentSessionEventRecord[]> {
    await this.getOwned(sessionId, userId);
    const take = Math.min(Math.max(1, limit || EVENTS_PAGE_DEFAULT), EVENTS_PAGE_MAX);
    const rows = await this.events
      .createQueryBuilder('e')
      .where('e.session_id = :sessionId', { sessionId })
      .andWhere('e.seq > :afterSeq', { afterSeq: Math.max(0, afterSeq || 0) })
      .orderBy('e.seq', 'ASC')
      .take(take)
      .getMany();
    return rows.map((r) => this.toRecord(r));
  }

  // ─── 사용자 쓰기 ─────────────────────────────────────────────────────────

  async create(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    cwd?: string;
    title?: string;
    permissionPolicy?: string;
  }): Promise<AgentSessionSnapshot> {
    const agent = await this.agents.findOne({ where: { id: input.agentId } });
    if (!agent) throw new AgentSessionError(404, 'agent_not_found');
    if (agent.workspace_id !== input.workspaceId) throw new AgentSessionError(403, 'agent_outside_workspace');
    if (!agent.is_active) throw new AgentSessionError(409, 'agent_inactive');
    const resolution = resolveAgentSessionRuntime(agent);
    if (!resolution.supported) {
      throw new AgentSessionError(409, 'runtime_unsupported', `Agent type ${resolution.runtime || '(none)'} has no ACP adapter (${resolution.reason})`);
    }
    if (!agent.manager_agent_id) throw new AgentSessionError(409, 'agent_has_no_runtime_host');

    const cwd = String(input.cwd ?? '').trim();
    if (cwd.length > CWD_MAX) throw new AgentSessionError(400, 'cwd_too_long');
    const title = String(input.title ?? '').trim().slice(0, TITLE_MAX);
    const policy = String(input.permissionPolicy ?? 'ask');
    if (!POLICY_SET.has(policy)) throw new AgentSessionError(400, 'permission_policy_invalid');

    const row = this.sessions.create({
      workspace_id: input.workspaceId,
      agent_id: agent.id,
      owner_user_id: input.userId,
      runtime: resolution.runtime,
      title,
      cwd,
      status: 'starting',
      permission_policy: policy,
      last_event_seq: 0,
      last_activity_at: null,
    });
    const saved = await this.sessions.save(row);
    this.logService.info('AgentSession', `created ${saved.id.slice(0, 8)} agent=${agent.id.slice(0, 8)} runtime=${resolution.runtime}`);
    const snap = await this.emitUpdate(saved, 'created');
    this.emitRequest(saved, 'open');
    return snap;
  }

  async prompt(sessionId: string, userId: string, textInput: unknown): Promise<{ turn_id: string; session: AgentSessionSnapshot }> {
    const text = typeof textInput === 'string' ? textInput : '';
    if (!text.trim()) throw new AgentSessionError(400, 'text_required');
    if (text.length > AGENT_SESSION_PROMPT_MAX_CHARS) throw new AgentSessionError(413, 'text_too_long');
    const session = await this.getOwned(sessionId, userId);
    if (!agentSessionAcceptsPrompt(session.status)) throw new AgentSessionError(409, 'session_closed');
    if (session.status === 'busy' || session.status === 'awaiting_permission') {
      throw new AgentSessionError(409, 'session_busy', 'A turn is already in progress. Cancel it or wait for it to finish.');
    }
    const turnId = randomUUID();
    await this.appendEventsInternal(session.id, [{ type: 'user_prompt', payload: { text }, turn_id: turnId }], {
      status: 'busy',
      last_error: null,
    });
    const fresh = await this.sessions.findOne({ where: { id: session.id } });
    if (!fresh) throw new AgentSessionError(404, 'session_not_found');
    if (!fresh.title) {
      // 첫 프롬프트 발췌를 제목으로 — 사용자가 언제든 rename 으로 덮어쓴다.
      fresh.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
      await this.sessions.save(fresh);
    }
    const snap = await this.emitUpdate(fresh, 'prompt');
    this.emitRequest(fresh, 'prompt', { turn_id: turnId, text });
    return { turn_id: turnId, session: snap };
  }

  async decidePermission(sessionId: string, userId: string, requestIdInput: unknown, optionIdInput: unknown): Promise<AgentSessionSnapshot> {
    const requestId = typeof requestIdInput === 'string' ? requestIdInput.trim() : '';
    if (!requestId) throw new AgentSessionError(400, 'request_id_required');
    const optionId = typeof optionIdInput === 'string' && optionIdInput.trim() ? optionIdInput.trim() : null;
    const session = await this.getOwned(sessionId, userId);
    if (!agentSessionAcceptsPrompt(session.status)) throw new AgentSessionError(409, 'session_closed');
    const already = await this.events
      .createQueryBuilder('e')
      .where('e.session_id = :sessionId', { sessionId: session.id })
      .andWhere('e.type = :type', { type: 'permission_decision' })
      .andWhere('e.payload LIKE :needle', { needle: `%${JSON.stringify(requestId)}%` })
      .getCount();
    if (already > 0) throw new AgentSessionError(409, 'permission_already_decided');
    await this.appendEventsInternal(session.id, [{
      type: 'permission_decision',
      payload: { request_id: requestId, outcome: optionId ? 'selected' : 'cancelled', option_id: optionId, decided_by: 'user' },
    }], { status: 'busy' });
    const fresh = (await this.sessions.findOne({ where: { id: session.id } }))!;
    const snap = await this.emitUpdate(fresh, 'permission');
    this.emitRequest(fresh, 'permission', { request_id: requestId, option_id: optionId });
    return snap;
  }

  async cancel(sessionId: string, userId: string): Promise<AgentSessionSnapshot> {
    const session = await this.getOwned(sessionId, userId);
    if (!agentSessionAcceptsPrompt(session.status)) throw new AgentSessionError(409, 'session_closed');
    this.emitRequest(session, 'cancel');
    return this.snapshot(session, await this.agentName(session.agent_id));
  }

  async setMode(sessionId: string, userId: string, modeIdInput: unknown): Promise<AgentSessionSnapshot> {
    const modeId = typeof modeIdInput === 'string' ? modeIdInput.trim() : '';
    if (!modeId) throw new AgentSessionError(400, 'mode_id_required');
    const session = await this.getOwned(sessionId, userId);
    if (!agentSessionAcceptsPrompt(session.status)) throw new AgentSessionError(409, 'session_closed');
    this.emitRequest(session, 'set_mode', { mode_id: modeId });
    return this.snapshot(session, await this.agentName(session.agent_id));
  }

  async rename(sessionId: string, userId: string, titleInput: unknown): Promise<AgentSessionSnapshot> {
    const title = typeof titleInput === 'string' ? titleInput.trim().slice(0, TITLE_MAX) : '';
    const session = await this.getOwned(sessionId, userId);
    session.title = title;
    await this.sessions.save(session);
    return this.emitUpdate(session, 'renamed');
  }

  async close(sessionId: string, userId: string): Promise<AgentSessionSnapshot> {
    const session = await this.getOwned(sessionId, userId);
    if (session.status !== 'closed') {
      session.status = 'closed';
      await this.sessions.save(session);
      await this.appendEventsInternal(session.id, [{ type: 'system', payload: { text: 'Session closed by user.' } }]);
      this.emitRequest(session, 'close');
    }
    return this.emitUpdate(session, 'closed');
  }

  async remove(sessionId: string, userId: string): Promise<void> {
    const session = await this.getOwned(sessionId, userId);
    if (session.status !== 'closed') this.emitRequest(session, 'close');
    const name = await this.agentName(session.agent_id);
    await this.dataSource.transaction(async (m) => {
      await m.getRepository(AgentSessionEvent).delete({ session_id: session.id });
      await m.getRepository(AgentSession).delete({ id: session.id });
    });
    session.status = 'closed';
    activityEvents.emit('agent_session_update', {
      session: this.snapshot(session, name),
      reason: 'deleted',
      timestamp: new Date().toISOString(),
    });
  }

  // ─── agent-manager 쓰기 ──────────────────────────────────────────────────

  /** X-Agent-Key 호출자가 이 세션에 쓸 수 있는지 — 세션의 agent 본인이거나 그
   *  agent 를 소유한 Runtime Host(manager_agent_id)여야 한다. */
  async getForAgentCaller(sessionId: string, callerAgentId: string): Promise<AgentSession> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new AgentSessionError(404, 'session_not_found');
    if (callerAgentId !== session.agent_id) {
      const agent = await this.agents.findOne({ where: { id: session.agent_id } });
      if (!agent || agent.manager_agent_id !== callerAgentId) {
        throw new AgentSessionError(403, 'session_agent_mismatch');
      }
    }
    return session;
  }

  async appendEvents(
    session: AgentSession,
    itemsInput: unknown,
    patch?: ManagerPatchInput | null,
  ): Promise<{ events: AgentSessionEventRecord[]; session: AgentSessionSnapshot }> {
    if (!Array.isArray(itemsInput)) throw new AgentSessionError(400, 'events_required');
    if (itemsInput.length > AGENT_SESSION_EVENT_BATCH_MAX) throw new AgentSessionError(413, 'events_batch_too_large');
    const items: AppendEventInput[] = itemsInput.map((raw: any, i: number) => {
      const type = typeof raw?.type === 'string' ? raw.type : '';
      if (!EVENT_TYPE_SET.has(type)) throw new AgentSessionError(400, 'event_type_invalid', `events[${i}].type=${type || '(empty)'}`);
      if (type === 'user_prompt') throw new AgentSessionError(400, 'event_type_reserved', 'user_prompt rows are written by the owner path only');
      const payload = raw?.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {};
      const serialized = JSON.stringify(payload);
      if (serialized.length > AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS) {
        throw new AgentSessionError(413, 'event_payload_too_large', `events[${i}] payload exceeds ${AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS} chars`);
      }
      return { type, payload, turn_id: typeof raw?.turn_id === 'string' ? raw.turn_id.slice(0, 64) : '' };
    });
    const normalizedPatch = patch ? this.normalizePatch(patch) : null;
    const rows = await this.appendEventsInternal(session.id, items, normalizedPatch ?? undefined);
    const fresh = (await this.sessions.findOne({ where: { id: session.id } }))!;
    const snap = normalizedPatch
      ? await this.emitUpdate(fresh, patch?.reason || 'manager_patch')
      : this.snapshot(fresh, await this.agentName(fresh.agent_id));
    return { events: rows, session: snap };
  }

  async applyManagerPatch(session: AgentSession, patch: ManagerPatchInput): Promise<AgentSessionSnapshot> {
    const normalized = this.normalizePatch(patch);
    if (Object.keys(normalized).length === 0) {
      return this.snapshot(session, await this.agentName(session.agent_id));
    }
    await this.sessions.update({ id: session.id }, normalized);
    const fresh = (await this.sessions.findOne({ where: { id: session.id } }))!;
    return this.emitUpdate(fresh, patch.reason || 'manager_patch');
  }

  // ─── 내부 ────────────────────────────────────────────────────────────────

  private normalizePatch(patch: ManagerPatchInput): Partial<AgentSession> {
    const out: Partial<AgentSession> = {};
    if (patch.status !== undefined) {
      if (typeof patch.status !== 'string' || !STATUS_SET.has(patch.status)) throw new AgentSessionError(400, 'status_invalid');
      out.status = patch.status;
    }
    if (patch.native_session_id !== undefined) {
      out.native_session_id = patch.native_session_id ? String(patch.native_session_id).slice(0, 256) : null;
    }
    if (patch.resume_supported !== undefined) out.resume_supported = patch.resume_supported ? 1 : 0;
    if (patch.current_mode !== undefined) out.current_mode = patch.current_mode ? String(patch.current_mode).slice(0, 128) : null;
    if (patch.available_modes !== undefined) {
      out.available_modes = Array.isArray(patch.available_modes)
        ? JSON.stringify(patch.available_modes.filter((m) => m && typeof m.id === 'string').slice(0, 32))
        : null;
    }
    if (patch.last_error !== undefined) out.last_error = patch.last_error ? String(patch.last_error).slice(0, 4000) : null;
    return out;
  }

  /**
   * seq 를 세션 단위로 원자 부여하며 이벤트를 쌓는다. Postgres 는 행 잠금
   * (pessimistic_write)으로 동시 append 를 직렬화하고, sql.js 는 단일 커넥션 +
   * db.ts 의 트랜잭션 직렬화 큐가 같은 보장을 준다(잠금 절은 드라이버가 지원하지
   * 않아 생략).
   */
  private async appendEventsInternal(
    sessionId: string,
    items: AppendEventInput[],
    patch?: Partial<AgentSession>,
  ): Promise<AgentSessionEventRecord[]> {
    const isPostgres = this.dataSource.options.type === 'postgres';
    const { rows, session } = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(AgentSession);
      const locked = isPostgres
        ? await repo.findOne({ where: { id: sessionId }, lock: { mode: 'pessimistic_write' } })
        : await repo.findOne({ where: { id: sessionId } });
      if (!locked) throw new AgentSessionError(404, 'session_not_found');
      let seq = locked.last_event_seq || 0;
      const eventRepo = m.getRepository(AgentSessionEvent);
      const created = items.map((item) => eventRepo.create({
        session_id: sessionId,
        seq: ++seq,
        turn_id: item.turn_id || '',
        type: item.type,
        payload: JSON.stringify(item.payload ?? {}),
      }));
      const saved = created.length ? await eventRepo.save(created) : [];
      await repo.update({ id: sessionId }, {
        ...(patch ?? {}),
        last_event_seq: seq,
        last_activity_at: new Date(),
      });
      return { rows: saved, session: locked };
    });
    const records = rows.map((r) => this.toRecord(r));
    for (const record of records) {
      activityEvents.emit('agent_session_event', {
        session_id: sessionId,
        workspace_id: session.workspace_id,
        owner_user_id: session.owner_user_id,
        event: record,
        timestamp: record.created_at,
      });
    }
    return records;
  }

  private toRecord(row: AgentSessionEvent): AgentSessionEventRecord {
    return {
      id: row.id,
      seq: row.seq,
      turn_id: row.turn_id || '',
      type: row.type,
      payload: parsePayload(row.payload),
      created_at: iso(row.created_at) ?? new Date().toISOString(),
    };
  }

  private async agentName(agentId: string): Promise<string | null> {
    const map = await resolveAgentDisplayNamesByIds(this.agents, [agentId]);
    return map.get(agentId) ?? null;
  }

  snapshot(row: AgentSession, agentName: string | null): AgentSessionSnapshot {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      agent_id: row.agent_id,
      agent_name: agentName || 'Agent',
      owner_user_id: row.owner_user_id,
      runtime: row.runtime,
      title: row.title || '',
      cwd: row.cwd || '',
      status: row.status,
      native_session_id: row.native_session_id ?? null,
      resume_supported: !!row.resume_supported,
      current_mode: row.current_mode ?? null,
      available_modes: parseModes(row.available_modes),
      permission_policy: row.permission_policy || 'ask',
      last_error: row.last_error ?? null,
      last_event_seq: row.last_event_seq || 0,
      last_activity_at: iso(row.last_activity_at),
      created_at: iso(row.created_at) ?? new Date().toISOString(),
      updated_at: iso(row.updated_at) ?? new Date().toISOString(),
    };
  }

  private async emitUpdate(row: AgentSession, reason: string): Promise<AgentSessionSnapshot> {
    const snap = this.snapshot(row, await this.agentName(row.agent_id));
    activityEvents.emit('agent_session_update', {
      session: snap,
      reason,
      timestamp: new Date().toISOString(),
    });
    return snap;
  }

  private emitRequest(
    row: AgentSession,
    op: AgentSessionRequestPayload['op'],
    extra: Partial<Pick<AgentSessionRequestPayload, 'turn_id' | 'text' | 'request_id' | 'option_id' | 'mode_id'>> = {},
  ): void {
    const payload: AgentSessionRequestPayload = {
      session_id: row.id,
      workspace_id: row.workspace_id,
      agent_id: row.agent_id,
      owner_user_id: row.owner_user_id,
      op,
      runtime: row.runtime,
      cwd: row.cwd || '',
      native_session_id: row.native_session_id ?? null,
      permission_policy: row.permission_policy || 'ask',
      ...extra,
      issued_at: new Date().toISOString(),
    };
    activityEvents.emit('agent_session_request', payload);
  }
}

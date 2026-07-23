/**
 * Shared runtime logic for the per-ticket hard-budget ceilings (ticket
 * a940d75b). Three independent enforcement points share this module:
 *
 *   (a) apps/server/src/modules/mcp/tools/comment-tools.ts (5 tools) +
 *       apps/server/src/modules/agent-api/agent-api.controller.ts (batch
 *       add-comment op) call `enforceAutoResponseBudget` before saving an
 *       agent-authored comment.
 *   (b)+(c) apps/server/src/modules/agents/trigger-loop.service.ts's
 *       `_emitTrigger` calls `lastHumanUnpendAt` + `countWindowDispatches` +
 *       `countWindowTokens` (ticket ef53fdf4) + `pendTicketForHardBudget`
 *       directly (the window arithmetic is specific to that single call
 *       site, see the gate there).
 *
 * Epoch rule (all three ceilings): only events strictly after the ticket's most
 * recent HUMAN-driven unpend count. Since ticket b2e88390, the only surface
 * that can flip `pending_user_action` true → false is the human-session-gated
 * REST `PATCH /api/tickets/:id` (MCP `unpend_ticket` and an MCP
 * `update_ticket` false-flip both reject unconditionally) — so an
 * ActivityLog row with `field_changed='pending_user_action'`,
 * `new_value='false'` is a reliable proxy for "a person looked at this and
 * cleared it". Without anchoring to that epoch, a breach's auto-pend would
 * be immediately re-tripped by the next agent comment/dispatch after a human
 * unpends — the counter never resets, so the ticket dies permanently the
 * moment it first crosses the ceiling.
 */
import type { DataSource } from 'typeorm';
import type { ActivityService } from '../services/activity.service';
import type { RoomMessagingService } from '../modules/chat-rooms/room-messaging.service';
import { ActivityLog } from '../entities/ActivityLog';
import { Board } from '../entities/Board';
import { BoardColumn } from '../entities/BoardColumn';
import { ChatRoom } from '../entities/ChatRoom';
import { Comment } from '../entities/Comment';
import { Subagent } from '../entities/Subagent';
import { Ticket } from '../entities/Ticket';
import { Workspace } from '../entities/Workspace';
import {
  ResolvedHardBudget,
  hardBudgetDefaultsFromEnv,
  resolveHardBudgetConfig,
} from './hard-budget-config';

export interface HardBudgetLogger {
  warn(category: string, message: string, meta?: Record<string, unknown>): void;
}

export interface HardBudgetGuardDeps {
  dataSource: DataSource;
  activityService: ActivityService;
  /** Optional — a caller without chat-room access (e.g. standalone MCP) just skips notify. */
  roomMessagingService?: RoomMessagingService | null;
  /** Optional — used only to log a fail-open catch; a missing logger just stays silent. */
  logger?: HardBudgetLogger | null;
}

/**
 * Walk a ticket up to the nearest ancestor carrying a column_id (subtasks
 * have column_id=null) and resolve that column's board. Mirrors the
 * `resolveBoardId` helper inlined in tickets.controller.ts's REST addComment.
 */
export async function resolveTicketBoardId(dataSource: DataSource, ticket: Ticket): Promise<string | null> {
  let cursor: Ticket | null = ticket;
  while (cursor && !cursor.column_id && cursor.parent_id) {
    cursor = await dataSource.getRepository(Ticket).findOne({ where: { id: cursor.parent_id } });
  }
  if (!cursor?.column_id) return null;
  const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: cursor.column_id } });
  return col?.board_id || null;
}

/** Resolve the effective hard-budget config for a ticket (board override, folded onto the env baseline). */
export async function resolveHardBudgetForTicket(
  dataSource: DataSource,
  ticket: Ticket,
): Promise<ResolvedHardBudget> {
  const boardId = await resolveTicketBoardId(dataSource, ticket);
  const board = boardId ? await dataSource.getRepository(Board).findOne({ where: { id: boardId } }) : null;
  return resolveHardBudgetConfig(board?.hard_budget_config ?? null, hardBudgetDefaultsFromEnv());
}

/**
 * Latest human-driven unpend timestamp for a ticket, or null if it was never
 * unpended (count from the beginning of the ticket's life in that case).
 */
export async function lastHumanUnpendAt(dataSource: DataSource, ticketId: string): Promise<Date | null> {
  const row = await dataSource.getRepository(ActivityLog).createQueryBuilder('a')
    .where('a.ticket_id = :tid', { tid: ticketId })
    .andWhere("a.field_changed = 'pending_user_action'")
    .andWhere("a.new_value = 'false'")
    .orderBy('a.created_at', 'DESC')
    .limit(1)
    .getOne();
  return row?.created_at ? new Date(row.created_at) : null;
}

/**
 * (a) Lifetime count of agent-authored, non-system comments on a ticket
 * since `since`.
 *
 * DELIBERATELY NOT "fixed" for sql.js same-second precision (ticket 8fc94adf
 * investigated this): sql.js's DB-level `datetime('now')` default (used
 * whenever a Comment is saved without an explicit `created_at`) has no
 * fractional seconds, while a bound `Date` parameter always does, so
 * `created_at >= :since` lexicographically excludes any row landing in the
 * same wall-clock second as `since` — same wall-clock second as `since` is
 * ALWAYS treated as "before" regardless of the real sub-second order.
 *
 * For every OTHER consumer of this pattern that would be a pure under-count
 * (safe: see created-at-since-param.ts). But `since` here is
 * `lastHumanUnpendAt` — the epoch a human unpend resets the ceiling to (see
 * file header) — and this function's whole reason to exist is guaranteeing
 * old, already-counted comments from BEFORE that epoch never leak into the
 * post-unpend count. The current same-second exclusion is exactly the
 * property that guarantee needs: a comment stored in the same truncated
 * second as the unpend epoch is (correctly, for this purpose) treated as
 * pre-epoch. Making the comparison same-second-inclusive (which is what a
 * naive "fix" would do) reopens the exact permanent-death loop ticket
 * a940d75b closed — pinned by hard-budget-guard.test.mjs's "a human unpend
 * actually clears the ceiling" test, which fails under an inclusive
 * comparison. Do not apply `sinceBoundaryParam` here.
 */
export async function countAutoResponses(dataSource: DataSource, ticketId: string, since: Date): Promise<number> {
  return dataSource.getRepository(Comment).createQueryBuilder('c')
    .where('c.ticket_id = :tid', { tid: ticketId })
    .andWhere("c.author_type = 'agent'")
    .andWhere("c.type != 'system'")
    .andWhere('c.created_at >= :since', { since })
    .getCount();
}

/**
 * (c) Successful-dispatch count inside the window, sourced from the EXISTING
 * `trigger_emitted` ActivityLog row every `_emitTrigger` success already
 * writes (ticket 4a6cdfd7 acceptance #8) — no new observability write.
 * `manual` (explicit human/operator request) and `comment_summary` (does not
 * advance the workflow; already bypasses the ticket-pending gate) are
 * excluded so they can't be blocked by — or count toward — this ceiling.
 */
// Same sql.js same-second exclusion as countAutoResponses above, and same
// reason it is left as-is: trigger-loop.service.ts anchors `since` to
// `max(lastHumanUnpendAt, windowStart)`, so this is epoch-anchored too —
// making the comparison same-second-inclusive would let pre-unpend dispatches
// leak back into the post-unpend window count. See countAutoResponses' doc
// comment for the full rationale (ticket 8fc94adf).
export async function countWindowDispatches(dataSource: DataSource, ticketId: string, since: Date): Promise<number> {
  return dataSource.getRepository(ActivityLog).createQueryBuilder('a')
    .where('a.ticket_id = :tid', { tid: ticketId })
    .andWhere("a.action = 'trigger_emitted'")
    .andWhere('a.trigger_source NOT IN (:...excluded)', { excluded: ['manual', 'comment_summary'] })
    .andWhere('a.created_at >= :since', { since })
    .getCount();
}

/**
 * (b) Summed input+output tokens inside the window, sourced from the
 * `subagents` table's usage columns (ticket 6dd3f968 — populated on the
 * agent-manager's `end` POST). Deliberately sums only `input_tokens` +
 * `output_tokens`, NOT `cache_read_input_tokens`/`cache_creation_input_tokens`:
 * a cache read is cheap reuse of already-processed context, not fresh
 * consumption, and folding it in at full weight would make a long, WELL-
 * cached session (cheap, not a problem) look just as "over budget" as an
 * uncached one that reprocesses the same context at full price every turn
 * (the actual failure mode this ceiling exists to catch). This is a token-
 * COUNT ceiling, not a dollar-cost one — see AgentUsageService/`bb2794cb` for
 * pricing-aware cost estimation, out of scope here.
 *
 * A CLI whose adapter never populates usage (Antigravity, or any manager
 * build predating ticket 6dd3f968) leaves both columns NULL on its
 * `subagents` row — SQL SUM ignores NULL, so those dispatches fall out of
 * the sum entirely rather than contributing 0 (ticket ef53fdf4's "특정 CLI가
 * usage를 노출하지 않으면 해당 CLI의 dispatch는 토큰 카운트에서 자연 제외"
 * requirement, satisfied for free by SUM's NULL handling — no CLI allowlist
 * needed here).
 *
 * `since` is filtered against `started_at` (matching AgentUsageService's
 * windowing, not `ended_at` — usage lands on `end`, but a long-running
 * dispatch should count against the window it started in). Same sql.js
 * same-second exclusion / epoch-anchoring rationale as countWindowDispatches
 * above applies here too (`since` is `max(lastHumanUnpendAt, windowStart)`
 * in the caller) — do not "fix" this to be same-second-inclusive.
 *
 * pg returns SUM over an int column as a STRING (bigint precision safety)
 * while sql.js returns a plain number — `Number()` coerces both uniformly,
 * same pattern as AgentUsageService's `num()` helper.
 */
export async function countWindowTokens(dataSource: DataSource, ticketId: string, since: Date): Promise<number> {
  const row = await dataSource.getRepository(Subagent).createQueryBuilder('s')
    .select('COALESCE(SUM(s.input_tokens), 0)', 'input_tokens')
    .addSelect('COALESCE(SUM(s.output_tokens), 0)', 'output_tokens')
    .where('s.ticket_id = :tid', { tid: ticketId })
    .andWhere('s.started_at >= :since', { since })
    .getRawOne<{ input_tokens: string | number; output_tokens: string | number }>();
  return Number(row?.input_tokens ?? 0) + Number(row?.output_tokens ?? 0);
}

/**
 * Atomically flip pending_user_action false → true (CAS via the WHERE
 * clause, same pattern as the existing agent-comment-pingpong guard's pend()
 * callback) and write the audit row. Returns false — a safe no-op — when the
 * ticket was already pending (someone else's concurrent breach, or an
 * unrelated pend already in effect), so callers never double-log.
 */
export async function pendTicketForHardBudget(
  dataSource: DataSource,
  activityService: ActivityService,
  ticket: Ticket,
  reason: string,
  pendSetBy: string,
): Promise<boolean> {
  const ticketRepo = dataSource.getRepository(Ticket);
  const pendingAt = new Date();
  const claimed = await ticketRepo.update(
    { id: ticket.id, pending_user_action: false },
    { pending_user_action: true, pending_reason: reason, pending_set_at: pendingAt, pending_set_by: pendSetBy },
  );
  ticket.pending_user_action = true;
  if (claimed.affected !== 1) return false;
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, action: 'updated', ticket_id: ticket.id,
    field_changed: 'pending_user_action', old_value: 'false', new_value: 'true',
    actor_id: 'system', actor_name: pendSetBy,
  });
  return true;
}

/** Configured alerts room → oldest room in the workspace. Mirrors RespawnStormDetectorService's resolution. */
async function resolveAlertRoomId(dataSource: DataSource, workspaceId: string): Promise<string | null> {
  if (!workspaceId) return null;
  const ws = await dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
  const roomRepo = dataSource.getRepository(ChatRoom);
  if (ws?.alerts_chat_room_id) {
    const configured = await roomRepo.findOne({ where: { id: ws.alerts_chat_room_id, workspace_id: workspaceId } });
    if (configured) return configured.id;
  }
  const fallback = await roomRepo.createQueryBuilder('r')
    .where('r.workspace_id = :wsId', { wsId: workspaceId })
    .orderBy('r.created_at', 'ASC')
    .limit(1)
    .getOne();
  return fallback?.id ?? null;
}

/** Best-effort chat alert — never throws, never blocks the caller's guard decision. */
export async function postHardBudgetAlert(
  deps: HardBudgetGuardDeps,
  ticket: Ticket,
  content: string,
): Promise<void> {
  if (!deps.roomMessagingService) return;
  try {
    const roomId = await resolveAlertRoomId(deps.dataSource, ticket.workspace_id);
    if (!roomId) return;
    await deps.roomMessagingService.sendSystemMessage(roomId, ticket.workspace_id, content);
  } catch (e) {
    // Notification is advisory — a failed post must never surface as a guard error.
    deps.logger?.warn('HardBudget', 'alert post failed (non-fatal)', { err: String(e), ticket_id: ticket.id });
  }
}

/**
 * (a) Entry point for every comment-creation surface. Call BEFORE saving an
 * agent-authored comment; when `blocked` is true the caller must skip the
 * save entirely (mirrors the existing ping-pong guard's suppress contract —
 * never throw, just report back so the tool returns `{ suppressed: true }`).
 *
 * Idempotent under concurrency: `pendTicketForHardBudget`'s CAS means two
 * racing over-budget comments both compute `blocked: true`, but only the
 * first to reach the UPDATE actually flips + audits the pend — the loser's
 * comment is still correctly blocked, just without a duplicate audit row.
 *
 * Availability-first: any unexpected failure evaluating the ceiling (a
 * transient DB error, an unusual ticket shape) degrades to `{ blocked: false }`
 * rather than throwing — the same posture the rest of this codebase's
 * safety-net checks take (respawn-storm sweep, merge-gate resolution). A
 * broken safety net must never be able to block a legitimate agent comment.
 */
export async function enforceAutoResponseBudget(
  deps: HardBudgetGuardDeps,
  ticket: Ticket,
): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const cfg = await resolveHardBudgetForTicket(deps.dataSource, ticket);
    if (!cfg.enabled) return { blocked: false };

    const epoch = await lastHumanUnpendAt(deps.dataSource, ticket.id);
    const since = epoch ?? new Date(0);
    const count = await countAutoResponses(deps.dataSource, ticket.id, since);
    if (count < cfg.maxAutoResponses) return { blocked: false };

    const reason =
      `이 티켓의 자동 응답 수가 하드 상한(${cfg.maxAutoResponses}건)을 초과해 자동 중지되었습니다. ` +
      `내용을 확인한 뒤 pending을 해제하세요.`;
    if (cfg.autoPend) {
      await pendTicketForHardBudget(deps.dataSource, deps.activityService, ticket, reason, 'hard_budget_response_guard');
    }
    if (cfg.notify) {
      await postHardBudgetAlert(deps, ticket, [
        `🚦 **Hard budget 초과 (자동 응답 수)** — \`${ticket.id}\``,
        `**${ticket.title}**`,
        `누적 자동 응답: ${count}건 이상 (상한 ${cfg.maxAutoResponses})`,
        cfg.autoPend ? '티켓 자동 pend됨 — 사람이 해제하기 전까지 추가 트리거가 차단됩니다.' : 'notify-only (auto-pend off for this board).',
      ].join('\n\n'));
    }
    return { blocked: true, reason: 'max_auto_responses_exceeded' };
  } catch (e) {
    deps.logger?.warn('HardBudget', 'enforceAutoResponseBudget failed (fail-open, comment allowed)', {
      err: String(e), ticket_id: ticket.id,
    });
    return { blocked: false };
  }
}

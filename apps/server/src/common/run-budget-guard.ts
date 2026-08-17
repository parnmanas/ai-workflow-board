/**
 * Run-creation-rate guard shared by the QA/Action/Orchestration run-dispatch
 * chokepoints (ticket a51ec6d9). Companion to hard-budget-guard.ts's
 * per-ticket ceilings, but a different scope axis: QaRun/ActionRun/
 * OrchestrationMission are not Tickets — no ticket_id, and (per
 * docs/catalog-scopes.md) no board_id either — so there is nothing to pend
 * and no board to resolve config from. This module instead counts NEW-RUN
 * creations inside a rolling window, scoped to the WORKSPACE
 * (`Workspace.hard_budget_config`'s `max_runs_per_window` key,
 * common/hard-budget-config.ts's (d) axis) and independently per run type
 * (a QA storm must not starve Action, and vice versa).
 *
 * Violation handling is CREATION-TIME REJECTION (`RunBudgetExceededError`,
 * status 429) — not pend/pause. A window-based rate cap self-heals as time
 * passes ("wait and it clears" is the escape hatch), which matters because
 * reaper coverage differs per run type: QA sweeps every non-terminal run
 * (qa-run-reaper.service.ts), Action has no stuck-run reaper at all, and
 * Orchestration has a mission-level blind spot (tracked separately, ticket
 * 954259e6) — an "open count" ceiling would risk a PERMANENT lock on the
 * uncovered two; a "creations in the last N minutes" ceiling never does,
 * since it only ever looks backward from now.
 *
 * Called at the HEAD of each of the three run-dispatch chokepoints —
 * qa-run.service.ts startQaRun, actions.service.ts dispatch,
 * orchestration-mission.service.ts createMission — before any side effect
 * (ChatRoom creation, run-row save). See run-budget-dispatch-gate.test.mjs
 * for the static call-site/ordering guard pinning that placement.
 */
import type { DataSource, Repository } from 'typeorm';
import { OrchestrationMission } from '../entities/OrchestrationMission';
import { QaRun } from '../entities/QaRun';
import { ActionRun } from '../entities/ActionRun';
import { Workspace } from '../entities/Workspace';
import { ChatRoom } from '../entities/ChatRoom';
import type { RoomMessagingService } from '../modules/chat-rooms/room-messaging.service';
import { ResolvedHardBudget, hardBudgetDefaultsFromEnv, resolveHardBudgetConfig } from './hard-budget-config';

export type RunBudgetKind = 'qa' | 'action' | 'orchestration';

export interface RunBudgetLogger {
  warn(category: string, message: string, meta?: Record<string, unknown>): void;
}

export interface RunBudgetGuardDeps {
  dataSource: DataSource;
  /** Optional — a caller without chat-room access just skips notify. */
  roomMessagingService?: RoomMessagingService | null;
  /** Optional — used only to log a fail-open catch / a confirmed breach; a missing logger just stays silent. */
  logger?: RunBudgetLogger | null;
}

/** Minimal shape every run-kind entity has: workspace scope + creation timestamp. */
interface RunRow {
  workspace_id: string;
  created_at: Date;
}

function runRepo(dataSource: DataSource, kind: RunBudgetKind): Repository<RunRow> {
  switch (kind) {
    case 'qa': return dataSource.getRepository(QaRun) as unknown as Repository<RunRow>;
    case 'action': return dataSource.getRepository(ActionRun) as unknown as Repository<RunRow>;
    case 'orchestration': return dataSource.getRepository(OrchestrationMission) as unknown as Repository<RunRow>;
  }
}

/**
 * Resolve the effective run-budget config for a workspace: workspace
 * override folded onto the env baseline. No board layer (see file header) —
 * this is deliberately NOT `resolveHardBudgetForTicket`'s board→env chain,
 * because none of the three run entities carry a board_id to resolve one
 * from, and using the ticket-scoped board layer here would let a config
 * interpreted at one scope be counted at another (the exact mismatch the
 * ticket a51ec6d9 plan calls out and rejects).
 */
export async function resolveHardBudgetForWorkspace(
  dataSource: DataSource,
  workspaceId: string,
): Promise<ResolvedHardBudget> {
  const ws = workspaceId
    ? await dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } })
    : null;
  return resolveHardBudgetConfig(ws?.hard_budget_config ?? null, hardBudgetDefaultsFromEnv());
}

/** Count of `kind` runs created in `workspaceId` at/after `since`. */
export async function countRunsInWindow(
  dataSource: DataSource,
  kind: RunBudgetKind,
  workspaceId: string,
  since: Date,
): Promise<number> {
  return runRepo(dataSource, kind).createQueryBuilder('r')
    .where('r.workspace_id = :wsId', { wsId: workspaceId })
    .andWhere('r.created_at >= :since', { since })
    .getCount();
}

/**
 * Creation time of the oldest `kind` run at/after `since` — the moment the
 * window will next shrink. Deliberately reads a full entity (`getOne`) sorted
 * ascending rather than a raw `MIN(created_at)` aggregate: a raw driver value
 * re-parsed with `new Date(str)` is ambiguous for sql.js's naive (no
 * timezone-suffix) datetime strings — the ECMAScript Date Time String format
 * treats those as LOCAL time, which silently drifted this by the host's UTC
 * offset in dev. Going through the entity's normal column-hydration path
 * instead reuses the SAME driver-level Date transformer every other read in
 * this codebase already relies on (matches `run.created_at` on a freshly-
 * saved entity, and is dialect-consistent with Postgres in production).
 */
async function oldestRunAt(
  dataSource: DataSource,
  kind: RunBudgetKind,
  workspaceId: string,
  since: Date,
): Promise<Date | null> {
  const oldest = await runRepo(dataSource, kind).createQueryBuilder('r')
    .where('r.workspace_id = :wsId', { wsId: workspaceId })
    .andWhere('r.created_at >= :since', { since })
    .orderBy('r.created_at', 'ASC')
    .limit(1)
    .getOne();
  return oldest?.created_at ?? null;
}

/** Configured alerts room → oldest room in the workspace. Mirrors hard-budget-guard.ts's resolveAlertRoomId. */
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

/** Best-effort chat alert — never throws, never blocks the caller. Workspace-scoped analogue of hard-budget-guard.ts's postHardBudgetAlert (no ticket to hang the alert off of here). */
export async function postRunBudgetAlert(
  deps: RunBudgetGuardDeps,
  workspaceId: string,
  content: string,
): Promise<void> {
  if (!deps.roomMessagingService) return;
  try {
    const roomId = await resolveAlertRoomId(deps.dataSource, workspaceId);
    if (!roomId) return;
    await deps.roomMessagingService.sendSystemMessage(roomId, workspaceId, content);
  } catch (e) {
    deps.logger?.warn('HardBudget', 'run-budget alert post failed (non-fatal)', { err: String(e), workspace_id: workspaceId });
  }
}

/** Thrown by `enforceRunBudget` on a confirmed breach. `status = 429` so every REST/MCP error surface that already special-cases `err.status` renders it correctly. */
export class RunBudgetExceededError extends Error {
  status = 429;
  constructor(
    public readonly kind: RunBudgetKind,
    public readonly workspaceId: string,
    public readonly count: number,
    public readonly limit: number,
    public readonly windowMinutes: number,
    public readonly retryAt: Date,
  ) {
    super(
      `${kind} run budget exceeded for workspace ${workspaceId}: ${count}/${limit} runs started in the last ${windowMinutes} minute(s). ` +
      `Earliest retry: ${retryAt.toISOString()}.`,
    );
    this.name = 'RunBudgetExceededError';
  }
}

/**
 * Entry point for the run-dispatch chokepoints. Call at the HEAD of the
 * function, before any side effect (ChatRoom creation, run-row save) — see
 * hard-budget-dispatch-gate.test.mjs's static-guard pattern, mirrored for
 * these call sites in run-budget-dispatch-gate.test.mjs. Throws
 * `RunBudgetExceededError` on a confirmed breach; callers let it propagate
 * (same `makeError(...)`-and-throw convention every other dispatch guard in
 * these services already uses) so REST/MCP/scheduler/retry/rerun-on-fix
 * callers all see one consistent error shape — including
 * ActionsService.completeRun's bounded retry, which calls `dispatch()`
 * inside a try/catch and treats a thrown retry as exhaustion (no separate
 * retry-bypass flag needed, ticket a51ec6d9 plan "정정 2").
 *
 * Fail-open (same posture as enforceAutoResponseBudget /
 * _checkHardBudgetGate): a failure evaluating the ceiling itself (config
 * resolution, count query) must never block a legitimate run. Once a breach
 * is CONFIRMED, though, the reject is unconditional — unlike the ticket-scoped
 * gate's auto-pend write, there is no further fallible side effect the
 * rejection itself depends on (notify is best-effort and never throws).
 */
export async function enforceRunBudget(
  deps: RunBudgetGuardDeps,
  kind: RunBudgetKind,
  workspaceId: string,
): Promise<void> {
  let breach: { count: number; cfg: ResolvedHardBudget; windowMin: number; since: Date } | null = null;
  try {
    const cfg = await resolveHardBudgetForWorkspace(deps.dataSource, workspaceId);
    if (!cfg.enabled) return;

    const now = new Date();
    const since = new Date(now.getTime() - cfg.windowMs);
    const count = await countRunsInWindow(deps.dataSource, kind, workspaceId, since);
    if (count < cfg.maxRunsPerWindow) return;

    breach = { count, cfg, windowMin: Math.round(cfg.windowMs / 60_000), since };
  } catch (e) {
    deps.logger?.warn('HardBudget', 'run-budget evaluation failed (fail-open, run allowed)', {
      err: String(e), workspace_id: workspaceId, kind,
    });
    return;
  }

  const { count, cfg, windowMin, since } = breach;
  const oldest = await oldestRunAt(deps.dataSource, kind, workspaceId, since).catch(() => null);
  const retryAt = new Date((oldest ?? new Date()).getTime() + cfg.windowMs);

  deps.logger?.warn('HardBudget', `run budget exceeded — ${kind} run rejected`, {
    workspace_id: workspaceId, kind, count, limit: cfg.maxRunsPerWindow, window_minutes: windowMin,
  });
  if (cfg.notify) {
    await postRunBudgetAlert(deps, workspaceId, [
      `🚦 **Hard budget 초과 (run 생성 빈도)** — kind=\`${kind}\``,
      `워크스페이스: \`${workspaceId}\``,
      `누적 생성: ${count}건 / ${windowMin}분 (상한 ${cfg.maxRunsPerWindow})`,
      `가장 이른 재시도 가능 시각: ${retryAt.toISOString()}`,
    ].join('\n\n'));
  }
  throw new RunBudgetExceededError(kind, workspaceId, count, cfg.maxRunsPerWindow, windowMin, retryAt);
}

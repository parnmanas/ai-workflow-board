// On-failure auto-ticket policy ⇄ editor form (docs/tickets.md → QA / Security
// failure tickets). Shared by the QA scenario editor and the Security profile
// editor. React-free so `node --test` imports it directly
// (test/on-failure-ticket-form.test.mjs).
//
// The ticket lands in the workspace pool — no board / column any more. The
// editor owns `project_id`, `status`, `tags`, `priority`, `dedupe` and
// `assignee_runtime`; scenario/profile-specific knobs (QA rerun loop, Security
// min_severity) are layered on top by each editor. Keys the editor does not
// show (e.g. `title_template`) are carried over from the stored config so a
// save never silently drops them — except the retired board-era keys, which
// are always stripped, and `labels`, which is read as a fallback for `tags`
// but never written back.

import type { OnFailureTicketStatus, TicketPriority } from '../../types';
import { TICKET_PRIORITIES } from '../../tickets/status';

export const ON_FAILURE_TICKET_STATUSES: readonly OnFailureTicketStatus[] = ['todo', 'backlog'];
export const DEFAULT_ON_FAILURE_TICKET_STATUS: OnFailureTicketStatus = 'todo';
export const DEFAULT_ON_FAILURE_TICKET_PRIORITY: TicketPriority = 'high';

export type OnFailureTicketDedupe = 'per_run' | 'per_open_ticket';

/** Board-era keys a stored config may still carry. Never sent back. */
export const RETIRED_ON_FAILURE_TICKET_KEYS = [
  'board_id',
  'column_id',
  'column_name',
  'assignee_id',
  'labels',
] as const;

export interface OnFailureTicketForm {
  enabled: boolean;
  /** '' = no project. */
  projectId: string;
  status: OnFailureTicketStatus;
  priority: TicketPriority;
  dedupe: OnFailureTicketDedupe;
  /** Edited with the shared <TagInput> (common/TagInput.tsx). */
  tags: string[];
  /** null = fall back to the scenario/profile target, then the project's default_assignee. */
  assigneeRuntime: Record<string, any> | null;
}

/** Common shape of the stored QA / Security on_failure_ticket configs. */
export interface StoredOnFailureTicket {
  enabled?: boolean;
  project_id?: string | null;
  status?: string | null;
  priority?: string | null;
  dedupe?: string | null;
  tags?: unknown;
  labels?: unknown;
  assignee_runtime?: Record<string, any> | null;
}

function cleanTag(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

/** Trimmed, non-empty, case-insensitively de-duplicated (first spelling wins). */
export function normalizeTags(list: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const tag = cleanTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** `tags`, else the legacy `labels` key (rows written before the board removal). */
export function readOnFailureTicketTags(cfg: StoredOnFailureTicket | null | undefined): string[] {
  if (!cfg) return [];
  if (Array.isArray(cfg.tags)) return normalizeTags(cfg.tags);
  if (Array.isArray(cfg.labels)) return normalizeTags(cfg.labels);
  return [];
}

function isStatus(v: unknown): v is OnFailureTicketStatus {
  return typeof v === 'string' && (ON_FAILURE_TICKET_STATUSES as readonly string[]).includes(v);
}

function isPriority(v: unknown): v is TicketPriority {
  return typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v);
}

export function onFailureTicketToForm(cfg: StoredOnFailureTicket | null | undefined): OnFailureTicketForm {
  return {
    enabled: !!cfg?.enabled,
    projectId: typeof cfg?.project_id === 'string' ? cfg.project_id : '',
    status: isStatus(cfg?.status) ? cfg!.status as OnFailureTicketStatus : DEFAULT_ON_FAILURE_TICKET_STATUS,
    priority: isPriority(cfg?.priority) ? cfg!.priority as TicketPriority : DEFAULT_ON_FAILURE_TICKET_PRIORITY,
    dedupe: cfg?.dedupe === 'per_open_ticket' ? 'per_open_ticket' : 'per_run',
    tags: readOnFailureTicketTags(cfg),
    assigneeRuntime: cfg?.assignee_runtime && typeof cfg.assignee_runtime === 'object' ? cfg.assignee_runtime : null,
  };
}

export interface OnFailureTicketPayload {
  enabled: boolean;
  project_id?: string;
  status?: OnFailureTicketStatus;
  priority?: TicketPriority;
  dedupe?: OnFailureTicketDedupe;
  tags?: string[];
  assignee_runtime?: Record<string, any>;
  [key: string]: unknown;
}

/**
 * Build the on_failure_ticket body from the form.
 *
 * - Disabled → an explicit `{ enabled: false }` so a stored policy is turned
 *   off rather than left untouched.
 * - Enabled → the stored config minus retired board-era keys, overlaid with the
 *   editor-owned fields. A cleared project / tag list / runtime is removed, not
 *   sent blank: no tags means "server default tags", no runtime means "target
 *   → project default_assignee".
 */
export function onFailureTicketFromForm(
  form: OnFailureTicketForm,
  stored?: StoredOnFailureTicket | null,
): OnFailureTicketPayload {
  if (!form.enabled) return { enabled: false };
  const out: OnFailureTicketPayload = { enabled: true };
  for (const [key, value] of Object.entries((stored || {}) as Record<string, unknown>)) {
    if ((RETIRED_ON_FAILURE_TICKET_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  out.enabled = true;
  out.status = form.status;
  out.priority = form.priority;
  out.dedupe = form.dedupe;

  const projectId = form.projectId.trim();
  if (projectId) out.project_id = projectId;
  else delete out.project_id;

  const tags = normalizeTags(form.tags);
  if (tags.length) out.tags = tags;
  else delete out.tags;

  if (form.assigneeRuntime) out.assignee_runtime = form.assigneeRuntime;
  else delete out.assignee_runtime;

  return out;
}

export interface ProjectOption {
  value: string;
  label: string;
}

/**
 * Options for the project select. '' = no project. A stored id that is not in
 * the loaded list (deleted project, list still loading) stays selectable as an
 * explicit "unknown" row instead of silently snapping to "none".
 */
export function projectSelectOptions(
  projects: ReadonlyArray<{ id: string; name: string }>,
  currentId: string,
  noneLabel: string,
): ProjectOption[] {
  const options: ProjectOption[] = [{ value: '', label: noneLabel }];
  for (const p of projects) options.push({ value: p.id, label: p.name || p.id });
  if (currentId && !projects.some((p) => p.id === currentId)) {
    options.push({ value: currentId, label: `알 수 없는 프로젝트 (${currentId.slice(0, 8)}…)` });
  }
  return options;
}

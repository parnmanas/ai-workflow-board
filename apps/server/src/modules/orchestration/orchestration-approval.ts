/**
 * Mission tool approvals — the rules, without the database (docs/orchestration.md → "실행 승인").
 *
 * A mission runtime whose slot runs at `approve` trust asks before using a gated tool. Who
 * answers is decided here, once, from the frozen roster:
 *
 *   member asks  + orchestrator `trusted` → the orchestrator decides
 *   member asks  + orchestrator not `trusted` → the user decides
 *   orchestrator asks                       → the user decides (nobody approves their own request)
 *
 * The orchestrator may also hand a request to the user (`escalate`), and a request it leaves
 * unanswered past the answer window goes to the user on its own — a member must never stay
 * blocked because the orchestrator is busy or gone.
 */

import { parseTeamAgentSpec } from '../../common/orchestration-member-spec';
import { readRuntimeRoster } from './orchestration-roster';

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What a decider can answer. `allow_session` also lets the CLI remember the rule for its session. */
export const APPROVAL_DECISIONS = ['allow', 'allow_session', 'deny'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** The orchestrator may additionally hand the request to the user. */
export const ORCHESTRATOR_APPROVAL_DECISIONS = [...APPROVAL_DECISIONS, 'escalate'] as const;
export type OrchestratorApprovalDecision = (typeof ORCHESTRATOR_APPROVAL_DECISIONS)[number];

export type ApprovalRoute = 'orchestrator' | 'user';
export type ApprovalRequesterRole = 'member' | 'orchestrator';

/** Why a request sits with whoever has it — stored on the row, shown in the UI. */
export type ApprovalRouteReason =
  | 'orchestrator_trusted'
  | 'orchestrator_not_trusted'
  | 'orchestrator_request'
  | 'orchestrator_escalated'
  | 'orchestrator_timeout'
  | 'orchestrator_unreachable';

/** One long-poll holds at most this long — under any proxy's idle cut (Cloudflare: 100s). */
export const APPROVAL_WAIT_MAX_MS = 25_000;

/**
 * A pending request nobody polled for this long has lost its requester (process exited, host
 * offline). The manager polls back-to-back, so three minutes is many missed polls, not a hiccup.
 */
export const APPROVAL_REQUESTER_GONE_MS = 3 * 60_000;

/** How long the orchestrator has before a request moves to the user on its own. */
export function orchestratorAnswerWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ORCHESTRATION_APPROVAL_ESCALATE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 60_000;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

export function isOrchestratorApprovalDecision(value: unknown): value is OrchestratorApprovalDecision {
  return typeof value === 'string' && (ORCHESTRATOR_APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/**
 * The orchestrator slot's permission tier (`strict` | `approve` | `trusted`), or null when the
 * mission carries none. Reads the execution spec frozen at start first, then the roster — both
 * are written together, the fallback only covers rows from before the spec column.
 */
export function orchestratorTrust(mission: { orchestrator_spec?: unknown; runtime_roster?: unknown }): string | null {
  const spec = parseTeamAgentSpec(mission.orchestrator_spec as any);
  const fromSpec = spec?.runtime_config?.permission_mode;
  if (fromSpec) return fromSpec;
  const roster = readRuntimeRoster(mission.runtime_roster);
  return roster?.orchestrator?.spec?.runtime_config?.permission_mode ?? null;
}

/** Only an orchestrator that already acts without asking may approve for others. */
export function orchestratorMayApprove(mission: { orchestrator_spec?: unknown; runtime_roster?: unknown }): boolean {
  return orchestratorTrust(mission) === 'trusted';
}

export function approvalRouteFor(input: {
  requesterRole: ApprovalRequesterRole;
  orchestratorTrusted: boolean;
}): { route: ApprovalRoute; reason: ApprovalRouteReason } {
  if (input.requesterRole === 'orchestrator') return { route: 'user', reason: 'orchestrator_request' };
  return input.orchestratorTrusted
    ? { route: 'orchestrator', reason: 'orchestrator_trusted' }
    : { route: 'user', reason: 'orchestrator_not_trusted' };
}

/** Readable, bounded copy of a tool input. Display only — the CLI keeps the real input. */
export const APPROVAL_INPUT_MAX_CHARS = 8_000;

export function summarizeApprovalInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  if (text.length <= APPROVAL_INPUT_MAX_CHARS) return text;
  return `${text.slice(0, APPROVAL_INPUT_MAX_CHARS)}\n… (${text.length - APPROVAL_INPUT_MAX_CHARS} more characters)`;
}

/** The status a decision closes a request with. */
export function statusForDecision(decision: ApprovalDecision): ApprovalStatus {
  return decision === 'deny' ? 'denied' : 'approved';
}

/** What the waiting Runtime Host reads. `message` is handed to the CLI on a denial or cancel. */
export interface ApprovalWireView {
  id: string | null;
  status: ApprovalStatus;
  route: ApprovalRoute | null;
  decision: ApprovalDecision | null;
  message: string;
}

export function approvalWireView(row: {
  id: string;
  status: string;
  route: string;
  decision: string | null;
  decided_by_type?: string | null;
  decided_by_name?: string | null;
  decision_note?: string | null;
  route_reason?: string | null;
}): ApprovalWireView {
  const status = (APPROVAL_STATUSES as readonly string[]).includes(row.status) ? (row.status as ApprovalStatus) : 'pending';
  const decision = isApprovalDecision(row.decision) ? row.decision : null;
  return {
    id: row.id,
    status,
    route: row.route === 'orchestrator' || row.route === 'user' ? row.route : null,
    decision,
    message: approvalMessage(status, row),
  };
}

function approvalMessage(
  status: ApprovalStatus,
  row: { decided_by_type?: string | null; decided_by_name?: string | null; decision_note?: string | null; route_reason?: string | null },
): string {
  const who = row.decided_by_type === 'orchestrator'
    ? 'the mission orchestrator'
    : row.decided_by_type === 'user'
      ? (row.decided_by_name ? `the user (${row.decided_by_name})` : 'the user')
      : 'AWB';
  const note = String(row.decision_note || '').trim();
  if (status === 'denied') {
    return `Denied by ${who}.${note ? ` Reason: ${note}` : ''} Do not retry the same action; find another way or report the step as blocked.`;
  }
  if (status === 'cancelled') {
    return `The approval request was withdrawn${note ? `: ${note}` : ''}. Do not retry the same action without a new reason.`;
  }
  if (status === 'approved') return `Approved by ${who}.${note ? ` Note: ${note}` : ''}`;
  return '';
}

/**
 * The message that wakes the orchestrator with a member's request. Posted into the mission room
 * like every other wake, so it reaches the orchestrator's CLI session as a normal turn.
 */
export function renderApprovalWakePrompt(input: {
  approvalId: string;
  memberName: string;
  stepKey: string;
  stepTitle: string;
  toolName: string;
  title: string;
  description: string;
  inputText: string;
  canAllowSession: boolean;
  answerWindowMs: number;
}): string {
  const minutes = Math.max(1, Math.round(input.answerWindowMs / 60_000));
  const lines = [
    `## Approval request — ${input.memberName} on step \`${input.stepKey}\``,
    '',
    `The member working on "${input.stepTitle}" wants to use **${input.toolName}** and is blocked until someone answers.`,
    'You are the mission orchestrator with trusted permissions, so you decide for it.',
  ];
  if (input.title.trim() && input.title.trim() !== input.toolName) lines.push('', `**Request:** ${input.title.trim()}`);
  if (input.description.trim()) lines.push('', `**Why:** ${input.description.trim()}`);
  if (input.inputText.trim()) lines.push('', '**Input:**', '```', input.inputText.trim(), '```');
  lines.push(
    '',
    `Answer with \`decide_orchestration_approval\` (approval_id: \`${input.approvalId}\`):`,
    '- `allow` — run it this once.',
    input.canAllowSession
      ? '- `allow_session` — run it and stop asking for the same kind of action in this member session.'
      : '- `allow_session` — same as `allow` here (the CLI offered no rule to remember).',
    '- `deny` — refuse; put the reason in `reason`, the member reads it.',
    '- `escalate` — let the user decide. Escalate anything irreversible, destructive, outside the mission\'s scope, touching secrets or production, or that you are not sure about.',
    '',
    `Judge it against the mission brief and this step's work order. If you do not answer within ${minutes} minute(s), the request goes to the user.`,
  );
  return lines.join('\n');
}

/** Short line for the timeline and the user notice. */
export function describeApprovalRequest(row: { tool_name: string; title?: string | null }): string {
  const title = String(row.title || '').trim();
  return title && title !== row.tool_name ? `${row.tool_name} — ${title.slice(0, 200)}` : row.tool_name;
}

/** One row as the mission screen and the orchestrator read it. */
export interface ApprovalView {
  id: string;
  mission_id: string;
  step_id: string | null;
  step_key: string | null;
  requester_role: string;
  requester_agent_id: string;
  requester_name: string;
  tool_name: string;
  title: string;
  description: string;
  input: string;
  can_allow_session: boolean;
  status: string;
  route: string;
  route_reason: string;
  routed_at: Date;
  decision: string | null;
  decided_by_type: string | null;
  decided_by_name: string;
  decision_note: string;
  decided_at: Date | null;
  created_at: Date;
}

/** The stored columns `projectApproval` reads (the entity, or a raw row of it). */
export type ApprovalRowLike = Omit<ApprovalView, 'can_allow_session'> & { can_allow_session: boolean | number };

export function projectApproval(row: ApprovalRowLike): ApprovalView {
  return {
    id: row.id,
    mission_id: row.mission_id,
    step_id: row.step_id,
    step_key: row.step_key,
    requester_role: row.requester_role,
    requester_agent_id: row.requester_agent_id,
    requester_name: row.requester_name,
    tool_name: row.tool_name,
    title: row.title,
    description: row.description,
    input: row.input,
    can_allow_session: !!row.can_allow_session,
    status: row.status,
    route: row.route,
    route_reason: row.route_reason,
    routed_at: row.routed_at,
    decision: row.decision,
    decided_by_type: row.decided_by_type,
    decided_by_name: row.decided_by_name,
    decision_note: row.decision_note,
    decided_at: row.decided_at,
    created_at: row.created_at,
  };
}

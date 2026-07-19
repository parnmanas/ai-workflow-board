import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Ticket, Agent, Channel, ActivityLog, Comment, CommentType, User, TicketAttachmentMeta, Resource, RepoBranch, TicketPrerequisiteRow, Action, EffortPreset, EffortPresetsConfig, BUILTIN_EFFORT_PRESETS, HandoffSpec } from '../types';
import { api, TicketRoleAssignmentRow, ConsensusView, ConsensusParty, getActiveWorkspaceId, rawResourceUrl } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications } from '../contexts/NotificationContext';
import ChildTicketList from './SubtaskList';
import CommentList from './CommentList';
import HandoffEditor from './HandoffEditor';
import { TypingIndicator } from './TypingIndicator';
import { tokens } from '../tokens';
import { MentionTextarea, MentionCandidate } from './common/MentionTextarea';
import { ALL_COMMENT_TYPES, COMMENT_TYPE_STYLES, defaultVisibleTypes, resolveCommentType, hasStaleOpenQuestion } from './comment-types';
import { formatAgentDisplayName } from '../utils/agentName';
import { isCommentSummaryInProgress } from '../utils/commentSummary';

export interface WorkspaceRoleSummary {
  id: string; slug: string; name: string;
  description?: string; position: number; is_builtin: boolean;
  role_prompt?: string;
}

interface TicketPanelProps {
  ticket: Ticket;
  columnName: string;
  agents: Agent[];
  users?: User[];
  channels: Channel[];
  // The full workspace role catalog. Drives one row per role on the panel,
  // sorted by position. Empty array → fallback to the legacy hardcoded
  // assignee/reporter/reviewer trio so the panel stays usable in workspaces
  // without the v0.34 role catalog yet.
  workspaceRoles?: WorkspaceRoleSummary[];
  // Flat list of all root tickets on the board, used by the SubtaskList
  // "Link existing" picker. Optional so legacy callers don't break.
  boardTickets?: Ticket[];
  // The board's columns (id + name), used by the consensus move-proposal
  // picker (T6) to pick a target column. Optional so legacy callers don't break.
  boardColumns?: Array<{ id: string; name: string }>;
  typingIndicators: Record<string, string | null>;
  onClose: () => void;
  // May be sync or async — the Save/Discard footer awaits the result so the
  // button can show "Saving…" until the round trip completes.
  onUpdate: (id: string, data: Record<string, any>) => void | Promise<void>;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onDeleteChild: (childId: string) => void;
  // Adopt an existing ticket as a subtask of `parentId`. Distinct from
  // onCreateChild (which makes a new ticket).
  onReparentChild?: (parentId: string, childId: string) => void;
  // Set (or clear) the holder of a workspace role on this ticket. Mutually
  // exclusive agent_id / user_id; pass both null/'' to clear. Used by legacy
  // direct-write call sites (none currently inside the panel — Save batches
  // role drafts through onSaveDraft below).
  onSetRoleAssignment?: (ticketId: string, roleId: string, holder: { agent_id?: string | null; user_id?: string | null }) => void | Promise<void>;
  // Commit the buffered Save/Discard draft in one shot. MUST reject (throw)
  // on server failure — the footer relies on the rejection to preserve dirty
  // state so the user doesn't lose their unsaved edits behind a misleading
  // success toast. Falls back to per-field onUpdate if omitted (legacy
  // embedders). MULTI-HOLDER (T6): role edits are delivered as the T1
  // `role_assignments[]` array (repeated role_slug = multiple holders; a
  // role_slug with no holder clears the slot), saved atomically through the
  // ticket PATCH's role_assignments path.
  onSaveDraft?: (
    ticketId: string,
    ticketFields: Record<string, any>,
    roleAssignments: Array<{ role_slug: string; agent_id?: string; user_id?: string }>,
  ) => Promise<void>;
  onAddComment: (
    ticketId: string,
    content: string,
    attachments?: { file_name: string; file_mimetype: string; file_data: string }[],
    options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown>; attachment_resource_ids?: string[] },
  ) => void;
  onSetCommentStatus?: (ticketId: string, commentId: string, status: 'open' | 'resolved') => void;
  onSelectTicket?: (id: string) => void;
  // The board this panel is rendered on. Used to filter the destination
  // picker (you don't move a ticket to its own board) and to detect a
  // post-move panel close (the ticket is no longer on this board).
  currentBoardId?: string;
  // Workspace the current board lives in. Drives the board picker fetch —
  // we list boards in the same workspace only (the server rejects
  // cross-workspace moves anyway).
  workspaceId?: string;
  // The board's abstract effort presets (raw JSON string or parsed config, or
  // null). Drives the per-ticket effort-preset picker. null/empty falls back
  // to BUILTIN_EFFORT_PRESETS for display.
  effortPresets?: EffortPresetsConfig | string | null;
  // Move a root ticket to another board. Optional column id picks a specific
  // column on the target board; omit for the destination's first column.
  onMoveToBoard?: (ticketId: string, targetBoardId: string, opts?: { target_column_id?: string }) => void;
  // Mention deep-link target — when set, switch to the comments tab and
  // forward to CommentList for scroll-and-highlight. Parent clears it via
  // onScrollToCommentConsumed once the panel has acknowledged the request,
  // so reopening the same ticket later doesn't re-fire the highlight.
  scrollToCommentId?: string | null;
  onScrollToCommentConsumed?: () => void;
}

function findInTree(root: Ticket, id: string): Ticket | null {
  if (root.id === id) return root;
  for (const child of (root.children || [])) {
    const found = findInTree(child, id);
    if (found) return found;
  }
  return null;
}

// 클립보드 복사 헬퍼 — HTTPS 컨텍스트에선 navigator.clipboard 를 쓰고,
// 그것이 없는 비-HTTPS/구형 브라우저에선 execCommand fallback 으로 복사한다.
// 성공 여부를 boolean 으로 돌려줘 호출부가 성공/실패 피드백을 분기하게 한다.
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback 으로 진행 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const priorityColors: Record<string, string> = {
  // tag/label palette — not tokenized
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

// Multi-holder role draft (T6 다중담당자). Each entry pins exactly one of
// agent_id / user_id; a role's draft is its FULL desired holder set. The
// picker buffers these and Save flushes them as the T1 role_assignments[] array.
type HolderDraft = { agent_id: string | null; user_id: string | null };
// Normalize a holder to `agent:<id>` / `user:<id>` for set comparison + dedupe.
const holderDraftKey = (h: HolderDraft): string =>
  h.agent_id ? `agent:${h.agent_id}` : h.user_id ? `user:${h.user_id}` : '';
// A resolved holder (from a role-assignment row) → its draft shape.
const holderToDraft = (h: { type: 'agent' | 'user'; id: string }): HolderDraft =>
  h.type === 'agent' ? { agent_id: h.id, user_id: null } : { agent_id: null, user_id: h.id };

// Read path for the board's effort presets — degrade malformed/empty input to
// the builtins, never throw (mirrors the server READ contract). Accepts the
// raw JSON string the board ships or an already-parsed config.
function parseEffortPresetList(raw: EffortPresetsConfig | string | null | undefined): EffortPreset[] {
  if (!raw) return BUILTIN_EFFORT_PRESETS.presets;
  let cfg: any = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return BUILTIN_EFFORT_PRESETS.presets;
    try { cfg = JSON.parse(trimmed); } catch { return BUILTIN_EFFORT_PRESETS.presets; }
  }
  if (!cfg || !Array.isArray(cfg.presets) || cfg.presets.length === 0) {
    return BUILTIN_EFFORT_PRESETS.presets;
  }
  return cfg.presets.filter((p: any) => p && typeof p.id === 'string');
}

interface TriggerRoleTarget { slug: string; label: string; holderName: string; hasAgent: boolean }

interface MoveToBoardOption {
  id: string;
  name: string;
  columns: { id: string; name: string }[];
}

function MoveToBoardMenu({
  open, onClose, boards, busy, onPick, loading,
}: {
  open: boolean;
  onClose: () => void;
  boards: MoveToBoardOption[];
  busy: boolean;
  loading: boolean;
  onPick: (boardId: string, columnId?: string) => void;
}) {
  // Track which board row is expanded to show its column picker. Null means
  // every row is collapsed (default state on open). Click a board's chevron
  // to expand; click the row body or the "Move →" hint to move to its first
  // column without picking.
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setExpanded(null);
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 10 }}
      />
      <div
        style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          minWidth: 260,
          maxWidth: 320,
          maxHeight: 360,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          zIndex: 11,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '6px 10px',
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: tokens.colors.textMuted,
            borderBottom: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceSubtle,
            flexShrink: 0,
          }}
        >
          Move to board
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '12px', fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              Loading boards…
            </div>
          ) : boards.length === 0 ? (
            <div style={{ padding: '12px', fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              No other boards in this workspace
            </div>
          ) : boards.map((b, idx) => {
            const isExpanded = expanded === b.id;
            return (
              <div key={b.id} style={{
                borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
              }}>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 10px',
                    background: 'transparent',
                  }}
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { if (!busy) { onPick(b.id); onClose(); } }}
                    style={{
                      flex: 1,
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: 'transparent', border: 'none',
                      padding: 0,
                      color: tokens.colors.textStrong,
                      fontSize: '12px', fontWeight: 600,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      textAlign: 'left',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title="Move to this board's first column"
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(isExpanded ? null : b.id)}
                    style={{
                      background: 'transparent', border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.sm, padding: '2px 6px',
                      color: tokens.colors.textMuted, fontSize: '10px',
                      cursor: 'pointer',
                    }}
                    title="Pick a specific column"
                  >
                    {isExpanded ? '▾' : '▸'} column
                  </button>
                </div>
                {isExpanded && (
                  <div style={{
                    padding: '4px 10px 8px 18px',
                    display: 'flex', flexDirection: 'column', gap: 2,
                    background: tokens.colors.surface,
                  }}>
                    {b.columns.length === 0 ? (
                      <div style={{ fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic', padding: '4px 0' }}>
                        No columns
                      </div>
                    ) : b.columns.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={busy}
                        onClick={() => { if (!busy) { onPick(b.id, c.id); onClose(); } }}
                        style={{
                          background: 'transparent', border: 'none',
                          padding: '4px 6px',
                          color: tokens.colors.textSecondary,
                          fontSize: '11px',
                          cursor: busy ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                          borderRadius: tokens.radii.sm,
                        }}
                        onMouseEnter={e => { if (!busy) e.currentTarget.style.background = tokens.colors.surfaceSubtle; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        → {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TriggerMenu({
  open, onClose, roleTargets, busy, onPick,
}: {
  open: boolean;
  onClose: () => void;
  roleTargets: TriggerRoleTarget[];
  busy: Record<string, boolean>;
  onPick: (slug: string, label: string, holderName: string) => void;
}) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 10 }}
      />
      <div
        style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          minWidth: 200,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          zIndex: 11,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '6px 10px',
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: tokens.colors.textMuted,
            borderBottom: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceSubtle,
          }}
        >
          Trigger
        </div>
        {roleTargets.map(({ slug, label, holderName, hasAgent }, idx) => {
          const isBusy = !!busy[slug];
          const disabled = !hasAgent || isBusy;
          return (
            <button
              key={slug}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onPick(slug, label, holderName);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
                color: disabled ? tokens.colors.textMuted : tokens.colors.textStrong,
                fontSize: '12px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = tokens.colors.surfaceSubtle; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                {isBusy ? 'sending…' : hasAgent ? holderName : 'unassigned'}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Generous client-side ceiling for comment media — mirrors the server's 200MB
// raw-upload cap (main.ts). Anything larger gets a clear toast at pick time
// instead of a silent drop or a server round-trip that 413s (ticket ff3e7337).
const COMMENT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const MAX_COMMENT_ATTACHMENTS = 5;

// A comment attachment staged in the composer. Exactly one of `file` /
// `resourceId` is set: `file` is a fresh pick uploaded on Send; `resourceId`
// references an existing Resource. `previewUrl` is an object URL (for files) or
// the /raw streaming URL (for resources) used to render the thumbnail.
type StagedAttachment = {
  key: string;
  file_name: string;
  file_mimetype: string;
  previewUrl: string;
  file?: File;
  resourceId?: string;
};

// Modal that lists file-backed board/workspace Resources so a comment can
// reference one instead of re-uploading bytes (ticket ff3e7337 — the
// design-recommended "reference existing Resource" path).
function ResourceReferencePicker({
  loading, error, items, onPick, onClose,
}: {
  loading: boolean;
  error: string | null;
  items: Resource[];
  onPick: (r: Resource) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)', maxHeight: '70vh', overflow: 'auto',
          background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.lg, padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong style={{ color: tokens.colors.textStrong, fontSize: 14 }}>기존 리소스 첨부</strong>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 16,
          }}>{'✕'}</button>
        </div>
        {loading && <div style={{ color: tokens.colors.textMuted, fontSize: 12, padding: '12px 0' }}>불러오는 중…</div>}
        {error && <div style={{ color: tokens.colors.danger, fontSize: 12, padding: '12px 0' }}>{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div style={{ color: tokens.colors.textMuted, fontSize: 12, padding: '12px 0' }}>첨부할 수 있는 파일 리소스가 없습니다.</div>
        )}
        {!loading && !error && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {items.map((r) => {
              const mt = r.file_mimetype || '';
              const isImage = mt.startsWith('image/');
              const isVideo = mt.startsWith('video/');
              return (
                <button
                  key={r.id}
                  onClick={() => onPick(r)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                    background: 'transparent', border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md, cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  <span style={{
                    width: 40, height: 40, flexShrink: 0, borderRadius: tokens.radii.sm,
                    border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
                    background: isVideo ? '#000' : tokens.colors.surfaceCard,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                  }}>
                    {isImage
                      ? <img src={rawResourceUrl(r.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : isVideo ? <span>🎬</span> : <span>📎</span>}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', color: tokens.colors.textStrong, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.file_name || r.name}</span>
                    <span style={{ display: 'block', color: tokens.colors.textMuted, fontSize: 10 }}>{mt || r.type}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TicketPanel({
  ticket, columnName, agents, users, channels, workspaceRoles, boardTickets, boardColumns, typingIndicators,
  onClose, onUpdate, onDelete, onCreateChild, onDeleteChild, onReparentChild, onSetRoleAssignment, onSaveDraft, onAddComment, onSetCommentStatus, onSelectTicket,
  currentBoardId, workspaceId, effortPresets, onMoveToBoard,
  scrollToCommentId, onScrollToCommentConsumed,
}: TicketPanelProps) {
  // ─── Ticket role assignments ────────────────────────────
  // Per-ticket fetch — the board endpoint doesn't include assignments yet,
  // and we want fresh data on panel open. Refetch when the ticket id or
  // updated_at changes so a write through onSetRoleAssignment converges.
  const [roleAssignments, setRoleAssignments] = useState<TicketRoleAssignmentRow[]>([]);
  // Buffered role-assignment edits keyed by role id. Drains to the server on
  // Save (clearing matching keys); cleared wholesale on Discard / ticket
  // switch. MULTI-HOLDER (T6): each value is the role's FULL desired holder set
  // (add/remove chips mutate it); Save flushes it as role_assignments[].
  const [roleDrafts, setRoleDrafts] = useState<Record<string, HolderDraft[]>>({});
  // True while a Save round-trip is in flight — disables the Save/Discard
  // footer buttons and the role pickers so the user can't fire a second
  // commit before the first has resolved.
  const [savingDraft, setSavingDraft] = useState(false);

  // ─── 다중담당자·합의 (T6) ────────────────────────────────
  // 현재 합의 상태(역할홀더별 agree/pending/object) + 열린 이동 제안. root 티켓만
  // 대상 — 서버 REST 브릿지(getTicketConsensus)로 조회하고 consensus_update SSE +
  // updated_at 변화로 라이브 갱신한다.
  const [consensus, setConsensus] = useState<ConsensusView | null>(null);
  // propose / vote / override 요청 in-flight — 액션 버튼 중복 클릭 방지.
  const [consensusBusy, setConsensusBusy] = useState(false);
  // 이동 제안 대상 컬럼 id(제안 picker 버퍼).
  const [proposeTarget, setProposeTarget] = useState<string>('');
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  // Per-role in-flight state for the Re-trigger buttons — prevents
  // double-fires while the network round trip is pending.
  const [retriggering, setRetriggering] = useState<Record<string, boolean>>({});
  const [triggerMenuOpen, setTriggerMenuOpen] = useState(false);
  const [commentSummary, setCommentSummary] = useState<any>({ status: 'idle' });
  const [summaryStarting, setSummaryStarting] = useState(false);

  // "Move to board" picker state. Boards in the workspace are loaded lazily
  // on first menu open and cached for the panel's lifetime so re-opening the
  // menu is instant. The cache is keyed by workspace_id; if the active
  // ticket's workspace ever changes (it shouldn't on a single panel mount),
  // a refetch happens automatically.
  const [moveBoardMenuOpen, setMoveBoardMenuOpen] = useState(false);
  const [moveBoardOptions, setMoveBoardOptions] = useState<MoveToBoardOption[]>([]);
  const [moveBoardLoading, setMoveBoardLoading] = useState(false);
  const [moveBoardWorkspaceLoaded, setMoveBoardWorkspaceLoaded] = useState<string | null>(null);
  const [movingToBoard, setMovingToBoard] = useState(false);

  // Navigation stack: array of ticket IDs navigated within this panel
  const [navStack, setNavStack] = useState<string[]>([ticket.id]);

  // Reset navStack when root ticket changes
  useEffect(() => {
    setNavStack([ticket.id]);
  }, [ticket.id]);

  const activePanelId = navStack[navStack.length - 1];

  // Derive active ticket from the root ticket tree
  const activeTicket = findInTree(ticket, activePanelId) || ticket;

  const refreshCommentSummary = useCallback(async () => {
    try { setCommentSummary(await api.getCommentSummary(activePanelId)); } catch { /* retry on next poll */ }
  }, [activePanelId]);

  useEffect(() => { void refreshCommentSummary(); }, [refreshCommentSummary]);
  useEffect(() => {
    if (!isCommentSummaryInProgress(commentSummary?.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getCommentSummary(activePanelId);
        setCommentSummary(next);
        if (next.status === 'completed') window.location.reload();
      } catch { /* keep originals visible and poll again */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activePanelId, commentSummary?.status]);

  const handleStartCommentSummary = useCallback(async () => {
    if (summaryStarting || isCommentSummaryInProgress(commentSummary?.status)) return;
    const accepted = await confirm({
      title: 'Replace comments with a summary?',
      message: 'All existing comments will be replaced by one agent-generated summary after it succeeds. Originals remain unchanged if summarization fails.',
      confirmLabel: 'Summarize and replace',
      danger: true,
    });
    if (!accepted) return;
    setSummaryStarting(true);
    try {
      const run = await api.startCommentSummary(activePanelId);
      setCommentSummary(run);
      showToast(run.status === 'pending' ? 'Comment summary started' : 'Summary already in progress', 'success');
    } catch (e: any) {
      setCommentSummary({ status: 'failed', error: e?.message || 'Failed to start summary' });
      showToast(e?.message || 'Failed to start comment summary', 'error');
    } finally { setSummaryStarting(false); }
  }, [activePanelId, commentSummary?.status, confirm, showToast, summaryStarting]);

  // 헤더의 Ticket ID pill 클릭 → 현재 활성 티켓의 전체 ID 를 클립보드에 복사.
  // 성공 시 success toast + pill 을 잠깐 초록으로 강조하고, 실패 시 error toast.
  // idCopied 는 1.5s 뒤 자동 해제해 원래 스타일로 되돌린다.
  const [idCopied, setIdCopied] = useState(false);
  const handleCopyId = useCallback(async () => {
    const ok = await copyTextToClipboard(activeTicket.id);
    if (ok) {
      setIdCopied(true);
      showToast('Ticket ID가 클립보드에 복사되었습니다', 'success');
      setTimeout(() => setIdCopied(false), 1500);
    } else {
      showToast('복사에 실패했습니다 — 클립보드 권한을 확인하세요', 'error');
    }
  }, [activeTicket.id, showToast]);

  // ─── 코멘트 동적 로딩 (커서 페이지네이션) ────────────────────────
  // 서버 detail GET 은 노드별 최신 N개 코멘트만 싣는다(OOM 방지). 더 오래된
  // 코멘트는 사용자가 목록 하단으로 스크롤할 때 GET /tickets/:id/comments 로
  // 페이지 단위 로드한다. 코멘트는 최신이 위(DESC)라 옛 코멘트는 아래쪽에
  // 쌓이므로, 하단 append 만으로 스크롤 위치가 자동 유지된다(prepend 복원 불필요).
  // 패널은 root/child 를 오가므로(navStack) 패널 티켓 id 별로 상태를 분리한다.
  //
  // 누적(accumulator) 방식: older-page 를 한 번이라도 받은 패널은 "그때까지 보던
  // 전체 목록 + 새 older-page" 를 loadedByPanel 에 쌓는다. 서버 detail 윈도우는
  // 새 코멘트가 들어오면 최신 N개로 슬라이드하므로, 단순히 (윈도우 + older) 만
  // 합치면 윈도우에서 밀려난 경계 코멘트가 둘 사이로 빠진다 — accumulator 가 한 번
  // 본 코멘트를 계속 보관해 그 누락을 막는다.
  const COMMENT_PAGE = 50;
  const [loadedByPanel, setLoadedByPanel] = useState<Record<string, Comment[]>>({});
  const [hasMoreByPanel, setHasMoreByPanel] = useState<Record<string, boolean>>({});
  const [loadingOlderPanel, setLoadingOlderPanel] = useState<string | null>(null);

  // root 티켓이 바뀌면 이전 트리의 누적 캐시를 비운다(navStack 리셋과 동일 시점).
  useEffect(() => {
    setLoadedByPanel({});
    setHasMoreByPanel({});
    setLoadingOlderPanel(null);
  }, [ticket.id]);

  const sortByCreatedDesc = (arr: Comment[]) => arr.sort((a, b) => {
    const d = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (d !== 0) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  // 서버 윈도우(activeTicket.comments, SSE 라이브 갱신 경로 그대로) + 누적분을
  // id dedupe 병합. 윈도우 버전이 최신(상태 변경/편집/repeat_count)이라 덮어쓴다.
  const mergedComments = useMemo(() => {
    const acc = loadedByPanel[activePanelId];
    const fresh = activeTicket.comments || [];
    if (!acc || acc.length === 0) return fresh; // older 미로드: 윈도우 그대로
    const map = new Map<string, Comment>();
    for (const c of acc) map.set(c.id, c);
    for (const c of fresh) map.set(c.id, c as Comment);
    return sortByCreatedDesc(Array.from(map.values()));
  }, [loadedByPanel, activePanelId, activeTicket.comments]);

  // older 를 받은 패널은 라이브 refetch 가 올 때마다 윈도우를 accumulator 로
  // 흡수해, 윈도우가 슬라이드해도 경계 코멘트를 잃지 않게 한다(미로드 패널은
  // 메모리 절약 위해 accumulator 를 만들지 않는다).
  useEffect(() => {
    const fresh = activeTicket.comments || [];
    if (fresh.length === 0) return;
    setLoadedByPanel(prev => {
      const existing = prev[activePanelId];
      if (!existing) return prev;
      const map = new Map(existing.map(c => [c.id, c]));
      for (const c of fresh) map.set(c.id, c as Comment);
      return { ...prev, [activePanelId]: Array.from(map.values()) };
    });
  }, [activeTicket.comments, activePanelId]);

  // 아직 older-page 를 한 번도 안 받았으면 서버의 comments_has_more 로 초기값을
  // 잡고, 이후엔 패널별 상태가 우선한다(라이브 refetch 가 덮어쓰지 못하게).
  const activeHasMore = hasMoreByPanel[activePanelId] ?? (activeTicket.comments_has_more ?? false);

  // 하단 근접 시 CommentList 가 호출. 현재 보던 전체 목록의 가장 오래된 항목을
  // 커서(before)로 다음 페이지를 받아 누적한다. 첫 호출 시 accumulator 를 현재
  // 목록으로 seed 해 윈도우 경계 코멘트를 포착한다.
  const handleLoadOlder = useCallback(async () => {
    const panelId = activePanelId;
    if (loadingOlderPanel) return;
    const current = mergedComments;
    const oldest = current[current.length - 1];
    if (!oldest) return;
    setLoadingOlderPanel(panelId);
    try {
      const page = await api.getTicketComments(panelId, { limit: COMMENT_PAGE, before: oldest.id });
      setLoadedByPanel(prev => {
        const existing = prev[panelId] || current; // seed: 현재 목록(윈도우+경계 포함)
        const map = new Map(existing.map(c => [c.id, c]));
        for (const c of page) if (!map.has(c.id)) map.set(c.id, c as Comment);
        return { ...prev, [panelId]: Array.from(map.values()) };
      });
      // 페이지가 limit 보다 적게 오면 더 이상 없음.
      setHasMoreByPanel(prev => ({ ...prev, [panelId]: page.length >= COMMENT_PAGE }));
    } catch {
      /* 실패해도 기존 목록 유지 — 다음 스크롤에서 재시도 가능 */
    } finally {
      setLoadingOlderPanel(cur => (cur === panelId ? null : cur));
    }
  }, [activePanelId, loadingOlderPanel, mergedComments]);

  const handleSelectChild = useCallback((child: Ticket) => {
    setNavStack(prev => [...prev, child.id]);
  }, []);

  const handleBack = useCallback(() => {
    setNavStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  }, []);

  // Lazy-load workspace boards when the move menu first opens. Excludes the
  // current board. Each entry carries a flat list of {id, name} columns so
  // the picker can let the user pick a specific column without a second
  // round trip per board (api.getBoards alone doesn't include columns).
  const loadMoveBoardOptions = useCallback(async () => {
    const wsId = workspaceId || '';
    if (!wsId) {
      setMoveBoardOptions([]);
      return;
    }
    if (moveBoardWorkspaceLoaded === wsId) return;
    setMoveBoardLoading(true);
    try {
      const all = await api.getBoards(wsId);
      const candidates = (all || []).filter((b: any) => !b.archived_at && b.id !== currentBoardId);
      const detailed = await Promise.all(
        candidates.map(async (b: any) => {
          try {
            const full = await api.getBoard(b.id);
            const cols = ((full?.columns || []) as any[])
              .slice()
              .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
              .map(c => ({ id: c.id, name: c.name }));
            return { id: b.id, name: b.name, columns: cols } as MoveToBoardOption;
          } catch {
            return { id: b.id, name: b.name, columns: [] } as MoveToBoardOption;
          }
        }),
      );
      setMoveBoardOptions(detailed);
      setMoveBoardWorkspaceLoaded(wsId);
    } finally {
      setMoveBoardLoading(false);
    }
  }, [workspaceId, currentBoardId, moveBoardWorkspaceLoaded]);

  const handleOpenMoveBoardMenu = useCallback(() => {
    setMoveBoardMenuOpen(true);
    loadMoveBoardOptions().catch(() => { /* loading flag already cleared */ });
  }, [loadMoveBoardOptions]);

  const handleMoveToBoard = useCallback(async (targetBoardId: string, columnId?: string) => {
    if (!onMoveToBoard) return;
    setMovingToBoard(true);
    try {
      await onMoveToBoard(activeTicket.id, targetBoardId, columnId ? { target_column_id: columnId } : undefined);
      const dest = moveBoardOptions.find(b => b.id === targetBoardId);
      const colName = columnId ? dest?.columns.find(c => c.id === columnId)?.name : undefined;
      showToast(
        `Moved to ${dest?.name || 'board'}${colName ? ` → ${colName}` : ''}`,
        'success',
      );
      // Ticket is no longer on this board — close the panel so the user
      // isn't left staring at stale state.
      onClose();
    } catch (e: any) {
      showToast(`Move failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setMovingToBoard(false);
    }
  }, [onMoveToBoard, activeTicket.id, moveBoardOptions, showToast, onClose]);

  const handleRetrigger = useCallback(async (slug: string, label: string, holderName?: string) => {
    if (retriggering[slug]) return;
    setRetriggering(prev => ({ ...prev, [slug]: true }));
    try {
      const result = await api.triggerAgent(activeTicket.id, slug as any);
      showToast(`Triggered ${label}${holderName ? ` (${holderName})` : ''}`, 'success');
      return result;
    } catch (e: any) {
      showToast(`Trigger failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setRetriggering(prev => ({ ...prev, [slug]: false }));
    }
  }, [activeTicket.id, retriggering, showToast]);

  // ESC key requests close — the real handler is installed below, after
  // requestClose is in scope (which depends on form-draft state declared
  // further down). Closing with unsaved edits prompts.

  // Form state — sync when activeTicket changes.
  const [title, setTitle] = useState(activeTicket.title);
  const [description, setDescription] = useState(activeTicket.description);
  // Dynamic Description textarea sizing: clamp visible rows between 10 and 20,
  // growing with the content (explicit newlines + estimated soft-wrap at ~80
  // cols). Keeps short tickets compact-ish while long ones stay readable
  // without the user having to drag the resize handle every time.
  const descriptionRows = useMemo(() => {
    const text = description || '';
    const wrapWidth = 80;
    const visualLines = text.split('\n').reduce(
      (acc, line) => acc + Math.max(1, Math.ceil(line.length / wrapWidth)),
      0,
    );
    return Math.max(10, Math.min(20, visualLines));
  }, [description]);
  const [priority, setPriority] = useState(activeTicket.priority);
  // Abstract effort preset id ('' = board default / no override). Resolved
  // per-CLI on the server at dispatch; here it's just the preset slug.
  const [effortPreset, setEffortPreset] = useState<string>(activeTicket.effort_preset || '');
  const [reviewerId, setReviewerId] = useState(activeTicket.reviewer_id || '');
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(activeTicket.channel_ids || []);
  // Base repository / branch picker state. The repo list is filtered to
  // type='repository' resources visible from this workspace + board scope.
  // Branch list is fetched lazily when a repo is selected (git ls-remote).
  const [baseRepoId, setBaseRepoId] = useState<string>(activeTicket.base_repo_resource_id || '');
  const [baseBranch, setBaseBranch] = useState<string>(activeTicket.base_branch || '');
  // Next ticket picker — empty string = unset. Drafts are committed via the
  // same Save/Discard footer as the rest of the form (dirtyTicketFields).
  const [nextTicketId, setNextTicketId] = useState<string>(activeTicket.next_ticket_id || '');
  // Per-ticket on-done action binding (ticket 16a6339c). `onDoneActionIds` is
  // the draft set the picker mutates; committed via the Save/Discard footer
  // (dirtyTicketFields) as `update_ticket(on_done_action_ids=[...])`. The
  // candidate list is every Action in the workspace — method (a) dispatch only
  // checks workspace + enabled, not board scope, so any workspace Action is
  // validly bindable here.
  const [onDoneActionIds, setOnDoneActionIds] = useState<string[]>(activeTicket.on_done_action_ids || []);
  // Cross-board handoff relay draft (ticket ac21a745). null = no relay. Committed
  // via the same Save/Discard footer (dirtyTicketFields) as update_ticket(handoff_spec).
  const [handoffSpec, setHandoffSpec] = useState<HandoffSpec | null>(
    activeTicket.handoff_spec && (activeTicket.handoff_spec.hops || []).length > 0 ? activeTicket.handoff_spec : null,
  );
  const [actionOptions, setActionOptions] = useState<Action[]>([]);
  const [repoOptions, setRepoOptions] = useState<Resource[]>([]);
  const [branchOptions, setBranchOptions] = useState<RepoBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [commentContent, setCommentContent] = useState('');
  // Staged attachments — kept in memory until the user hits Send. Two kinds:
  //   • file     — a freshly picked File, uploaded as a Resource on Send (raw
  //                bytes, no base64-in-JSON, so large videos don't 413).
  //   • resource — a reference to an already-uploaded board/workspace Resource.
  // On Send, files upload first; then the comment POST carries only
  // attachment_resource_ids (never the bytes), which is what fixes the 10MB
  // body 413 that silently dropped video comments (ticket ff3e7337).
  const [commentAttachments, setCommentAttachments] = useState<StagedAttachment[]>([]);
  // True while uploads are in flight on Send — disables the composer so a
  // double-submit can't fire a second batch of uploads.
  const [commentSending, setCommentSending] = useState(false);
  // Existing-Resource picker (the "reference an already-uploaded file" path).
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const [resourcePickerItems, setResourcePickerItems] = useState<Resource[]>([]);
  const [resourcePickerLoading, setResourcePickerLoading] = useState(false);
  const [resourcePickerError, setResourcePickerError] = useState<string | null>(null);
  // Compose type selector — restricted to types where COMMENT_TYPE_STYLES.composable=true.
  // 'note' is the default so the previous flow (just type and Send) is unchanged.
  const [composeType, setComposeType] = useState<CommentType>('note');
  // Phase 3: live typing indicator. Map keyed by actor_id so multiple typists
  // (e.g., user + reviewer agent) don't shadow each other. Auto-cleared after
  // TYPING_TTL_MS so a tab close doesn't leave a stale "X is typing".
  const [commentTypists, setCommentTypists] = useState<Record<string, { name: string; until: number }>>({});
  // Phase 2C: which question (if any) the user is currently composing an answer to.
  // Set via the Answer button on a question card; cleared on submit/cancel/ticket switch.
  const [replyingTo, setReplyingTo] = useState<{ id: string; preview: string; author: string } | null>(null);
  // Tier-1 E: live ticket presence — who else has this panel open right now.
  // Server emits ticket_presence on viewer-set transitions; we keep the latest
  // viewer list keyed by composite type:id so user/agent collisions can't shadow.
  const [presenceViewers, setPresenceViewers] = useState<Array<{ type: 'user' | 'agent'; id: string; name: string }>>([]);
  // Tier-1 F: last_read_at for the current user on this ticket. Comments
  // with created_at > lastReadAt render with an "unread" cue. Snapshotted
  // on panel mount so the moment-of-arrival cutoff stays stable while the
  // user reads — re-marking only happens on unmount / ticket switch.
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'detail' | 'comments' | 'activity' | 'user'>('detail');
  // Pending-user-action edit drafts (ticket a57517be / 861aa636).
  // - pendingReasonDraft is bound to the "Park reason" textarea shown when
  //   the ticket is NOT pending; lets the human park it with a reason.
  // - userResponseDraft is bound to the "Your response" textarea shown when
  //   the ticket IS pending; Resume posts this as a ticket comment before
  //   clearing pending_user_action, so the assignee sees the reply on the
  //   next trigger without the human having to scroll to the comments tab.
  const [pendingReasonDraft, setPendingReasonDraft] = useState<string>('');
  const [userResponseDraft, setUserResponseDraft] = useState<string>('');
  const [pendingBusy, setPendingBusy] = useState(false);
  // Prerequisites (ticket 48d14fff) — the "blocked-by another ticket" link
  // set. Seeded from activeTicket.prerequisites (present only on the
  // loadTicketFull path), then refreshed via api.listPrerequisites so the
  // section is authoritative regardless of which load path supplied the prop.
  // prereqPickId / prereqReason back the inline "add prerequisite" picker.
  const [prereqRows, setPrereqRows] = useState<TicketPrerequisiteRow[]>(activeTicket.prerequisites || []);
  const [prereqBusy, setPrereqBusy] = useState(false);
  const [prereqPickId, setPrereqPickId] = useState<string>('');
  const [prereqReason, setPrereqReason] = useState<string>('');
  const [prereqError, setPrereqError] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  // Modal preview can be an image OR a video — discriminate by mimetype so
  // the modal picks the right element. `null` mimetype falls back to <img>
  // for backwards compatibility with legacy callers that pass src only.
  const [imagePreview, setImagePreview] = useState<{ src: string; mimetype?: string } | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  // Ticket-level attachments — file_data is fetched on demand (download/preview)
  // so the metadata list can stay cheap. Seeded from the ticket payload, then
  // refreshed via api.listTicketAttachments after each mutation so concurrent
  // edits across tabs converge.
  const [ticketAttachments, setTicketAttachments] = useState<TicketAttachmentMeta[]>(activeTicket.attachments || []);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // Form drafts reset on ticket switch only. Remote updates (updated_at
  // bumps from cross-tab edits, comments, etc.) must NOT clobber the user's
  // unsaved edits — the Save/Discard footer is the only commit/rollback
  // path now that the panel buffers all field edits.
  useEffect(() => {
    setTitle(activeTicket.title);
    setDescription(activeTicket.description);
    setPriority(activeTicket.priority);
    setEffortPreset(activeTicket.effort_preset || '');
    setSelectedChannelIds(activeTicket.channel_ids || []);
    setBaseRepoId(activeTicket.base_repo_resource_id || '');
    setBaseBranch(activeTicket.base_branch || '');
    setNextTicketId(activeTicket.next_ticket_id || '');
    setOnDoneActionIds(activeTicket.on_done_action_ids || []);
    setHandoffSpec(
      activeTicket.handoff_spec && (activeTicket.handoff_spec.hops || []).length > 0 ? activeTicket.handoff_spec : null,
    );
    setBranchOptions([]);
    setBranchesError(null);
    setRoleDrafts({});
    setCommentContent('');
    setCommentAttachments([]);
    setPendingReasonDraft(activeTicket.pending_reason || '');
    setUserResponseDraft('');
    // Auto-switch to the User tab when opening a pending ticket so the human
    // sees the ask immediately. Skipped when scrollToCommentId is set (a
    // deep-link from a mention notification — that lives in the comments
    // tab and the dedicated effect below routes there).
    setActiveTab(activeTicket.pending_user_action ? 'user' : 'detail');
  }, [activeTicket.id]);

  // Mention deep-link override — when a comment id is queued (at panel mount
  // or arriving on the currently-open ticket), jump to the comments tab so
  // the scroll-and-highlight has somewhere to land. Skip the null clear:
  // Board.tsx resets scrollToCommentId after the highlight fires, and re-
  // running the form-drafts reset above would wipe the user's unsaved edits
  // and snap the tab back to detail mid-highlight.
  useEffect(() => {
    if (scrollToCommentId) setActiveTab('comments');
  }, [scrollToCommentId]);

  // Authoritative server-side facts — the reviewer id and the attachment list
  // — keep refreshing on updated_at because they have no client-side draft
  // concept. The form drafts above are isolated from this stream.
  useEffect(() => {
    setReviewerId(activeTicket.reviewer_id || '');
    // Seed from the ticket payload (only loadTicketFull populates this; the
    // board listing doesn't), then fetch fresh metadata so the list is
    // always authoritative regardless of which load path supplied the prop.
    setTicketAttachments(activeTicket.attachments || []);
    setAttachmentError(null);
    let cancelled = false;
    api.listTicketAttachments(activeTicket.id)
      .then(rows => { if (!cancelled) setTicketAttachments(rows || []); })
      .catch(() => { /* keep seeded list — non-blocking */ });
    return () => { cancelled = true; };
  }, [activeTicket.id, activeTicket.updated_at]);

  // Cross-tab sync — board_update fires on every activity event, so refresh
  // the attachments list when our ticket is the target. Filtering by
  // field_changed='attachment' avoids refetching on unrelated updates
  // (assignee change, comment add, etc.).
  useBoardStreamEvent('board_update', useCallback((data: any) => {
    if (!data || data.ticket_id !== activeTicket.id) return;
    if (data.field_changed !== 'attachment') return;
    api.listTicketAttachments(activeTicket.id)
      .then(rows => setTicketAttachments(rows || []))
      .catch(() => { /* non-blocking */ });
  }, [activeTicket.id]));

  // Auto-route to the User tab when this ticket transitions into pending state
  // from elsewhere (agent flipped pending_user_action while the panel is open).
  // The activeTicket prop is bumped via board refresh on the same SSE event,
  // so this effect catches the transition without needing to listen to SSE
  // directly. Conservative: only switch when not already on Comments/Activity
  // (avoid stealing focus mid-read).
  useEffect(() => {
    if (activeTicket.pending_user_action && activeTab === 'detail') {
      setActiveTab('user');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicket.pending_user_action]);

  useEffect(() => {
    if (activeTab === 'activity') {
      api.getTicketActivity(activeTicket.id).then(setActivities).catch(() => {});
    }
  }, [activeTab, activeTicket.id]);

  // Resync the pending_reason draft when the server-side value changes (e.g.,
  // the agent edited the reason in another tab). The draft itself is local —
  // edits buffer here until the user clicks Save / Pend / Unpend on the User
  // tab — but a server-side update bumps updated_at and should overwrite an
  // empty/unchanged draft so the panel stays authoritative.
  useEffect(() => {
    setPendingReasonDraft(activeTicket.pending_reason || '');
  }, [activeTicket.id, activeTicket.updated_at]);

  // Pend / unpend handlers (ticket a57517be). Single-shot REST PATCH calls
  // that flip the flag and let the SSE board_update event refresh the
  // ticket; the Unpend button needs no confirmation because the action is
  // reversible (the agent or user can pend again). Pend requires a reason —
  // the empty-string guard is the only validation.
  const handlePendTicket = useCallback(async () => {
    const reason = pendingReasonDraft.trim();
    if (!reason) return;
    setPendingBusy(true);
    try {
      await api.updateTicket(activeTicket.id, {
        pending_user_action: true,
        pending_reason: reason,
      });
    } finally {
      setPendingBusy(false);
    }
  }, [activeTicket.id, pendingReasonDraft]);

  // Resume posts the user's response (if any) as a regular ticket comment
  // BEFORE flipping pending_user_action off, so the comment lands in the
  // thread before the dispatch loop wakes the assignee on the next trigger.
  // onAddComment is fire-and-forget per its prop type but Board's wrapper
  // returns a Promise; Promise.resolve normalises the await target so we
  // sequence reliably either way.
  const handleUnpendTicket = useCallback(async () => {
    const response = userResponseDraft.trim();
    setPendingBusy(true);
    try {
      if (response) {
        await Promise.resolve(onAddComment(activeTicket.id, response));
      }
      await api.updateTicket(activeTicket.id, { pending_user_action: false });
      setUserResponseDraft('');
      setPendingReasonDraft('');
    } finally {
      setPendingBusy(false);
    }
  }, [activeTicket.id, userResponseDraft, onAddComment]);

  // Load the prerequisite link set (ticket 48d14fff). Seeds from the ticket
  // payload first (loadTicketFull populates it; the board listing doesn't),
  // then fetches fresh so the section is authoritative. Refetched on
  // updated_at so an agent adding/clearing a prereq elsewhere converges here.
  useEffect(() => {
    setPrereqRows(activeTicket.prerequisites || []);
    setPrereqError(null);
    setPrereqPickId('');
    setPrereqReason('');
    let cancelled = false;
    api.listPrerequisites(activeTicket.id)
      .then(res => { if (!cancelled) setPrereqRows(res?.prerequisites || []); })
      .catch(() => { /* keep seeded list — non-blocking */ });
    return () => { cancelled = true; };
  }, [activeTicket.id, activeTicket.updated_at]);

  // Add a prerequisite from the inline picker. The REST endpoint returns the
  // full updated ticket (incl. the refreshed `prerequisites` array), so adopt
  // that directly rather than issuing a follow-up GET. The SSE board_update
  // (fired by the prerequisite_added activity) keeps pending_on_tickets and
  // the board card in sync.
  const handleAddPrerequisite = useCallback(async () => {
    const pid = prereqPickId.trim();
    if (!pid) return;
    setPrereqBusy(true);
    setPrereqError(null);
    try {
      const updated = await api.addPrerequisites(activeTicket.id, [pid], prereqReason.trim() || undefined);
      setPrereqRows(updated?.prerequisites || []);
      setPrereqPickId('');
      setPrereqReason('');
    } catch (e: any) {
      setPrereqError(e?.message || 'Failed to add prerequisite');
    } finally {
      setPrereqBusy(false);
    }
  }, [activeTicket.id, prereqPickId, prereqReason]);

  const handleRemovePrerequisite = useCallback(async (prereqId: string) => {
    setPrereqBusy(true);
    setPrereqError(null);
    try {
      const updated = await api.removePrerequisite(activeTicket.id, prereqId);
      setPrereqRows(updated?.prerequisites || []);
    } catch (e: any) {
      setPrereqError(e?.message || 'Failed to remove prerequisite');
    } finally {
      setPrereqBusy(false);
    }
  }, [activeTicket.id]);

  // Fetch role assignments for the active ticket. Refetched on
  // activeTicket.updated_at so writes through onSetRoleAssignment (which
  // triggers a board refresh and bumps updated_at) converge.
  useEffect(() => {
    let cancelled = false;
    api.listTicketRoleAssignments(activeTicket.id)
      .then(rows => { if (!cancelled) setRoleAssignments(rows || []); })
      .catch(() => { if (!cancelled) setRoleAssignments([]); });
    return () => { cancelled = true; };
  }, [activeTicket.id, activeTicket.updated_at]);

  // ─── 합의 상태 조회/갱신 (T6) ────────────────────────────
  // root 티켓만 대상. updated_at 변화(이동/투표가 보드 refresh 로 bump)에 재조회 →
  // 수렴. 실패/비-root 는 null(패널 숨김).
  const refreshConsensus = useCallback(async () => {
    if (activeTicket.depth !== 0) { setConsensus(null); return; }
    try {
      const v = await api.getTicketConsensus(activeTicket.id);
      setConsensus(v);
    } catch {
      setConsensus(null);
    }
  }, [activeTicket.id, activeTicket.depth]);

  useEffect(() => {
    let cancelled = false;
    if (activeTicket.depth !== 0) { setConsensus(null); return; }
    api.getTicketConsensus(activeTicket.id)
      .then(v => { if (!cancelled) setConsensus(v); })
      .catch(() => { if (!cancelled) setConsensus(null); });
    return () => { cancelled = true; };
  }, [activeTicket.id, activeTicket.updated_at, activeTicket.depth]);

  // 라이브 갱신: consensus_update SSE 는 카운트만 실으므로, 이 티켓 대상 이벤트가
  // 오면 상세 홀더 상태를 재조회한다.
  useBoardStreamEvent('consensus_update', (data: any) => {
    if (data?.ticket_id === activeTicket.id) refreshConsensus();
  });

  // Seed @-mention candidates from props + ticket role_ids immediately so the
  // dropdown works before the workspace-user API call returns.
  useEffect(() => {
    const agentById = new Map(agents.map(a => [a.id, a]));
    const roleItems: MentionCandidate[] = [];
    const pushRole = (key: 'assignee' | 'reporter' | 'reviewer', id: string | undefined) => {
      if (!id) return;
      const a = agentById.get(id);
      roleItems.push({ type: 'role', id: key, name: key, sublabel: a ? formatAgentDisplayName(a) : id });
    };
    pushRole('assignee', activeTicket.assignee_id);
    pushRole('reporter', activeTicket.reporter_id);
    pushRole('reviewer', activeTicket.reviewer_id);
    const agentItems: MentionCandidate[] = agents.map(a => ({ type: 'agent', id: a.id, name: formatAgentDisplayName(a) }));
    setMentionCandidates([...roleItems, ...agentItems]);

    const workspaceId = getActiveWorkspaceId() || '';
    if (!workspaceId) return;
    api.getMentionCandidates(workspaceId, activeTicket.id)
      .then(data => {
        const next: MentionCandidate[] = [
          ...data.role_shortcuts.map(r => ({ type: 'role' as const, id: r.key, name: r.key, sublabel: r.label.replace(`${r.key} `, '') })),
          ...data.users.map(u => ({ type: 'user' as const, id: u.id, name: u.name })),
          // Enrich server-returned agent rows with manager_name from the
          // local agents list (which carries it). Falls back to bare name
          // when a candidate isn't in the local list yet.
          ...data.agents.map(a => {
            const full = agents.find(x => x.id === a.id);
            return { type: 'agent' as const, id: a.id, name: formatAgentDisplayName(full || a) };
          }),
        ];
        const seen = new Set<string>();
        setMentionCandidates(next.filter(c => {
          const k = `${c.type}:${c.id}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }));
      })
      .catch(() => { /* keep fallback */ });
  }, [activeTicket.id, activeTicket.assignee_id, activeTicket.reporter_id, activeTicket.reviewer_id, agents]);

  // Order-insensitive equality for channel id arrays — the server stores them
  // as a list but neither side guarantees a stable order.
  const channelIdsEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  };

  // Order-SENSITIVE equality. on_done_action_ids is a sequence, not a set —
  // its array order IS the dispatch order — so a pure reorder (same id set,
  // different positions) must still register as dirty. channelIdsEqual sorts
  // before comparing and would mask that, leaving the Save button disabled.
  const idsEqualOrdered = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // Canonical equality for the handoff relay spec (ticket ac21a745). Both sides
  // normalize to null when there are no hops, then compare hop JSON — so a draft
  // that only reorders/edits a hop registers dirty, and null↔empty is a no-op.
  const handoffSpecEqual = (a: HandoffSpec | null, b: HandoffSpec | undefined) => {
    const norm = (s: HandoffSpec | null | undefined) =>
      s && (s.hops || []).length > 0 ? JSON.stringify(s.hops) : '';
    return norm(a) === norm(b);
  };

  // Ticket-field drafts that differ from the server-side row. Empty when the
  // form matches the ticket exactly. The Save handler PATCHes whatever lives
  // in this object in a single round trip, which collapses the previous
  // per-field activity log entries (and their fanned-out trigger reservations)
  // into a single ticket_update event.
  const dirtyTicketFields = useMemo(() => {
    const out: Record<string, any> = {};
    if (title !== activeTicket.title) out.title = title;
    if ((description || '') !== (activeTicket.description || '')) out.description = description;
    if (priority !== activeTicket.priority) out.priority = priority;
    if ((effortPreset || '') !== (activeTicket.effort_preset || '')) {
      // Empty draft → null clears the per-ticket override (server treats
      // null/'' as "use the board default at dispatch").
      out.effort_preset = effortPreset || null;
    }
    if (!channelIdsEqual(selectedChannelIds, activeTicket.channel_ids || [])) {
      out.channel_ids = selectedChannelIds;
    }
    if ((baseRepoId || '') !== (activeTicket.base_repo_resource_id || '')) {
      out.base_repo_resource_id = baseRepoId || null;
    }
    if ((baseBranch || '') !== (activeTicket.base_branch || '')) {
      out.base_branch = baseBranch || null;
    }
    if ((nextTicketId || '') !== (activeTicket.next_ticket_id || '')) {
      // Empty draft → null clears the link on the server (REST + MCP both
      // treat null/'' as "clear next_ticket_id"). Non-empty → the picked id.
      out.next_ticket_id = nextTicketId || null;
    }
    if (!idsEqualOrdered(onDoneActionIds, activeTicket.on_done_action_ids || [])) {
      // Order-SENSITIVE compare: array order is the dispatch order, so a pure
      // reorder must flag the field dirty. An empty array clears the per-ticket
      // binding server-side.
      out.on_done_action_ids = onDoneActionIds;
    }
    if (!handoffSpecEqual(handoffSpec, activeTicket.handoff_spec)) {
      // Object compare via canonical hop JSON. Draft null / empty hops → null,
      // which the server treats as "clear the handoff relay".
      out.handoff_spec = handoffSpec && (handoffSpec.hops || []).length > 0 ? handoffSpec : null;
    }
    return out;
  }, [
    title, description, priority, effortPreset, selectedChannelIds, baseRepoId, baseBranch, nextTicketId,
    onDoneActionIds, handoffSpec,
    activeTicket.title, activeTicket.description, activeTicket.priority, activeTicket.effort_preset,
    activeTicket.channel_ids, activeTicket.base_repo_resource_id, activeTicket.base_branch,
    activeTicket.next_ticket_id, activeTicket.on_done_action_ids, activeTicket.handoff_spec,
  ]);

  // Current holders grouped by role id (multi-holder T6). roleAssignments is one
  // row per (role, holder), so a role with N holders appears as N rows — group
  // them into a holder list per role for both the chip picker and the dirty diff.
  const holdersByRoleId = useMemo(() => {
    const m = new Map<string, Array<{ type: 'agent' | 'user'; id: string; name: string }>>();
    for (const r of roleAssignments) {
      if (!r.holder) continue;
      const list = m.get(r.role.id) || [];
      list.push(r.holder);
      m.set(r.role.id, list);
    }
    return m;
  }, [roleAssignments]);

  // Server-resolved holder display names keyed by holder id. The REST
  // role-assignments projection resolves ids workspace-independently (and, per
  // ST-7, with the <Manager>/<Agent> prefix), so this is the fallback when a
  // holder's agent/user isn't in the workspace-scoped `agents`/`users` lists —
  // an already-assigned cross-workspace agent then shows its name instead of a
  // raw id (ticket 0cccf9b5).
  const resolvedHolderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roleAssignments) {
      if (r.holder) m.set(r.holder.id, r.holder.name);
    }
    return m;
  }, [roleAssignments]);

  // Role drafts that genuinely change the holder SET. A draft whose holder set
  // equals the live set is dropped (no-op — e.g. add then remove the same one,
  // or reorder). Compared as unordered key sets (holder order isn't meaningful).
  const dirtyRoleDrafts = useMemo(() => {
    const out: Record<string, HolderDraft[]> = {};
    for (const [roleId, draft] of Object.entries(roleDrafts)) {
      const currentKeys = new Set(
        (holdersByRoleId.get(roleId) || []).map(h => holderDraftKey(holderToDraft(h))).filter(Boolean),
      );
      const draftKeys = new Set(draft.map(holderDraftKey).filter(Boolean));
      const same = draftKeys.size === currentKeys.size && [...draftKeys].every(k => currentKeys.has(k));
      if (!same) out[roleId] = draft;
    }
    return out;
  }, [roleDrafts, holdersByRoleId]);

  const isDirty = Object.keys(dirtyTicketFields).length > 0 || Object.keys(dirtyRoleDrafts).length > 0;

  const handleDiscardDraft = useCallback(() => {
    setTitle(activeTicket.title);
    setDescription(activeTicket.description);
    setPriority(activeTicket.priority);
    setEffortPreset(activeTicket.effort_preset || '');
    setSelectedChannelIds(activeTicket.channel_ids || []);
    setBaseRepoId(activeTicket.base_repo_resource_id || '');
    setBaseBranch(activeTicket.base_branch || '');
    setNextTicketId(activeTicket.next_ticket_id || '');
    setOnDoneActionIds(activeTicket.on_done_action_ids || []);
    setHandoffSpec(
      activeTicket.handoff_spec && (activeTicket.handoff_spec.hops || []).length > 0 ? activeTicket.handoff_spec : null,
    );
    setRoleDrafts({});
  }, [
    activeTicket.title, activeTicket.description, activeTicket.priority, activeTicket.effort_preset,
    activeTicket.channel_ids, activeTicket.base_repo_resource_id, activeTicket.base_branch,
    activeTicket.next_ticket_id, activeTicket.on_done_action_ids, activeTicket.handoff_spec,
  ]);

  const handleSaveDraft = useCallback(async () => {
    if (savingDraft) return;
    // Snapshot the in-flight commit so drafts the user adds DURING the save
    // round trip survive — only the keys we actually sent get cleared on
    // success, leaving newer edits ready for the next Save click.
    const ticketFieldsToSave = dirtyTicketFields;
    const roleDraftsToSave = { ...dirtyRoleDrafts };
    const dirtyRoleIds = Object.keys(roleDraftsToSave);
    if (Object.keys(ticketFieldsToSave).length === 0 && dirtyRoleIds.length === 0) return;
    setSavingDraft(true);
    // Build the T1 role_assignments[] payload from the dirty holder sets. One
    // entry per holder (repeated role_slug = multi-holder set); a dirty role
    // whose set is empty emits a holder-less entry so the server CLEARS the slot.
    const roleIdToSlug = new Map((workspaceRoles || []).map(r => [r.id, r.slug]));
    const roleAssignmentsPayload: Array<{ role_slug: string; agent_id?: string; user_id?: string }> = [];
    for (const roleId of dirtyRoleIds) {
      const slug = roleIdToSlug.get(roleId);
      if (!slug) continue;
      const holders = roleDraftsToSave[roleId].filter(h => h.agent_id || h.user_id);
      if (holders.length === 0) {
        roleAssignmentsPayload.push({ role_slug: slug }); // holder-less → clear
      } else {
        for (const h of holders) {
          roleAssignmentsPayload.push(
            h.agent_id ? { role_slug: slug, agent_id: h.agent_id } : { role_slug: slug, user_id: h.user_id! },
          );
        }
      }
    }
    try {
      if (onSaveDraft) {
        await onSaveDraft(activeTicket.id, ticketFieldsToSave, roleAssignmentsPayload);
      } else {
        // Legacy fallback (no onSaveDraft embedder): ticket fields via onUpdate,
        // plus a best-effort SINGLE-holder role write (first holder) through
        // onSetRoleAssignment. Multi-holder edits require onSaveDraft.
        const ops: Array<Promise<unknown>> = [];
        if (Object.keys(ticketFieldsToSave).length > 0) {
          ops.push(Promise.resolve(onUpdate(activeTicket.id, ticketFieldsToSave)));
        }
        if (onSetRoleAssignment) {
          for (const roleId of dirtyRoleIds) {
            const first = roleDraftsToSave[roleId].find(h => h.agent_id || h.user_id) || { agent_id: null, user_id: null };
            ops.push(Promise.resolve(onSetRoleAssignment(activeTicket.id, roleId, first)));
          }
        }
        await Promise.all(ops);
      }
      // Only reached when the save resolved cleanly. A throw skips this block,
      // so the role drafts the user committed stay buffered, the Save footer
      // stays visible, and only the upstream error toast fires.
      setRoleDrafts(prev => {
        const next = { ...prev };
        for (const k of dirtyRoleIds) delete next[k];
        return next;
      });
      showToast('Saved', 'success');
    } catch (e: any) {
      showToast(`Save failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setSavingDraft(false);
    }
  }, [savingDraft, dirtyTicketFields, dirtyRoleDrafts, activeTicket.id, onSaveDraft, onUpdate, onSetRoleAssignment, showToast, workspaceRoles]);

  // Wrap close so X / Escape prompt before discarding unsaved edits. The
  // post-Delete close path uses raw onClose (the ticket is gone — there's
  // nothing to save).
  const confirmingCloseRef = useRef(false);
  const requestClose = useCallback(async () => {
    if (isDirty) {
      // Guard against the panel's own Escape listener re-firing while the
      // confirm dialog (itself an Escape-closable Modal) is already open.
      if (confirmingCloseRef.current) return;
      confirmingCloseRef.current = true;
      const ok = await confirm({
        title: 'Discard changes',
        message: 'Discard unsaved ticket edits?',
        confirmLabel: 'Discard',
      });
      confirmingCloseRef.current = false;
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose, confirm]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [requestClose]);

  // Load the repository resources visible to this ticket. We pull workspace +
  // board scope in one shot (no board_id filter) so workspace-wide repos show
  // up alongside the per-board ones, then dedupe by id.
  useEffect(() => {
    const wsId = workspaceId || getActiveWorkspaceId() || '';
    if (!wsId) {
      setRepoOptions([]);
      return;
    }
    let cancelled = false;
    api.listResources(wsId, undefined, 'repository')
      .then(rows => { if (!cancelled) setRepoOptions(rows || []); })
      .catch(() => { if (!cancelled) setRepoOptions([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Load the Action candidates for the "Run on Done" picker. Omitting board_id
  // returns every Action in the workspace (board-scoped + workspace-scoped) —
  // method (a) per-ticket dispatch only checks workspace + enabled, so any of
  // them is bindable to this ticket regardless of which board it belongs to.
  useEffect(() => {
    const wsId = workspaceId || getActiveWorkspaceId() || '';
    if (!wsId) {
      setActionOptions([]);
      return;
    }
    let cancelled = false;
    api.listActions(wsId)
      .then(rows => { if (!cancelled) setActionOptions(rows || []); })
      .catch(() => { if (!cancelled) setActionOptions([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Lazy-load branches when the user selects a repo (or the ticket loads with
  // one already pinned). git ls-remote runs server-side and can take a few
  // seconds; we surface that with a loading flag rather than blocking the
  // panel render.
  useEffect(() => {
    const wsId = workspaceId || getActiveWorkspaceId() || '';
    if (!wsId || !baseRepoId) {
      setBranchOptions([]);
      setBranchesError(null);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesError(null);
    api.listRepoBranches(baseRepoId, wsId)
      .then(({ branches }) => { if (!cancelled) setBranchOptions(branches || []); })
      .catch(err => {
        if (cancelled) return;
        setBranchOptions([]);
        setBranchesError(err?.message || 'Failed to list branches');
      })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, baseRepoId]);

  // Remove a staged attachment and revoke its object URL (files only — resource
  // /raw URLs aren't object URLs and don't need revoking).
  const removeStagedAttachment = (key: string) => {
    setCommentAttachments(prev => {
      const target = prev.find(a => a.key === key);
      if (target?.file && target.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(target.previewUrl); } catch { /* noop */ }
      }
      return prev.filter(a => a.key !== key);
    });
  };

  const handleAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    // No mimetype restriction — comment attachments go through the Resource
    // table the same as any other workspace/board asset, so the picker accepts
    // PDFs, zips, videos, etc.
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const staged: StagedAttachment[] = [];
      const rejected: string[] = [];
      let slots = MAX_COMMENT_ATTACHMENTS - commentAttachments.length;
      for (let i = 0; i < files.length; i++) {
        if (slots <= 0) { rejected.push(`${files[i].name} (최대 ${MAX_COMMENT_ATTACHMENTS}개)`); continue; }
        const file = files[i];
        // Clear error instead of the old silent `continue` that dropped large
        // files with no feedback (ticket ff3e7337 — silent failure removal).
        if (file.size > COMMENT_MEDIA_MAX_BYTES) {
          rejected.push(`${file.name} (${Math.round(file.size / 1024 / 1024)}MB > ${Math.round(COMMENT_MEDIA_MAX_BYTES / 1024 / 1024)}MB)`);
          continue;
        }
        staged.push({
          key: `f-${Date.now()}-${i}-${file.name}`,
          file_name: file.name,
          file_mimetype: file.type || 'application/octet-stream',
          previewUrl: URL.createObjectURL(file),
          file,
        });
        slots--;
      }
      if (staged.length > 0) setCommentAttachments(prev => [...prev, ...staged].slice(0, MAX_COMMENT_ATTACHMENTS));
      if (rejected.length > 0) showToast(`첨부 불가: ${rejected.join(', ')}`, 'error');
    };
    input.click();
  };

  // ─── Reference an existing board/workspace Resource ──────────────
  // The design-recommended path: instead of re-uploading bytes, point the
  // comment at a Resource that already exists. The comment POST then carries
  // only the id (ticket ff3e7337).
  const openResourcePicker = useCallback(async () => {
    setResourcePickerOpen(true);
    setResourcePickerLoading(true);
    setResourcePickerError(null);
    const ws = (activeTicket as any).workspace_id || workspaceId;
    if (!ws) {
      setResourcePickerError('워크스페이스를 확인할 수 없습니다.');
      setResourcePickerLoading(false);
      return;
    }
    try {
      // Board-scoped files first (most relevant), then workspace-scoped, then
      // existing comment attachments — de-duped by id, files with bytes only.
      const [boardRes, wsRes] = await Promise.all([
        currentBoardId ? api.listResources(ws, currentBoardId).catch(() => [] as Resource[]) : Promise.resolve([] as Resource[]),
        api.listResources(ws, '').catch(() => [] as Resource[]),
      ]);
      const seen = new Set<string>();
      const merged = [...boardRes, ...wsRes].filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return !!r.file_name; // only file-backed resources are attachable
      });
      setResourcePickerItems(merged);
    } catch (err: any) {
      setResourcePickerError(err?.message || '리소스를 불러오지 못했습니다.');
    } finally {
      setResourcePickerLoading(false);
    }
  }, [activeTicket, workspaceId, currentBoardId]);

  const addResourceReference = (r: Resource) => {
    setCommentAttachments(prev => {
      if (prev.some(a => a.resourceId === r.id)) return prev; // no dupes
      if (prev.length >= MAX_COMMENT_ATTACHMENTS) {
        showToast(`최대 ${MAX_COMMENT_ATTACHMENTS}개까지 첨부할 수 있습니다.`, 'error');
        return prev;
      }
      return [...prev, {
        key: `r-${r.id}`,
        file_name: r.file_name || r.name,
        file_mimetype: r.file_mimetype || '',
        previewUrl: rawResourceUrl(r.id),
        resourceId: r.id,
      }];
    });
    setResourcePickerOpen(false);
  };

  // ─── Ticket-level attachments ────────────────────────────────
  const TICKET_ATTACHMENT_MAX = 20;
  const TICKET_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

  const handleAddTicketAttachments = useCallback(() => {
    setAttachmentError(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      const remaining = TICKET_ATTACHMENT_MAX - ticketAttachments.length;
      if (remaining <= 0) {
        setAttachmentError(`Maximum ${TICKET_ATTACHMENT_MAX} attachments per ticket`);
        return;
      }
      const payload: { file_name: string; file_mimetype: string; file_data: string }[] = [];
      const oversized: string[] = [];
      for (let i = 0; i < files.length && payload.length < remaining; i++) {
        const file = files[i];
        if (file.size > TICKET_ATTACHMENT_SIZE_BYTES) {
          oversized.push(file.name);
          continue;
        }
        const data = await fileToBase64(file);
        payload.push({
          file_name: file.name,
          file_mimetype: file.type || 'application/octet-stream',
          file_data: data,
        });
      }
      if (payload.length === 0) {
        if (oversized.length > 0) {
          setAttachmentError(`Skipped — exceeds 10MB: ${oversized.join(', ')}`);
        }
        return;
      }
      setAttachmentBusy(true);
      try {
        const saved = await api.addTicketAttachments(activeTicket.id, payload);
        setTicketAttachments(prev => [...saved, ...prev]);
        if (oversized.length > 0) {
          setAttachmentError(`Skipped — exceeds 10MB: ${oversized.join(', ')}`);
        }
      } catch (err: any) {
        setAttachmentError(err?.message || 'Upload failed');
      } finally {
        setAttachmentBusy(false);
      }
    };
    input.click();
  }, [activeTicket.id, ticketAttachments.length]);

  const handleDeleteTicketAttachment = useCallback(async (attachmentId: string, fileName: string) => {
    const ok = await confirm({ title: 'Delete attachment', message: `Delete attachment "${fileName}"?` });
    if (!ok) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    const prev = ticketAttachments;
    setTicketAttachments(prev.filter(a => a.id !== attachmentId));
    try {
      await api.deleteTicketAttachment(activeTicket.id, attachmentId);
    } catch (err: any) {
      setTicketAttachments(prev);
      setAttachmentError(err?.message || 'Delete failed');
    } finally {
      setAttachmentBusy(false);
    }
  }, [activeTicket.id, ticketAttachments, confirm]);

  const handleDownloadTicketAttachment = useCallback(async (attachment: TicketAttachmentMeta) => {
    setAttachmentError(null);
    try {
      const full = await api.getTicketAttachment(activeTicket.id, attachment.id);
      if (!full?.file_data) {
        setAttachmentError('Attachment has no data');
        return;
      }
      const link = document.createElement('a');
      link.href = `data:${full.file_mimetype || 'application/octet-stream'};base64,${full.file_data}`;
      link.download = full.file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      setAttachmentError(err?.message || 'Download failed');
    }
  }, [activeTicket.id]);

  const handlePreviewTicketAttachment = useCallback(async (attachment: TicketAttachmentMeta) => {
    const mt = attachment.file_mimetype || '';
    const isImage = mt.startsWith('image/');
    const isVideo = mt.startsWith('video/');
    if (!isImage && !isVideo) {
      handleDownloadTicketAttachment(attachment);
      return;
    }
    setAttachmentError(null);
    try {
      const full = await api.getTicketAttachment(activeTicket.id, attachment.id);
      if (full?.file_data) {
        setImagePreview({
          src: `data:${full.file_mimetype};base64,${full.file_data}`,
          mimetype: full.file_mimetype,
        });
      }
    } catch (err: any) {
      setAttachmentError(err?.message || 'Preview failed');
    }
  }, [activeTicket.id, handleDownloadTicketAttachment]);

  // ─── Phase 3: typing emit (debounced) ─────────────────────────────────
  // Send is_typing=true on first keystroke; idle for TYPING_IDLE_MS triggers
  // is_typing=false. The throttle prevents flooding the SSE bus while still
  // refreshing the indicator before its TTL expires.
  const TYPING_IDLE_MS = 1500;
  const TYPING_REFRESH_MS = 4000; // resend "still typing" so other clients keep the badge alive
  const TYPING_TTL_MS = 6000;     // local sweep horizon (server emits no explicit clear if tab dies)
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingActiveRef = useRef(false);
  const lastTypingTicketIdRef = useRef<string | null>(null);

  const stopTypingEmit = useCallback((ticketId: string | null) => {
    if (typingIdleTimer.current) { clearTimeout(typingIdleTimer.current); typingIdleTimer.current = null; }
    if (typingRefreshTimer.current) { clearInterval(typingRefreshTimer.current); typingRefreshTimer.current = null; }
    if (typingActiveRef.current && ticketId) {
      typingActiveRef.current = false;
      api.setCommentTyping(ticketId, false, composeType !== 'note' ? composeType : undefined).catch(() => { /* fire-and-forget */ });
    }
  }, [composeType]);

  const handleComposeChange = useCallback((value: string) => {
    setCommentContent(value);
    const ticketId = activeTicket.id;
    lastTypingTicketIdRef.current = ticketId;
    if (!value.trim()) {
      // Empty buffer → user cleared / sent. Drop the indicator immediately.
      stopTypingEmit(ticketId);
      return;
    }
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      api.setCommentTyping(ticketId, true, composeType !== 'note' ? composeType : undefined).catch(() => { /* fire-and-forget */ });
      // Start refresh heartbeat while the typing flag stays on
      typingRefreshTimer.current = setInterval(() => {
        if (typingActiveRef.current) {
          api.setCommentTyping(ticketId, true, composeType !== 'note' ? composeType : undefined).catch(() => {});
        }
      }, TYPING_REFRESH_MS);
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(() => stopTypingEmit(ticketId), TYPING_IDLE_MS);
  }, [activeTicket.id, composeType, stopTypingEmit]);

  // On unmount or ticket switch, send a clean "stopped typing" so the other
  // viewers don't keep waiting on a TTL.
  useEffect(() => {
    return () => stopTypingEmit(lastTypingTicketIdRef.current);
  }, [stopTypingEmit]);
  useEffect(() => {
    if (lastTypingTicketIdRef.current && lastTypingTicketIdRef.current !== activeTicket.id) {
      stopTypingEmit(lastTypingTicketIdRef.current);
    }
  }, [activeTicket.id, stopTypingEmit]);

  // Tier-1 H: per-type notification mute. Hoisted above the comment_typing
  // handler because that handler reads mutedTypes — keeping the declaration
  // colocated with the chip filter (which would be a more natural home for
  // a future "filter chip + mute toggle" combo) would cause a TDZ error.
  // (chip = "show in the list", mute = "suppress signals like unread dots
  // and typing indicators"). A type can be visible-but-muted ("I'll read
  // chats when I scroll, just don't ping me about them") or hidden-but-
  // notified (rare, but the model supports it).
  const COMMENT_MUTE_LS_KEY = 'awb.commentTypeMuted';
  const [mutedTypes, setMutedTypes] = useState<Set<CommentType>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(COMMENT_MUTE_LS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const validKeys = new Set(Object.keys(COMMENT_TYPE_STYLES));
          return new Set(parsed.filter((t): t is CommentType => typeof t === 'string' && validKeys.has(t)));
        }
      }
    } catch { /* fall through */ }
    return new Set<CommentType>();
  });
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      localStorage.setItem(COMMENT_MUTE_LS_KEY, JSON.stringify(Array.from(mutedTypes)));
    } catch { /* ignore */ }
  }, [mutedTypes]);
  const toggleMute = useCallback((t: CommentType) => {
    setMutedTypes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }, []);
  const [notifMenuOpen, setNotifMenuOpen] = useState(false);

  // Subscribe to comment_typing events for the active ticket. Server already
  // suppresses self-echo, so anything we receive came from someone else.
  // Tier-1 H: drop the typist signal entirely when the typed comment_type
  // is muted — the user has opted out of being interrupted by chat-typing,
  // question-typing, etc.
  useBoardStreamEvent('comment_typing', useCallback((data: any) => {
    if (!data || data.ticket_id !== activeTicket.id) return;
    if (data.comment_type && mutedTypes.has(data.comment_type as CommentType)) return;
    if (data.is_typing) {
      setCommentTypists(prev => ({
        ...prev,
        [data.actor_id]: { name: data.actor_name || 'Someone', until: Date.now() + TYPING_TTL_MS },
      }));
    } else {
      setCommentTypists(prev => {
        if (!prev[data.actor_id]) return prev;
        const next = { ...prev };
        delete next[data.actor_id];
        return next;
      });
    }
  }, [activeTicket.id, mutedTypes]));

  // Periodic sweep so a typist whose tab died eventually disappears.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCommentTypists(prev => {
        let changed = false;
        const next: typeof prev = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v.until > now) next[k] = v; else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmitComment = async () => {
    if (!commentContent.trim() || commentSending) return;
    // When replying to a question, force type='answer' and link via parent_id.
    // The server auto-resolves the parent question on receipt (see
    // tickets.controller.addComment) so the OPEN pill flips to Resolved
    // without a follow-up call.
    const isReply = !!replyingTo;
    const submittedType: CommentType = isReply ? 'answer' : composeType;
    const baseOptions = isReply
      ? { type: 'answer' as const, parent_id: replyingTo!.id }
      : (composeType !== 'note' ? { type: composeType } : undefined);

    // Upload-first: turn every staged file into a Resource, then the comment
    // POST carries only attachment_resource_ids — never the bytes. This is the
    // fix for the 10MB JSON-body 413 that silently dropped video comments
    // (ticket ff3e7337). If any upload fails, abort with a clear toast and keep
    // the staged items so the user can retry instead of losing the comment.
    let resourceIds: string[] = [];
    if (commentAttachments.length > 0) {
      const ws = (activeTicket as any).workspace_id || workspaceId;
      if (!ws) { showToast('워크스페이스를 확인할 수 없어 첨부를 업로드할 수 없습니다.', 'error'); return; }
      setCommentSending(true);
      try {
        for (const att of commentAttachments) {
          if (att.resourceId) { resourceIds.push(att.resourceId); continue; }
          if (att.file) {
            const uploaded = await api.uploadResourceFile(att.file, {
              workspace_id: ws,
              board_id: currentBoardId || null,
              type: 'comment_attachment',
            });
            resourceIds.push(uploaded.id);
          }
        }
      } catch (err: any) {
        setCommentSending(false);
        showToast(`첨부 업로드 실패: ${err?.message || 'unknown error'}`, 'error');
        return; // keep staged attachments + comment text for retry
      }
      setCommentSending(false);
    }

    const options = resourceIds.length > 0
      ? { ...(baseOptions || {}), attachment_resource_ids: resourceIds }
      : baseOptions;

    onAddComment(
      activeTicket.id,
      commentContent.trim(),
      undefined, // bytes never travel in the comment POST anymore
      options,
    );
    // Revoke any object URLs we created for file previews.
    for (const att of commentAttachments) {
      if (att.file && att.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(att.previewUrl); } catch { /* noop */ }
      }
    }
    setCommentContent('');
    setCommentAttachments([]);
    // Reset to the default type after each send so a one-off Question doesn't
    // sticky-set the compose mode.
    setComposeType('note');
    // Drop reply context so the next comment isn't accidentally an answer too.
    setReplyingTo(null);
    // Clear typing indicator immediately on submit (otherwise the just-sent
    // comment would land alongside a "still typing" footer).
    stopTypingEmit(activeTicket.id);
    // Auto-enable the chip for the type we just submitted, otherwise the new
    // row would land in the timeline but be hidden by the active filter.
    setActiveTypes(prev => {
      if (prev.has(submittedType)) return prev;
      const next = new Set(prev);
      next.add(submittedType);
      return next;
    });
  };

  // ─── Tier-1 E: ticket-presence heartbeat + subscription ──────────────
  // Ping every 15s while this panel is mounted so the server's 30s TTL
  // stays refreshed. Seed-fire immediately so the badge paints on first
  // render without a 15s wait.
  useEffect(() => {
    const ticketId = activeTicket.id;
    let cancelled = false;
    const ping = () => {
      api.pingTicketPresence(ticketId).catch(() => { /* best-effort */ });
    };
    ping();
    const interval = setInterval(() => { if (!cancelled) ping(); }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      // Best-effort explicit leave so the other viewers' badge clears
      // without waiting for TTL expiry. Fire-and-forget; we don't await.
      api.leaveTicketPresence(ticketId).catch(() => { /* ignore */ });
    };
  }, [activeTicket.id]);

  // ─── Tier-1 F: ticket read marker ────────────────────────────────────
  // Fetch last_read_at on mount/ticket-switch and snapshot it so the
  // unread cue in CommentList stays stable while the user reads. On
  // unmount/ticket-switch we POST a NOW marker so the next visit treats
  // anything posted while we were away as unread.
  const { markRead: markBadgeRead } = useNotifications();
  useEffect(() => {
    const ticketId = activeTicket.id;
    let cancelled = false;
    api.getTicketReadState(ticketId)
      .then(state => { if (!cancelled) setLastReadAt(state.last_read_at); })
      .catch(() => { if (!cancelled) setLastReadAt(null); });
    // Opening the panel already counts as "read up to here" for the badge
    // system. The server marker is still written on unmount below, but
    // clearing the sidebar badge immediately makes the UI feel right.
    markBadgeRead('tickets', ticketId);
    return () => {
      cancelled = true;
      // Mark the ticket read up to NOW. Server is monotonic so a
      // concurrent tab having marked further forward is preserved.
      api.markTicketRead(ticketId).catch(() => { /* ignore */ });
    };
  }, [activeTicket.id, markBadgeRead]);

  // Subscribe to ticket_presence events scoped to the currently active ticket.
  // Server emits only on transitions, so this is low-traffic.
  useBoardStreamEvent('ticket_presence', useCallback((data: any) => {
    if (!data || data.ticket_id !== activeTicket.id) return;
    const list = Array.isArray(data.viewers) ? data.viewers : [];
    setPresenceViewers(list);
  }, [activeTicket.id]));

  // Drop stale viewer list when switching tickets (don't show last ticket's
  // viewers while the first ticket_presence event for the new ticket arrives).
  useEffect(() => { setPresenceViewers([]); }, [activeTicket.id]);

  // Best-effort leave on page unload. Uses a POST body with is_active:false
  // — sendBeacon is the only fetch variant guaranteed to deliver from an
  // unload handler, but fetch keepalive works in modern browsers too.
  useEffect(() => {
    const onUnload = () => {
      try {
        const token = localStorage.getItem('auth_token');
        const wsId = getActiveWorkspaceId();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (wsId) headers['X-Workspace-Id'] = wsId;
        const baseUrl = window.location.hostname === 'localhost'
          ? `${window.location.protocol}//${window.location.hostname}:7701`
          : '';
        // Beacon can't set headers reliably, so prefer fetch keepalive.
        fetch(`${baseUrl}/api/tickets/${activeTicket.id}/presence`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ is_active: false }),
          keepalive: true,
        }).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [activeTicket.id]);

  const handleStartReply = useCallback((commentId: string) => {
    const target = mergedComments.find(c => c.id === commentId);
    if (!target) return;
    setReplyingTo({
      id: target.id,
      preview: (target.content || '').slice(0, 120),
      author: target.author || 'Someone',
    });
  }, [mergedComments]);

  // Drop reply context when the user navigates to a different ticket so the
  // banner can't outlive the question it points at.
  useEffect(() => { setReplyingTo(null); }, [activeTicket.id]);

  // Type-filter state — Set so toggling is O(1). Defaults exclude 'system' so
  // the previous behavior (no audit-log noise in the timeline) is preserved.
  // Persisted to localStorage under a stable key so the user's last selection
  // survives ticket switches and reloads. Bad/missing payloads fall back to
  // defaults; type narrowing happens against COMMENT_TYPE_STYLES to avoid a
  // future enum addition silently surfacing rogue values.
  const COMMENT_FILTER_LS_KEY = 'awb.commentTypeFilter';
  const [activeTypes, setActiveTypes] = useState<Set<CommentType>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(COMMENT_FILTER_LS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const validKeys = new Set(Object.keys(COMMENT_TYPE_STYLES));
          const safe = parsed.filter((t): t is CommentType => typeof t === 'string' && validKeys.has(t));
          if (safe.length > 0) return new Set(safe);
        }
      }
    } catch { /* localStorage disabled / quota / corrupt JSON — fall through */ }
    return defaultVisibleTypes();
  });
  // Persist on every change. Cheap (small array) and we want the next ticket
  // panel mount on the same browser to see the latest selection without a
  // round-trip.
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      localStorage.setItem(COMMENT_FILTER_LS_KEY, JSON.stringify(Array.from(activeTypes)));
    } catch { /* ignore — non-critical */ }
  }, [activeTypes]);

  // Filter comments by current chip selection. Two axes:
  //   • author_type === 'system' → routed through the 'system' chip even if
  //     the row is legacy and has type='note' (older system rows pre-Phase 1).
  //   • everything else → routed through its CommentType.
  // Plus: if a row's parent is hidden by the current filter, the row drops
  // out too. Collapsing the whole thread when the question chip turns off
  // matches user intent ("hide the conversation, not just one half of it").
  // Replies whose parent is missing from the dataset entirely (true orphans,
  // e.g. parent deleted) still pass — CommentList renders them at top level.
  const filteredComments = useMemo(() => {
    const all = mergedComments;
    const byId = new Map<string, typeof all[number]>();
    for (const c of all) byId.set(c.id, c);
    const visibleByOwnType = (c: typeof all[number]): boolean => {
      if (c.author_type === 'system') return activeTypes.has('system');
      return activeTypes.has(resolveCommentType(c.type as string | null | undefined));
    };
    return all.filter(c => {
      if (!visibleByOwnType(c)) return false;
      if (c.parent_id) {
        const parent = byId.get(c.parent_id);
        // Parent exists but is filtered out → hide this row too. Parent
        // missing from the dataset → keep this row (true orphan).
        if (parent && !visibleByOwnType(parent)) return false;
      }
      return true;
    });
  }, [mergedComments, activeTypes]);

  // Counts per type — drives chip badge ("3" beside Question, etc.) so the
  // user can see at a glance which buckets have content.
  const typeCounts = useMemo(() => {
    const counts: Record<CommentType, number> = {
      note: 0, question: 0, answer: 0, decision: 0, chat: 0, system: 0, handoff: 0,
    };
    // 페이지네이션 이후 칩 카운트는 "현재 로드된" 코멘트 기준이다. 더 오래된
    // 코멘트를 스크롤 로드하면 값이 올라간다(전체 카운트를 위해 트리 전체를
    // 메모리에 올리는 건 이 티켓의 목적과 정면충돌하므로 의도적 선택).
    for (const c of mergedComments) {
      if (c.author_type === 'system') {
        counts.system += 1;
      } else {
        counts[resolveCommentType(c.type as string | null | undefined)] += 1;
      }
    }
    return counts;
  }, [mergedComments]);

  // Tab badge stays filter-independent — toggling chips shouldn't change "how
  // many comments this ticket has". System rows still excluded so the badge
  // reflects user-relevant volume. 페이지네이션으로 "로드된" 수만 세므로, 더
  // 오래된 코멘트가 남아 있으면 `+` 를 붙여(activeHasMore) 부분 카운트임을 표시.
  const userCommentCount = mergedComments.filter(c => c.author_type !== 'system').length;

  const toggleType = useCallback((t: CommentType) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }, []);

  const labelStyle = {
    fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
    textTransform: 'uppercase' as const, display: 'block', marginBottom: 4,
  };

  const renderCommentInput = () => (
    <div>
      {/* Reply banner — visible only while answering a question. Forces
         type='answer' on submit (see handleSubmitComment) so the user can't
         accidentally choose a different type while in reply mode. */}
      {replyingTo && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
          padding: '6px 10px', borderRadius: tokens.radii.md,
          background: tokens.colors.surfaceSubtle,
          border: `1px solid ${tokens.colors.info}`,
          borderLeft: `3px solid ${tokens.colors.info}`,
        }}>
          <span style={{
            fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
            background: 'transparent', color: tokens.colors.infoLight,
            border: `1px solid ${tokens.colors.info}`, textTransform: 'uppercase', letterSpacing: 0.4,
          }}>{'\u2192'} Answering</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: '11px', color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: tokens.colors.textDisabled, fontWeight: 600 }}>{replyingTo.author}:</span>{' '}
            {replyingTo.preview}
          </div>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            title="Cancel reply"
            style={{
              background: 'transparent', border: 'none', color: tokens.colors.textMuted,
              cursor: 'pointer', fontSize: '14px', padding: '0 4px',
            }}
          >{'\u2715'}</button>
        </div>
      )}
      {/* Compose type selector — hidden in reply mode since the type is locked
         to 'answer'. Otherwise: segmented control of composable types. */}
      {!replyingTo && (
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        {ALL_COMMENT_TYPES.filter(t => COMMENT_TYPE_STYLES[t].composable).map(t => {
          const tstyle = COMMENT_TYPE_STYLES[t];
          const active = composeType === t;
          return (
            <button
              key={`compose-${t}`}
              type="button"
              onClick={() => setComposeType(t)}
              title={`Post as ${tstyle.label}`}
              aria-pressed={active}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: tokens.radii.sm,
                fontSize: '11px', fontWeight: 600,
                background: active ? tstyle.bg : 'transparent',
                color: active ? tstyle.text : tokens.colors.textMuted,
                border: `1px solid ${active ? tstyle.border : tokens.colors.border}`,
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.4,
              }}
            >
              <span aria-hidden="true">{tstyle.icon}</span>
              <span>{tstyle.label}</span>
            </button>
          );
        })}
      </div>
      )}
      {commentAttachments.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
          {commentAttachments.map((att) => {
            const mt = att.file_mimetype || '';
            const isImage = mt.startsWith('image/');
            const isVideo = mt.startsWith('video/');
            const src = att.previewUrl;
            return (
              <div key={att.key} style={{ position: 'relative' }} title={att.resourceId ? `${att.file_name} (기존 리소스 참조)` : att.file_name}>
                {att.resourceId && (
                  <span aria-hidden="true" style={{
                    position: 'absolute', bottom: -2, left: -2, zIndex: 1,
                    background: tokens.colors.info, color: 'white', fontSize: '8px',
                    fontWeight: 700, padding: '0 3px', borderRadius: tokens.radii.sm,
                  }}>REF</span>
                )}
                {isImage ? (
                  <img
                    src={src}
                    alt={att.file_name}
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}` }}
                  />
                ) : isVideo ? (
                  <div
                    title={att.file_name}
                    style={{
                      width: 60, height: 44, borderRadius: tokens.radii.sm,
                      border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
                      position: 'relative', background: '#000',
                    }}
                  >
                    <video
                      src={src}
                      muted
                      playsInline
                      preload="metadata"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        color: 'rgba(255,255,255,0.85)', fontSize: '14px',
                        textShadow: '0 0 4px rgba(0,0,0,0.7)', pointerEvents: 'none',
                      }}
                    >▶</span>
                  </div>
                ) : (
                  <div
                    title={att.file_name}
                    style={{
                      width: 120, maxWidth: 180, height: 44, padding: '4px 6px',
                      borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}`,
                      background: tokens.colors.surfaceCard, color: tokens.colors.textSecondary,
                      display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px',
                      overflow: 'hidden',
                    }}
                  >
                    <span style={{ fontSize: '14px' }}>📎</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.file_name}</span>
                  </div>
                )}
                <button onClick={() => removeStagedAttachment(att.key)}
                  style={{ position: 'absolute', top: -4, right: -4, background: tokens.colors.danger, color: 'white', border: 'none', borderRadius: tokens.radii.full, width: 16, height: 16, fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 5 }}>
        <button onClick={handleAttach} disabled={commentSending} title="파일 첨부 (업로드)" style={{
          background: tokens.colors.border, color: tokens.colors.textMuted, border: 'none', borderRadius: tokens.radii.md,
          padding: '5px 9px', fontSize: '13px', cursor: commentSending ? 'not-allowed' : 'pointer',
        }}>&#128206;</button>
        <button onClick={openResourcePicker} disabled={commentSending} title="기존 리소스 참조 첨부" style={{
          background: tokens.colors.border, color: tokens.colors.textMuted, border: 'none', borderRadius: tokens.radii.md,
          padding: '5px 9px', fontSize: '13px', cursor: commentSending ? 'not-allowed' : 'pointer',
        }}>&#128193;</button>
        <MentionTextarea
          rows={1}
          value={commentContent}
          onChange={handleComposeChange}
          candidates={mentionCandidates}
          onSubmit={handleSubmitComment}
          placeholder={user ? `${user.name}(으)로 댓글 작성... (@로 태그)` : 'Write a comment... (@ to tag)'}
          ariaLabel="Comment"
          style={{
            width: '100%', background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
            padding: '5px 10px', color: tokens.colors.textStrong, fontSize: '12px', outline: 'none',
            resize: 'none', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box',
          }}
        />
        <button onClick={handleSubmitComment} disabled={!commentContent.trim() || commentSending} style={{
          background: (commentContent.trim() && !commentSending) ? tokens.colors.accent : tokens.colors.border, color: 'white', border: 'none', borderRadius: tokens.radii.md,
          padding: '5px 12px', fontSize: '12px', fontWeight: 600, cursor: (commentContent.trim() && !commentSending) ? 'pointer' : 'not-allowed',
        }}>{commentSending ? '업로드…' : 'Send'}</button>
      </div>
      {resourcePickerOpen && (
        <ResourceReferencePicker
          loading={resourcePickerLoading}
          error={resourcePickerError}
          items={resourcePickerItems}
          onPick={addResourceReference}
          onClose={() => setResourcePickerOpen(false)}
        />
      )}
    </div>
  );

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: tokens.colors.surface, borderLeft: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: `1px solid ${tokens.colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {navStack.length > 1 && (
            <button onClick={handleBack} style={{
              background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
              padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
            }}>&#8592; Back</button>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={handleCopyId}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopyId(); }
            }}
            title={idCopied ? '복사됨!' : '클릭하여 Ticket ID 복사'}
            aria-label={`Ticket ID ${activeTicket.id}, 클릭하여 클립보드에 복사`}
            style={{
              fontSize: '11px', padding: '3px 8px', borderRadius: 4,
              background: idCopied ? tokens.colors.successBg : tokens.colors.surfaceCard,
              color: idCopied ? tokens.colors.successLight : tokens.colors.textMuted, fontWeight: 500,
              cursor: 'pointer', userSelect: 'none',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >#{activeTicket.id}</span>
          <span style={{
            fontSize: '11px', padding: '3px 8px', borderRadius: 4,
            background: tokens.colors.surfaceCard, color: tokens.colors.textMuted,
          }}>{columnName}</span>
          {/* Tier-1 G stale-question badge in the panel header. Same threshold
             as the board card so a ticket marked stale on the board stays
             marked once you open it — no surprise mismatch. */}
          {(activeTicket.has_stale_open_question ?? hasStaleOpenQuestion(mergedComments)) && (
            <span
              title="An open question on this ticket has been waiting >24h"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 20, height: 20, borderRadius: '50%',
                background: tokens.colors.warningBg, color: tokens.colors.warningLight,
                fontSize: '12px', fontWeight: 700,
                border: `1px solid ${tokens.colors.warning}`,
              }}
              aria-label="Stale open question"
            >?</span>
          )}
          {/* Tier-1 E presence — show other viewers (exclude self) as small
             avatar pills. Capped at 3 visible + "+N" overflow so a noisy
             ticket doesn't blow out the header row. Title attribute lists
             everyone for hover-disclosure. */}
          {(() => {
            const others = presenceViewers.filter(v => !(v.type === 'user' && user && v.id === user.id));
            if (others.length === 0) return null;
            const visible = others.slice(0, 3);
            const overflow = others.length - visible.length;
            const title = `Currently viewing: ${others.map(v => v.name || v.id).join(', ')}`;
            return (
              <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {visible.map(v => (
                  <span key={`pres-${v.type}-${v.id}`} style={{
                    width: 18, height: 18, borderRadius: '50%',
                    background: v.type === 'agent' ? tokens.colors.accent : tokens.colors.info,
                    color: 'white', fontSize: '9px', fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${tokens.colors.surface}`,
                    marginLeft: -4,
                  }}>{(v.name || '?').charAt(0).toUpperCase()}</span>
                ))}
                {overflow > 0 && (
                  <span style={{
                    fontSize: '10px', color: tokens.colors.textMuted, marginLeft: 4,
                  }}>+{overflow}</span>
                )}
              </span>
            );
          })()}
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
          <button
            onClick={() => setTriggerMenuOpen(v => !v)}
            title="Manually wake an agent on this ticket (bypasses cooldown)"
            style={{
              background: tokens.colors.surfaceCard,
              color: tokens.colors.accentMid,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>⚡</span>
            <span>Trigger</span>
          </button>
          <TriggerMenu
            open={triggerMenuOpen}
            onClose={() => setTriggerMenuOpen(false)}
            roleTargets={(workspaceRoles || []).slice().sort((a, b) => a.position - b.position).map(r => {
              const row = roleAssignments.find(x => x.role.id === r.id);
              const holder = row?.holder || null;
              // Trigger only fires for agent holders — user holders aren't
              // wakeable (no agent endpoint to call). Mark hasAgent
              // accordingly so the menu disables them with the same "unassigned"
              // visual cue.
              // ST-7: when the holder is an agent, prefer the display
              // name from the loaded agents list (which carries
              // manager_name) over the bare name in the assignment row
              // payload — keeps managed agents rendered as
              // <ManagerName>/<AgentName> in the trigger menu too.
              const fullAgent = holder?.type === 'agent' && holder?.id
                ? agents.find(a => a.id === holder.id)
                : null;
              const holderDisplay = fullAgent
                ? formatAgentDisplayName(fullAgent)
                : (holder?.name || (holder ? holder.id : 'unassigned'));
              return {
                slug: r.slug,
                label: r.name,
                holderName: holderDisplay,
                hasAgent: holder?.type === 'agent',
              };
            })}
            busy={retriggering}
            onPick={(slug, label, holderName) => handleRetrigger(slug, label, holderName)}
          />
          {/* Move-to-board action — only meaningful for root tickets, since
             children carry no column_id and inherit the board through their
             parent. Hidden when no handler is wired (legacy callers). */}
          {onMoveToBoard && activeTicket.depth === 0 && !activeTicket.parent_id && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={handleOpenMoveBoardMenu}
                disabled={movingToBoard}
                title="Move this ticket (and its subtasks) to a different board"
                style={{
                  background: tokens.colors.surfaceCard,
                  color: tokens.colors.textSecondary,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '4px 12px',
                  fontSize: '12px',
                  cursor: movingToBoard ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span>📋</span>
                <span>{movingToBoard ? 'Moving…' : 'Move to…'}</span>
              </button>
              <MoveToBoardMenu
                open={moveBoardMenuOpen}
                onClose={() => setMoveBoardMenuOpen(false)}
                boards={moveBoardOptions}
                loading={moveBoardLoading}
                busy={movingToBoard}
                onPick={(boardId, columnId) => handleMoveToBoard(boardId, columnId)}
              />
            </div>
          )}
          <button onClick={() => { onDelete(activeTicket.id); onClose(); }} style={{
            background: tokens.colors.dangerBg, color: tokens.colors.dangerLight, border: 'none', borderRadius: tokens.radii.md,
            padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
          }}>Delete</button>
          <button onClick={requestClose} style={{
            background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
            padding: '4px 12px', fontSize: '16px', cursor: 'pointer',
          }}>x</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0 }}>
        {(['detail', 'comments', 'activity', 'user'] as const).map(tab => {
          // Pending-user-action highlight on the User tab (ticket a57517be).
          // Pulses warning-coloured when the ticket needs intervention so the
          // user spots it the moment the panel opens — matches the badge
          // styling on the TicketCard for visual continuity.
          const isUserTabPending = tab === 'user' && !!activeTicket.pending_user_action;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={isUserTabPending && activeTab !== 'user' ? 'awb-pending-pulse' : undefined}
              style={{
                padding: '8px 16px',
                background: isUserTabPending && activeTab !== 'user' ? tokens.colors.warningBg : 'transparent',
                border: 'none',
                borderBottom: activeTab === tab
                  ? `2px solid ${isUserTabPending ? tokens.colors.warning : tokens.colors.accent}`
                  : '2px solid transparent',
                color: activeTab === tab
                  ? (isUserTabPending ? tokens.colors.warningLight : tokens.colors.textStrong)
                  : (isUserTabPending ? tokens.colors.warningLight : tokens.colors.textSecondary),
                fontSize: '12px', fontWeight: isUserTabPending ? 700 : 600,
                cursor: 'pointer', textTransform: 'capitalize',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {tab}
              {tab === 'comments' && userCommentCount > 0 && (
                <span style={{
                  fontSize: '10px', background: tokens.colors.border, color: tokens.colors.textMuted,
                  borderRadius: 8, padding: '1px 5px', fontWeight: 700,
                }}>{userCommentCount}{activeHasMore ? '+' : ''}</span>
              )}
              {tab === 'user' && activeTicket.pending_user_action && (
                <span aria-hidden="true" style={{ fontSize: '11px' }}>⏸</span>
              )}
              {/* Blocked-by-tickets indicator (ticket 48d14fff) — shown only
                  when the ticket is blocked on prereqs but NOT also pending a
                  human (the ⏸ above already covers the human case). The chain
                  link nudges the user toward the Prerequisites section on the
                  Detail tab. */}
              {tab === 'user' && activeTicket.pending_on_tickets && !activeTicket.pending_user_action && (
                <span aria-hidden="true" title="Blocked by prerequisite tickets" style={{ fontSize: '11px', color: tokens.colors.info }}>⛓</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'detail' ? (
          <>
            {/* Title */}
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              style={{
                width: '100%', background: 'transparent', border: 'none', color: tokens.colors.textPrimary,
                fontSize: '18px', fontWeight: 700, outline: 'none', marginBottom: 14,
              }}
            />

            {/* Meta row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Priority</label>
                <select
                  value={priority}
                  onChange={e => setPriority(e.target.value as any)}
                  style={{
                    background: tokens.colors.surfaceCard, border: `2px solid ${priorityColors[priority]}`,
                    borderRadius: tokens.radii.md, padding: '5px 8px',
                    color: priorityColors[priority], fontSize: '12px', fontWeight: 600, width: '100%',
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              {/* Effort preset — abstract effort option the board resolves
                  per-CLI at dispatch. '' maps to null = board default. */}
              <div>
                <label style={labelStyle}>Effort preset</label>
                <select
                  value={effortPreset}
                  onChange={e => setEffortPreset(e.target.value)}
                  style={{
                    background: tokens.colors.surfaceCard, border: `2px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md, padding: '5px 8px',
                    color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 600, width: '100%',
                  }}
                >
                  <option value="">(board default)</option>
                  {parseEffortPresetList(effortPresets).map(p => (
                    <option key={p.id} value={p.id}>{p.label || p.id}</option>
                  ))}
                </select>
              </div>

              {(() => {
                // One cell per workspace role, sorted by position. MULTI-HOLDER
                // (T6): each role is a chip picker — existing holders render as
                // removable chips and an "add" dropdown appends more (agents or
                // users). A single holder looks like one chip (no regression).
                const sortedRoles = (workspaceRoles || []).slice()
                  .sort((a, b) => a.position - b.position);
                if (sortedRoles.length === 0) {
                  return (
                    <div style={{ gridColumn: '1 / span 2', fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                      No workspace roles yet — configure roles in workspace settings.
                    </div>
                  );
                }
                // Agent Manager(type='manager')는 역할 담당자가 될 수 없다 (ticket 941c72d3) — 후보에서 숨김.
                const activeAgents = (agents || []).filter(a => a.is_active && a.type !== 'manager');
                const activeUsers = users || [];
                const editable = !!onSetRoleAssignment && !savingDraft;
                return sortedRoles.map(role => {
                  // Effective holder set = buffered draft (if any) else the live
                  // holders. A draft is the role's FULL desired holder set.
                  const draft = roleDrafts[role.id];
                  const effective: HolderDraft[] = draft
                    ? draft
                    : (holdersByRoleId.get(role.id) || []).map(holderToDraft);
                  const heldKeys = new Set(effective.map(holderDraftKey).filter(Boolean));

                  const nameOf = (h: HolderDraft): string => {
                    if (h.agent_id) {
                      const a = (agents || []).find(x => x.id === h.agent_id);
                      if (a) return formatAgentDisplayName(a);
                      // Cross-workspace holder: not in the ws-scoped agents
                      // list. Fall back to the server-resolved display name
                      // (workspace-independent) instead of leaking the raw id.
                      return resolvedHolderNameById.get(h.agent_id) || h.agent_id;
                    }
                    if (h.user_id) {
                      const u = (users || []).find(x => x.id === h.user_id);
                      if (u) return (u.name || u.email);
                      return resolvedHolderNameById.get(h.user_id) || h.user_id;
                    }
                    return '?';
                  };
                  const commit = (next: HolderDraft[]) => setRoleDrafts(prev => ({ ...prev, [role.id]: next }));
                  const removeHolder = (h: HolderDraft) =>
                    commit(effective.filter(e => holderDraftKey(e) !== holderDraftKey(h)));
                  const addFromValue = (raw: string) => {
                    if (!raw) return;
                    const h: HolderDraft = raw.startsWith('agent:')
                      ? { agent_id: raw.slice(6), user_id: null }
                      : { agent_id: null, user_id: raw.slice(5) };
                    const key = holderDraftKey(h);
                    if (!key || heldKeys.has(key)) return;
                    commit([...effective, h]);
                  };
                  const addableAgents = activeAgents.filter(a => !heldKeys.has(`agent:${a.id}`));
                  const addableUsers = activeUsers.filter(u => !heldKeys.has(`user:${u.id}`));

                  return (
                    <div key={role.id}>
                      <label style={labelStyle}>
                        {role.name}
                        {effective.length >= 2 && (
                          <span style={{ marginLeft: 6, fontSize: '10px', color: tokens.colors.accentLight, fontWeight: 700 }}>
                            ×{effective.length}
                          </span>
                        )}
                      </label>
                      <div
                        title={role.description || ''}
                        style={{
                          display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
                          background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md, padding: '4px 6px', minHeight: 30,
                        }}
                      >
                        {effective.length === 0 && (
                          <span style={{ fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>Unassigned</span>
                        )}
                        {effective.map(h => (
                          <span
                            key={holderDraftKey(h)}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              background: h.agent_id ? `${tokens.colors.accent}20` : `${tokens.colors.info}20`,
                              color: tokens.colors.textStrong, fontSize: '11px', fontWeight: 600,
                              borderRadius: tokens.radii.sm, padding: '2px 4px 2px 8px',
                            }}
                          >
                            {nameOf(h)}
                            {editable && (
                              <button
                                type="button"
                                aria-label={`remove ${nameOf(h)}`}
                                onClick={() => removeHolder(h)}
                                style={{
                                  background: 'transparent', border: 'none', color: tokens.colors.textSecondary,
                                  cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: 0,
                                }}
                              >×</button>
                            )}
                          </span>
                        ))}
                        {editable && (addableAgents.length > 0 || addableUsers.length > 0) && (
                          <select
                            value=""
                            onChange={e => { addFromValue(e.target.value); e.currentTarget.value = ''; }}
                            style={{
                              background: 'transparent', border: 'none', color: tokens.colors.accentMid,
                              fontSize: '11px', cursor: 'pointer', outline: 'none',
                            }}
                          >
                            <option value="">+ 추가…</option>
                            {addableAgents.length > 0 && (
                              <optgroup label="Agents">
                                {addableAgents.map(a => (
                                  <option key={`a-${a.id}`} value={`agent:${a.id}`}>{formatAgentDisplayName(a)}</option>
                                ))}
                              </optgroup>
                            )}
                            {addableUsers.length > 0 && (
                              <optgroup label="Users">
                                {addableUsers.map(u => (
                                  <option key={`u-${u.id}`} value={`user:${u.id}`}>{u.name || u.email}</option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* 다중담당자·합의 패널 (T6). 이탈(현재) 컬럼 라우팅 홀더가 ≥2 이거나
                열린 이동 제안이 있을 때만 렌더 — 단일홀더 티켓은 숨겨져 시각 회귀
                없음. 홀더별 agree/pending/object, 진행바, why-blocked, 이동 제안,
                (홀더면) 투표, (reporter면) override 를 노출한다. */}
            {(() => {
              if (!consensus) return null;
              const st = consensus.state;
              const showPanel = consensus.gate.holder_count >= 2 || !!consensus.proposal;
              if (!showPanel) return null;

              const keyOf = (p: ConsensusParty) => `${p.type}:${p.id}`;
              const agreedKeys = new Set(st.agreed.map(keyOf));
              const objectedKeys = new Set(st.objected.map(keyOf));
              const nameOfParty = (p: ConsensusParty): string => {
                const k = keyOf(p);
                if (consensus.names[k]) return consensus.names[k];
                if (p.type === 'agent') {
                  const a = (agents || []).find(x => x.id === p.id);
                  if (a) return formatAgentDisplayName(a);
                } else {
                  const u = (users || []).find(x => x.id === p.id);
                  if (u) return u.name || u.email;
                }
                return p.id.slice(0, 8);
              };
              const statusOf = (p: ConsensusParty): 'agree' | 'object' | 'pending' =>
                agreedKeys.has(keyOf(p)) ? 'agree' : objectedKeys.has(keyOf(p)) ? 'object' : 'pending';

              // 현재 유저가 required 홀더인지 / reporter 홀더인지 → vote / override 노출.
              const myKey = user ? `user:${user.id}` : '';
              const iAmRequired = !!myKey && st.required.some(p => keyOf(p) === myKey);
              const reporterRole = (workspaceRoles || []).find(r => r.slug === 'reporter');
              const reporterHolderKeys = reporterRole
                ? new Set((holdersByRoleId.get(reporterRole.id) || []).map(h => `${h.type}:${h.id}`))
                : new Set<string>();
              const iAmReporter = !!myKey && reporterHolderKeys.has(myKey);

              const proposalId = consensus.proposal?.proposal_id || st.proposalId || null;
              const requiredCount = st.required.length;
              const agreedCount = st.agreed.length;
              const pct = requiredCount > 0 ? Math.round((agreedCount / requiredCount) * 100) : 0;
              const targetCols = (boardColumns || []).filter(c => c.id !== activeTicket.column_id);

              const statusStyle: Record<string, { bg: string; fg: string; label: string }> = {
                agree: { bg: `${tokens.colors.success}22`, fg: tokens.colors.successLight, label: '동의' },
                object: { bg: `${tokens.colors.danger}22`, fg: tokens.colors.dangerLight, label: '이의' },
                pending: { bg: `${tokens.colors.border}55`, fg: tokens.colors.textMuted, label: '대기' },
              };

              const doVote = async (status: 'agree' | 'object', override = false) => {
                if (consensusBusy) return;
                setConsensusBusy(true);
                try {
                  const r = await api.recordTicketConsensusVote(activeTicket.id, {
                    status, proposal_id: proposalId || undefined, override,
                  });
                  await refreshConsensus();
                  if (r?.moved) showToast(`합의 성립 → '${r.moved.to_column_name || '이동'}' 자동 이동`, 'success');
                  else showToast(override ? 'Override 적용' : `시그널 기록: ${status}`, 'success');
                } catch (e: any) {
                  showToast(`실패: ${e?.message || 'unknown error'}`, 'error');
                } finally {
                  setConsensusBusy(false);
                }
              };
              const doPropose = async () => {
                if (consensusBusy || !proposeTarget) return;
                setConsensusBusy(true);
                try {
                  await api.proposeTicketMove(activeTicket.id, proposeTarget);
                  setProposeTarget('');
                  await refreshConsensus();
                  showToast('이동 제안 등록 — 전 홀더 동의 시 자동 이동', 'success');
                } catch (e: any) {
                  showToast(`제안 실패: ${e?.message || 'unknown error'}`, 'error');
                } finally {
                  setConsensusBusy(false);
                }
              };

              const headerBadge = st.satisfied
                ? { bg: `${tokens.colors.success}22`, fg: tokens.colors.successLight, label: st.overriddenBy ? '합의(override)' : '합의 성립' }
                : consensus.gate.blocked
                  ? { bg: `${tokens.colors.warning}22`, fg: tokens.colors.warningLight, label: '합의 필요' }
                  : { bg: `${tokens.colors.border}55`, fg: tokens.colors.textSecondary, label: '진행 중' };

              return (
                <div style={{
                  border: `1px solid ${tokens.colors.accent}55`, borderRadius: tokens.radii.md,
                  padding: '10px 12px', marginBottom: 14, background: `${tokens.colors.accent}0d`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: tokens.colors.textStrong }}>
                      합의 <span style={{ color: tokens.colors.textMuted, fontWeight: 500 }}>· 다중담당자 {requiredCount}명</span>
                    </span>
                    <span style={{
                      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                      background: headerBadge.bg, color: headerBadge.fg, padding: '2px 8px', borderRadius: tokens.radii.sm,
                    }}>{headerBadge.label}</span>
                  </div>

                  {/* 열린 이동 제안 */}
                  {consensus.proposal && (
                    <div style={{ fontSize: '11px', color: tokens.colors.textSecondary, marginBottom: 8 }}>
                      이동 제안: <strong style={{ color: tokens.colors.accentLight }}>{columnName || '현재'}</strong>
                      {' → '}
                      <strong style={{ color: tokens.colors.accentLight }}>{consensus.proposal.target_column_name || '대상'}</strong>
                      {' '}(by {nameOfParty(consensus.proposal.by)})
                    </div>
                  )}

                  {/* 진행바 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ flex: 1, height: 6, background: `${tokens.colors.border}66`, borderRadius: tokens.radii.xs, overflow: 'hidden' }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: st.satisfied ? tokens.colors.successLight : tokens.colors.accent,
                        borderRadius: tokens.radii.xs, transition: 'width 0.2s',
                      }} />
                    </div>
                    <span style={{ fontSize: '11px', color: tokens.colors.textSecondary, fontWeight: 600 }}>
                      동의 {agreedCount}/{requiredCount}
                    </span>
                  </div>

                  {/* 홀더별 상태 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: consensus.gate.blocked ? 8 : 0 }}>
                    {st.required.map(p => {
                      const s = statusOf(p);
                      const ss = statusStyle[s];
                      return (
                        <span key={keyOf(p)} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          background: ss.bg, color: ss.fg, fontSize: '11px', fontWeight: 600,
                          borderRadius: tokens.radii.sm, padding: '2px 8px',
                        }}>
                          {s === 'agree' ? '✓' : s === 'object' ? '✗' : '⋯'} {nameOfParty(p)}
                        </span>
                      );
                    })}
                  </div>

                  {/* why-blocked */}
                  {consensus.gate.blocked && (
                    <div style={{ fontSize: '11px', color: tokens.colors.warningLight, marginBottom: 8 }}>
                      이동 차단: {st.pending.length > 0 && `${st.pending.length}명 미투표`}
                      {st.pending.length > 0 && st.objected.length > 0 && ', '}
                      {st.objected.length > 0 && `${st.objected.length}명 이의`}
                      {' — 전원 동의 또는 reporter override 필요.'}
                    </div>
                  )}

                  {/* 액션: 이동 제안 (누구나) + 투표(홀더) + override(reporter) */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
                    {targetCols.length > 0 && (
                      <>
                        <select
                          value={proposeTarget}
                          disabled={consensusBusy}
                          onChange={e => setProposeTarget(e.target.value)}
                          style={{
                            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                            borderRadius: tokens.radii.sm, padding: '4px 6px', color: tokens.colors.textStrong, fontSize: '11px',
                          }}
                        >
                          <option value="">{consensus.proposal ? '다른 컬럼으로 제안…' : '이동 대상 컬럼…'}</option>
                          {targetCols.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button
                          type="button"
                          disabled={consensusBusy || !proposeTarget}
                          onClick={doPropose}
                          style={{
                            background: tokens.colors.accent, color: '#fff', border: 'none',
                            borderRadius: tokens.radii.sm, padding: '4px 10px', fontSize: '11px', fontWeight: 600,
                            cursor: consensusBusy || !proposeTarget ? 'not-allowed' : 'pointer', opacity: consensusBusy || !proposeTarget ? 0.6 : 1,
                          }}
                        >이동 제안</button>
                      </>
                    )}
                    {iAmRequired && proposalId && (
                      <>
                        <button
                          type="button" disabled={consensusBusy} onClick={() => doVote('agree')}
                          style={{
                            background: `${tokens.colors.success}22`, color: tokens.colors.successLight,
                            border: `1px solid ${tokens.colors.success}55`, borderRadius: tokens.radii.sm,
                            padding: '4px 10px', fontSize: '11px', fontWeight: 600, cursor: consensusBusy ? 'not-allowed' : 'pointer',
                          }}
                        >동의</button>
                        <button
                          type="button" disabled={consensusBusy} onClick={() => doVote('object')}
                          style={{
                            background: `${tokens.colors.danger}22`, color: tokens.colors.dangerLight,
                            border: `1px solid ${tokens.colors.danger}55`, borderRadius: tokens.radii.sm,
                            padding: '4px 10px', fontSize: '11px', fontWeight: 600, cursor: consensusBusy ? 'not-allowed' : 'pointer',
                          }}
                        >이의</button>
                      </>
                    )}
                    {iAmReporter && !st.satisfied && (
                      <button
                        type="button" disabled={consensusBusy} onClick={() => doVote('agree', true)}
                        title="reporter 권한으로 합의를 강제 통과시켜 즉시 이동합니다(감사 로그 기록)."
                        style={{
                          background: `${tokens.colors.warning}22`, color: tokens.colors.warningLight,
                          border: `1px solid ${tokens.colors.warning}66`, borderRadius: tokens.radii.sm,
                          padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: consensusBusy ? 'not-allowed' : 'pointer',
                        }}
                      >⚡ Override</button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Base repository / branch — pinned per-ticket so the assignee
                agent's `in_progress_workflow` cuts its feature branch from
                the right base instead of whatever the working_dir happens
                to be on. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Base Repository</label>
                <select
                  value={baseRepoId}
                  onChange={e => {
                    const next = e.target.value;
                    setBaseRepoId(next);
                    setBaseBranch('');
                  }}
                  style={{
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%', cursor: 'pointer',
                  }}
                >
                  <option value="">— None —</option>
                  {repoOptions.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>
                  Base Branch
                  {baseRepoId && branchesLoading ? ' · loading…' : ''}
                </label>
                <select
                  value={baseBranch}
                  disabled={!baseRepoId || branchesLoading}
                  onChange={e => setBaseBranch(e.target.value)}
                  style={{
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%',
                    cursor: !baseRepoId || branchesLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  <option value="">{baseRepoId ? '— Use repo default —' : '— Select repo first —'}</option>
                  {/* Pinned base_branch may not be in the live ls-remote list
                      (branch deleted upstream, or list still loading). Show
                      it anyway so the picker reflects the persisted value. */}
                  {baseBranch && !branchOptions.some(b => b.name === baseBranch) && (
                    <option value={baseBranch}>{baseBranch}</option>
                  )}
                  {branchOptions.map(b => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
                {branchesError && (
                  <div style={{ fontSize: '10px', color: tokens.colors.dangerLight, marginTop: 4 }}>
                    {branchesError}
                  </div>
                )}
              </div>
            </div>

            {/* Next Ticket — when this ticket lands on a terminal column,
                TriggerLoopService dispatches a `next_ticket` round for the
                linked ticket's CURRENT column's routing roles. Picker is
                drawn from boardTickets (excludes self + non-root tickets
                are already filtered out by Board.tsx). The server-hydrated
                next_ticket snapshot keeps the option visible even when the
                linked ticket lives outside the current board view. */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                Next Ticket
                {activeTicket.next_ticket?.column_name
                  ? ` · currently in ${activeTicket.next_ticket.column_name}`
                  : ''}
              </label>
              <select
                value={nextTicketId}
                onChange={e => setNextTicketId(e.target.value)}
                style={{
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                  padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%', cursor: 'pointer',
                }}
              >
                <option value="">— None —</option>
                {/* Persisted link comes first so it always renders, even if
                    the linked ticket lives on another board (boardTickets
                    only carries the current board) or the picker hasn't
                    received boardTickets yet. */}
                {activeTicket.next_ticket && !(boardTickets || []).some(t => t.id === activeTicket.next_ticket!.id) && (
                  <option value={activeTicket.next_ticket.id}>
                    {activeTicket.next_ticket.title}
                    {activeTicket.next_ticket.column_name ? ` (${activeTicket.next_ticket.column_name})` : ''}
                  </option>
                )}
                {(boardTickets || [])
                  .filter(t => t.id !== activeTicket.id)
                  .map(t => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
              </select>
            </div>

            {/* Cross-board handoff relay (ticket ac21a745). Root tickets only —
                a follow-up is created on the next functional board when this
                ticket completes, carrying its deliverable context. Also renders
                the read-only pipeline rollup for the relay this ticket is in.
                Reuses the move-to-board picker's lazily-loaded workspace boards. */}
            {activeTicket.depth === 0 && !activeTicket.parent_id && (
              <HandoffEditor
                ticket={activeTicket}
                boardOptions={moveBoardOptions}
                boardsLoading={moveBoardLoading}
                onEnsureBoards={loadMoveBoardOptions}
                value={handoffSpec}
                onChange={setHandoffSpec}
              />
            )}

            {/* Run on Done — per-ticket on-done action binding (ticket
                16a6339c, method "a"; picker reworked in 59afc55a). The bound
                actions are dispatched exactly ONCE when THIS ticket lands on a
                terminal column, and only for this ticket — independent of any
                board/label-scoped policy (method "b"). A bound action fires even
                if its own `trigger` is blank (manual); clearing the list clears
                the binding. enabled=false actions are skipped at dispatch, so
                they're shown disabled.

                Two regions: an ordered "selected" list (the array order is the
                dispatch order — reorder with ↑/↓) and an "add" candidate list.
                Candidates are scoped to this board + workspace-scoped actions;
                other boards' board-scoped actions are hidden (criterion a). An
                already-bound id that's out-of-scope or deleted still shows in
                the selected list so it can be unbound (criterion d). */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ ...labelStyle, marginBottom: 6 }}>
                Run on Done
                {onDoneActionIds.length > 0 ? ` · ${onDoneActionIds.length} bound` : ''}
              </label>
              <div style={{
                background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
                padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
              }}>
                {(() => {
                  // Candidate add-list scope (ticket 59afc55a, criterion a):
                  // workspace-scoped Actions (board_id null) + Actions on THIS
                  // ticket's board only. Board-scoped Actions belonging to a
                  // DIFFERENT board are excluded from the add list. We still
                  // keep `actionOptions` as the full workspace fetch so names
                  // resolve for already-bound ids (incl. out-of-scope/cross-board
                  // ones) in the selected list below (criterion d).
                  const inScope = (a: Action) => a.board_id == null || a.board_id === currentBoardId;
                  const actionById = new Map(actionOptions.map(a => [a.id, a]));
                  const candidates = actionOptions.filter(a => inScope(a) && !onDoneActionIds.includes(a.id));

                  // Reorder helper — moves the id at `from` to `to`, clamped.
                  // The array order IS the dispatch order, saved verbatim via
                  // update_ticket(on_done_action_ids=[...]) (criterion b/c).
                  const moveBound = (from: number, to: number) => {
                    setOnDoneActionIds(prev => {
                      if (to < 0 || to >= prev.length || from === to) return prev;
                      const next = [...prev];
                      const [moved] = next.splice(from, 1);
                      next.splice(to, 0, moved);
                      return next;
                    });
                  };

                  const iconBtnStyle = (disabled: boolean) => ({
                    flexShrink: 0,
                    background: 'transparent', border: 'none',
                    color: disabled ? tokens.colors.border : tokens.colors.textMuted,
                    fontSize: '12px', lineHeight: 1, padding: '0 3px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  });

                  return (
                    <>
                      {/* ── Selected actions (ordered, reorderable) ──────────
                          One row per bound id in dispatch order. Unknown ids
                          (deleted, or scoped out of the fetch) still render so
                          they can be unbound (criterion d). */}
                      {onDoneActionIds.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {onDoneActionIds.map((id, idx) => {
                            const act = actionById.get(id);
                            const targetAgent = act ? agents.find(a => a.id === act.target_agent_id) : undefined;
                            return (
                              <div key={id} style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '3px 5px', borderRadius: 4,
                                background: `${tokens.colors.accent}15`,
                              }}>
                                <span style={{
                                  flexShrink: 0, fontSize: '10px', fontWeight: 700,
                                  color: tokens.colors.textMuted, minWidth: 14, textAlign: 'right',
                                }}>{idx + 1}.</span>
                                {act ? (
                                  <>
                                    <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>
                                      {act.name}
                                    </span>
                                    {targetAgent && (
                                      <span style={{ fontSize: '10px', color: tokens.colors.textSecondary }}>
                                        → {formatAgentDisplayName(targetAgent)}
                                      </span>
                                    )}
                                    <span style={{ fontSize: '10px', color: act.enabled ? tokens.colors.textMuted : tokens.colors.warningLight, marginLeft: 'auto' }}>
                                      {act.enabled ? (act.board_id ? 'board' : 'workspace') : 'disabled — won’t fire'}
                                    </span>
                                  </>
                                ) : (
                                  <span style={{ fontSize: '12px', color: tokens.colors.textMuted, fontStyle: 'italic', marginRight: 'auto' }}>
                                    {id.slice(0, 8)}… (removed action)
                                  </span>
                                )}
                                <button
                                  type="button"
                                  title="Move up (earlier in dispatch order)"
                                  disabled={idx === 0}
                                  onClick={() => moveBound(idx, idx - 1)}
                                  style={iconBtnStyle(idx === 0)}
                                >↑</button>
                                <button
                                  type="button"
                                  title="Move down (later in dispatch order)"
                                  disabled={idx === onDoneActionIds.length - 1}
                                  onClick={() => moveBound(idx, idx + 1)}
                                  style={iconBtnStyle(idx === onDoneActionIds.length - 1)}
                                >↓</button>
                                <button
                                  type="button"
                                  title="Unbind this action"
                                  onClick={() => setOnDoneActionIds(prev => prev.filter(x => x !== id))}
                                  style={{ ...iconBtnStyle(false), fontSize: '14px' }}
                                >×</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* ── Add candidates ───────────────────────────────────
                          Scoped to current board + workspace; clicking appends
                          to the end of the dispatch order. */}
                      {candidates.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: onDoneActionIds.length > 0 ? 6 : 0 }}>
                          {onDoneActionIds.length > 0 && (
                            <div style={{ fontSize: '10px', color: tokens.colors.textMuted, fontWeight: 600, padding: '0 4px' }}>
                              Add an action
                            </div>
                          )}
                          {candidates.map(act => {
                            const targetAgent = agents.find(a => a.id === act.target_agent_id);
                            return (
                              <button
                                key={act.id}
                                type="button"
                                onClick={() => setOnDoneActionIds(prev => [...prev, act.id])}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                                  padding: '3px 5px', borderRadius: 4, textAlign: 'left',
                                  background: 'transparent', border: 'none', width: '100%',
                                }}
                              >
                                <span style={{ flexShrink: 0, fontSize: '12px', color: tokens.colors.textMuted, lineHeight: 1 }}>+</span>
                                <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>
                                  {act.name}
                                </span>
                                {targetAgent && (
                                  <span style={{ fontSize: '10px', color: tokens.colors.textSecondary }}>
                                    → {formatAgentDisplayName(targetAgent)}
                                  </span>
                                )}
                                <span style={{ fontSize: '10px', color: act.enabled ? tokens.colors.textMuted : tokens.colors.warningLight, marginLeft: 'auto' }}>
                                  {act.enabled ? (act.board_id ? 'board' : 'workspace') : 'disabled — won’t fire'}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {onDoneActionIds.length === 0 && candidates.length === 0 && (
                        <div style={{ fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic', padding: '2px 4px' }}>
                          No actions on this board or workspace yet — create one in Admin → Actions to bind it here.
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Prerequisites (ticket 48d14fff) — the M:N "blocked-by another
                ticket" set. Distinct from Next Ticket above (forward 1:1 push):
                this ticket stays parked (pending_on_tickets) until EVERY prereq
                here reaches a terminal column, at which point the trigger loop
                auto-resumes it — no human unpend. Each row shows a status pill
                (satisfied / blocked / removed) so the user can see at a glance
                what's still holding the ticket. */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                Prerequisites
                {prereqRows.length > 0 && (() => {
                  const open = prereqRows.filter(r => r.prerequisite && !r.prerequisite.archived_at && !r.prerequisite.is_terminal).length;
                  return open > 0
                    ? ` · ${open} blocking, auto-resumes when all done`
                    : ' · all satisfied';
                })()}
              </label>

              {prereqRows.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                  {prereqRows.map(row => {
                    const p = row.prerequisite;
                    const archived = !!p?.archived_at;
                    const satisfied = !!p?.is_terminal && !archived;
                    // Status pill: green=satisfied (terminal), muted=archived
                    // (link auto-drops), blue=still blocking, red=missing row.
                    const pill = !p
                      ? { label: 'MISSING', bg: tokens.colors.warningBg, fg: tokens.colors.warningLight }
                      : archived
                        ? { label: 'ARCHIVED', bg: tokens.colors.surface, fg: tokens.colors.textMuted }
                        : satisfied
                          ? { label: 'SATISFIED', bg: tokens.colors.successBg, fg: tokens.colors.successLight }
                          : { label: p.column_name ? p.column_name.toUpperCase() : 'BLOCKING', bg: tokens.colors.surface, fg: tokens.colors.info };
                    return (
                      <div
                        key={row.prerequisite_ticket_id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          background: tokens.colors.surfaceCard,
                          border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md,
                          padding: '6px 8px',
                        }}
                      >
                        <span style={{
                          flexShrink: 0,
                          fontSize: '9px', fontWeight: 800, letterSpacing: '0.4px',
                          padding: '1px 6px', borderRadius: tokens.radii.sm,
                          textTransform: 'uppercase',
                          background: pill.bg, color: pill.fg,
                        }}>{pill.label}</span>
                        <button
                          type="button"
                          onClick={() => onSelectTicket && p && onSelectTicket(p.id)}
                          title={p ? 'Open prerequisite ticket' : undefined}
                          disabled={!p || !onSelectTicket}
                          style={{
                            flex: 1, minWidth: 0, textAlign: 'left',
                            background: 'transparent', border: 'none', padding: 0,
                            color: tokens.colors.textStrong, fontSize: '12px',
                            cursor: (p && onSelectTicket) ? 'pointer' : 'default',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >{p ? p.title : `(deleted) ${row.prerequisite_ticket_id}`}</button>
                        <button
                          type="button"
                          onClick={() => handleRemovePrerequisite(row.prerequisite_ticket_id)}
                          disabled={prereqBusy}
                          title="Remove this prerequisite"
                          style={{
                            flexShrink: 0,
                            background: 'transparent', border: 'none',
                            color: tokens.colors.textMuted, fontSize: '14px',
                            cursor: prereqBusy ? 'not-allowed' : 'pointer', lineHeight: 1,
                            padding: '0 2px',
                          }}
                        >×</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add picker — same boardTickets source as Next Ticket, minus
                  self and tickets already linked as prerequisites. */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={prereqPickId}
                  onChange={e => setPrereqPickId(e.target.value)}
                  style={{
                    flex: 1, minWidth: 0,
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  <option value="">— Add a prerequisite ticket —</option>
                  {(boardTickets || [])
                    .filter(t => t.id !== activeTicket.id && !prereqRows.some(r => r.prerequisite_ticket_id === t.id))
                    .map(t => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={handleAddPrerequisite}
                  disabled={prereqBusy || !prereqPickId}
                  style={{
                    flexShrink: 0,
                    background: tokens.colors.accent, color: 'white', border: 'none',
                    borderRadius: tokens.radii.md, padding: '5px 12px', fontSize: '12px', fontWeight: 600,
                    cursor: (prereqBusy || !prereqPickId) ? 'not-allowed' : 'pointer',
                    opacity: (prereqBusy || !prereqPickId) ? 0.5 : 1,
                  }}
                >Add</button>
              </div>
              {prereqPickId && (
                <input
                  type="text"
                  value={prereqReason}
                  onChange={e => setPrereqReason(e.target.value)}
                  placeholder="Optional: why is this a prerequisite?"
                  style={{
                    width: '100%', marginTop: 6,
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit',
                  }}
                />
              )}
              {prereqError && (
                <div style={{ marginTop: 6, fontSize: '11px', color: tokens.colors.warningLight }}>{prereqError}</div>
              )}
            </div>

            {/* Created By */}
            {activeTicket.created_by && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Created By</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                    textTransform: 'uppercase',
                    background: activeTicket.created_by_type === 'agent' ? tokens.colors.badgeAgentBg : tokens.colors.badgeUserBg,
                    color: activeTicket.created_by_type === 'agent' ? tokens.colors.accentSubtle : tokens.colors.infoLight,
                  }}>{activeTicket.created_by_type === 'agent' ? 'Agent' : 'User'}</span>
                  <span style={{ fontSize: '11px', color: tokens.colors.textStrong, fontWeight: 500 }}>
                    {activeTicket.created_by}
                  </span>
                </div>
              </div>
            )}

            {/* Description */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ ...labelStyle, marginBottom: 6 }}>Description</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Add description..."
                rows={descriptionRows}
                style={{
                  width: '100%', background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px',
                  resize: 'vertical', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Ticket-level attachments. Distinct from comment attachments —
               files added here live on the ticket itself and cascade-delete
               with it; they do NOT pass through the Resource indirection
               that the comment composer uses. */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>
                  Attachments
                  {ticketAttachments.length > 0 && (
                    <span style={{ marginLeft: 6, color: tokens.colors.textDisabled, fontWeight: 500 }}>
                      ({ticketAttachments.length}/{TICKET_ATTACHMENT_MAX})
                    </span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={handleAddTicketAttachments}
                  disabled={attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    color: tokens.colors.textStrong,
                    fontSize: '11px',
                    padding: '4px 10px',
                    cursor: (attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX) ? 'not-allowed' : 'pointer',
                    opacity: (attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX) ? 0.5 : 1,
                  }}
                  title="Attach files (10MB each, max 20 per ticket)"
                >
                  + Attach files
                </button>
              </div>
              {attachmentError && (
                <div style={{
                  fontSize: '11px', color: tokens.colors.dangerLight, padding: '4px 6px',
                  background: tokens.colors.dangerBg, borderRadius: tokens.radii.sm, marginBottom: 4,
                }}>
                  {attachmentError}
                </div>
              )}
              {ticketAttachments.length === 0 ? (
                <div style={{
                  fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic',
                  padding: '6px 10px', background: tokens.colors.surfaceCard,
                  border: `1px dashed ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
                }}>
                  No files attached.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ticketAttachments.map(att => {
                    const mt = att.file_mimetype || '';
                    const isImage = mt.startsWith('image/');
                    const isVideo = mt.startsWith('video/');
                    const sizeKb = att.file_size > 0 ? Math.max(1, Math.round(att.file_size / 1024)) : null;
                    return (
                      <div
                        key={att.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 10px',
                          background: tokens.colors.surfaceCard,
                          border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handlePreviewTicketAttachment(att)}
                          style={{
                            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                            color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 500,
                            textAlign: 'left', flex: 1, minWidth: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                          title={isImage || isVideo ? 'Click to preview' : 'Click to download'}
                        >
                          {isImage ? '🖼️' : isVideo ? '🎬' : '📎'} {att.file_name}
                        </button>
                        <span style={{ fontSize: '10px', color: tokens.colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                          {sizeKb !== null ? `${sizeKb} KB` : ''}
                          {att.uploaded_by ? ` · ${att.uploaded_by}` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDownloadTicketAttachment(att)}
                          title="Download"
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: tokens.colors.textSecondary, fontSize: '12px', padding: '0 4px',
                          }}
                        >⬇</button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTicketAttachment(att.id, att.file_name)}
                          disabled={attachmentBusy}
                          title="Delete"
                          style={{
                            background: 'transparent', border: 'none', cursor: attachmentBusy ? 'not-allowed' : 'pointer',
                            color: tokens.colors.dangerLight, fontSize: '12px', padding: '0 4px',
                          }}
                        >✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Notification Channels */}
            {channels.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Notification Channels</label>
                <div style={{
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
                  padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
                }}>
                  {channels.map(ch => {
                    const isSelected = selectedChannelIds.includes(ch.id);
                    return (
                      <label key={ch.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                        padding: '3px 5px', borderRadius: 4,
                        background: isSelected ? `${tokens.colors.accent}15` : 'transparent',
                      }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {
                            if (isSelected && selectedChannelIds.length <= 1) return;
                            const next = isSelected
                              ? selectedChannelIds.filter(id => id !== ch.id)
                              : [...selectedChannelIds, ch.id];
                            setSelectedChannelIds(next);
                          }}
                          style={{ accentColor: tokens.colors.accent, cursor: isSelected && selectedChannelIds.length <= 1 ? 'not-allowed' : 'pointer' }}
                        />
                        <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{ch.name}</span>
                        <span style={{ fontSize: '10px', color: ch.is_active ? tokens.colors.successLight : tokens.colors.textSecondary, marginLeft: 'auto' }}>
                          {ch.type}{ch.is_active ? '' : ' (inactive)'}
                        </span>
                      </label>
                    );
                  })}
                  {selectedChannelIds.length === 0 && (
                    <div style={{ fontSize: '11px', color: tokens.colors.danger, padding: '4px 6px', background: `${tokens.colors.danger}15`, borderRadius: tokens.radii.sm }}>
                      No channel selected — please select at least one channel to receive notifications
                    </div>
                  )}
                  {selectedChannelIds.length === 1 && (
                    <div style={{ fontSize: '11px', color: tokens.colors.warningLight, padding: '2px 6px' }}>
                      Last channel — cannot be removed
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Child Tickets (Subtasks) */}
            <ChildTicketList
              parentTicket={activeTicket}
              agents={agents}
              maxDepth={2}
              boardTickets={boardTickets}
              onCreateChild={onCreateChild}
              onUpdateChild={(id, data) => onUpdate(id, data)}
              onDeleteChild={onDeleteChild}
              onReparentChild={onReparentChild}
              onSelectChild={handleSelectChild}
            />
          </>
        ) : activeTab === 'comments' ? (
          /* Comments Tab */
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 200 }}>
            {/* Type filter chips + Tier-1 H notification menu. Notify mute is
               independent of the filter (chip = list visibility, mute =
               signal suppression like unread dots and typing indicators). */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, alignItems: 'center', position: 'relative' }}>
              <button
                type="button"
                onClick={handleStartCommentSummary}
                disabled={summaryStarting || isCommentSummaryInProgress(commentSummary?.status)}
                title="Replace existing comments with one agent-generated summary"
                style={{ padding: '2px 8px', borderRadius: tokens.radii.full as any, fontSize: 11, fontWeight: 600, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceSubtle, color: tokens.colors.textStrong, cursor: summaryStarting || isCommentSummaryInProgress(commentSummary?.status) ? 'not-allowed' : 'pointer', opacity: summaryStarting || isCommentSummaryInProgress(commentSummary?.status) ? 0.6 : 1 }}
              >
                {summaryStarting || isCommentSummaryInProgress(commentSummary?.status) ? 'Summarizing…' : 'Summary'}
              </button>
              {commentSummary?.status === 'failed' && (
                <span role="alert" style={{ fontSize: 11, color: tokens.colors.danger }}>
                  {commentSummary.error_code ? `${commentSummary.error_code}: ` : ''}
                  {commentSummary.error || 'Summary failed. Originals were preserved; you can retry.'}
                </span>
              )}
              {/* Render a chip for every type that has at least one comment.
                 Previously also kept chips for OFF types the user had toggled
                 off, but that branch hid chips for types with count=0 the
                 instant the user clicked to toggle them off — leaving no way
                 to toggle back on. count>0 alone is the right invariant: the
                 chip exists iff there is something to filter. */}
              {/* Notify menu — bell icon + count badge if anything is muted */}
              <button
                type="button"
                onClick={() => setNotifMenuOpen(v => !v)}
                title="Notification preferences (mute signals per comment type)"
                aria-pressed={notifMenuOpen}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: tokens.radii.full as any,
                  fontSize: '11px', fontWeight: 600,
                  background: notifMenuOpen ? tokens.colors.surfaceSubtle : 'transparent',
                  color: mutedTypes.size > 0 ? tokens.colors.warningLight : tokens.colors.textMuted,
                  border: `1px solid ${tokens.colors.border}`,
                  cursor: 'pointer',
                }}
              >
                <span aria-hidden="true">{mutedTypes.size > 0 ? '\uD83D\uDD15' : '\uD83D\uDD14'}</span>
                {mutedTypes.size > 0 && <span style={{ fontSize: '10px' }}>{mutedTypes.size}</span>}
              </button>
              {notifMenuOpen && (
                <div
                  // Click-outside via overlay isn't worth a global listener for
                  // this small menu; clicking elsewhere on the chip row or the
                  // bell again closes it (toggle).
                  style={{
                    position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
                    minWidth: 220, padding: 8,
                    background: tokens.colors.surfaceCard,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                  }}
                >
                  <div style={{ fontSize: '10px', color: tokens.colors.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Mute signals per type
                  </div>
                  {ALL_COMMENT_TYPES.filter(t => COMMENT_TYPE_STYLES[t].composable || t === 'handoff' || t === 'answer').map(t => {
                    const tstyle = COMMENT_TYPE_STYLES[t];
                    const muted = mutedTypes.has(t);
                    return (
                      <label key={`mute-${t}`} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', cursor: 'pointer',
                      }}>
                        <input
                          type="checkbox"
                          checked={muted}
                          onChange={() => toggleMute(t)}
                          style={{ accentColor: tokens.colors.warning }}
                        />
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '12px', color: tokens.colors.textStrong }}>
                          <span aria-hidden="true" style={{ color: tstyle.text }}>{tstyle.icon}</span>
                          <span>{tstyle.label}</span>
                        </span>
                      </label>
                    );
                  })}
                  <div style={{ fontSize: '10px', color: tokens.colors.textMuted, marginTop: 6, fontStyle: 'italic' }}>
                    Muted types stay visible in the list — but their unread dot and "is typing" hints are hidden.
                  </div>
                </div>
              )}
              {ALL_COMMENT_TYPES.filter(t => typeCounts[t] > 0).map(t => {
                const tstyle = COMMENT_TYPE_STYLES[t];
                const active = activeTypes.has(t);
                return (
                  <button
                    key={`chip-${t}`}
                    onClick={() => toggleType(t)}
                    title={`Toggle ${tstyle.label} comments`}
                    aria-pressed={active}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '2px 8px', borderRadius: tokens.radii.full as any,
                      fontSize: '11px', fontWeight: 600,
                      background: active ? tstyle.bg : 'transparent',
                      color: active ? tstyle.text : tokens.colors.textMuted,
                      border: `1px solid ${active ? tstyle.border : tokens.colors.border}`,
                      cursor: 'pointer',
                      textTransform: 'uppercase', letterSpacing: 0.4,
                      opacity: typeCounts[t] === 0 ? 0.5 : 1,
                    }}
                  >
                    <span aria-hidden="true">{tstyle.icon}</span>
                    <span>{tstyle.label}</span>
                    {typeCounts[t] > 0 && (
                      <span style={{
                        fontSize: '10px', padding: '0 5px', borderRadius: tokens.radii.full as any,
                        background: tokens.colors.surface, color: tokens.colors.textMuted, marginLeft: 2,
                      }}>{typeCounts[t]}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <CommentList
              comments={filteredComments}
              onImagePreview={(src, mimetype) => setImagePreview({ src, mimetype })}
              onSetCommentStatus={onSetCommentStatus
                ? (commentId, status) => onSetCommentStatus(activeTicket.id, commentId, status)
                : undefined}
              onReply={handleStartReply}
              replyingToCommentId={replyingTo?.id || null}
              lastReadAt={lastReadAt}
              mutedTypes={mutedTypes}
              scrollToCommentId={scrollToCommentId ?? null}
              onScrollToCommentConsumed={onScrollToCommentConsumed}
              onLoadOlder={handleLoadOlder}
              hasMoreOlder={activeHasMore}
              loadingOlder={loadingOlderPanel === activePanelId}
            />

            <TypingIndicator agentName={typingIndicators[navStack[navStack.length - 1]] ?? null} />

            {/* Phase 3 — comment-typing live indicator. Names are joined with
               commas if multiple typists overlap. Stays a separate row from the
               agent-trigger TypingIndicator above so the two signals don't
               overwrite each other. */}
            {Object.keys(commentTypists).length > 0 && (
              <div style={{
                fontSize: '11px', color: tokens.colors.textMuted,
                padding: '2px 8px', fontStyle: 'italic',
              }}>
                {Object.values(commentTypists).map(t => t.name).join(', ')} {Object.keys(commentTypists).length === 1 ? 'is' : 'are'} typing...
              </div>
            )}

            {renderCommentInput()}
          </div>
        ) : activeTab === 'activity' ? (
          /* Activity Tab */
          <div>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 12 }}>
              Activity Log
            </h4>
            {activities.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: tokens.colors.textSecondary, fontSize: '13px' }}>
                No activity recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activities.map(log => (
                  <div key={log.id} style={{
                    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 12px', fontSize: '12px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>
                        {log.action.replace('_', ' ').toUpperCase()} - {log.entity_type}
                      </span>
                      <span style={{ color: tokens.colors.textSecondary, fontSize: '11px' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </div>
                    {log.field_changed && (
                      <div style={{ color: tokens.colors.textMuted }}>
                        Field: {log.field_changed}
                        {log.old_value && ` | From: ${log.old_value}`}
                        {log.new_value && ` | To: ${log.new_value}`}
                      </div>
                    )}
                    {log.actor_name && (
                      <div style={{ color: tokens.colors.textSecondary, marginTop: 2 }}>By: {log.actor_name}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* User Tab (ticket a57517be) — dedicated surface for human-in-the-loop
             tickets. When pending_user_action is true the assignee couldn't
             make progress without a decision; this tab summarises the ask
             above the comment stream so the user can act without reading the
             whole thread. When the flag is clear the tab still acts as the
             primary entry point for parking the ticket. */
          <div>
            {/* Blocked-by-tickets banner (ticket 48d14fff). Shown whenever the
                ticket is parked on prerequisites — independent of the human
                pending flag, so a ticket that is BOTH waiting on a human and
                blocked by tickets shows this banner above the human-action UI.
                Unlike pending_user_action there's no Resume button: it clears
                itself automatically when every prerequisite reaches terminal.
                The list + Add control live on the Detail tab's Prerequisites
                section. */}
            {activeTicket.pending_on_tickets && (
              <div style={{
                background: tokens.colors.surfaceCard,
                border: `2px dashed ${tokens.colors.info}`,
                borderRadius: tokens.radii.lg,
                padding: '12px 14px',
                marginBottom: 16,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span aria-hidden="true" style={{ fontSize: '16px' }}>⛓</span>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: tokens.colors.info, letterSpacing: '0.4px' }}>
                    BLOCKED BY TICKETS
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
                  Waiting on {prereqRows.filter(r => r.prerequisite && !r.prerequisite.archived_at && !r.prerequisite.is_terminal).length || prereqRows.length} prerequisite ticket(s).
                  This resumes <strong>automatically</strong> once every prerequisite reaches a terminal column — no action needed.
                  See the <strong>Prerequisites</strong> section on the Detail tab to view or change them.
                </div>
              </div>
            )}
            {activeTicket.pending_user_action ? (
              <>
                <div style={{
                  background: tokens.colors.warningBg,
                  border: `2px dashed ${tokens.colors.warning}`,
                  borderRadius: tokens.radii.lg,
                  padding: '12px 14px',
                  marginBottom: 16,
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    marginBottom: 8,
                  }}>
                    <span aria-hidden="true" style={{ fontSize: '18px' }}>⏸</span>
                    <span style={{
                      fontSize: '13px', fontWeight: 700,
                      color: tokens.colors.warningLight,
                      letterSpacing: '0.4px',
                    }}>
                      PENDING USER ACTION
                    </span>
                  </div>
                  <div style={{
                    fontSize: '12px', color: tokens.colors.textSecondary,
                    marginBottom: 6,
                  }}>
                    {activeTicket.pending_set_by && (
                      <span>Parked by <strong style={{ color: tokens.colors.textStrong }}>{activeTicket.pending_set_by}</strong></span>
                    )}
                    {activeTicket.pending_set_at && (
                      <span> · {new Date(activeTicket.pending_set_at).toLocaleString()}</span>
                    )}
                  </div>
                  {activeTicket.pending_reason && (
                    <div style={{
                      background: tokens.colors.surfaceCard,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.md,
                      padding: '8px 10px',
                      fontSize: '13px',
                      color: tokens.colors.textStrong,
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                    }}>
                      {activeTicket.pending_reason}
                    </div>
                  )}
                </div>

                <label style={labelStyle}>Your response (optional)</label>
                <textarea
                  value={userResponseDraft}
                  onChange={e => setUserResponseDraft(e.target.value)}
                  rows={4}
                  placeholder="Type your answer, decision, or new context. Posted as a ticket comment when you Resume — leave empty to just unpend."
                  style={{
                    width: '100%',
                    background: tokens.colors.surfaceCard,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    color: tokens.colors.textStrong,
                    padding: '8px 10px',
                    fontSize: '13px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={handleUnpendTicket}
                    disabled={pendingBusy}
                    style={{
                      background: tokens.colors.successBg,
                      border: `1px solid ${tokens.colors.successLight}`,
                      borderRadius: tokens.radii.md,
                      color: tokens.colors.successLight,
                      padding: '6px 14px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: pendingBusy ? 0.5 : 1,
                    }}
                  >{userResponseDraft.trim() ? '▶ Post & Resume' : '▶ Resume (Unpend)'}</button>
                </div>

                <h4 style={{
                  fontSize: '12px', fontWeight: 700,
                  color: tokens.colors.textSecondary,
                  marginTop: 22, marginBottom: 8,
                  textTransform: 'uppercase', letterSpacing: '0.5px',
                }}>What to do next</h4>
                <ul style={{
                  margin: 0, paddingLeft: 18,
                  fontSize: '12px', color: tokens.colors.textSecondary,
                  lineHeight: 1.6,
                }}>
                  <li>Read the reason above and the latest comments to see what's blocked.</li>
                  <li>Type your answer in the response box, then click <strong>Resume</strong> — the text lands as a comment and the assignee picks it up on the next trigger.</li>
                  <li>Already replied in the Comments tab? Just click <strong>Resume</strong> with the box empty.</li>
                  <li>Need to split the work? Create a follow-up ticket from the board, then Resume.</li>
                </ul>
              </>
            ) : (
              <>
                <div style={{
                  background: tokens.colors.surfaceCard,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg,
                  padding: '12px 14px',
                  marginBottom: 16,
                  color: tokens.colors.textSecondary,
                  fontSize: '12px',
                  lineHeight: 1.5,
                }}>
                  This ticket is not currently parked for user intervention. Park it
                  here when a human decision is needed and the agent should stop
                  re-trying. Parked tickets get a high-visibility badge on the
                  board and drop out of the agent's focus queue until you resume them.
                </div>

                <label style={labelStyle}>Park reason</label>
                <textarea
                  value={pendingReasonDraft}
                  onChange={e => setPendingReasonDraft(e.target.value)}
                  rows={4}
                  placeholder="Why does this ticket need human intervention?"
                  style={{
                    width: '100%',
                    background: tokens.colors.surfaceCard,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    color: tokens.colors.textStrong,
                    padding: '8px 10px',
                    fontSize: '13px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={handlePendTicket}
                    disabled={pendingBusy || pendingReasonDraft.trim().length === 0}
                    style={{
                      background: tokens.colors.warningBg,
                      border: `1px solid ${tokens.colors.warning}`,
                      borderRadius: tokens.radii.md,
                      color: tokens.colors.warningLight,
                      padding: '6px 14px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: (pendingBusy || pendingReasonDraft.trim().length === 0) ? 0.5 : 1,
                    }}
                  >⏸ Park for user</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Save / Discard footer — visible only on the detail tab when at
         least one buffered edit differs from the server. Comments and
         attachments have their own explicit Send/Upload buttons; they don't
         participate in this draft state. */}
      {activeTab === 'detail' && isDirty && (
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px',
          borderTop: `1px solid ${tokens.colors.border}`,
          background: tokens.colors.surfaceCard,
        }}>
          <span style={{ fontSize: '11px', color: tokens.colors.textMuted, flex: 1 }}>
            Unsaved changes
          </span>
          <button
            type="button"
            onClick={handleDiscardDraft}
            disabled={savingDraft}
            style={{
              background: 'transparent',
              color: tokens.colors.textSecondary,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '5px 12px',
              fontSize: '12px',
              cursor: savingDraft ? 'not-allowed' : 'pointer',
            }}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={savingDraft}
            style={{
              background: tokens.colors.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '5px 14px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: savingDraft ? 'not-allowed' : 'pointer',
              opacity: savingDraft ? 0.6 : 1,
            }}
          >
            {savingDraft ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {/* Image / video preview modal */}
      {imagePreview && (
        <div onClick={() => setImagePreview(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, cursor: 'pointer',
        }}>
          {imagePreview.mimetype?.startsWith('video/') ? (
            // Stop bubbling so clicking the controls doesn't close the modal —
            // backdrop click still does.
            <video
              src={imagePreview.src}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, background: '#000' }}
            />
          ) : (
            <img src={imagePreview.src} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
          )}
        </div>
      )}
    </div>
  );
}

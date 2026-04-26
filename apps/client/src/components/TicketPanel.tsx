import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Ticket, Agent, Channel, ActivityLog, CommentType, User } from '../types';
import { api, TicketRoleAssignmentRow } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications } from '../contexts/NotificationContext';
import ChildTicketList from './SubtaskList';
import CommentList from './CommentList';
import { TypingIndicator } from './TypingIndicator';
import { tokens } from '../tokens';
import { MentionTextarea, MentionCandidate } from './common/MentionTextarea';
import { ALL_COMMENT_TYPES, COMMENT_TYPE_STYLES, defaultVisibleTypes, resolveCommentType, hasStaleOpenQuestion } from './comment-types';

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
  typingIndicators: Record<string, string | null>;
  onClose: () => void;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onDeleteChild: (childId: string) => void;
  // Adopt an existing ticket as a subtask of `parentId`. Distinct from
  // onCreateChild (which makes a new ticket).
  onReparentChild?: (parentId: string, childId: string) => void;
  // Set (or clear) the holder of a workspace role on this ticket. Mutually
  // exclusive agent_id / user_id; pass both null/'' to clear.
  onSetRoleAssignment?: (ticketId: string, roleId: string, holder: { agent_id?: string | null; user_id?: string | null }) => void;
  onAddComment: (
    ticketId: string,
    content: string,
    attachments?: { file_name: string; file_mimetype: string; file_data: string }[],
    options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown> },
  ) => void;
  onSetCommentStatus?: (ticketId: string, commentId: string, status: 'open' | 'resolved') => void;
  onSelectTicket?: (id: string) => void;
}

function findInTree(root: Ticket, id: string): Ticket | null {
  if (root.id === id) return root;
  for (const child of (root.children || [])) {
    const found = findInTree(child, id);
    if (found) return found;
  }
  return null;
}

const priorityColors: Record<string, string> = {
  // tag/label palette — not tokenized
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

interface TriggerRoleTarget { slug: string; label: string; holderName: string; hasAgent: boolean }

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

export default function TicketPanel({
  ticket, columnName, agents, users, channels, workspaceRoles, boardTickets, typingIndicators,
  onClose, onUpdate, onDelete, onCreateChild, onDeleteChild, onReparentChild, onSetRoleAssignment, onAddComment, onSetCommentStatus, onSelectTicket,
}: TicketPanelProps) {
  // ─── Ticket role assignments ────────────────────────────
  // Per-ticket fetch — the board endpoint doesn't include assignments yet,
  // and we want fresh data on panel open. Refetch when the ticket id or
  // updated_at changes so a write through onSetRoleAssignment converges.
  const [roleAssignments, setRoleAssignments] = useState<TicketRoleAssignmentRow[]>([]);
  // Pending writes — UI shows "saving…" on the relevant role row.
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const { user } = useAuth();
  const { showToast } = useToast();

  // Per-role in-flight state for the Re-trigger buttons — prevents
  // double-fires while the network round trip is pending.
  const [retriggering, setRetriggering] = useState<Record<string, boolean>>({});
  const [triggerMenuOpen, setTriggerMenuOpen] = useState(false);

  // Navigation stack: array of ticket IDs navigated within this panel
  const [navStack, setNavStack] = useState<string[]>([ticket.id]);

  // Reset navStack when root ticket changes
  useEffect(() => {
    setNavStack([ticket.id]);
  }, [ticket.id]);

  const activePanelId = navStack[navStack.length - 1];

  // Derive active ticket from the root ticket tree
  const activeTicket = findInTree(ticket, activePanelId) || ticket;

  const handleSelectChild = useCallback((child: Ticket) => {
    setNavStack(prev => [...prev, child.id]);
  }, []);

  const handleBack = useCallback(() => {
    setNavStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  }, []);

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

  // ESC key closes panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Form state — sync when activeTicket changes
  const resolveAgentName = (id: string | undefined, name: string) => {
    if (id) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent.name;
    }
    return name;
  };

  const [title, setTitle] = useState(activeTicket.title);
  const [description, setDescription] = useState(activeTicket.description);
  const [priority, setPriority] = useState(activeTicket.priority);
  const [assignee, setAssignee] = useState(resolveAgentName(activeTicket.assignee_id, activeTicket.assignee));
  const [reporter, setReporter] = useState(resolveAgentName(activeTicket.reporter_id, activeTicket.reporter));
  const [reviewerId, setReviewerId] = useState(activeTicket.reviewer_id || '');
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(activeTicket.channel_ids || []);
  const [commentContent, setCommentContent] = useState('');
  // Staged attachments — kept in memory until the user hits Send; server
  // turns each into a Resource (type='comment_attachment') and attaches the
  // resulting ids to the comment in one transactional POST.
  const [commentAttachments, setCommentAttachments] = useState<{ file_name: string; file_mimetype: string; file_data: string }[]>([]);
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
  const [activeTab, setActiveTab] = useState<'detail' | 'comments' | 'activity'>('detail');
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  useEffect(() => {
    setTitle(activeTicket.title);
    setDescription(activeTicket.description);
    setPriority(activeTicket.priority);
    setAssignee(resolveAgentName(activeTicket.assignee_id, activeTicket.assignee));
    setReporter(resolveAgentName(activeTicket.reporter_id, activeTicket.reporter));
    setReviewerId(activeTicket.reviewer_id || '');
    setSelectedChannelIds(activeTicket.channel_ids || []);
    setCommentContent('');
    setCommentAttachments([]);
    setActiveTab('detail');
  }, [activeTicket.id, activeTicket.updated_at]);

  useEffect(() => {
    if (activeTab === 'activity') {
      api.getTicketActivity(activeTicket.id).then(setActivities).catch(() => {});
    }
  }, [activeTab, activeTicket.id]);

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

  // Seed @-mention candidates from props + ticket role_ids immediately so the
  // dropdown works before the workspace-user API call returns.
  useEffect(() => {
    const agentById = new Map(agents.map(a => [a.id, a]));
    const roleItems: MentionCandidate[] = [];
    const pushRole = (key: 'assignee' | 'reporter' | 'reviewer', id: string | undefined) => {
      if (!id) return;
      const a = agentById.get(id);
      roleItems.push({ type: 'role', id: key, name: key, sublabel: a ? a.name : id });
    };
    pushRole('assignee', activeTicket.assignee_id);
    pushRole('reporter', activeTicket.reporter_id);
    pushRole('reviewer', activeTicket.reviewer_id);
    const agentItems: MentionCandidate[] = agents.map(a => ({ type: 'agent', id: a.id, name: a.name }));
    setMentionCandidates([...roleItems, ...agentItems]);

    const workspaceId = typeof window !== 'undefined'
      ? localStorage.getItem('currentWorkspaceId') || ''
      : '';
    if (!workspaceId) return;
    api.getMentionCandidates(workspaceId, activeTicket.id)
      .then(data => {
        const next: MentionCandidate[] = [
          ...data.role_shortcuts.map(r => ({ type: 'role' as const, id: r.key, name: r.key, sublabel: r.label.replace(`${r.key} `, '') })),
          ...data.users.map(u => ({ type: 'user' as const, id: u.id, name: u.name })),
          ...data.agents.map(a => ({ type: 'agent' as const, id: a.id, name: a.name })),
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

  const saveField = (field: string, value: any) => {
    onUpdate(activeTicket.id, { [field]: value });
  };

  const handleAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    // No mimetype restriction — comment attachments go through the Resource
    // table the same as any other workspace/board asset, so the picker accepts
    // PDFs, zips, videos, etc. Matches server cap in MAX_COMMENT_ATTACHMENT_SIZE.
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newAttachments: typeof commentAttachments = [];
      for (let i = 0; i < files.length && commentAttachments.length + newAttachments.length < 5; i++) {
        const file = files[i];
        if (file.size > 10 * 1024 * 1024) continue;
        const data = await fileToBase64(file);
        newAttachments.push({ file_name: file.name, file_mimetype: file.type || 'application/octet-stream', file_data: data });
      }
      setCommentAttachments(prev => [...prev, ...newAttachments].slice(0, 5));
    };
    input.click();
  };

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

  const handleSubmitComment = () => {
    if (commentContent.trim()) {
      // When replying to a question, force type='answer' and link via parent_id.
      // The server auto-resolves the parent question on receipt (see
      // tickets.controller.addComment) so the OPEN pill flips to Resolved
      // without a follow-up call.
      const isReply = !!replyingTo;
      const submittedType: CommentType = isReply ? 'answer' : composeType;
      const options = isReply
        ? { type: 'answer' as const, parent_id: replyingTo!.id }
        : (composeType !== 'note' ? { type: composeType } : undefined);

      onAddComment(
        activeTicket.id,
        commentContent.trim(),
        commentAttachments.length > 0 ? commentAttachments : undefined,
        options,
      );
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
    }
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
        const wsId = localStorage.getItem('currentWorkspaceId');
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
    const target = (activeTicket.comments || []).find(c => c.id === commentId);
    if (!target) return;
    setReplyingTo({
      id: target.id,
      preview: (target.content || '').slice(0, 120),
      author: target.author || 'Someone',
    });
  }, [activeTicket.comments]);

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
    const all = activeTicket.comments || [];
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
  }, [activeTicket.comments, activeTypes]);

  // Counts per type — drives chip badge ("3" beside Question, etc.) so the
  // user can see at a glance which buckets have content.
  const typeCounts = useMemo(() => {
    const counts: Record<CommentType, number> = {
      note: 0, question: 0, answer: 0, decision: 0, chat: 0, system: 0, handoff: 0,
    };
    for (const c of activeTicket.comments || []) {
      if (c.author_type === 'system') {
        counts.system += 1;
      } else {
        counts[resolveCommentType(c.type as string | null | undefined)] += 1;
      }
    }
    return counts;
  }, [activeTicket.comments]);

  // Tab badge stays filter-independent — toggling chips shouldn't change "how
  // many comments this ticket has". System rows still excluded so the badge
  // reflects user-relevant volume.
  const userCommentCount = (activeTicket.comments || []).filter(c => c.author_type !== 'system').length;

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
          {commentAttachments.map((att, idx) => {
            const isImage = att.file_mimetype.startsWith('image/');
            return (
              <div key={idx} style={{ position: 'relative' }}>
                {isImage ? (
                  <img
                    src={`data:${att.file_mimetype};base64,${att.file_data}`}
                    alt={att.file_name}
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}` }}
                  />
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
                <button onClick={() => setCommentAttachments(prev => prev.filter((_, i) => i !== idx))}
                  style={{ position: 'absolute', top: -4, right: -4, background: tokens.colors.danger, color: 'white', border: 'none', borderRadius: tokens.radii.full, width: 16, height: 16, fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 5 }}>
        <button onClick={handleAttach} title="Attach file" style={{
          background: tokens.colors.border, color: tokens.colors.textMuted, border: 'none', borderRadius: tokens.radii.md,
          padding: '5px 9px', fontSize: '13px', cursor: 'pointer',
        }}>&#128206;</button>
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
        <button onClick={handleSubmitComment} disabled={!commentContent.trim()} style={{
          background: commentContent.trim() ? tokens.colors.accent : tokens.colors.border, color: 'white', border: 'none', borderRadius: tokens.radii.md,
          padding: '5px 12px', fontSize: '12px', fontWeight: 600, cursor: commentContent.trim() ? 'pointer' : 'not-allowed',
        }}>Send</button>
      </div>
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
          <span style={{
            fontSize: '11px', padding: '3px 8px', borderRadius: 4,
            background: tokens.colors.surfaceCard, color: tokens.colors.textMuted, fontWeight: 500,
          }}>#{activeTicket.id}</span>
          <span style={{
            fontSize: '11px', padding: '3px 8px', borderRadius: 4,
            background: tokens.colors.surfaceCard, color: tokens.colors.textMuted,
          }}>{columnName}</span>
          {/* Tier-1 G stale-question badge in the panel header. Same threshold
             as the board card so a ticket marked stale on the board stays
             marked once you open it — no surprise mismatch. */}
          {hasStaleOpenQuestion(activeTicket.comments) && (
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
              return {
                slug: r.slug,
                label: r.name,
                holderName: holder?.name || (holder ? holder.id : 'unassigned'),
                hasAgent: holder?.type === 'agent',
              };
            })}
            busy={retriggering}
            onPick={(slug, label, holderName) => handleRetrigger(slug, label, holderName)}
          />
          <button onClick={() => { onDelete(activeTicket.id); onClose(); }} style={{
            background: tokens.colors.dangerBg, color: tokens.colors.dangerLight, border: 'none', borderRadius: tokens.radii.md,
            padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
          }}>Delete</button>
          <button onClick={onClose} style={{
            background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
            padding: '4px 12px', fontSize: '16px', cursor: 'pointer',
          }}>x</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0 }}>
        {(['detail', 'comments', 'activity'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '8px 16px', background: 'transparent', border: 'none',
            borderBottom: activeTab === tab ? `2px solid ${tokens.colors.accent}` : '2px solid transparent',
            color: activeTab === tab ? tokens.colors.textStrong : tokens.colors.textSecondary,
            fontSize: '12px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            {tab}
            {tab === 'comments' && userCommentCount > 0 && (
              <span style={{
                fontSize: '10px', background: tokens.colors.border, color: tokens.colors.textMuted,
                borderRadius: 8, padding: '1px 5px', fontWeight: 700,
              }}>{userCommentCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'detail' ? (
          <>
            {/* Title */}
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => title !== activeTicket.title && saveField('title', title)}
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
                  onChange={e => { setPriority(e.target.value as any); saveField('priority', e.target.value); }}
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

              {(() => {
                // One cell per workspace role, sorted by position. Encoding
                // the holder as a prefixed select value (`agent:<id>` /
                // `user:<id>`) keeps the picker a single dropdown that spans
                // both holder kinds without duplicating the row.
                const sortedRoles = (workspaceRoles || []).slice()
                  .sort((a, b) => a.position - b.position);
                if (sortedRoles.length === 0) {
                  return (
                    <div style={{ gridColumn: '1 / span 2', fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                      No workspace roles yet — configure roles in workspace settings.
                    </div>
                  );
                }
                const assignmentByRoleId = new Map(roleAssignments.map(r => [r.role.id, r]));
                const activeAgents = (agents || []).filter(a => a.is_active);
                const activeUsers = users || [];
                return sortedRoles.map(role => {
                  const row = assignmentByRoleId.get(role.id);
                  const holder = row?.holder || null;
                  const value = holder
                    ? `${holder.type}:${holder.id}`
                    : '';
                  const saving = savingRoleId === role.id;
                  return (
                    <div key={role.id}>
                      <label style={labelStyle}>{role.name}</label>
                      <select
                        value={value}
                        disabled={!onSetRoleAssignment || saving}
                        onChange={async e => {
                          if (!onSetRoleAssignment) return;
                          const raw = e.target.value;
                          const next = !raw
                            ? { agent_id: null, user_id: null }
                            : raw.startsWith('agent:')
                              ? { agent_id: raw.slice(6), user_id: null }
                              : raw.startsWith('user:')
                                ? { agent_id: null, user_id: raw.slice(5) }
                                : { agent_id: null, user_id: null };
                          setSavingRoleId(role.id);
                          try {
                            await onSetRoleAssignment(activeTicket.id, role.id, next);
                          } finally {
                            setSavingRoleId(null);
                          }
                        }}
                        title={role.description || ''}
                        style={{
                          background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                          padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%',
                          cursor: !onSetRoleAssignment ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <option value="">Unassigned{saving ? ' · saving…' : ''}</option>
                        {activeAgents.length > 0 && (
                          <optgroup label="Agents">
                            {activeAgents.map(a => (
                              <option key={`a-${a.id}`} value={`agent:${a.id}`}>{a.name}</option>
                            ))}
                          </optgroup>
                        )}
                        {activeUsers.length > 0 && (
                          <optgroup label="Users">
                            {activeUsers.map(u => (
                              <option key={`u-${u.id}`} value={`user:${u.id}`}>{u.name || u.email}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  );
                });
              })()}
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
                onBlur={() => description !== activeTicket.description && saveField('description', description)}
                placeholder="Add description..."
                rows={3}
                style={{
                  width: '100%', background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px',
                  resize: 'vertical', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
                }}
              />
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
                            onUpdate(activeTicket.id, { channel_ids: next });
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
              onImagePreview={(src) => setImagePreview(src)}
              onSetCommentStatus={onSetCommentStatus
                ? (commentId, status) => onSetCommentStatus(activeTicket.id, commentId, status)
                : undefined}
              onReply={handleStartReply}
              replyingToCommentId={replyingTo?.id || null}
              lastReadAt={lastReadAt}
              mutedTypes={mutedTypes}
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
        ) : (
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
        )}
      </div>

      {/* Image preview modal */}
      {imagePreview && (
        <div onClick={() => setImagePreview(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, cursor: 'pointer',
        }}>
          <img src={imagePreview} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

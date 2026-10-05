import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Ticket, TicketCard, TicketStatus, RuntimeParticipant, Channel, ActivityLog, Comment, CommentType, User, Resource, TicketPrerequisiteRow, Action } from '../types';
import { api, getActiveAccountId, rawResourceUrl } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications } from '../contexts/NotificationContext';
import ChildTicketList from './SubtaskList';
import CommentList from './CommentList';
import { TypingIndicator } from './TypingIndicator';
import { tokens } from '../tokens';
import { MentionTextarea, MentionCandidate } from './common/MentionTextarea';
import { ActivityPill } from './common/ActivityIndicator';
import { ticketActivity } from '../activity';
import { ALL_COMMENT_TYPES, COMMENT_TYPE_STYLES, defaultVisibleTypes, resolveCommentType, hasStaleOpenQuestion } from './comment-types';
import { formatAgentDisplayName } from '../utils/agentName';
import { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_PRIORITY_LABELS, ticketStatusLabel, ticketStatusColor, triggerReasonLabel } from '../tickets/status';
import { useProjects } from '../projects/useProjects';
import { useTicketTags } from '../tickets/useTicketTags';
import { mergeTagSuggestions } from '../tickets/tagInput';
import type { RuntimeSpecDraft } from '../runtime/runtimeSpec';
import ResourceReferencePicker from './ticketPanel/ResourceReferencePicker';
import TagInput from './common/TagInput';
import ProjectBranchFields from './ticketPanel/ProjectBranchFields';
import AssigneeSection from './ticketPanel/AssigneeSection';
import OnDoneActionsField from './ticketPanel/OnDoneActionsField';
import PrerequisitesField from './ticketPanel/PrerequisitesField';
import TicketAttachmentsSection from './ticketPanel/TicketAttachmentsSection';
import {
  TicketDraft, collectTagPool, computeDirtyTicketFields, draftFromTicket, effectiveAssignee, effectiveTags,
  openPrerequisiteCount, runtimeSpecEqual, settleSavedDraft,
} from './ticketPanel/ticketDraft';

export interface TicketPanelProps {
  ticket: Ticket;
  agents: RuntimeParticipant[];
  users?: User[];
  channels: Channel[];
  /** Root tickets of the workspace pool currently loaded by the page — next-ticket/prerequisite/"link existing subtask" pickers + tag suggestions. */
  workspaceTickets?: TicketCard[];
  typingIndicators: Record<string, string | null>;
  accountId?: string;
  onClose: () => void;
  // May be sync or async. Used as the Save fallback when onSaveDraft is absent.
  onUpdate: (id: string, data: Record<string, any>) => void | Promise<void>;
  /** Status change (PATCH /tickets/:id/move). Falls back to api.moveTicket when omitted. */
  onMove?: (ticketId: string, status: TicketStatus) => void | Promise<void>;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; tags?: string[] }) => void;
  onDeleteChild: (childId: string) => void;
  // Adopt an existing ticket as a subtask of `parentId` (distinct from onCreateChild).
  onReparentChild?: (parentId: string, childId: string) => void;
  /** Commit the buffered Save/Discard draft (one PATCH). MUST reject on failure —
   *  the footer relies on the rejection to keep the dirty state instead of
   *  showing a misleading success toast. */
  onSaveDraft?: (ticketId: string, ticketFields: Record<string, any>) => Promise<void>;
  onAddComment: (
    ticketId: string,
    content: string,
    attachments?: { file_name: string; file_mimetype: string; file_data: string }[],
    options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown>; attachment_resource_ids?: string[] },
  ) => void;
  onSetCommentStatus?: (ticketId: string, commentId: string, status: 'open' | 'resolved') => void;
  onSelectTicket?: (id: string) => void;
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

export default function TicketPanel({
  ticket, agents, channels, workspaceTickets, typingIndicators, accountId,
  onClose, onUpdate, onMove, onDelete, onCreateChild, onDeleteChild, onReparentChild, onSaveDraft, onAddComment, onSetCommentStatus, onSelectTicket,
  scrollToCommentId, onScrollToCommentConsumed,
}: TicketPanelProps) {
  // True while a Save round-trip is in flight — disables the Save/Discard
  // footer and the assignee editor so a second commit can't fire before the
  // first has resolved.
  const [savingDraft, setSavingDraft] = useState(false);
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  // Navigation stack: array of ticket IDs navigated within this panel
  const [navStack, setNavStack] = useState<string[]>([ticket.id]);

  // Reset navStack when root ticket changes
  useEffect(() => {
    setNavStack([ticket.id]);
  }, [ticket.id]);

  const activePanelId = navStack[navStack.length - 1];

  // Derive active ticket from the root ticket tree
  const activeTicket = findInTree(ticket, activePanelId) || ticket;

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

  const wsId = activeTicket.account_id || accountId || getActiveAccountId() || '';
  const isRoot = activeTicket.depth === 0 && !activeTicket.parent_id;

  // In-flight flags below are keyed by ticket id: the panel is reused across
  // tickets (and across the child nav stack), so a Run / move / archive still
  // pending on one ticket must not disable or annotate the next one.

  // Status moves immediately (not part of the Save draft). The picked status
  // shows until the refreshed ticket prop lands.
  const [statusPending, setStatusPending] = useState<{ id: string; status: TicketStatus } | null>(null);
  const pendingStatus = statusPending?.id === activeTicket.id ? statusPending.status : null;
  const moveTicket = useCallback(async (ticketId: string, status: TicketStatus) => {
    try {
      await Promise.resolve(onMove ? onMove(ticketId, status) : api.moveTicket(ticketId, status));
    } catch (e: any) {
      showToast(`Move failed: ${e?.message || 'unknown error'}`, 'error');
    }
  }, [onMove, showToast]);
  const handleStatusChange = useCallback(async (status: TicketStatus) => {
    const id = activeTicket.id;
    if (status === activeTicket.status || pendingStatus) return;
    setStatusPending({ id, status });
    try { await moveTicket(id, status); } finally { setStatusPending(cur => (cur?.id === id ? null : cur)); }
  }, [activeTicket.id, activeTicket.status, pendingStatus, moveTicket]);

  // Manual "Run" (root tickets only) — asks the dispatcher to (re)send the
  // ticket to its assignee now. A refusal carries the reason (unassigned,
  // pending, paused, at capacity, …), kept inline under the assignee too.
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runRefusal, setRunRefusal] = useState<{ id: string; reason: string } | null>(null);
  const running = runningId === activeTicket.id;
  const runNote = runRefusal?.id === activeTicket.id ? runRefusal.reason : null;
  const handleRun = useCallback(async () => {
    const id = activeTicket.id;
    if (runningId === id) return;
    setRunningId(id);
    setRunRefusal(null);
    try {
      const res = await api.triggerTicket(id);
      if (res?.dispatched) {
        showToast('담당자에게 실행을 보냈습니다', 'success');
      } else {
        const reason = triggerReasonLabel(res?.reason);
        setRunRefusal({ id, reason });
        showToast(res?.reason === 'queued' ? reason : `디스패치되지 않음: ${reason}`, 'info');
      }
    } catch (e: any) {
      showToast(`Run failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setRunningId(cur => (cur === id ? null : cur));
    }
  }, [activeTicket.id, runningId, showToast]);

  const [archivingId, setArchivingId] = useState<string | null>(null);
  const handleToggleArchive = useCallback(async () => {
    const id = activeTicket.id;
    if (archivingId === id) return;
    const archived = !!activeTicket.archived_at;
    setArchivingId(id);
    try {
      if (archived) await api.unarchiveTicket(id);
      else await api.archiveTicket(id);
      showToast(archived ? 'Unarchived' : 'Archived', 'success');
    } catch (e: any) {
      showToast(`${archived ? 'Unarchive' : 'Archive'} failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setArchivingId(cur => (cur === id ? null : cur));
    }
  }, [activeTicket.id, activeTicket.archived_at, archivingId, showToast]);
  const archiveBusy = archivingId === activeTicket.id;

  // ESC key requests close — the real handler is installed below, after
  // requestClose is in scope (which depends on form-draft state declared
  // further down). Closing with unsaved edits prompts.

  // Detail-tab Save/Discard draft (ticketPanel/ticketDraft.ts). Reset on
  // ticket switch only — remote updated_at bumps must NOT clobber unsaved edits.
  const [draft, setDraft] = useState<TicketDraft>(() => draftFromTicket(activeTicket));
  const setDraftField = useCallback(<K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  }, []);
  const draftTags = effectiveTags(draft, activeTicket);
  const draftAssignee = effectiveAssignee(draft, activeTicket);
  // Dynamic Description textarea sizing: clamp visible rows between 10 and 20,
  // growing with the content (explicit newlines + estimated soft-wrap at ~80
  // cols). Keeps short tickets compact-ish while long ones stay readable
  // without the user having to drag the resize handle every time.
  const descriptionRows = useMemo(() => {
    const text = draft.description || '';
    const wrapWidth = 80;
    const visualLines = text.split('\n').reduce(
      (acc, line) => acc + Math.max(1, Math.ceil(line.length / wrapWidth)),
      0,
    );
    return Math.max(10, Math.min(20, visualLines));
  }, [draft.description]);

  const { projects, loading: projectsLoading } = useProjects(wsId || null);
  // The workspace list wins; until it loads, the full ticket's own project
  // summary (it carries host_folders) still lets the assignee editor prefill
  // the project's folder on the chosen host.
  const draftProject = useMemo(
    () => projects.find(p => p.id === draft.projectId)
      || (activeTicket.project && activeTicket.project.id === draft.projectId ? activeTicket.project : null),
    [projects, draft.projectId, activeTicket.project],
  );
  // Tag suggestions: every tag in the loaded pool, most used first.
  // plus the workspace-wide `/ticket-tags` counts (the page may be filtered).
  const workspaceTags = useTicketTags(wsId || null);
  const tagPool = useMemo(
    () => mergeTagSuggestions(collectTagPool(workspaceTickets), workspaceTags),
    [workspaceTickets, workspaceTags],
  );
  const [actionOptions, setActionOptions] = useState<Action[]>([]);
  const [commentContent, setCommentContent] = useState('');
  // Staged attachments — kept in memory until the user hits Send. Two kinds:
  //   • file     — a freshly picked File, uploaded as a Resource on Send (raw
  //                bytes, no base64-in-JSON, so large videos don't 413).
  //   • resource — a reference to an already-uploaded workspace Resource.
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
  const [prereqRows, setPrereqRows] = useState<TicketPrerequisiteRow[]>(activeTicket.prerequisites || []);
  const [prereqBusy, setPrereqBusy] = useState(false);
  const [prereqError, setPrereqError] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  // Modal preview can be an image OR a video — discriminate by mimetype so
  // the modal picks the right element. `null` mimetype falls back to <img>
  // for backwards compatibility with legacy callers that pass src only.
  const [imagePreview, setImagePreview] = useState<{ src: string; mimetype?: string } | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);

  const [duplicateDecisionBusy, setDuplicateDecisionBusy] = useState(false);
  const [duplicateDecisionDone, setDuplicateDecisionDone] = useState(false);

  // Form drafts reset on ticket switch only. Remote updates (updated_at
  // bumps from cross-tab edits, comments, etc.) must NOT clobber the user's
  // unsaved edits — the Save/Discard footer is the only commit/rollback
  // path now that the panel buffers all field edits.
  useEffect(() => {
    setDraft(draftFromTicket(activeTicket));
    setCommentContent('');
    setCommentAttachments([]);
    setPendingReasonDraft(activeTicket.pending_reason || '');
    setDuplicateDecisionDone(false);
    setUserResponseDraft('');
    // Auto-switch to the User tab when opening a pending ticket so the human
    // sees the ask immediately. Skipped when scrollToCommentId is set (a
    // deep-link from a mention notification — that lives in the comments
    // tab and the dedicated effect below routes there).
    setActiveTab(activeTicket.pending_user_action ? 'user' : 'detail');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicket.id]);

  const handleDuplicateDecision = useCallback(async (candidateId: string | null) => {
    if (duplicateDecisionBusy) return;
    setDuplicateDecisionBusy(true);
    try {
      await api.decideTicketDuplicate(activeTicket.id, candidateId
        ? { action: 'link', candidate_ticket_id: candidateId }
        : { action: 'keep_independent' });
      setDuplicateDecisionDone(true);
      showToast(candidateId
        ? 'Linked to the selected canonical ticket. Independent dispatch remains suppressed.'
        : 'Kept as an independent ticket and resumed normal dispatch.', 'success');
    } catch (error: any) {
      showToast(error?.message || 'Could not save the duplicate decision.', 'error');
    } finally {
      setDuplicateDecisionBusy(false);
    }
  }, [activeTicket.id, duplicateDecisionBusy, showToast]);

  // Mention deep-link override — when a comment id is queued (at panel mount
  // or arriving on the currently-open ticket), jump to the comments tab so
  // the scroll-and-highlight has somewhere to land. Skip the null clear:
  // the page resets scrollToCommentId after the highlight fires, and re-
  // running the form-drafts reset above would wipe the user's unsaved edits
  // and snap the tab back to detail mid-highlight.
  useEffect(() => {
    if (scrollToCommentId) setActiveTab('comments');
  }, [scrollToCommentId]);

  // Auto-route to the User tab when this ticket transitions into pending state
  // from elsewhere (agent flipped pending_user_action while the panel is open).
  // The activeTicket prop is bumped via the page's refresh on the same SSE event,
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
  // onAddComment is fire-and-forget per its prop type but the page's wrapper
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
  // payload first (only the full ticket read populates it), then fetches fresh
  // so the section is authoritative. Refetched on updated_at so an agent
  // adding/clearing a prereq elsewhere converges here.
  useEffect(() => {
    setPrereqRows(activeTicket.prerequisites || []);
    setPrereqError(null);
    let cancelled = false;
    api.listPrerequisites(activeTicket.id)
      .then(res => { if (!cancelled) setPrereqRows(res?.prerequisites || []); })
      .catch(() => { /* keep seeded list — non-blocking */ });
    return () => { cancelled = true; };
  }, [activeTicket.id, activeTicket.updated_at]);

  // The REST endpoints return the full updated ticket (incl. the refreshed
  // `prerequisites` array), so adopt that directly rather than issuing a
  // follow-up GET. The SSE board_update (fired by the prerequisite activity)
  // keeps pending_on_tickets and the list row in sync.
  const handleAddPrerequisite = useCallback(async (prerequisiteId: string, reason: string): Promise<boolean> => {
    setPrereqBusy(true);
    setPrereqError(null);
    try {
      const updated = await api.addPrerequisites(activeTicket.id, [prerequisiteId], reason || undefined);
      setPrereqRows(updated?.prerequisites || []);
      return true;
    } catch (e: any) {
      setPrereqError(e?.message || 'Failed to add prerequisite');
      return false;
    } finally {
      setPrereqBusy(false);
    }
  }, [activeTicket.id]);

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

  // Seed @-mention candidates from the agents prop immediately so the
  // dropdown works before the workspace mention-candidates call returns.
  useEffect(() => {
    setMentionCandidates(agents.map(a => ({ type: 'agent' as const, id: a.id, name: formatAgentDisplayName(a) })));
    if (!wsId) return;
    let cancelled = false;
    api.getMentionCandidates(wsId, activeTicket.id)
      .then(data => {
        if (cancelled) return;
        const next: MentionCandidate[] = [
          ...data.users.map(u => ({ type: 'user' as const, id: u.id, name: u.name })),
          // Enrich server-returned agent rows with manager_name from the
          // local agents list (which carries it). Falls back to the server
          // row's own manager_name when a candidate isn't in the local list.
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
    return () => { cancelled = true; };
  }, [activeTicket.id, agents, wsId]);

  // Ticket-field drafts that differ from the server-side row, shaped as the
  // PATCH body. The Save handler sends it in a single round trip (one
  // ticket_update activity instead of one per field).
  const dirtyTicketFields = useMemo(() => computeDirtyTicketFields(draft, activeTicket), [draft, activeTicket]);
  const isDirty = Object.keys(dirtyTicketFields).length > 0;

  const handleDiscardDraft = useCallback(() => {
    setDraft(draftFromTicket(activeTicket));
  }, [activeTicket]);

  const handleSaveDraft = useCallback(async () => {
    if (savingDraft) return;
    // Snapshot the in-flight commit so edits made DURING the save round trip
    // survive (settleSavedDraft only drops overrides that were part of it).
    const fieldsToSave = dirtyTicketFields;
    const savedDraft = draft;
    if (Object.keys(fieldsToSave).length === 0) return;
    setSavingDraft(true);
    try {
      if (onSaveDraft) await onSaveDraft(activeTicket.id, fieldsToSave);
      else await Promise.resolve(onUpdate(activeTicket.id, fieldsToSave));
      // Only reached when the save resolved cleanly. A throw skips this, so
      // the draft stays buffered and the Save footer stays visible.
      setDraft(cur => settleSavedDraft(cur, savedDraft));
      showToast('Saved', 'success');
    } catch (e: any) {
      showToast(`Save failed: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setSavingDraft(false);
    }
  }, [savingDraft, dirtyTicketFields, draft, activeTicket.id, onSaveDraft, onUpdate, showToast]);

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

  // Load the Action candidates for the "Run on Done" picker. Reusable Actions
  // are Account-scoped, and per-ticket dispatch checks workspace + enabled.
  useEffect(() => {
    if (!wsId) {
      setActionOptions([]);
      return;
    }
    let cancelled = false;
    api.listActions(wsId)
      .then(rows => { if (!cancelled) setActionOptions(rows || []); })
      .catch(() => { if (!cancelled) setActionOptions([]); });
    return () => { cancelled = true; };
  }, [wsId]);

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
    // table the same as any other workspace asset, so the picker accepts
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

  // ─── Reference an existing workspace Resource ──────────────
  // The design-recommended path: instead of re-uploading bytes, point the
  // comment at a Resource that already exists. The comment POST then carries
  // only the id (ticket ff3e7337).
  const openResourcePicker = useCallback(async () => {
    setResourcePickerOpen(true);
    setResourcePickerLoading(true);
    setResourcePickerError(null);
    const ws = (activeTicket as any).account_id || accountId;
    if (!ws) {
      setResourcePickerError('소유 계정을 확인할 수 없습니다.');
      setResourcePickerLoading(false);
      return;
    }
    try {
      // Account files first, then existing comment attachments — de-duped
      // by id, files with bytes only.
      const wsRes = await api.listResources(ws).catch(() => [] as Resource[]);
      const seen = new Set<string>();
      const merged = wsRes.filter((r) => {
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
  }, [activeTicket, accountId]);

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
      const ws = (activeTicket as any).account_id || accountId;
      if (!ws) { showToast('소유 계정을 확인할 수 없어 첨부를 업로드할 수 없습니다.', 'error'); return; }
      setCommentSending(true);
      try {
        for (const att of commentAttachments) {
          if (att.resourceId) { resourceIds.push(att.resourceId); continue; }
          if (att.file) {
            const uploaded = await api.uploadResourceFile(att.file, {
              account_id: ws,
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
    //
    // This marker covers ticket-comment UNREAD counts only. @-mentions are
    // deliberately NOT cleared by it — they clear per-comment once the
    // comment carrying them is actually on screen (useMentionViewportReader,
    // wired below).
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
        const wsId = activeTicket.account_id || accountId || getActiveAccountId();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (wsId) headers['X-Account-Id'] = wsId;
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
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: '11px', padding: '3px 8px', borderRadius: 4,
            background: tokens.colors.surfaceCard, color: tokens.colors.textMuted,
          }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: ticketStatusColor(activeTicket.status) }} />
            {ticketStatusLabel(activeTicket.status)}
          </span>
          {activeTicket.archived_at && (
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase',
              background: tokens.colors.surfaceSubtle, color: tokens.colors.textMuted,
            }}>Archived</span>
          )}
          {/* Tier-1 G stale-question badge in the panel header. Same threshold
             as the ticket card so a ticket marked stale in the list stays
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
        {/* 진행 상태 — 보드 카드·미션·세션·채팅이 공유하는 어휘(src/activity.ts).
            오른쪽 프레임 헤더는 점 대신 라벨까지 보여 준다. */}
        <ActivityPill view={ticketActivity(activeTicket)} />
        <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
          {/* Run — root tickets only; children are a checklist the parent's
              assignee works through and are never dispatched themselves. */}
          {isRoot && (
            <button
              onClick={handleRun}
              disabled={running || !activeTicket.assignee}
              title={activeTicket.assignee
                ? 'Send this ticket to its assignee now'
                : '담당자가 없어 실행할 수 없습니다 — Detail 탭에서 담당자를 지정하고 저장하세요'}
              style={{
                background: tokens.colors.surfaceCard,
                color: activeTicket.assignee ? tokens.colors.accentMid : tokens.colors.textMuted,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '4px 12px',
                fontSize: '12px',
                cursor: running || !activeTicket.assignee ? 'not-allowed' : 'pointer',
                opacity: running || !activeTicket.assignee ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>▶</span>
              <span>{running ? 'Running…' : 'Run'}</span>
            </button>
          )}
          {isRoot && (
            <button
              onClick={handleToggleArchive}
              disabled={archiveBusy}
              title={activeTicket.archived_at ? 'Restore this ticket to the pool' : 'Archive this ticket (and its subtasks)'}
              style={{
                background: tokens.colors.surfaceCard, color: tokens.colors.textSecondary,
                border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                padding: '4px 12px', fontSize: '12px', cursor: archiveBusy ? 'not-allowed' : 'pointer',
              }}
            >{activeTicket.archived_at ? 'Unarchive' : 'Archive'}</button>
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
              value={draft.title}
              onChange={e => setDraftField('title', e.target.value)}
              style={{
                width: '100%', background: 'transparent', border: 'none', color: tokens.colors.textPrimary,
                fontSize: '18px', fontWeight: 700, outline: 'none', marginBottom: 14,
              }}
            />

            {/* Status (moves immediately) + Priority (draft) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Status{pendingStatus ? ' · moving…' : ''}</label>
                <select
                  value={pendingStatus ?? activeTicket.status}
                  disabled={!!pendingStatus}
                  onChange={e => handleStatusChange(e.target.value as TicketStatus)}
                  style={{
                    background: tokens.colors.surfaceCard,
                    border: `2px solid ${ticketStatusColor(pendingStatus ?? activeTicket.status)}`,
                    borderRadius: tokens.radii.md, padding: '5px 8px',
                    color: ticketStatusColor(pendingStatus ?? activeTicket.status),
                    fontSize: '12px', fontWeight: 600, width: '100%',
                    cursor: pendingStatus ? 'not-allowed' : 'pointer',
                  }}
                >
                  {TICKET_STATUSES.map(s => <option key={s} value={s}>{ticketStatusLabel(s)}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Priority</label>
                <select
                  value={draft.priority}
                  onChange={e => setDraftField('priority', e.target.value as TicketDraft['priority'])}
                  style={{
                    background: tokens.colors.surfaceCard, border: `2px solid ${priorityColors[draft.priority]}`,
                    borderRadius: tokens.radii.md, padding: '5px 8px',
                    color: priorityColors[draft.priority], fontSize: '12px', fontWeight: 600, width: '100%',
                  }}
                >
                  {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>)}
                </select>
              </div>
            </div>

            {/* Tags (draft) — suggestions come from the loaded workspace pool */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Tags</label>
              <TagInput
                key={`tags-${activeTicket.id}`}
                value={draftTags}
                suggestions={tagPool}
                onChange={next => setDraftField('tags', next)}
              />
            </div>

            {/* Project / base branch + assignee — root tickets only. Children
                have no assignee and are never dispatched: the parent's
                assignee works through them in the parent's checkout. */}
            {isRoot ? (
              <>
                <ProjectBranchFields
                  projects={projects}
                  projectsLoading={projectsLoading}
                  projectId={draft.projectId}
                  baseBranch={draft.baseBranch}
                  savedProject={activeTicket.project}
                  onProjectChange={id => setDraft(prev => ({ ...prev, projectId: id, baseBranch: '' }))}
                  onBranchChange={b => setDraftField('baseBranch', b)}
                  labelStyle={labelStyle}
                />
                <AssigneeSection
                  key={`assignee-${activeTicket.id}`}
                  assignee={draftAssignee}
                  unsaved={!!draft.assignee && !runtimeSpecEqual(draft.assignee.value, activeTicket.assignee)}
                  project={draftProject}
                  accountId={wsId}
                  disabled={savingDraft}
                  onChange={(next: RuntimeSpecDraft | null) => setDraftField('assignee', { value: next })}
                  runNote={runNote}
                  labelStyle={labelStyle}
                />
              </>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Assignee</label>
                <div style={{ fontSize: '12px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                  부모 티켓의 담당자가 처리합니다
                </div>
              </div>
            )}

            {/* Next Ticket — when this ticket enters `done`, the linked ticket
                is picked up next. Options come from the loaded workspace pool;
                the server-hydrated next_ticket snapshot keeps the saved link
                visible even when it isn't in the loaded list. */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                Next Ticket
                {activeTicket.next_ticket?.status
                  ? ` · currently ${ticketStatusLabel(activeTicket.next_ticket.status)}`
                  : ''}
              </label>
              <select
                value={draft.nextTicketId}
                onChange={e => setDraftField('nextTicketId', e.target.value)}
                style={{
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                  padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%', cursor: 'pointer',
                }}
              >
                <option value="">— None —</option>
                {activeTicket.next_ticket && !(workspaceTickets || []).some(t => t.id === activeTicket.next_ticket!.id) && (
                  <option value={activeTicket.next_ticket.id}>
                    {activeTicket.next_ticket.title} · {ticketStatusLabel(activeTicket.next_ticket.status)}
                  </option>
                )}
                {(workspaceTickets || [])
                  .filter(t => t.id !== activeTicket.id)
                  .map(t => (
                    <option key={t.id} value={t.id}>{t.title} · {ticketStatusLabel(t.status)}</option>
                  ))}
              </select>
            </div>

            <OnDoneActionsField
              value={draft.onDoneActionIds}
              onChange={update => setDraft(prev => ({ ...prev, onDoneActionIds: update(prev.onDoneActionIds) }))}
              actions={actionOptions}
              agents={agents}
              labelStyle={labelStyle}
            />

            <PrerequisitesField
              key={`prereq-${activeTicket.id}`}
              rows={prereqRows}
              busy={prereqBusy}
              error={prereqError}
              candidates={(workspaceTickets || []).filter(t =>
                t.id !== activeTicket.id && !prereqRows.some(r => r.prerequisite_ticket_id === t.id))}
              onAdd={handleAddPrerequisite}
              onRemove={handleRemovePrerequisite}
              onOpen={onSelectTicket}
              labelStyle={labelStyle}
            />
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
                value={draft.description}
                onChange={e => setDraftField('description', e.target.value)}
                placeholder="Add description..."
                rows={descriptionRows}
                style={{
                  width: '100%', background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg, padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px',
                  resize: 'vertical', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
                }}
              />
            </div>

            <TicketAttachmentsSection
              key={`attachments-${activeTicket.id}`}
              ticket={activeTicket}
              onPreview={(src, mimetype) => setImagePreview({ src, mimetype })}
              labelStyle={labelStyle}
            />

            {/* Notification Channels */}
            {channels.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Notification Channels</label>
                <div style={{
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
                  padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
                }}>
                  {channels.map(ch => {
                    const isSelected = draft.channelIds.includes(ch.id);
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
                            if (isSelected && draft.channelIds.length <= 1) return;
                            const next = isSelected
                              ? draft.channelIds.filter(id => id !== ch.id)
                              : [...draft.channelIds, ch.id];
                            setDraftField('channelIds', next);
                          }}
                          style={{ accentColor: tokens.colors.accent, cursor: isSelected && draft.channelIds.length <= 1 ? 'not-allowed' : 'pointer' }}
                        />
                        <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{ch.name}</span>
                        <span style={{ fontSize: '10px', color: ch.is_active ? tokens.colors.successLight : tokens.colors.textSecondary, marginLeft: 'auto' }}>
                          {ch.type}{ch.is_active ? '' : ' (inactive)'}
                        </span>
                      </label>
                    );
                  })}
                  {draft.channelIds.length === 0 && (
                    <div style={{ fontSize: '11px', color: tokens.colors.danger, padding: '4px 6px', background: `${tokens.colors.danger}15`, borderRadius: tokens.radii.sm }}>
                      No channel selected — please select at least one channel to receive notifications
                    </div>
                  )}
                  {draft.channelIds.length === 1 && (
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
              maxDepth={2}
              workspaceTickets={workspaceTickets}
              tagPool={tagPool}
              onCreateChild={onCreateChild}
              onMoveChild={moveTicket}
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
              ticketIdForMentions={activeTicket.id}
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
                  Waiting on {openPrerequisiteCount(prereqRows) || prereqRows.length} prerequisite ticket(s).
                  This resumes <strong>automatically</strong> once every prerequisite is <strong>Done</strong> — no action needed.
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

                {activeTicket.duplicate_decision_pending === true
                  && !!activeTicket.duplicate_candidates?.length
                  && !duplicateDecisionDone ? (
                  <div style={{
                    background: tokens.colors.surfaceCard,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.lg,
                    padding: '12px 14px',
                  }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 8 }}>
                      Is this report a duplicate?
                    </div>
                    <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, lineHeight: 1.5, marginBottom: 10 }}>
                      Choose the canonical ticket to link. This report will follow its outcome without waking an assignee or reviewer independently.
                    </div>
                    {activeTicket.duplicate_candidates.map(candidate => (
                      <div key={candidate.ticket_id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 12, padding: '9px 0', borderTop: `1px solid ${tokens.colors.border}`,
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: tokens.colors.textStrong, fontSize: '13px', fontWeight: 600 }}>
                            {candidate.title}
                          </div>
                          <div style={{ color: tokens.colors.textSecondary, fontSize: '11px', marginTop: 3 }}>
                            {candidate.ticket_id} · {candidate.matched_signals.join(', ').replaceAll('_', ' ')}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={duplicateDecisionBusy}
                          onClick={() => handleDuplicateDecision(candidate.ticket_id)}
                          style={{
                            flexShrink: 0, background: tokens.colors.surfaceSubtle,
                            border: `1px solid ${tokens.colors.info}`, borderRadius: tokens.radii.md,
                            color: tokens.colors.info, padding: '6px 10px', fontSize: '12px',
                            fontWeight: 600, cursor: 'pointer', opacity: duplicateDecisionBusy ? 0.5 : 1,
                          }}
                        >Link here</button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                      <button
                        type="button"
                        disabled={duplicateDecisionBusy}
                        onClick={() => handleDuplicateDecision(null)}
                        style={{
                          background: 'transparent', border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md, color: tokens.colors.textSecondary,
                          padding: '6px 10px', fontSize: '12px', fontWeight: 600,
                          cursor: 'pointer', opacity: duplicateDecisionBusy ? 0.5 : 1,
                        }}
                      >Keep independent</button>
                    </div>
                  </div>
                ) : duplicateDecisionDone ? (
                  <div style={{
                    background: tokens.colors.successBg,
                    border: `1px solid ${tokens.colors.successLight}`,
                    borderRadius: tokens.radii.md,
                    color: tokens.colors.successLight,
                    padding: '10px 12px',
                    fontSize: '12px',
                  }}>
                    Duplicate decision saved.
                  </div>
                ) : (
                  <>
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
                  </>
                )}

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
                  <li>Need to split the work? Create a follow-up ticket, then Resume.</li>
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
                  re-trying. Parked tickets get a high-visibility badge in the
                  ticket list and are not dispatched until you resume them.
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

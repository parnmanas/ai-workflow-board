import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { AGENT_SESSIONS_CHANGED_EVENT, useAgentSessionsNav } from '../../hooks/useAgentSessionsNav';
import { tokens } from '../../tokens';
import type {
  AgentSessionEventEvent,
  AgentSessionEventRecord,
  AgentSessionSnapshot,
  AgentSessionUpdateEvent,
} from '../../types';
import { Button, EmptyState, ErrorState } from '../common';
import PageHeader from '../PageHeader';
import NewSessionModal from './NewSessionModal';
import SessionComposer from './SessionComposer';
import SessionTranscript from './SessionTranscript';
import {
  buildTranscript,
  canPrompt,
  describeSessionStatus,
  hasSeqGap,
  mergeIncomingEvent,
  pendingPermission,
  runtimeLabel,
  sessionDisplayTitle,
} from './sessionTranscript.logic';

/**
 * Sessions — Agent Session(CLI 직접 세션) 표면. `/ws/:wsId/sessions` 는 목록,
 * `/ws/:wsId/sessions/:sessionId` 는 한 세션의 트랜스크립트 + 컴포저.
 *
 * Chat(ChatPage) 과는 데이터도 계약도 다르다: 방/참여자/멘션이 없고, 에이전트의
 * ACP 스트림이 그대로 보이며, 권한 요청은 여기서 사용자가 결정한다.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function toneColor(tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger'): string {
  switch (tone) {
    case 'accent': return tokens.colors.accentLight;
    case 'success': return tokens.colors.successLight;
    case 'warning': return tokens.colors.warningLight;
    case 'danger': return tokens.colors.dangerLight;
    default: return tokens.colors.textMuted;
  }
}

function StatusPill({ status }: { status: string }) {
  const view = describeSessionStatus(status);
  const color = toneColor(view.tone);
  return (
    <span
      data-session-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        color,
        border: `1px solid ${color}55`,
        borderRadius: 999,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        className={status === 'busy' || status === 'starting' ? 'awb-pending-pulse' : undefined}
        style={{ width: 7, height: 7, borderRadius: '50%', background: color }}
      />
      {view.label}
    </span>
  );
}

function RuntimeBadge({ runtime }: { runtime: string }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        color: tokens.colors.accentSubtle,
        background: tokens.colors.badgeAgentBg,
        border: `1px solid ${tokens.colors.accent}55`,
        borderRadius: 999,
        padding: '1px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {runtimeLabel(runtime)}
    </span>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ─── 목록 ───────────────────────────────────────────────────────────────────

function SessionsIndex({
  wsId,
  sessions,
  loading,
  error,
  onReload,
  onNew,
}: {
  wsId: string;
  sessions: AgentSessionSnapshot[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onNew: () => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Drive a CLI agent directly — Claude Code, Codex, Hermes. Your session, your working folder, your approvals."
        actions={<Button variant="primary" size="sm" onClick={onNew}>New session</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={onReload} />
        ) : loading && sessions.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            description="Start a session with one of your agents. Everything the CLI does streams here, and tool permissions wait for your decision."
            action={<Button variant="primary" onClick={onNew}>Start your first session</Button>}
          />
        ) : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate(`/ws/${wsId}/sessions/${s.id}`)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg,
                  background: tokens.colors.surfaceCard,
                  padding: '12px 14px',
                  color: tokens.colors.textPrimary,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontFamily: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sessionDisplayTitle(s)}
                  </span>
                  <StatusPill status={s.status} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.agent_name}</span>
                  <RuntimeBadge runtime={s.runtime} />
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.textMuted }}>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.cwd}>
                    {s.cwd || '(agent working_dir)'}
                  </span>
                  <span>{relativeTime(s.last_activity_at || s.created_at)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── 세션 뷰 ────────────────────────────────────────────────────────────────

function SessionView({
  wsId,
  sessionId,
  onDeleted,
  onNew,
}: {
  wsId: string;
  sessionId: string;
  onDeleted: () => void;
  onNew: () => void;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [session, setSession] = useState<AgentSessionSnapshot | null>(null);
  const [events, setEvents] = useState<AgentSessionEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const refetchingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snap, list] = await Promise.all([
        api.getAgentSession(sessionId),
        api.listAgentSessionEvents(sessionId, 0, 2000),
      ]);
      setSession(snap);
      setEvents(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load the session');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useBoardStreamEvent('agent_session_update', useCallback((data: AgentSessionUpdateEvent) => {
    if (!data?.session || data.session.id !== sessionId) return;
    if (data.reason === 'deleted') {
      onDeleted();
      return;
    }
    setSession(data.session);
  }, [sessionId, onDeleted]));

  useBoardStreamEvent('agent_session_event', useCallback((data: AgentSessionEventEvent) => {
    if (!data || data.session_id !== sessionId || !data.event) return;
    setEvents((prev) => mergeIncomingEvent(prev, data.event));
  }, [sessionId]));

  // SSE 유실로 seq 갭이 생기면 한 번 재조회한다.
  useEffect(() => {
    if (!hasSeqGap(events) || refetchingRef.current) return;
    refetchingRef.current = true;
    api.listAgentSessionEvents(sessionId, 0, 2000)
      .then((list) => setEvents(Array.isArray(list) ? list : []))
      .catch(() => undefined)
      .finally(() => {
        refetchingRef.current = false;
      });
  }, [events, sessionId]);

  const blocks = useMemo(() => buildTranscript(events), [events]);
  const pending = useMemo(() => pendingPermission(blocks), [blocks]);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const status = session?.status || 'starting';
  const statusView = describeSessionStatus(status);
  const busy = status === 'busy' || status === 'awaiting_permission';

  const send = useCallback(async (text: string) => {
    try {
      const result = await api.promptAgentSession(sessionId, text);
      setSession(result.session);
      setFollow(true);
    } catch (err: any) {
      showToast(err?.message || 'Failed to send the prompt', 'error');
      throw err;
    }
  }, [sessionId, showToast]);

  const decide = useCallback(async (requestId: string, optionId: string | null) => {
    setDecidingRequestId(requestId);
    try {
      const snap = await api.decideAgentSessionPermission(sessionId, requestId, optionId);
      setSession(snap);
    } catch (err: any) {
      showToast(err?.message || 'Failed to answer the permission request', 'error');
    } finally {
      setDecidingRequestId(null);
    }
  }, [sessionId, showToast]);

  const cancel = useCallback(async () => {
    try {
      await api.cancelAgentSession(sessionId);
      showToast('Cancel requested', 'info');
    } catch (err: any) {
      showToast(err?.message || 'Failed to cancel', 'error');
    }
  }, [sessionId, showToast]);

  const setMode = useCallback(async (modeId: string) => {
    try {
      await api.setAgentSessionMode(sessionId, modeId);
    } catch (err: any) {
      showToast(err?.message || 'Failed to change mode', 'error');
    }
  }, [sessionId, showToast]);

  const saveTitle = useCallback(async () => {
    setEditingTitle(false);
    if (!session || titleDraft.trim() === (session.title || '').trim()) return;
    try {
      const snap = await api.renameAgentSession(sessionId, titleDraft.trim());
      setSession(snap);
    } catch (err: any) {
      showToast(err?.message || 'Failed to rename', 'error');
    }
  }, [session, sessionId, titleDraft, showToast]);

  const close = useCallback(async () => {
    if (!(await confirm({ title: 'Close this session?', message: 'The agent process stops. The transcript stays readable, but you cannot prompt it again.', danger: false, confirmLabel: 'Close session' }))) return;
    try {
      const snap = await api.closeAgentSession(sessionId);
      setSession(snap);
    } catch (err: any) {
      showToast(err?.message || 'Failed to close', 'error');
    }
  }, [confirm, sessionId, showToast]);

  const remove = useCallback(async () => {
    if (!(await confirm({ title: 'Delete this session?', message: 'The transcript is deleted for good.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await api.deleteAgentSession(sessionId);
      window.dispatchEvent(new Event(AGENT_SESSIONS_CHANGED_EVENT));
      onDeleted();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete', 'error');
    }
  }, [confirm, sessionId, onDeleted, showToast]);

  if (error && !session) {
    return (
      <>
        <PageHeader title="Session" actions={<Button variant="secondary" size="sm" onClick={() => navigate(`/ws/${wsId}/sessions`)}>All sessions</Button>} />
        <div style={{ padding: 20 }}><ErrorState message={error} onRetry={() => void load()} /></div>
      </>
    );
  }

  const composerHint = status === 'closed'
    ? 'This session is closed. Start a new one to continue.'
    : status === 'awaiting_permission'
      ? 'The agent is waiting for your decision on the permission request above.'
      : status === 'suspended'
        ? 'The agent process is stopped. Your next prompt reopens the session' + (session?.resume_supported ? ' and restores its context.' : '.')
        : status === 'error' && session?.last_error
          ? `Last error: ${session.last_error}`
          : null;

  return (
    <>
      <header
        style={{
          background: tokens.gradients.surfaceCard,
          borderBottom: `1px solid ${tokens.colors.border}`,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => navigate(`/ws/${wsId}/sessions`)}
          aria-label="All sessions"
          title="All sessions"
          style={{ border: 'none', background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
        >
          ←
        </button>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {editingTitle ? (
            <input
              autoFocus
              aria-label="Session title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              style={{
                fontSize: 15,
                fontWeight: 700,
                background: tokens.colors.surface,
                color: tokens.colors.textPrimary,
                border: `1px solid ${tokens.colors.accent}`,
                borderRadius: tokens.radii.md,
                padding: '2px 8px',
                maxWidth: 520,
              }}
            />
          ) : (
            <button
              type="button"
              title="Rename"
              onClick={() => {
                setTitleDraft(session?.title || '');
                setEditingTitle(true);
              }}
              style={{
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: tokens.colors.textPrimary,
                fontSize: 15,
                fontWeight: 700,
                padding: 0,
                cursor: 'text',
                fontFamily: 'inherit',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {session ? sessionDisplayTitle(session) : 'Session'}
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: tokens.colors.textSecondary, flexWrap: 'wrap' }}>
            <span>{session?.agent_name || '…'}</span>
            {session && <RuntimeBadge runtime={session.runtime} />}
            <span style={{ fontFamily: MONO, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }} title={session?.cwd || ''}>
              {session?.cwd || '(agent working_dir)'}
            </span>
          </div>
        </div>
        <StatusPill status={status} />
        {session && session.available_modes.length > 0 && (
          <select
            aria-label="Session mode"
            value={session.current_mode || ''}
            disabled={status === 'closed'}
            onChange={(e) => void setMode(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: tokens.radii.md,
              border: `1px solid ${tokens.colors.border}`,
              background: tokens.colors.surface,
              color: tokens.colors.textPrimary,
              fontSize: 12,
            }}
          >
            {!session.current_mode && <option value="">mode…</option>}
            {session.available_modes.map((m) => (
              <option key={m.id} value={m.id} title={m.description}>{m.name}</option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" onClick={() => void load()} title="Reload transcript">Reload</Button>
          <Button variant="ghost" size="sm" onClick={onNew}>New</Button>
          {status !== 'closed' && <Button variant="secondary" size="sm" onClick={() => void close()}>Close</Button>}
          <Button variant="danger" size="sm" onClick={() => void remove()}>Delete</Button>
        </div>
      </header>

      {session?.last_error && status === 'error' && (
        <div role="alert" style={{ padding: '8px 16px', fontSize: 12, color: tokens.colors.dangerLight, background: `${tokens.colors.dangerBg}66`, borderBottom: `1px solid ${tokens.colors.border}` }}>
          {session.last_error}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }}
      >
        {loading && events.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading transcript…</div>
        ) : blocks.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>
            {statusView.live ? 'Session is ready. Send your first prompt.' : 'No transcript yet.'}
          </div>
        ) : (
          <SessionTranscript
            blocks={blocks}
            decidingRequestId={decidingRequestId}
            onDecidePermission={(requestId, optionId) => void decide(requestId, optionId)}
            permissionsEnabled={status === 'awaiting_permission' || status === 'busy'}
          />
        )}
      </div>

      {!follow && (
        <button
          type="button"
          onClick={() => {
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          style={{
            alignSelf: 'center',
            marginTop: -36,
            marginBottom: 8,
            fontSize: 11.5,
            padding: '4px 10px',
            borderRadius: 999,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceCard,
            color: tokens.colors.textSecondary,
            cursor: 'pointer',
            zIndex: 1,
          }}
        >
          ↓ Jump to latest
        </button>
      )}

      <SessionComposer
        disabled={status === 'closed'}
        busy={busy}
        placeholder={
          pending ? 'Answer the permission request above…'
            : status === 'closed' ? 'Session closed'
              : canPrompt(status) ? 'Send a prompt to the CLI…' : 'Working…'
        }
        hint={composerHint}
        onSend={send}
        onCancel={() => void cancel()}
      />
    </>
  );
}

// ─── 라우트 컨테이너 ────────────────────────────────────────────────────────

export default function SessionsPage() {
  const { wsId, sessionId } = useParams<{ wsId: string; sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { sessions, loading, error, reload } = useAgentSessionsNav(wsId ?? null);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setNewOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const onDeleted = useCallback(() => {
    reload();
    navigate(`/ws/${wsId}/sessions`, { replace: true });
  }, [navigate, reload, wsId]);

  if (!wsId) return null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {sessionId ? (
        <SessionView key={sessionId} wsId={wsId} sessionId={sessionId} onDeleted={onDeleted} onNew={() => setNewOpen(true)} />
      ) : (
        <SessionsIndex wsId={wsId} sessions={sessions} loading={loading} error={error} onReload={reload} onNew={() => setNewOpen(true)} />
      )}
      <NewSessionModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(session) => {
          setNewOpen(false);
          window.dispatchEvent(new Event(AGENT_SESSIONS_CHANGED_EVENT));
          navigate(`/ws/${wsId}/sessions/${session.id}`);
        }}
      />
    </div>
  );
}

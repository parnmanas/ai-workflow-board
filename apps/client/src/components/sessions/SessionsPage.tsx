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
  AgentSessionHost,
  AgentSessionLiveSnapshot,
  AgentSessionSummary,
  AgentSessionUpdateEvent,
} from '../../types';
import { Button, EmptyState, ErrorState } from '../common';
import PageHeader from '../PageHeader';
import CliSettingsPanel from './CliSettingsPanel';
import NewSessionModal from './NewSessionModal';
import SessionComposer from './SessionComposer';
import SessionTranscript from './SessionTranscript';
import { sessionPath, sortSessionsByActivity } from './sessionList.logic';
import {
  appendLiveEvent,
  buildTranscript,
  canPrompt,
  describeSessionStatus,
  pendingPermission,
  runtimeLabel,
  sessionDisplayTitle,
} from './sessionTranscript.logic';

/**
 * Sessions — Agent Session(CLI 직접 세션) 표면.
 *   /ws/:wsId/sessions                          Runtime Host 목록
 *   /ws/:wsId/sessions/:managerId/:cli          그 장비 그 CLI 의 세션 목록(장비에 이미 있는 것 포함)
 *   /ws/:wsId/sessions/:managerId/:cli/:id      트랜스크립트(장비의 기록) + 라이브 스트림 + 컴포저
 *
 * Chat(ChatPage) 과는 데이터도 계약도 다르다: 방/참여자/멘션이 없고, 기록은 장비의 CLI 홈에서
 * 오며, 권한 요청은 여기서 사용자가 결정한다.
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

function StatusPill({ status }: { status: string | null | undefined }) {
  const view = describeSessionStatus(status);
  const color = toneColor(view.tone);
  return (
    <span
      data-session-status={status || 'idle'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color,
        border: `1px solid ${color}55`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
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

function CliBadge({ cli }: { cli: string }) {
  return (
    <span
      style={{
        fontSize: 10.5, fontWeight: 600, color: tokens.colors.accentSubtle, background: tokens.colors.badgeAgentBg,
        border: `1px solid ${tokens.colors.accent}55`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
      }}
    >
      {runtimeLabel(cli)}
    </span>
  );
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ─── Runtime Host 목록 ──────────────────────────────────────────────────────

function HostsIndex({ wsId, hosts, loading, error, onReload, onNew }: {
  wsId: string; hosts: AgentSessionHost[]; loading: boolean; error: string | null; onReload: () => void; onNew: () => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Drive a CLI on one of your Runtime Hosts — Claude Code, Codex, Hermes — including the sessions already on that machine."
        actions={<Button variant="primary" size="sm" onClick={onNew} disabled={hosts.length === 0}>New session</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={onReload} />
        ) : loading && hosts.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading Runtime Hosts…</div>
        ) : hosts.length === 0 ? (
          <EmptyState
            title="No Runtime Host is connected"
            description="Sessions run on a machine with awb-agent-manager. Pair one from the AI Agents page, and install claude-agent-acp or codex-acp there."
          />
        ) : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {hosts.map((host) => (
              <div
                key={host.manager_id}
                style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, background: tokens.colors.surfaceCard, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.textPrimary }}>{host.name}</span>
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: MONO }}>{host.hostname}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: tokens.colors.textMuted }}>seen {relativeTime(host.last_seen_at)}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {host.clis.length === 0 && <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>No ACP-capable CLI reported</span>}
                  {host.clis.map((cli) => {
                    const bound = host.cli_settings?.[cli] ?? null;
                    return (
                      <button
                        key={cli}
                        type="button"
                        onClick={() => navigate(`/ws/${wsId}/sessions/${host.manager_id}/${cli}`)}
                        title={bound ? `Signs in with "${bound.name}"` : "Uses the host's own login"}
                        style={{
                          border: `1px solid ${tokens.colors.accent}66`, background: tokens.colors.badgeAgentBg, color: tokens.colors.accentSubtle,
                          borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {bound ? '🔑 ' : ''}{runtimeLabel(cli)} →
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── 호스트 × CLI 세션 목록 ────────────────────────────────────────────────

function HostSessionsView({ wsId, managerId, cli, host, onNew }: {
  wsId: string; managerId: string; cli: string; host: AgentSessionHost | null; onNew: () => void;
}) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listHostSessions(managerId, cli);
      setSessions(sortSessionsByActivity(Array.isArray(list) ? list : []));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to list sessions on the Runtime Host');
    } finally {
      setLoading(false);
    }
  }, [managerId, cli]);

  useEffect(() => {
    void load();
  }, [load]);

  useBoardStreamEvent('agent_session_update', useCallback((data: AgentSessionUpdateEvent) => {
    const s = data?.session;
    if (!s || s.manager_id !== managerId || s.cli !== cli) return;
    setSessions((prev) => prev.map((row) => (row.session_id === s.session_id ? { ...row, live_status: s.status, title: s.title || row.title } : row)));
  }, [managerId, cli]));

  const hostName = host?.name || managerId.slice(0, 8);
  const boundCredential = host?.cli_settings?.[cli] ?? null;
  const [showSettings, setShowSettings] = useState(false);
  return (
    <>
      <PageHeader
        title={`${hostName} · ${runtimeLabel(cli)}`}
        description={host ? `Sessions in ${runtimeLabel(cli)}'s own history on ${host.hostname}. Open one to continue it here, or start a new one.` : 'This Runtime Host is not connected right now.'}
        actions={(
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/ws/${wsId}/sessions`)}>All hosts</Button>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>Reload</Button>
            <Button
              variant={showSettings ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setShowSettings((v) => !v)}
              title={boundCredential ? `Signs in with "${boundCredential.name}"` : "Uses the host's own login"}
            >
              {boundCredential ? `🔑 ${boundCredential.name}` : 'CLI settings'}
            </Button>
            <Button variant="primary" size="sm" onClick={onNew}>New session</Button>
          </>
        )}
      />
      {showSettings && (
        <div style={{ paddingTop: 12 }}>
          <CliSettingsPanel wsId={wsId} managerId={managerId} cli={cli} hostName={hostName} onChanged={() => window.dispatchEvent(new Event(AGENT_SESSIONS_CHANGED_EVENT))} />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : loading && sessions.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Asking the Runtime Host for its sessions…</div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions on this host yet"
            description={`${runtimeLabel(cli)} has no saved sessions on ${hostName}. Start one and it will show up here — and in the CLI's own history.`}
            action={<Button variant="primary" onClick={onNew}>Start a session</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 960 }}>
            {sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                onClick={() => navigate(sessionPath(`/ws/${wsId}`, managerId, cli, s.session_id))}
                style={{
                  textAlign: 'left', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, background: tokens.colors.surfaceCard,
                  padding: '10px 14px', color: tokens.colors.textPrimary, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sessionDisplayTitle(s)}
                  </span>
                  {s.source === 'awb' && <span style={{ fontSize: 10, color: tokens.colors.textMuted, border: `1px solid ${tokens.colors.border}`, borderRadius: 999, padding: '0 6px' }}>AWB</span>}
                  {s.live_status && s.live_status !== 'idle' && <StatusPill status={s.live_status} />}
                </div>
                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: tokens.colors.textMuted }}>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.cwd}>{s.cwd}</span>
                  <span style={{ fontFamily: MONO }} title={s.session_id}>{s.session_id.slice(0, 8)}</span>
                  <span>{relativeTime(s.updated_at)}</span>
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

function SessionView({ wsId, managerId, cli, sessionId, host, onNew }: {
  wsId: string; managerId: string; cli: string; sessionId: string; host: AgentSessionHost | null; onNew: () => void;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [summary, setSummary] = useState<AgentSessionSummary | null>(null);
  const [live, setLive] = useState<AgentSessionLiveSnapshot | null>(null);
  const [events, setEvents] = useState<AgentSessionEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await api.getHostSession(managerId, cli, sessionId);
      setSummary(detail.session);
      setLive(detail.live);
      setEvents(Array.isArray(detail.events) ? detail.events : []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load the session from the Runtime Host');
    } finally {
      setLoading(false);
    }
  }, [managerId, cli, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const matches = useCallback((d: { manager_id?: string; cli?: string; session_id?: string } | null | undefined) =>
    !!d && d.manager_id === managerId && d.cli === cli && d.session_id === sessionId, [managerId, cli, sessionId]);

  useBoardStreamEvent('agent_session_update', useCallback((data: AgentSessionUpdateEvent) => {
    if (!matches(data?.session)) return;
    setLive(data.session);
  }, [matches]));

  useBoardStreamEvent('agent_session_event', useCallback((data: AgentSessionEventEvent) => {
    if (!matches(data) || !data.event) return;
    setEvents((prev) => appendLiveEvent(prev, data.event));
  }, [matches]));

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

  const status = live?.status || 'idle';
  const busy = status === 'busy' || status === 'awaiting_permission' || status === 'starting';
  const title = live?.title || summary?.title || '';
  const cwd = live?.cwd || summary?.cwd || '';

  const send = useCallback(async (text: string) => {
    try {
      const result = await api.promptHostSession(managerId, cli, sessionId, text);
      setLive(result.live);
      setEvents((prev) => appendLiveEvent(prev, {
        id: `local:${result.turn_id}`, seq: 0, turn_id: result.turn_id, type: 'user_prompt', payload: { text }, created_at: new Date().toISOString(),
      }));
      setFollow(true);
    } catch (err: any) {
      showToast(err?.message || 'Failed to send the prompt', 'error');
      throw err;
    }
  }, [managerId, cli, sessionId, showToast]);

  const decide = useCallback(async (requestId: string, optionId: string | null) => {
    setDecidingRequestId(requestId);
    try {
      setLive(await api.decideHostSessionPermission(managerId, cli, sessionId, requestId, optionId));
    } catch (err: any) {
      showToast(err?.message || 'Failed to answer the permission request', 'error');
    } finally {
      setDecidingRequestId(null);
    }
  }, [managerId, cli, sessionId, showToast]);

  const cancel = useCallback(async () => {
    try {
      await api.cancelHostSession(managerId, cli, sessionId);
      showToast('Cancel requested', 'info');
    } catch (err: any) {
      showToast(err?.message || 'Failed to cancel', 'error');
    }
  }, [managerId, cli, sessionId, showToast]);

  const setMode = useCallback(async (modeId: string) => {
    try {
      await api.setHostSessionMode(managerId, cli, sessionId, modeId);
    } catch (err: any) {
      showToast(err?.message || 'Failed to change mode', 'error');
    }
  }, [managerId, cli, sessionId, showToast]);

  const close = useCallback(async () => {
    if (!(await confirm({ title: 'Stop the agent process?', message: 'The CLI process on the Runtime Host stops. The session stays in the CLI\'s history and reopens on your next prompt.', danger: false, confirmLabel: 'Stop' }))) return;
    try {
      setLive(await api.closeHostSession(managerId, cli, sessionId));
    } catch (err: any) {
      showToast(err?.message || 'Failed to stop', 'error');
    }
  }, [confirm, managerId, cli, sessionId, showToast]);

  if (error && !live && !summary) {
    return (
      <>
        <PageHeader title="Session" actions={<Button variant="secondary" size="sm" onClick={() => navigate(`/ws/${wsId}/sessions/${managerId}/${cli}`)}>Back to list</Button>} />
        <div style={{ padding: 20 }}><ErrorState message={error} onRetry={() => void load()} /></div>
      </>
    );
  }

  const authProblem = !!live?.last_error && /auth|login|credential/i.test(live.last_error);
  const composerHint = status === 'awaiting_permission'
    ? 'The agent is waiting for your decision on the permission request above.'
    : status === 'error' && authProblem
      ? `${runtimeLabel(cli)} on ${host?.name || 'the host'} is not signed in. Log in on the host, or bind a credential in this CLI's settings (list page → CLI settings).`
    : status === 'idle' || status === 'closed'
      ? `No live process — your next prompt starts ${runtimeLabel(cli)} on ${host?.name || 'the host'} and resumes this session.`
      : status === 'error' && live?.last_error
        ? `Last error: ${live.last_error}`
        : null;

  return (
    <>
      <header
        style={{
          background: tokens.gradients.surfaceCard, borderBottom: `1px solid ${tokens.colors.border}`, padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => navigate(`/ws/${wsId}/sessions/${managerId}/${cli}`)}
          aria-label="Back to sessions"
          title="Back to sessions"
          style={{ border: 'none', background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
        >
          ←
        </button>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ color: tokens.colors.textPrimary, fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sessionDisplayTitle({ title, cli, session_id: sessionId })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: tokens.colors.textSecondary, flexWrap: 'wrap' }}>
            <span>{host?.name || live?.manager_name || managerId.slice(0, 8)}</span>
            <CliBadge cli={cli} />
            <span style={{ fontFamily: MONO, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }} title={cwd}>
              {cwd || '(cwd unknown)'}
            </span>
            <span style={{ fontFamily: MONO, color: tokens.colors.textMuted }} title={sessionId}>{sessionId.slice(0, 8)}</span>
          </div>
        </div>
        <StatusPill status={status} />
        {live && live.available_modes.length > 0 && (
          <select
            aria-label="Session mode"
            value={live.current_mode || ''}
            disabled={!busy && status !== 'ready'}
            onChange={(e) => void setMode(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12 }}
          >
            {!live.current_mode && <option value="">mode…</option>}
            {live.available_modes.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" onClick={() => void load()} title="Reload the transcript from the Runtime Host">Reload</Button>
          <Button variant="ghost" size="sm" onClick={onNew}>New</Button>
          {(status === 'ready' || busy || status === 'error') && <Button variant="secondary" size="sm" onClick={() => void close()}>Stop</Button>}
        </div>
      </header>

      {live?.last_error && status === 'error' && (
        <div role="alert" style={{ padding: '8px 16px', fontSize: 12, color: tokens.colors.dangerLight, background: `${tokens.colors.dangerBg}66`, borderBottom: `1px solid ${tokens.colors.border}` }}>
          {live.last_error}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px' }}>
        {loading && events.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Reading the session from the Runtime Host…</div>
        ) : blocks.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>No transcript yet. Send your first prompt.</div>
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
            alignSelf: 'center', marginTop: -36, marginBottom: 8, fontSize: 11.5, padding: '4px 10px', borderRadius: 999,
            border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard, color: tokens.colors.textSecondary, cursor: 'pointer', zIndex: 1,
          }}
        >
          ↓ Jump to latest
        </button>
      )}

      <SessionComposer
        disabled={false}
        busy={busy}
        placeholder={pending ? 'Answer the permission request above…' : canPrompt(status) ? `Send a prompt to ${runtimeLabel(cli)}…` : 'Working…'}
        hint={composerHint}
        onSend={send}
        onCancel={() => void cancel()}
      />
    </>
  );
}

// ─── 라우트 컨테이너 ────────────────────────────────────────────────────────

export default function SessionsPage() {
  const { wsId, managerId, cli, sessionId } = useParams<{ wsId: string; managerId?: string; cli?: string; sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hosts, loading, error, reload } = useAgentSessionsNav(wsId ?? null);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setNewOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (!wsId) return null;
  const host = managerId ? hosts.find((h) => h.manager_id === managerId) ?? null : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {managerId && cli && sessionId ? (
        <SessionView key={`${managerId}/${cli}/${sessionId}`} wsId={wsId} managerId={managerId} cli={cli} sessionId={sessionId} host={host} onNew={() => setNewOpen(true)} />
      ) : managerId && cli ? (
        <HostSessionsView key={`${managerId}/${cli}`} wsId={wsId} managerId={managerId} cli={cli} host={host} onNew={() => setNewOpen(true)} />
      ) : (
        <HostsIndex wsId={wsId} hosts={hosts} loading={loading} error={error} onReload={reload} onNew={() => setNewOpen(true)} />
      )}
      <NewSessionModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        hosts={hosts}
        initialManagerId={managerId}
        initialCli={cli}
        onCreated={(liveSession) => {
          setNewOpen(false);
          navigate(sessionPath(`/ws/${wsId}`, liveSession.manager_id, liveSession.cli, liveSession.session_id));
        }}
      />
    </div>
  );
}

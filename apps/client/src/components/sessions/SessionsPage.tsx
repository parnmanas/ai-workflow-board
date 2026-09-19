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
import { groupSessionsByCwd, sessionPath, type CwdGroup } from './sessionList.logic';
import {
  appendLiveEvent,
  buildTranscript,
  canConnect,
  canPrompt,
  describeSessionStatus,
  isWaitingStatus,
  pendingInteraction,
  runtimeLabel,
  sessionDisplayTitle,
  shouldAutoConnect,
} from './sessionTranscript.logic';

/**
 * Sessions — Agent Session(CLI 직접 세션) 표면.
 *   /ws/:wsId/sessions                        Runtime Host 목록
 *   /ws/:wsId/sessions/:managerId             그 장비의 모든 세션 (cwd 별 그룹)
 *   /ws/:wsId/sessions/:managerId/:cli/:id    트랜스크립트(장비의 기록) + 라이브 스트림 + 컴포저
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {host.clis.length === 0
                    ? <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>No ACP-capable CLI reported</span>
                    : host.clis.map((cli) => {
                        const bound = host.cli_settings?.[cli] ?? null;
                        return (
                          <span
                            key={cli}
                            title={bound ? `Signs in with "${bound.name}"` : "Uses the host's own login"}
                            style={{
                              border: `1px solid ${tokens.colors.accent}55`, background: tokens.colors.badgeAgentBg, color: tokens.colors.accentSubtle,
                              borderRadius: 999, padding: '3px 10px', fontSize: 11.5, fontWeight: 600,
                            }}
                          >
                            {bound ? '🔑 ' : ''}{runtimeLabel(cli)}
                          </span>
                        );
                      })
                  }
                </div>
                <div style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/ws/${wsId}/sessions/${host.manager_id}`)}
                    style={{
                      border: `1px solid ${tokens.colors.accent}66`, background: 'transparent', color: tokens.colors.accentSubtle,
                      borderRadius: tokens.radii.md, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Open sessions →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── 호스트 세션 목록 — cwd 기준 그룹 ─────────────────────────────────────

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function CwdGroupCard({ group, wsId, managerId, onNew }: {
  group: CwdGroup; wsId: string; managerId: string; onNew: (cwd: string) => void;
}) {
  const navigate = useNavigate();
  const [showOlder, setShowOlder] = useState(false);
  const latestTime = group.sessions[0]?.updated_at;

  const cutoff = Date.now() - THREE_DAYS_MS;
  const recentSessions = group.sessions.filter(
    (s) => s.updated_at && new Date(s.updated_at).getTime() >= cutoff,
  );
  // Always show at least the newest session even if everything is old
  const alwaysVisible = recentSessions.length > 0 ? recentSessions : group.sessions.slice(0, 1);
  const hiddenSessions = recentSessions.length > 0
    ? group.sessions.filter((s) => !s.updated_at || new Date(s.updated_at).getTime() < cutoff)
    : group.sessions.slice(1);
  const displayed = showOlder ? group.sessions : alwaysVisible;

  return (
    <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, background: tokens.colors.surfaceCard, overflow: 'hidden' }}>
      {/* 그룹 헤더 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
        borderBottom: `1px solid ${tokens.colors.border}`, background: `${tokens.colors.surface}88`,
      }}>
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={group.cwd}
        >
          {group.cwd || '(unknown directory)'}
        </span>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>{relativeTime(latestTime)}</span>
        <button
          type="button"
          onClick={() => onNew(group.cwd)}
          style={{
            border: `1px solid ${tokens.colors.accent}66`, background: 'transparent', color: tokens.colors.accentSubtle,
            borderRadius: tokens.radii.md, padding: '2px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}
        >
          + New
        </button>
      </div>
      {/* 세션 행 */}
      {displayed.map((s, i) => (
        <button
          key={s.session_id}
          type="button"
          onClick={() => navigate(sessionPath(`/ws/${wsId}`, managerId, s.cli, s.session_id))}
          style={{
            width: '100%', textAlign: 'left', border: 'none',
            borderTop: i === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
            background: 'transparent', padding: '9px 14px', color: tokens.colors.textPrimary,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit',
          }}
        >
          <CliBadge cli={s.cli} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sessionDisplayTitle(s)}
          </span>
          {s.source === 'awb' && (
            <span style={{ fontSize: 10, color: tokens.colors.textMuted, border: `1px solid ${tokens.colors.border}`, borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap' }}>AWB</span>
          )}
          {s.live_status && s.live_status !== 'idle' && <StatusPill status={s.live_status} />}
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, whiteSpace: 'nowrap', minWidth: 48, textAlign: 'right' }}>{relativeTime(s.updated_at)}</span>
        </button>
      ))}
      {/* 오래된 세션 토글 */}
      {hiddenSessions.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOlder((v) => !v)}
          style={{
            width: '100%', textAlign: 'center', border: 'none',
            borderTop: `1px solid ${tokens.colors.border}`,
            background: `${tokens.colors.surface}55`, padding: '6px 14px',
            color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
          }}
        >
          {showOlder ? '접기 ↑' : `${hiddenSessions.length}개 더 보기 ↓`}
        </button>
      )}
    </div>
  );
}

function HostProjectsView({ wsId, managerId, host, onNew, onNewWithCwd }: {
  wsId: string; managerId: string; host: AgentSessionHost | null; onNew: () => void; onNewWithCwd: (cwd: string) => void;
}) {
  const navigate = useNavigate();
  const [sessionsByCli, setSessionsByCli] = useState<Record<string, AgentSessionSummary[]>>({});
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState<string | null>(null); // cli 이름

  const load = useCallback(async () => {
    if (!host) return;
    setLoading(true);
    const results: Record<string, AgentSessionSummary[]> = {};
    const errs: string[] = [];
    await Promise.all(host.clis.map(async (cli) => {
      try {
        const list = await api.listHostSessions(managerId, cli);
        results[cli] = Array.isArray(list) ? list : [];
      } catch (err: any) {
        errs.push(`${runtimeLabel(cli)}: ${err?.message || 'fetch failed'}`);
        results[cli] = [];
      }
    }));
    setSessionsByCli(results);
    setErrors(errs);
    setLoading(false);
  }, [host, managerId]);

  useEffect(() => { void load(); }, [load]);

  useBoardStreamEvent('agent_session_update', useCallback((data: AgentSessionUpdateEvent) => {
    const s = data?.session;
    if (!s || s.manager_id !== managerId) return;
    setSessionsByCli((prev) => {
      const cli = s.cli;
      const list = prev[cli];
      if (!list) return prev;
      return { ...prev, [cli]: list.map((row) => row.session_id === s.session_id ? { ...row, live_status: s.status, title: s.title || row.title } : row) };
    });
  }, [managerId]));

  const groups = useMemo(() => groupSessionsByCwd(sessionsByCli), [sessionsByCli]);
  const hostName = host?.name || managerId.slice(0, 8);
  const totalSessions = groups.reduce((n, g) => n + g.sessions.length, 0);

  return (
    <>
      <PageHeader
        title={hostName}
        description={host ? `${host.hostname} — sessions grouped by working directory` : 'This Runtime Host is not connected right now.'}
        actions={(
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/ws/${wsId}/sessions`)}>All hosts</Button>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>Reload</Button>
            {host && host.clis.map((cli) => {
              const bound = host.cli_settings?.[cli] ?? null;
              return (
                <Button
                  key={cli}
                  variant={showSettings === cli ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setShowSettings((v) => (v === cli ? null : cli))}
                  title={bound ? `Signs in with "${bound.name}"` : "Uses the host's own login"}
                >
                  {bound ? `🔑 ${runtimeLabel(cli)}` : runtimeLabel(cli)}
                </Button>
              );
            })}
            <Button variant="primary" size="sm" onClick={onNew}>New session</Button>
          </>
        )}
      />
      {showSettings && (
        <div style={{ paddingTop: 12 }}>
          <CliSettingsPanel wsId={wsId} managerId={managerId} cli={showSettings} hostName={hostName} onChanged={() => window.dispatchEvent(new Event(AGENT_SESSIONS_CHANGED_EVENT))} />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {errors.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: `${tokens.colors.warningBg}55`, border: `1px solid ${tokens.colors.warningLight}44`, borderRadius: tokens.radii.md, fontSize: 12, color: tokens.colors.warningLight }}>
            {errors.join(' · ')}
          </div>
        )}
        {loading && totalSessions === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Asking the Runtime Host for sessions…</div>
        ) : groups.length === 0 ? (
          <EmptyState
            title="No sessions on this host yet"
            description={`${hostName} has no saved sessions. Start one and it will show up here — and in the CLI's own history.`}
            action={<Button variant="primary" onClick={onNew}>Start a session</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 960 }}>
            {groups.map((group) => (
              <CwdGroupCard key={group.cwd} group={group} wsId={wsId} managerId={managerId} onNew={onNewWithCwd} />
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
  const pending = useMemo(() => pendingInteraction(blocks), [blocks]);

  // 상태는 "승인/입력 대기" 인데 트랜스크립트에 미결 카드가 없다 — permission/elicitation 행을
  // SSE 로 못 받은 경우(다른 화면에 있었거나 새로고침)다. history RPC 가 미결 요청을 다시
  // 실어 보내고, 매니저에 프로세스가 없으면 서버가 idle 로 되돌리므로 한 번 다시 읽으면
  // 둘 중 하나로 정리된다. 같은 상태 스냅샷에 대해 한 번만 시도한다(무한 재조회 방지).
  const status = live?.status || 'idle';
  const reconciledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isWaitingStatus(status) || pending || loading) return;
    const marker = `${sessionId}:${live?.updated_at || ''}`;
    if (reconciledForRef.current === marker) return;
    reconciledForRef.current = marker;
    void load();
  }, [status, pending, loading, live?.updated_at, sessionId, load]);

  // 연결 — 프로세스가 없는 세션을 session/load 로 연다. 모델·모드 같은 설정 목록과 slash command 는
  // 어댑터가 살아 있어야 오므로, 페이지에 들어오면 idle 세션은 자동으로 한 번 연결한다(터미널에서
  // `--resume` 하는 것과 같다). closed/error 는 Connect 버튼으로만.
  const [connecting, setConnecting] = useState(false);
  const autoConnectedRef = useRef<string | null>(null);
  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      setLive(await api.openHostSession(managerId, cli, { session_id: sessionId }));
    } catch (err: any) {
      showToast(err?.message || 'Failed to connect to the session on the Runtime Host', 'error');
    } finally {
      setConnecting(false);
    }
  }, [managerId, cli, sessionId, showToast]);
  useEffect(() => {
    if (loading || !live || connecting || !shouldAutoConnect(status)) return;
    const marker = `${managerId}/${cli}/${sessionId}`;
    if (autoConnectedRef.current === marker) return;
    autoConnectedRef.current = marker;
    void connect();
  }, [loading, live, connecting, status, managerId, cli, sessionId, connect]);

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

  const busy = status === 'busy' || isWaitingStatus(status) || status === 'starting';
  const title = live?.title || summary?.title || '';
  const cwd = live?.cwd || summary?.cwd || '';
  const configOptions = live?.config_options ?? [];
  const commands = live?.available_commands ?? [];
  // 어댑터가 mode 를 config option 으로도 주면(category 'mode') 그쪽을 쓰고 옛 mode 셀렉트는 숨긴다.
  const showLegacyModeSelect = !!live && live.available_modes.length > 0 && !configOptions.some((o) => o.category === 'mode');

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

  const answerElicitation = useCallback(async (elicitationId: string, action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> | null) => {
    setDecidingRequestId(elicitationId);
    try {
      setLive(await api.answerHostSessionElicitation(managerId, cli, sessionId, elicitationId, action, content));
    } catch (err: any) {
      showToast(err?.message || 'Failed to send your answer', 'error');
    } finally {
      setDecidingRequestId(null);
    }
  }, [managerId, cli, sessionId, showToast]);

  const setConfigOption = useCallback(async (configId: string, value: string | boolean) => {
    try {
      await api.setHostSessionConfigOption(managerId, cli, sessionId, configId, value);
    } catch (err: any) {
      showToast(err?.message || 'Failed to change the setting', 'error');
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
        <PageHeader title="Session" actions={<Button variant="secondary" size="sm" onClick={() => navigate(`/ws/${wsId}/sessions/${managerId}`)}>Back to list</Button>} />
        <div style={{ padding: 20 }}><ErrorState message={error} onRetry={() => void load()} /></div>
      </>
    );
  }

  const authProblem = !!live?.last_error && /auth|login|credential/i.test(live.last_error);
  const composerHint = isWaitingStatus(status)
    ? (pending
      ? (pending.kind === 'elicitation' ? 'The agent is asking you something above — answer it to continue.' : 'The agent is waiting for your decision on the permission request above.')
      : 'The Runtime Host reports a pending request — fetching it… If it does not appear, Stop the agent process and prompt again.')
    : status === 'error' && authProblem
      ? `${runtimeLabel(cli)} on ${host?.name || 'the host'} is not signed in. Log in on the host, or bind a credential in this CLI's settings (list page → CLI settings).`
    : connecting || status === 'starting'
      ? `Connecting to ${runtimeLabel(cli)} on ${host?.name || 'the host'}… settings appear once the session is open.`
    : status === 'idle' || status === 'closed'
      ? `No live process — Connect, or send a prompt, to start ${runtimeLabel(cli)} on ${host?.name || 'the host'} and resume this session.`
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
          onClick={() => navigate(`/ws/${wsId}/sessions/${managerId}`)}
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
        {/* 어댑터가 준 세션 설정(모델·reasoning·mode …) — 살아 있는 세션에서만 바꿀 수 있다 */}
        {configOptions.map((option) => {
          // 턴 중·대기 중·여는 중에는 잠근다. idle/closed/error 면 매니저가 세션을 먼저 열고 적용한다.
          const controlsDisabled = status === 'busy' || status === 'starting' || isWaitingStatus(status);
          if (option.type === 'boolean') {
            return (
              <label key={option.config_id} title={option.description} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: tokens.colors.textSecondary, cursor: controlsDisabled ? 'not-allowed' : 'pointer' }}>
                <input
                  type="checkbox"
                  aria-label={option.name}
                  data-config-id={option.config_id}
                  checked={option.current_value === true}
                  disabled={controlsDisabled}
                  onChange={(e) => void setConfigOption(option.config_id, e.target.checked)}
                />
                {option.name}
              </label>
            );
          }
          if (option.type !== 'select') return null;
          const groups = new Map<string, typeof option.options>();
          for (const o of option.options) {
            const g = o.group || '';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push(o);
          }
          const renderOptions = (list: typeof option.options) => list.map((o) => <option key={o.value} value={o.value} title={o.description}>{o.name}</option>);
          return (
            <select
              key={option.config_id}
              aria-label={option.name}
              title={option.description || option.name}
              data-config-id={option.config_id}
              data-config-category={option.category}
              value={typeof option.current_value === 'string' ? option.current_value : ''}
              disabled={controlsDisabled}
              onChange={(e) => void setConfigOption(option.config_id, e.target.value)}
              style={{ padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, maxWidth: 220 }}
            >
              {typeof option.current_value !== 'string' && <option value="">{option.name}…</option>}
              {Array.from(groups.entries()).map(([group, list]) => (group
                ? <optgroup key={group} label={group}>{renderOptions(list)}</optgroup>
                : renderOptions(list)))}
            </select>
          );
        })}
        {showLegacyModeSelect && live && (
          <select
            aria-label="Session mode"
            value={live.current_mode || ''}
            disabled={status === 'busy' || status === 'starting' || isWaitingStatus(status)}
            onChange={(e) => void setMode(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12 }}
          >
            {!live.current_mode && <option value="">mode…</option>}
            {live.available_modes.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          {canConnect(status) && !connecting && (
            <Button variant="primary" size="sm" onClick={() => void connect()} title="Start the CLI process for this session on the Runtime Host and load its settings">
              {status === 'error' ? 'Reconnect' : 'Connect'}
            </Button>
          )}
          {(connecting || status === 'starting') && <Button variant="secondary" size="sm" disabled loading>Connecting…</Button>}
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
            onAnswerElicitation={(elicitationId, action, content) => void answerElicitation(elicitationId, action, content)}
            permissionsEnabled={isWaitingStatus(status) || status === 'busy'}
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
        placeholder={pending ? (pending.kind === 'elicitation' ? 'Answer the question above…' : 'Answer the permission request above…') : canPrompt(status) ? `Send a prompt to ${runtimeLabel(cli)}…` : 'Working…'}
        hint={composerHint}
        commands={commands}
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
  const [newInitialCwd, setNewInitialCwd] = useState<string | undefined>();

  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setNewOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const openNew = useCallback(() => { setNewInitialCwd(undefined); setNewOpen(true); }, []);
  const openNewWithCwd = useCallback((cwd: string) => { setNewInitialCwd(cwd); setNewOpen(true); }, []);

  if (!wsId) return null;
  const host = managerId ? hosts.find((h) => h.manager_id === managerId) ?? null : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {managerId && cli && sessionId ? (
        <SessionView key={`${managerId}/${cli}/${sessionId}`} wsId={wsId} managerId={managerId} cli={cli} sessionId={sessionId} host={host} onNew={openNew} />
      ) : managerId ? (
        <HostProjectsView key={managerId} wsId={wsId} managerId={managerId} host={host} onNew={openNew} onNewWithCwd={openNewWithCwd} />
      ) : (
        <HostsIndex wsId={wsId} hosts={hosts} loading={loading} error={error} onReload={reload} onNew={openNew} />
      )}
      <NewSessionModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        hosts={hosts}
        initialManagerId={managerId}
        initialCli={cli}
        initialCwd={newInitialCwd}
        onCreated={(liveSession) => {
          setNewOpen(false);
          navigate(sessionPath(`/ws/${wsId}`, liveSession.manager_id, liveSession.cli, liveSession.session_id));
        }}
      />
    </div>
  );
}

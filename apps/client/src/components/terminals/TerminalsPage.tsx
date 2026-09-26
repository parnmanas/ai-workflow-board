import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { TerminalHost, TerminalSummary, TerminalUpdateEvent } from '../../types';
import { ActivityPill, Button, EmptyState, ErrorState } from '../common';
import PageHeader from '../PageHeader';
import NewTerminalModal from './NewTerminalModal';
import TerminalView from './TerminalView';
import { describeTerminalStatus, isLiveTerminal, terminalDisplayTitle, upsertTerminal } from './terminalList.logic';

/**
 * Terminals — Runtime Host 셸 표면.
 *   /ws/:wsId/terminals                      터미널을 띄울 수 있는 Runtime Host 목록
 *   /ws/:wsId/terminals/:managerId           그 장비에 **살아 있는** 터미널 목록
 *   /ws/:wsId/terminals/:managerId/:id       xterm 화면
 *
 * Agent Session 과 표면은 닮았지만 데이터 수명이 다르다: 터미널은 프로세스가 곧 존재라서
 * 기록이 없고, 그래서 목록에 죽은 행이 없다(docs/terminals.md).
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 터미널 상태 pill — 세션/미션과 같은 진행 어휘(src/activity.ts). */
function StatusPill({ status }: { status: string | null | undefined }) {
  return (
    <ActivityPill
      view={describeTerminalStatus(status)}
      dataAttr={{ 'data-terminal-status': status || 'unknown' }}
    />
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
  wsId: string; hosts: TerminalHost[]; loading: boolean; error: string | null; onReload: () => void; onNew: () => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Terminals"
        description="Open a shell on one of your Runtime Hosts. A terminal lives only while it runs — nothing is recorded."
        actions={<Button variant="primary" size="sm" onClick={onNew} disabled={hosts.length === 0}>New terminal</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={onReload} />
        ) : loading && hosts.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading Runtime Hosts…</div>
        ) : hosts.length === 0 ? (
          <EmptyState
            title="No Runtime Host can open terminals"
            description="Terminals run on a machine with awb-agent-manager. Pair one from the AI Agents page and make sure its PTY support is installed (the optional @lydell/node-pty package)."
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
                  {host.shells.map((s) => (
                    <span
                      key={s.id}
                      title={s.path}
                      style={{
                        border: `1px solid ${tokens.colors.accent}55`, background: tokens.colors.badgeAgentBg, color: tokens.colors.accentSubtle,
                        borderRadius: 999, padding: '3px 10px', fontSize: 11.5, fontWeight: 600,
                      }}
                    >
                      {s.label}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/ws/${wsId}/terminals/${host.manager_id}`)}
                    style={{
                      border: `1px solid ${tokens.colors.accent}66`, background: 'transparent', color: tokens.colors.accentSubtle,
                      borderRadius: tokens.radii.md, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Open terminals →
                  </button>
                  <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
                    {host.live_count > 0 ? `${host.live_count} live` : 'none running'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── 한 장비의 살아 있는 터미널 목록 ────────────────────────────────────────

function HostTerminals({ wsId, host, terminals, loading, error, onReload, onNew, onClose }: {
  wsId: string;
  host: TerminalHost | null;
  terminals: TerminalSummary[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onNew: () => void;
  onClose: (terminal: TerminalSummary) => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title={host?.name || 'Runtime Host'}
        description={host ? `Live shells on ${host.hostname}${host.platform ? ` · ${host.platform}` : ''}. Closing one ends its process.` : 'This Runtime Host is not connected right now.'}
        actions={<Button variant="primary" size="sm" onClick={onNew} disabled={!host}>New terminal</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={onReload} />
        ) : loading && terminals.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading terminals…</div>
        ) : terminals.length === 0 ? (
          <EmptyState
            title="No terminal is running here"
            description="Terminals are not saved — the list shows only live shells. Start one to get going."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {terminals.map((terminal) => (
              <div
                key={terminal.terminal_id}
                data-terminal-id={terminal.terminal_id}
                style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, background: tokens.colors.surfaceCard, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}
              >
                <button
                  type="button"
                  onClick={() => navigate(`/ws/${wsId}/terminals/${terminal.manager_id}/${terminal.terminal_id}`)}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: tokens.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {terminalDisplayTitle(terminal)}
                  </div>
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {terminal.cwd || '~'}{terminal.pid ? ` · pid ${terminal.pid}` : ''} · started {relativeTime(terminal.created_at)}
                  </div>
                </button>
                <StatusPill status={terminal.status} />
                <Button variant="secondary" size="sm" onClick={() => onClose(terminal)}>Close</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── 페이지 ────────────────────────────────────────────────────────────────

export default function TerminalsPage() {
  const { wsId = '', managerId = '', terminalId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [hosts, setHosts] = useState<TerminalHost[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(searchParams.get('new') === '1');
  const [current, setCurrent] = useState<TerminalSummary | null>(null);
  const generation = useRef(0);

  const host = useMemo(() => hosts.find((h) => h.manager_id === managerId) ?? null, [hosts, managerId]);

  const loadHosts = useCallback(async () => {
    if (!wsId) return;
    setHostsLoading(true);
    try {
      const list = await api.listTerminalHosts(wsId);
      setHosts(Array.isArray(list) ? list : []);
      setHostsError(null);
    } catch (err: any) {
      setHostsError(err?.message || 'Failed to load Runtime Hosts');
    } finally {
      setHostsLoading(false);
    }
  }, [wsId]);

  const loadTerminals = useCallback(async (id: string) => {
    if (!id) return;
    const gen = generation.current + 1;
    generation.current = gen;
    setListLoading(true);
    try {
      const list = await api.listHostTerminals(id);
      if (generation.current !== gen) return;
      setTerminals(Array.isArray(list) ? list : []);
      setListError(null);
    } catch (err: any) {
      if (generation.current !== gen) return;
      setTerminals([]);
      setListError(err?.message || 'Failed to load terminals');
    } finally {
      if (generation.current === gen) setListLoading(false);
    }
  }, []);

  useEffect(() => { void loadHosts(); }, [loadHosts]);
  useEffect(() => { if (managerId) void loadTerminals(managerId); }, [managerId, loadTerminals]);

  // 매니저가 붙거나 떨어지면 호스트 목록과 그 장비의 터미널을 다시 읽는다 — 매니저가
  // 죽으면 그 장비의 PTY 도 함께 죽으므로 목록이 즉시 달라진다.
  useBoardStreamEvent('agent_instance_update', useCallback(() => {
    void loadHosts();
    if (managerId) void loadTerminals(managerId);
  }, [loadHosts, loadTerminals, managerId]));

  useBoardStreamEvent('terminal_update', useCallback((raw: TerminalUpdateEvent) => {
    const next = raw?.terminal;
    if (!next || next.manager_id !== managerId) return;
    setTerminals((prev) => upsertTerminal(prev, next));
  }, [managerId]));

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    if (searchParams.get('new') === '1') {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const onCreated = useCallback((terminal: TerminalSummary) => {
    closeModal();
    setTerminals((prev) => upsertTerminal(prev, terminal));
    void loadHosts();
    navigate(`/ws/${wsId}/terminals/${terminal.manager_id}/${terminal.terminal_id}`);
  }, [closeModal, loadHosts, navigate, wsId]);

  const closeTerminal = useCallback(async (terminal: TerminalSummary) => {
    const ok = await confirm({
      title: 'Close terminal?',
      message: `This ends the shell process on ${terminal.manager_name || 'the Runtime Host'}. Anything running in it stops.`,
      confirmLabel: 'Close terminal',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.closeHostTerminal(terminal.manager_id, terminal.terminal_id);
      setTerminals((prev) => prev.filter((t) => t.terminal_id !== terminal.terminal_id));
      if (terminalId === terminal.terminal_id) navigate(`/ws/${wsId}/terminals/${terminal.manager_id}`);
    } catch (err: any) {
      showToast(err?.message || 'Failed to close the terminal', 'error');
    }
  }, [confirm, navigate, showToast, terminalId, wsId]);

  const modal = (
    <NewTerminalModal
      open={modalOpen}
      onClose={closeModal}
      hosts={hosts}
      initialManagerId={managerId || undefined}
      onCreated={onCreated}
    />
  );

  if (managerId && terminalId) {
    const title = current ? terminalDisplayTitle(current) : 'Terminal';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader
          title={title}
          description={`${host?.name || managerId.slice(0, 8)}${current?.cwd ? ` · ${current.cwd}` : ''}`}
          actions={(
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {current && <StatusPill status={current.status} />}
              <Button variant="secondary" size="sm" onClick={() => navigate(`/ws/${wsId}/terminals/${managerId}`)}>All terminals</Button>
              {current && isLiveTerminal(current) && (
                <Button variant="secondary" size="sm" onClick={() => void closeTerminal(current)}>Close</Button>
              )}
            </div>
          )}
        />
        <TerminalView managerId={managerId} terminalId={terminalId} onTerminalChange={setCurrent} />
        {modal}
      </div>
    );
  }

  if (managerId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <HostTerminals
          wsId={wsId}
          host={host}
          terminals={terminals}
          loading={listLoading}
          error={listError}
          onReload={() => void loadTerminals(managerId)}
          onNew={openModal}
          onClose={(t) => void closeTerminal(t)}
        />
        {modal}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <HostsIndex
        wsId={wsId}
        hosts={hosts}
        loading={hostsLoading}
        error={hostsError}
        onReload={() => void loadHosts()}
        onNew={openModal}
      />
      {modal}
    </div>
  );
}

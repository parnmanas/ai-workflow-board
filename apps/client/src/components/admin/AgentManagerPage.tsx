import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import type {
  Agent,
  AgentCredentialEntry,
  AgentManagerCommandKind,
  AgentManagerInstance,
  Credential,
  PairingTokenMint,
  PairingTokenSafe,
  SubagentSummary,
  WorktreeStatusEntry,
} from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { Button, Input, Modal, Select } from '../common';
import { formatAgentDisplayName } from '../../utils/agentName';
import DirectoryPicker from './DirectoryPicker';
import ManagedAgentDialog from './ManagedAgentDialog';

/**
 * Phase 3 — admin dashboard for live daemon/proxy plugin instances.
 *
 * Layout: master/detail split. Left column lists every heartbeating instance
 * grouped by host; right column shows the selected instance's subagents,
 * recent server-side logs touching that agent, and a restart button that
 * dispatches `restart_manager` over the agent_manager_command SSE channel
 * (manager-mode only — re-execs the daemon in place, no git pull).
 *
 * Real-time refresh: subscribes to `agent_instance_update` SSE events fired
 * by InstanceRegistryService on every upsert / TTL eviction. Steady-state
 * heartbeats (every 30s) keep `last_seen_at` ticking; missing instances drop
 * off automatically when their TTL (90s) expires server-side.
 */

const REFRESH_FALLBACK_MS = 15_000;
const RECENT_ERROR_WINDOW_MS = 10 * 60_000;

function degradedReason(inst: AgentManagerInstance): string | null {
  const breakerCount = inst.open_breaker_count ?? 0;
  const errorAt = inst.last_error_upload_at ? new Date(inst.last_error_upload_at).getTime() : 0;
  const recentError = Number.isFinite(errorAt) && errorAt > 0 && Date.now() - errorAt <= RECENT_ERROR_WINDOW_MS;
  if (breakerCount > 0 && recentError) return `${breakerCount} open breaker(s); recent error upload`;
  if (breakerCount > 0) return `${breakerCount} open circuit breaker(s)`;
  if (recentError) return `recent error upload (${formatRelative(inst.last_error_upload_at)})`;
  return null;
}

function formatRelative(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return ts;
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return ts ?? '—';
  }
}

function formatDuration(startIso: string): string {
  try {
    const ms = Date.now() - new Date(startIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const days = Math.floor(hr / 24);
    return `${days}d ${hr % 24}h`;
  } catch {
    return '—';
  }
}

function modeBadgeColor(mode: 'daemon' | 'proxy' | 'manager'): string {
  // manager → accent (admin-controllable), daemon → accentLight (legacy daemon),
  // proxy → success (passive Claude CLI bridge).
  if (mode === 'manager') return tokens.colors.accent;
  if (mode === 'daemon') return tokens.colors.accentLight;
  return tokens.colors.successLight;
}

// ─── Live worktrees (ticket 72fc244f) ──────────────────────────────────────

function worktreeStateMeta(state: 'allocated' | 'idle' | 'orphaned'): {
  label: string;
  color: string;
  bg: string;
} {
  // allocated → green (a worker is on it), idle → muted (warm/free), orphaned →
  // red (active lease with no live owner past the reclaim grace — a visible leak).
  if (state === 'allocated') {
    return { label: 'allocated', color: tokens.colors.successLight, bg: tokens.colors.successBg };
  }
  if (state === 'orphaned') {
    return { label: 'orphaned', color: tokens.colors.dangerLight, bg: tokens.colors.dangerBg };
  }
  return { label: 'idle', color: tokens.colors.textMuted, bg: tokens.colors.surfaceSubtle };
}

/** Short ticket ref for the "slot → task" line: "#d68afab5 <title>" (title only
 *  when the server joined one; falls back to the raw slug for idle per_ticket). */
function worktreeTaskLabel(w: WorktreeStatusEntry): string {
  if (w.ticket_id) {
    const short = w.ticket_id.slice(0, 8);
    return w.ticket_title ? `#${short} ${w.ticket_title}` : `#${short}`;
  }
  // per_ticket idle dir: only the 8-char slug is knowable locally.
  if (w.mode === 'per_ticket') return `#${w.slot}`;
  return 'idle';
}

function StatePill({ state }: { state: 'allocated' | 'idle' | 'orphaned' }) {
  const meta = worktreeStateMeta(state);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: meta.color,
        background: meta.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

/**
 * Renders a manager instance's live worktrees, grouped by working_dir then by
 * mode. Shared pool slots come first as an explicit "slot → current task" map
 * (the core ask of ticket 72fc244f: dark shared-N leases are legible at a
 * glance); per_ticket dirs follow. QA/Security run clones (`.awb/qa/`) are a
 * separate workspace and intentionally not listed here.
 */
function WorktreeStatusList({ entries }: { entries: WorktreeStatusEntry[] }) {
  // Group by working_dir so a multi-agent manager doesn't blur two repos' pools.
  const byDir = new Map<string, WorktreeStatusEntry[]>();
  for (const e of entries) {
    const key = e.working_dir || '(unknown working_dir)';
    (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(e);
  }
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'monospace',
    fontSize: 11,
    padding: '2px 0',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from(byDir.entries()).map(([dir, rows]) => {
        const shared = rows.filter((r) => r.mode === 'shared');
        const perTicket = rows.filter((r) => r.mode === 'per_ticket');
        return (
          <div key={dir} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 10,
                color: tokens.colors.textMuted,
                wordBreak: 'break-all',
              }}
            >
              {dir}
            </div>
            {shared.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 6 }}>
                {shared.map((w) => (
                  <div key={w.path} style={rowStyle}>
                    <span style={{ color: tokens.colors.accentLight, minWidth: 62 }}>{w.slot}</span>
                    <span style={{ color: tokens.colors.textMuted }}>→</span>
                    <span
                      style={{
                        color:
                          w.state === 'idle' ? tokens.colors.textMuted : tokens.colors.textStrong,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={`${worktreeTaskLabel(w)}${w.branch ? ` @${w.branch}` : ''}`}
                    >
                      {worktreeTaskLabel(w)}
                      {w.branch ? (
                        <span style={{ color: tokens.colors.textMuted }}> @{w.branch}</span>
                      ) : null}
                    </span>
                    <StatePill state={w.state} />
                  </div>
                ))}
              </div>
            )}
            {perTicket.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 6 }}>
                {perTicket.map((w) => (
                  <div key={w.path} style={rowStyle}>
                    <span
                      style={{
                        color: tokens.colors.textStrong,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={`${worktreeTaskLabel(w)}${w.branch ? ` @${w.branch}` : ''}`}
                    >
                      {worktreeTaskLabel(w)}
                      {w.branch ? (
                        <span style={{ color: tokens.colors.textMuted }}> @{w.branch}</span>
                      ) : null}
                    </span>
                    <StatePill state={w.state} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface InstanceRowProps {
  inst: AgentManagerInstance;
  selected: boolean;
  onSelect(): void;
}

function InstanceRow({ inst, selected, onSelect }: InstanceRowProps) {
  const stale = Date.now() - new Date(inst.last_seen_at).getTime() > 60_000;
  const degraded = degradedReason(inst);
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        marginBottom: 6,
        background: selected ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
        border: `1px solid ${selected ? tokens.colors.accent : tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        color: tokens.colors.textStrong,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              background: `${modeBadgeColor(inst.mode)}20`,
              color: modeBadgeColor(inst.mode),
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              flexShrink: 0,
            }}
          >
            {inst.mode}
          </span>
          <span
            style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={inst.agent_name && inst.agent_name !== inst.hostname ? `host: ${inst.hostname}` : inst.hostname}
          >
            {inst.agent_name || inst.hostname}
          </span>
        </div>
        {degraded && (
          <span
            style={{ fontSize: 10, fontWeight: 700, color: tokens.colors.warning, textTransform: 'uppercase' }}
            title={degraded}
          >
            degraded
          </span>
        )}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: stale || degraded ? tokens.colors.warning : tokens.colors.success,
            flexShrink: 0,
          }}
          title={stale ? 'Heartbeat stale' : degraded || 'Heartbeating'}
        />
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: tokens.colors.textMuted }}>
        agent <code>{inst.agent_id.slice(0, 8)}</code> · pid {inst.pid || '—'} · v{inst.plugin_version} · {inst.cli}
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: tokens.colors.textMuted }}>
        last seen {formatRelative(inst.last_seen_at)} · up {formatDuration(inst.started_at)}
      </div>
    </button>
  );
}

interface InstanceDetailProps {
  inst: AgentManagerInstance;
}

function InstanceDetail({ inst }: InstanceDetailProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const degraded = degradedReason(inst);
  const [subagents, setSubagents] = useState<SubagentSummary[] | null>(null);
  const [logs, setLogs] = useState<any[] | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [restartAllPending, setRestartAllPending] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  // Manager Agent.name + description live in the agents table, separate
  // from inst.hostname (OS hostname). The header shows hostname; this
  // load surfaces the Agent.name (used as the children's display prefix)
  // so the operator can see and edit it. Only loaded for manager-mode
  // instances since daemon/proxy don't have an editable identity.
  const [managerInfo, setManagerInfo] = useState<{ name: string; description: string } | null>(null);
  const [editIdentityOpen, setEditIdentityOpen] = useState(false);

  const loadSubagents = useCallback(async () => {
    try {
      const data = await api.getAgentManagerInstanceSubagents(inst.instance_id);
      setSubagents(data);
    } catch (err: any) {
      showToast(`Failed to load subagents: ${err?.message || err}`, 'error');
      setSubagents([]);
    }
  }, [inst.instance_id, showToast]);

  const loadLogs = useCallback(async () => {
    try {
      const data = await api.getAgentManagerInstanceLogs(inst.instance_id, 100);
      setLogs(data);
    } catch (err: any) {
      showToast(`Failed to load logs: ${err?.message || err}`, 'error');
      setLogs([]);
    }
  }, [inst.instance_id, showToast]);

  const loadManagerInfo = useCallback(async () => {
    if (inst.mode !== 'manager') {
      setManagerInfo(null);
      return;
    }
    try {
      const a = await api.getAgent(inst.agent_id);
      setManagerInfo({ name: a.name || '', description: a.description || '' });
    } catch (err: any) {
      // Non-fatal: header degrades gracefully to hostname-only.
      setManagerInfo(null);
    }
  }, [inst.mode, inst.agent_id]);

  useEffect(() => {
    setSubagents(null);
    setLogs(null);
    setManagerInfo(null);
    loadSubagents();
    loadLogs();
    loadManagerInfo();
  }, [inst.instance_id, loadSubagents, loadLogs, loadManagerInfo]);

  // Dispatch restart_manager SSE command via the /restart admin endpoint.
  // Server returns 202 with command_id + a short message; the manager later
  // re-execs and reappears as an `agent_instance_update` event with the
  // same plugin_version (no polling needed here).
  const handleRestart = async () => {
    if (restartPending) return;
    const ok = await confirm({
      title: 'Restart manager',
      message: 'Restart this manager? Every in-flight subagent, chat session, and ticket session on this host will be terminated. The manager will re-exec in place and reappear in ~30s.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
    setRestartPending(true);
    try {
      const resp: any = await api.restartAgentManagerInstance(inst.instance_id);
      const idTail = typeof resp?.command_id === 'string' ? ` (id=${resp.command_id.slice(0, 8)})` : '';
      showToast(
        `${resp?.message || 'restart_manager dispatched'}${idTail} — manager will reappear in ~30s.`,
        'success',
      );
    } catch (err: any) {
      showToast(`Restart failed: ${err?.message || err}`, 'error');
    } finally {
      setRestartPending(false);
    }
  };

  // Dispatch restart_all_agents SSE command. Unlike restart_manager, the
  // manager process stays up — it just reaps+respawns each managed agent in
  // place (fresh credential + immediate in-flight resume per agent). The 202
  // only carries command_id; the exact restarted count lands in the async ack
  // (server-logged), so we surface the *target* count from agent_ids instead.
  const handleRestartAllAgents = async () => {
    if (restartAllPending) return;
    const targetCount = inst.agent_ids?.length ?? 0;
    const ok = await confirm({
      title: 'Restart all agents',
      message:
        '이 매니저가 관리하는 모든 agent 를 재시작합니다. 각 agent 의 진행 중 작업은 재시작 후 자동 재개됩니다. (매니저 프로세스는 유지)',
      confirmLabel: 'Restart all',
    });
    if (!ok) return;
    setRestartAllPending(true);
    try {
      const resp = await api.restartAllAgents(inst.instance_id);
      const idTail = resp?.command_id ? ` (id=${resp.command_id.slice(0, 8)})` : '';
      showToast(
        `restart_all_agents dispatched${idTail} — ${targetCount} agent(s) will restart, ` +
          `resuming in-flight work.`,
        'success',
      );
    } catch (err: any) {
      showToast(`restart_all_agents failed: ${err?.message || err}`, 'error');
    } finally {
      setRestartAllPending(false);
    }
  };

  // Dispatch update_manager SSE command. In a git checkout the manager runs
  // git pull + npm install + build, acks success, then re-execs with --force;
  // an npm-global install instead reinstalls via `npm i -g` (detached helper)
  // and relaunches. Either way we see the restart on the client as an
  // `agent_instance_update` event with the new plugin_version — no polling.
  const handleUpdate = async () => {
    if (updatePending) return;
    const ok = await confirm({
      title: 'Update manager',
      message:
        inst.install_mode === 'npm-global'
          ? 'Update this manager? It will reinstall from npm (npm i -g awb-agent-manager@latest) and restart.'
          : 'Update this manager? It will pull the latest source, rebuild, and restart.',
      confirmLabel: 'Update',
      danger: false,
    });
    if (!ok) return;
    setUpdatePending(true);
    try {
      const resp = await api.sendAgentManagerCommand(inst.instance_id, { command: 'update_manager' });
      showToast(
        `update_manager dispatched (id=${resp.command_id.slice(0, 8)}) — manager will rebuild + re-exec; ` +
          `it'll reappear in ~30s with the new version.`,
        'success',
      );
    } catch (err: any) {
      showToast(`update_manager failed: ${err?.message || err}`, 'error');
    } finally {
      setUpdatePending(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div
        style={{
          padding: 16,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '3px 8px',
              borderRadius: 4,
              background: `${modeBadgeColor(inst.mode)}20`,
              color: modeBadgeColor(inst.mode),
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {inst.mode}
          </span>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>
            {managerInfo?.name || inst.hostname}
          </h2>
          {managerInfo?.name && managerInfo.name !== inst.hostname && (
            <span
              style={{ fontSize: 12, color: tokens.colors.textMuted }}
              title="OS hostname reported by the manager process — distinct from the editable Agent identity name above."
            >
              host: {inst.hostname}
            </span>
          )}
          <span style={{ fontSize: 12, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>
            {inst.instance_id}
          </span>
          {degraded && (
            <span
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, color: tokens.colors.warning, background: tokens.colors.warningBg }}
              title={degraded}
            >
              DEGRADED · {degraded}
            </span>
          )}
        </div>
        <dl
          style={{
            margin: '12px 0 0 0',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '8px 16px',
            fontSize: 12,
            color: tokens.colors.textSecondary,
          }}
        >
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Agent
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong, fontFamily: 'monospace' }}>
              {inst.agent_id}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Workspace
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong, fontFamily: 'monospace' }}>
              {inst.workspace_id || '—'}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              PID / CLI
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {inst.pid || '—'} / {inst.cli}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Plugin
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              v{inst.plugin_version}
              {inst.mode === 'manager' && (
                <ManagerVersionBadge inst={inst} />
              )}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Started
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {formatRelative(inst.started_at)} (up {formatDuration(inst.started_at)})
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Last heartbeat
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {formatRelative(inst.last_seen_at)}
            </dd>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Registered CLI adapters
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {inst.cli_adapters.length === 0 ? '—' : inst.cli_adapters.join(', ')}
            </dd>
          </div>
          {inst.mode === 'manager' && (
            <>
              <div style={{ gridColumn: '1 / -1' }}>
                <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Working directories ({inst.working_dirs?.length ?? 0})
                </dt>
                <dd style={{ margin: 0, color: tokens.colors.textStrong, fontFamily: 'monospace', fontSize: 11 }}>
                  {inst.working_dirs && inst.working_dirs.length > 0 ? inst.working_dirs.join('  •  ') : '—'}
                </dd>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Agent identities supervised ({inst.agent_ids?.length ?? 0})
                </dt>
                <dd style={{ margin: 0, color: tokens.colors.textStrong, fontFamily: 'monospace', fontSize: 11 }}>
                  {inst.agent_ids && inst.agent_ids.length > 0
                    ? inst.agent_ids.map((a) => a.slice(0, 8)).join(', ')
                    : '—'}
                </dd>
              </div>
              {inst.paired_at && (
                <div>
                  <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Paired
                  </dt>
                  <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
                    {formatRelative(inst.paired_at)}
                  </dd>
                </div>
              )}
              <div style={{ gridColumn: '1 / -1' }}>
                <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Live worktrees ({inst.active_worktrees?.length ?? 0})
                </dt>
                <dd style={{ margin: '4px 0 0' }}>
                  {inst.active_worktrees && inst.active_worktrees.length > 0 ? (
                    <WorktreeStatusList entries={inst.active_worktrees} />
                  ) : (
                    <span style={{ color: tokens.colors.textMuted, fontSize: 12, fontStyle: 'italic' }}>
                      {inst.active_worktrees
                        ? 'no live worktrees (all slots idle / worktree isolation off)'
                        : 'no worktree telemetry (pre-worktree-visibility manager)'}
                    </span>
                  )}
                </dd>
              </div>
              {/* ticket d34075b5 — durable, server-visible dispatch-block signal.
                  Cumulative per-reason count of dispatches dropped at the manager's
                  worktree / push-credential preflight gate (a shared-pool
                  `pool_exhausted` starvation was previously invisible until
                  e7c87517's 24h no-progress backstop). Shown only when non-empty;
                  pool exhaustion is highlighted since it self-recovers via the
                  manager's on-demand reclaim but signals a leaking / undersized pool. */}
              {inst.dispatch_block_counts && Object.keys(inst.dispatch_block_counts).length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Dispatch blocks (cumulative since boot)
                  </dt>
                  <dd style={{ margin: '4px 0 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(inst.dispatch_block_counts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([kind, n]) => {
                        const isPool = kind === 'worktree:pool_exhausted';
                        return (
                          <span
                            key={kind}
                            title={
                              isPool
                                ? 'Shared warm-pool exhausted — every slot was an active lease (usually a leaked lease from a worker that died uncleanly). The manager reclaims on-demand + on a 5-min tick; a persistent count signals a leaking or undersized pool.'
                                : 'Dispatch dropped at the worktree / push-credential preflight gate.'
                            }
                            style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              padding: '2px 8px',
                              borderRadius: 4,
                              color: isPool ? tokens.colors.warning : tokens.colors.textStrong,
                              background: isPool ? tokens.colors.warningBg : tokens.colors.surfaceSubtle,
                            }}
                          >
                            {kind} ×{n}
                          </span>
                        );
                      })}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          {inst.mode === 'manager' && (
            <button
              onClick={() => setEditIdentityOpen(true)}
              disabled={!managerInfo}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                background: 'transparent',
                color: tokens.colors.textStrong,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                cursor: managerInfo ? 'pointer' : 'wait',
                fontFamily: 'inherit',
                opacity: managerInfo ? 1 : 0.5,
              }}
              title="Rename the manager Agent identity. The new name becomes the prefix for every child agent in the UI."
            >
              Edit identity
            </button>
          )}
          {inst.mode === 'manager' && inst.update_available && (
            <button
              onClick={handleUpdate}
              disabled={updatePending}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                background: updatePending ? tokens.colors.surfaceHover : tokens.colors.success,
                color: updatePending ? tokens.colors.textMuted : tokens.colors.surface,
                border: 'none',
                borderRadius: tokens.radii.md,
                cursor: updatePending ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title={
                inst.install_mode === 'npm-global'
                  ? `Update from v${inst.plugin_version} → v${inst.latest_version || '?'} (npm i -g awb-agent-manager@latest, then restart).`
                  : `Update from v${inst.plugin_version} → v${inst.latest_version || '?'} (git pull + npm install + build, then re-exec).`
              }
            >
              {updatePending
                ? 'Updating…'
                : `Update → v${inst.latest_version || '?'}`}
            </button>
          )}
          <button
            onClick={handleRestart}
            disabled={restartPending}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              background: restartPending ? tokens.colors.surfaceHover : tokens.colors.warning,
              color: restartPending ? tokens.colors.textMuted : tokens.colors.surface,
              border: 'none',
              borderRadius: tokens.radii.md,
              cursor: restartPending ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
            title="Dispatch restart_manager: manager re-execs in place (no git pull / build). Manager-mode only."
          >
            Restart instance
          </button>
          {inst.mode === 'manager' && (
            <button
              onClick={handleRestartAllAgents}
              disabled={restartAllPending}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                background: restartAllPending ? tokens.colors.surfaceHover : tokens.colors.warning,
                color: restartAllPending ? tokens.colors.textMuted : tokens.colors.surface,
                border: 'none',
                borderRadius: tokens.radii.md,
                cursor: restartAllPending ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Dispatch restart_all_agents: reap+respawn every managed agent in place (fresh credential + immediate in-flight resume per agent). Manager process stays up — no downtime."
            >
              {restartAllPending ? 'Restarting agents…' : 'Restart all agents'}
            </button>
          )}
          <button
            onClick={() => { loadSubagents(); loadLogs(); loadManagerInfo(); }}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              background: 'transparent',
              color: tokens.colors.textStrong,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Refresh
          </button>
        </div>
      </div>
      {inst.mode === 'manager' && managerInfo && (
        <EditAgentManagerDialog
          isOpen={editIdentityOpen}
          onClose={() => setEditIdentityOpen(false)}
          managerAgentId={inst.agent_id}
          initialName={managerInfo.name}
          initialDescription={managerInfo.description}
          onSubmitted={() => {
            setEditIdentityOpen(false);
            loadManagerInfo();
          }}
        />
      )}

      {inst.mode === 'manager' && <ManagedAgentsSection inst={inst} />}

      {/* Subagents */}
      <section
        style={{
          padding: 16,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
        }}
      >
        <h3 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
          Subagents ({subagents?.length ?? 0})
        </h3>
        {subagents === null ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
        ) : subagents.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
            No subagents currently tracked for this agent in this workspace.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {subagents.map((s) => (
              <li
                key={s.subagent_id}
                style={{
                  padding: 8,
                  background: tokens.colors.surface,
                  borderRadius: tokens.radii.sm,
                  fontSize: 12,
                  color: tokens.colors.textStrong,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{s.label || s.session_key}</span>
                  <span style={{ marginLeft: 8, fontSize: 10, color: tokens.colors.textMuted, textTransform: 'uppercase' }}>
                    {s.kind}
                  </span>
                  {s.role && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: tokens.colors.accentLight }}>
                      · {s.role}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                  pid {s.pid} · {s.line_count} lines · started {formatRelative(s.started_at)}
                  {s.ended_at && <> · ended {formatRelative(s.ended_at)}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Logs */}
      <section
        style={{
          flex: 1,
          minHeight: 0,
          padding: 16,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h3 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
          Recent logs ({logs?.length ?? 0})
        </h3>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {logs === null ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
              No matching log entries in the in-memory buffer.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {logs.map((entry, idx) => (
                <li
                  key={entry.id ?? idx}
                  style={{
                    padding: '6px 8px',
                    background: tokens.colors.surface,
                    borderRadius: tokens.radii.xs,
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: tokens.colors.textStrong,
                    display: 'grid',
                    gridTemplateColumns: '120px 60px 100px 1fr',
                    gap: 8,
                  }}
                >
                  <span style={{ color: tokens.colors.textMuted }}>{entry.timestamp}</span>
                  <span style={{ color: entry.level === 'error' ? tokens.colors.danger : entry.level === 'warn' ? tokens.colors.warning : tokens.colors.info, fontWeight: 600 }}>
                    {entry.level}
                  </span>
                  <span style={{ color: tokens.colors.accentLight }}>{entry.category}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

export default function AgentManagerPage() {
  const [instances, setInstances] = useState<AgentManagerInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgentManagerInstances();
      setInstances(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_FALLBACK_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Live updates over SSE — server emits agent_instance_update on every
  // heartbeat upsert and TTL eviction. We treat each event as a hint to
  // refetch (cheap: in-memory map) so the list reflects the registry truth
  // even if a single SSE event is dropped on the wire.
  useBoardStreamEvent('agent_instance_update', () => {
    refresh();
  });

  const grouped = useMemo(() => {
    const byHost = new Map<string, AgentManagerInstance[]>();
    for (const inst of instances) {
      const list = byHost.get(inst.hostname) || [];
      list.push(inst);
      byHost.set(inst.hostname, list);
    }
    return Array.from(byHost.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);

  // Auto-select the first instance once data arrives so the right pane has
  // something to render. Drops the selection if the instance disappears.
  useEffect(() => {
    if (instances.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !instances.some((i) => i.instance_id === selectedId)) {
      setSelectedId(instances[0].instance_id);
    }
  }, [instances, selectedId]);

  const selected = instances.find((i) => i.instance_id === selectedId) || null;

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
      {/* Master pane */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {loading ? 'Loading…' : `${instances.length} instance${instances.length === 1 ? '' : 's'}`}
          </span>
          <Button size="sm" variant="primary" onClick={() => setPairOpen(true)}>
            Pair manager…
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {grouped.length === 0 && !loading && (
            <div
              style={{
                padding: 16,
                fontSize: 12,
                color: tokens.colors.textMuted,
                background: tokens.colors.surfaceCard,
                border: `1px dashed ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                textAlign: 'center',
              }}
            >
              No daemon or proxy instances are currently heartbeating against this server.
              Start <code>daemon.mjs</code> or attach Claude CLI via the AWB proxy plugin.
            </div>
          )}
          {grouped.map(([host, list]) => (
            <div key={host} style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: tokens.colors.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                  padding: '0 4px',
                }}
              >
                {host}
              </div>
              {list.map((inst) => (
                <InstanceRow
                  key={inst.instance_id}
                  inst={inst}
                  selected={inst.instance_id === selectedId}
                  onSelect={() => setSelectedId(inst.instance_id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Detail pane */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {selected ? (
          <InstanceDetail inst={selected} />
        ) : (
          <div
            style={{
              padding: 24,
              fontSize: 12,
              color: tokens.colors.textMuted,
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
            }}
          >
            Select an instance from the list to inspect its subagents and logs.
          </div>
        )}
      </div>

      <PairingDialog isOpen={pairOpen} onClose={() => setPairOpen(false)} />
    </div>
  );
}

// ───────────────────────────── ST-5 ─────────────────────────────
// Manager-only sections + pairing wizard. Kept in the same file because
// they read from the same SSE-driven `instances` state and there is only
// one consumer. If a second page ever needs the pairing wizard, lift it
// into a shared admin component module.

// ─── Credential expiry badge ──────────────────────────────────────────
//
// Surfaces per-agent OAuth token state on each managed-agent row so the
// operator notices "expires in 12h" before the agent silently starts
// returning is_error=true on every turn. Heartbeat data comes from
// inst.agent_credentials (manager → server → here); never the raw token.
//
// Severity rules:
//   1. expired (now ≥ expires_at_ms) → red, regardless of refresh_token
//   2. <48h to expiry → yellow
//   3. refresh_token_present === false → yellow (any expiry = silent fail)
//   4. kind === 'unknown' / 'missing' → yellow / red (no metadata to validate)
//   5. kind === 'api_key' → no badge (env var has no expiry concept)
//   6. kind === 'operator_home' → always badge (neutral when healthy or
//      uninspectable, escalated to expiring/expired/no-refresh when the
//      operator's introspectable expiry is concerning). Surfacing this
//      consistently is what keeps codex/antigravity agents from looking
//      "broken" (red 'missing') next to claude agents on the same
//      operator-HOME fallback.
//   7. subscription kind with >48h refresh-token-present → no badge (healthy)

const EXPIRY_WARNING_MS = 48 * 60 * 60 * 1000;

/** Public path inside the AWB repo that documents the re-login runbook.
 *  Linked from the badge hovercard. We intentionally show the path rather
 *  than a hardcoded URL — operators read the docs from their own checkout
 *  on the manager host (where they'll need to re-auth claude anyway). */
const RELOGIN_DOC_PATH = 'docs/managed-agent-relogin.md';

type CredentialBadgeSeverity = 'expired' | 'expiring' | 'no-refresh' | 'unknown' | 'missing' | 'operator-home';

interface CredentialBadgeData {
  severity: CredentialBadgeSeverity;
  label: string;
  /** One-line summary shown in the hovercard before the runbook link. */
  detail: string;
}

/**
 * Decide whether (and how) to badge an agent given its credential entry.
 * Returns null when the agent is healthy on a per-agent credential or
 * the badge would be noise (api_key kind, no entry yet from a pre-feature
 * manager). operator_home always badges — see severity rules above.
 */
function classifyCredential(entry: AgentCredentialEntry | undefined): CredentialBadgeData | null {
  if (!entry) return null;                          // pre-feature manager
  if (entry.kind === 'api_key') return null;        // no expiry concept

  const now = Date.now();

  if (entry.kind === 'missing') {
    return {
      severity: 'missing',
      label: 'no credential',
      detail: 'No credential file in this agent\'s cli-home — every spawn will hit "not authenticated" until an operator runs the re-login runbook on the manager host.',
    };
  }

  if (entry.kind === 'unknown') {
    return {
      severity: 'unknown',
      label: 'credential ?',
      detail: 'Credential file exists in cli-home but its shape is unrecognized. Check the manager\'s log and re-run the re-login runbook if needed.',
    };
  }

  if (entry.kind === 'operator_home') {
    // No per-agent credential is configured. The manager uses the
    // operator's HOME credential (claude `.credentials.json`, codex
    // `auth.json`, etc.) for every spawn. Always show a badge so the
    // operator sees a consistent state across all CLIs — the previous
    // behaviour silently hid healthy claude agents (>48h remaining)
    // while reporting codex/antigravity ones as red 'missing', even though
    // both were in the exact same fallback state.
    if (typeof entry.expires_at_ms === 'number') {
      const remaining = entry.expires_at_ms - now;
      if (remaining <= 0) {
        return {
          severity: 'expired',
          label: 'op HOME expired',
          detail: entry.refresh_token_present
            ? 'Operator HOME OAuth access token has expired but a refresh token is present — the CLI should auto-renew on the next turn. If turns keep failing with is_error=true, re-login on the manager host.'
            : 'Operator HOME OAuth access token has expired and no refresh token is on disk. The manager cannot auto-renew; an operator must re-login on the manager host.',
        };
      }
      if (!entry.refresh_token_present) {
        return {
          severity: 'no-refresh',
          label: `op HOME · no refresh · ${formatRemaining(remaining)}`,
          detail: `Operator HOME OAuth credential has no refresh_token, so when the access token expires (${formatRemaining(remaining)}) every turn will silently fail. Re-login on the manager host to capture a credential file with a refresh_token.`,
        };
      }
      if (remaining < EXPIRY_WARNING_MS) {
        return {
          severity: 'expiring',
          label: `op HOME · expires in ${formatRemaining(remaining)}`,
          detail: `Operator HOME OAuth access token expires in ${formatRemaining(remaining)}. A refresh token is present so the CLI will normally auto-renew silently — but if it fails, every turn returns is_error=true with no signal. Re-login proactively if you'd rather not depend on that path.`,
        };
      }
      // Healthy operator HOME (>48h, refresh present). Still badge so the
      // operator can tell at a glance "no per-agent credential set up here".
      return {
        severity: 'operator-home',
        label: 'operator HOME',
        detail: `No per-agent credential is configured for this agent. The manager is using the operator's HOME credential (auto-renewing; ${formatRemaining(remaining)} on current access token). Configure a per-agent credential in this workspace's Credentials tab for isolated auth.`,
      };
    }
    // No expiry metadata. Normal for adapters that don't introspect their
    // credential file (codex / antigravity); also covers claude operator-HOME
    // when the operator hasn't run `claude login` yet — in that case the
    // CLI will surface its own "not authenticated" error on first spawn,
    // which is clearer than anything we could synthesize here.
    return {
      severity: 'operator-home',
      label: 'operator HOME',
      detail: 'No per-agent credential is configured for this agent. The manager is using the operator\'s HOME credential as fallback; the manager cannot introspect this CLI\'s credential file format, so no expiry is shown.',
    };
  }

  // subscription kind — per-agent OAuth credential. Carries a real expires_at.
  if (typeof entry.expires_at_ms === 'number') {
    const remaining = entry.expires_at_ms - now;
    if (remaining <= 0) {
      return {
        severity: 'expired',
        label: 'expired',
        detail: entry.refresh_token_present
          ? 'OAuth access token has expired but a refresh token is present — claude should auto-renew on the next turn. If turns keep failing with is_error=true, run the re-login runbook.'
          : 'OAuth access token has expired and no refresh token is on disk. The manager cannot auto-renew; an operator must re-login on the manager host.',
      };
    }
    if (!entry.refresh_token_present) {
      // No refresh token = any expiry is silent failure waiting to happen.
      // Always badge regardless of remaining time.
      return {
        severity: 'no-refresh',
        label: `no refresh · ${formatRemaining(remaining)}`,
        detail: `OAuth credential has no refresh_token, so when the access token expires (${formatRemaining(remaining)}) every turn will silently fail. Re-run the re-login runbook to capture a credential file with a refresh_token.`,
      };
    }
    if (remaining < EXPIRY_WARNING_MS) {
      return {
        severity: 'expiring',
        label: `expires in ${formatRemaining(remaining)}`,
        detail: `OAuth access token expires in ${formatRemaining(remaining)}. A refresh token is present so claude will normally auto-renew silently — but if it fails, every turn returns is_error=true with no signal. Re-run the runbook proactively if you'd rather not depend on that path.`,
      };
    }
    // healthy — refresh_token present, > 48h remaining
    return null;
  }

  // subscription with no expires_at_ms → unrecognized; surface.
  return {
    severity: 'unknown',
    label: 'credential ?',
    detail: 'Manager could not parse the OAuth file in cli-home. Re-run the re-login runbook if turns are failing.',
  };
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

function CredentialExpiryBadge({ entry }: { entry: AgentCredentialEntry | undefined }) {
  const data = classifyCredential(entry);
  const [hover, setHover] = useState(false);
  if (!data) return null;
  const palette: Record<CredentialBadgeSeverity, { bg: string; fg: string; border: string }> = {
    expired:    { bg: `${tokens.colors.danger}20`,  fg: tokens.colors.danger,  border: tokens.colors.danger },
    expiring:   { bg: `${tokens.colors.warning}20`, fg: tokens.colors.warning, border: tokens.colors.warning },
    'no-refresh': { bg: `${tokens.colors.warning}20`, fg: tokens.colors.warning, border: tokens.colors.warning },
    unknown:    { bg: `${tokens.colors.warning}20`, fg: tokens.colors.warning, border: tokens.colors.warning },
    missing:    { bg: `${tokens.colors.danger}20`,  fg: tokens.colors.danger,  border: tokens.colors.danger },
    // Neutral / informational — "no per-agent credential, using operator HOME
    // fallback". Not a warning state, so use textSecondary instead of the
    // warning/danger palette to keep the row visually calm.
    'operator-home': { bg: tokens.colors.surfaceHover, fg: tokens.colors.textSecondary, border: tokens.colors.border },
  };
  const c = palette[data.severity];
  // Drop the warning glyph for the neutral operator-home state so it doesn't
  // visually compete with real expiry/missing warnings on the same page.
  const prefix = data.severity === 'operator-home' ? '' : '⚠ ';
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        style={{
          marginLeft: 6,
          fontSize: 10,
          fontWeight: 700,
          padding: '1px 6px',
          borderRadius: 4,
          background: c.bg,
          color: c.fg,
          border: `1px solid ${c.border}40`,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}
      >
        {prefix}{data.label}
      </span>
      {hover && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 10,
            minWidth: 280,
            maxWidth: 360,
            padding: '8px 10px',
            background: tokens.colors.surfaceCard,
            color: tokens.colors.textStrong,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
            fontSize: 11,
            lineHeight: 1.5,
            fontWeight: 400,
            textTransform: 'none',
            letterSpacing: 0,
            whiteSpace: 'normal',
          }}
        >
          {data.detail}
          <div style={{ marginTop: 6, color: tokens.colors.textMuted }}>
            See <code style={{ background: tokens.colors.surface, padding: '0 4px', borderRadius: 3 }}>{RELOGIN_DOC_PATH}</code> in the AWB repo for the re-login runbook on the manager host.
          </div>
        </span>
      )}
    </span>
  );
}

interface ManagedAgentsSectionProps {
  inst: AgentManagerInstance;
}

// CLI lifecycle is currently stubbed in the manager (registry-only, no
// child_process fork). The "(stub)" suffix surfaces that to the operator so
// ST-6: lifecycle is now real — spawn_agent provisions the agent's apiKey,
// writes its on-disk config + mcp-config.json, registers it in the runtime
// context, and marks status='running'. stop_agent drops the context and
// erases on-disk secrets. The previous "(stub)" suffix on labels and the
// "lifecycle stubbed" toast suffix are dropped accordingly.
const COMMAND_BUTTONS: {
  kind: AgentManagerCommandKind;
  label: string;
  variant: 'primary' | 'danger' | 'secondary';
  title: string;
}[] = [
  {
    kind: 'spawn_agent',
    label: 'Spawn',
    variant: 'primary',
    title:
      "Dispatch spawn_agent: bootstrap on-disk dir + apiKey, register runtime context. " +
      "The manager spawns subagents per event under this agent's identity.",
  },
  {
    kind: 'stop_agent',
    label: 'Stop',
    variant: 'danger',
    title: 'Dispatch stop_agent: drop runtime context + erase on-disk secrets. In-flight subagents keep running.',
  },
  {
    kind: 'restart_agent',
    label: 'Restart',
    variant: 'secondary',
    title: 'Dispatch restart_agent: stop + spawn (re-provisions a fresh apiKey).',
  },
];

// Maintenance commands — reach into the per-agent cli-home / working_dir
// from the manager process. These only make sense when the agent is already
// spawned (the manager owns its cli-home / context registry entry), so they
// render in a separate row that's disabled while supervised=false.
const MAINTENANCE_BUTTONS: {
  kind: AgentManagerCommandKind;
  label: string;
  title: string;
}[] = [
  {
    kind: 'update_plugins',
    label: 'Update plugins',
    title:
      'git pull --ff-only on every claude plugin marketplace under the agent\'s ' +
      'cli-home. Refreshes the marketplace source without restarting the agent.',
  },
  {
    kind: 'refresh_mcp_config',
    label: 'Refresh MCP',
    title:
      'Rewrite the agent\'s mcp-config.json with the current AWB url + existing ' +
      'apiKey. Use after changing the AWB server URL. Does not rotate the key.',
  },
];

function ManagedAgentsSection({ inst }: ManagedAgentsSectionProps) {
  const { showToast } = useToast();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  // Lookup table for inst.agent_credentials by agent_id; rebuilt whenever
  // a fresh heartbeat lands on the SSE-driven inst object. Older managers
  // don't ship the array — the map stays empty and badges short-circuit
  // to null inside CredentialExpiryBadge so the UI degrades gracefully.
  const credentialsByAgentId = useMemo(() => {
    const m = new Map<string, AgentCredentialEntry>();
    for (const row of inst.agent_credentials ?? []) {
      m.set(row.agent_id, row);
    }
    return m;
  }, [inst.agent_credentials]);
  // null = closed, Agent = editing that row. Edit-only here now — managed
  // agent CREATION moved to the workspace AI Agents tab so the new agent
  // gets created in the operator's actual workspace instead of inheriting
  // the manager's pairing-time workspace. Operators relocate pre-existing
  // managed agents through the per-row workspace picker below.
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [pendingCmd, setPendingCmd] = useState<string | null>(null); // `${cmd}:${agentId}`
  // Workspace dropdown source for the per-row workspace picker — managers
  // are global, but each managed agent must live in exactly one workspace.
  // Loaded once per section mount and reused across all rows.
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);

  // The manager Agent identity is `inst.agent_id` (created by pair/redeem).
  // Children are agents whose `manager_agent_id` matches — they may live in
  // ANY workspace (managed agents created from a workspace AI Agents tab
  // get the operator's workspace, not the manager's). Hit the admin
  // cross-workspace agent listing so children outside the operator's
  // currently-active workspace are still visible from this admin page.
  const refresh = useCallback(async () => {
    try {
      const all = await api.getAgentsAll();
      const children = (all as Agent[]).filter((a) => a.manager_agent_id === inst.agent_id);
      setAgents(children);
    } catch (err: any) {
      showToast(`Failed to load managed agents: ${err?.message || err}`, 'error');
      setAgents([]);
    }
  }, [inst.agent_id, showToast]);

  useEffect(() => {
    setAgents(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    api.getWorkspaces()
      .then((rows: any[]) => {
        if (!alive) return;
        setWorkspaces(rows.map((w: any) => ({ id: w.id, name: w.name || w.id })));
      })
      .catch(() => { if (alive) setWorkspaces([]); });
    return () => { alive = false; };
  }, []);

  const moveWorkspace = useCallback(
    async (agentId: string, workspaceId: string) => {
      try {
        await api.setManagedAgentWorkspace(agentId, workspaceId);
        showToast('Workspace updated', 'success');
        refresh();
      } catch (err: any) {
        showToast(`Move failed: ${err?.message || err}`, 'error');
      }
    },
    [refresh, showToast],
  );

  const sendCommand = useCallback(
    async (kind: AgentManagerCommandKind, agentId: string, extraArgs?: Record<string, any>) => {
      const key = `${kind}:${agentId}`;
      if (pendingCmd === key) return;
      setPendingCmd(key);
      try {
        const resp = await api.sendAgentManagerCommand(inst.instance_id, {
          command: kind,
          args: { agent_id: agentId, ...(extraArgs || {}) },
        });
        // Dispatch ack only — the manager's execution ack lands on the
        // server log via POST /command/ack a moment later. The dispatcher
        // ack here just says "the SSE event was published". Operators
        // looking for "did the manager actually do it" should check the
        // manager's logs panel.
        showToast(`${kind} dispatched (id=${resp.command_id.slice(0, 8)})`, 'success');
      } catch (err: any) {
        showToast(`Command failed: ${err?.message || err}`, 'error');
      } finally {
        setPendingCmd(null);
      }
    },
    [inst.instance_id, pendingCmd, showToast],
  );

  const reloadConfig = useCallback(async () => {
    if (pendingCmd === 'reload_config') return;
    setPendingCmd('reload_config');
    try {
      const resp = await api.sendAgentManagerCommand(inst.instance_id, { command: 'reload_config' });
      showToast(`reload_config dispatched (id=${resp.command_id.slice(0, 8)})`, 'success');
    } catch (err: any) {
      showToast(`reload_config failed: ${err?.message || err}`, 'error');
    } finally {
      setPendingCmd(null);
    }
  }, [inst.instance_id, pendingCmd, showToast]);

  return (
    <section
      style={{
        padding: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
          Managed agents ({agents?.length ?? 0})
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={reloadConfig}
            disabled={pendingCmd === 'reload_config'}
            title="Send reload_config to the manager (re-reads its config without restart)."
          >
            Reload config
          </Button>
        </div>
      </div>

      {agents === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
      ) : agents.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          No agents linked to this manager yet. Create one from a workspace's <strong>AI Agents</strong> tab and pick this manager from the optional dropdown.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agents.map((a) => {
            const supervised = inst.agent_ids?.includes(a.id);
            return (
              <li
                key={a.id}
                style={{
                  padding: 10,
                  background: tokens.colors.surface,
                  borderRadius: tokens.radii.sm,
                  fontSize: 12,
                  color: tokens.colors.textStrong,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontWeight: 600 }}>{formatAgentDisplayName(a)}</span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: `${tokens.colors.accent}20`,
                        color: tokens.colors.accent,
                        textTransform: 'uppercase',
                      }}
                    >
                      {a.type}
                    </span>
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        fontWeight: 600,
                        color: supervised ? tokens.colors.success : tokens.colors.textMuted,
                      }}
                      title={supervised ? 'Currently supervised by this manager' : 'Not yet picked up by the manager'}
                    >
                      ● {supervised ? 'live' : 'offline'}
                    </span>
                    <CredentialExpiryBadge entry={credentialsByAgentId.get(a.id)} />
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditAgent(a)}
                      title="Edit name / CLI / working_dir / description. A CLI change takes effect after restart_agent."
                    >
                      Edit
                    </Button>
                    {COMMAND_BUTTONS.map((btn) => (
                      <Button
                        key={btn.kind}
                        size="sm"
                        variant={btn.variant}
                        disabled={pendingCmd === `${btn.kind}:${a.id}`}
                        onClick={() => sendCommand(btn.kind, a.id)}
                        title={btn.title}
                      >
                        {btn.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>
                  id <code>{a.id.slice(0, 8)}</code> · cwd <code>{a.working_dir || '—'}</code>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: tokens.colors.textMuted, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>Workspace:</span>
                  <select
                    value={a.workspace_id || ''}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (!next || next === a.workspace_id) return;
                      moveWorkspace(a.id, next);
                    }}
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      background: tokens.colors.surfaceCard,
                      color: tokens.colors.textStrong,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.sm,
                      fontFamily: 'inherit',
                    }}
                    title="Move this managed agent into a different workspace. The manager_agent_id link is preserved."
                  >
                    {workspaces.length === 0 && (
                      <option value={a.workspace_id || ''}>{a.workspace_id ? a.workspace_id.slice(0, 8) : '—'}</option>
                    )}
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                {!a.working_dir && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: tokens.colors.warning }}>
                    <span>⚠ working_dir not set — manager will refuse to spawn.</span>
                    <SetWorkingDirInline
                      onSubmit={(dir) => sendCommand('set_working_dir', a.id, { working_dir: dir })}
                      pending={pendingCmd === `set_working_dir:${a.id}`}
                    />
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span
                    style={{ fontSize: 10, fontWeight: 600, color: tokens.colors.textMuted, marginRight: 4 }}
                    title="Operational commands the AgentManager can run on this managed agent without restarting it."
                  >
                    Maintenance:
                  </span>
                  {MAINTENANCE_BUTTONS.map((btn) => {
                    const blocked = !supervised;
                    const blockedTitle = blocked
                      ? 'Spawn the agent first so the manager owns its cli-home.'
                      : btn.title;
                    return (
                      <Button
                        key={btn.kind}
                        size="sm"
                        variant="ghost"
                        disabled={blocked || pendingCmd === `${btn.kind}:${a.id}`}
                        onClick={() => sendCommand(btn.kind, a.id)}
                        title={blockedTitle}
                      >
                        {btn.label}
                      </Button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ManagedAgentDialog
        isOpen={editAgent !== null}
        onClose={() => setEditAgent(null)}
        managerAgentId={inst.agent_id}
        managerInstanceId={inst.instance_id}
        defaultCli={inst.cli}
        mode="edit"
        agent={editAgent}
        onSubmitted={() => {
          setEditAgent(null);
          refresh();
        }}
      />
    </section>
  );
}

interface SetWorkingDirInlineProps {
  pending: boolean;
  onSubmit(dir: string): void;
}

function SetWorkingDirInline({ pending, onSubmit }: SetWorkingDirInlineProps) {
  const [value, setValue] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <Input
        type="text"
        placeholder="/path/on/manager/host"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        style={{ fontSize: 11, padding: '2px 6px', minWidth: 220 }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !value.trim()}
        onClick={() => {
          const dir = value.trim();
          if (dir) onSubmit(dir);
        }}
      >
        Set
      </Button>
    </span>
  );
}

// ─── Pairing wizard ────────────────────────────────────────────────────

interface PairingDialogProps {
  isOpen: boolean;
  onClose(): void;
}

function PairingDialog({ isOpen, onClose }: PairingDialogProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [pairings, setPairings] = useState<PairingTokenSafe[] | null>(null);
  const [agentName, setAgentName] = useState('');
  const [minted, setMinted] = useState<PairingTokenMint | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgentManagerPairings();
      setPairings(data);
    } catch (err: any) {
      showToast(`Failed to load pairings: ${err?.message || err}`, 'error');
      setPairings([]);
    }
  }, [showToast]);

  useEffect(() => {
    if (!isOpen) return;
    setMinted(null);
    refresh();
  }, [isOpen, refresh]);

  const handleMint = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const rec = await api.mintAgentManagerPairing({ agent_name: agentName.trim() || undefined });
      setMinted(rec);
      setAgentName('');
      refresh();
    } catch (err: any) {
      showToast(`Mint failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    const ok = await confirm({
      title: 'Revoke pairing token',
      message: 'Revoke this pairing token? Any in-flight bootstrap using it will fail.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try {
      await api.revokeAgentManagerPairing(id);
      refresh();
    } catch (err: any) {
      showToast(`Revoke failed: ${err?.message || err}`, 'error');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Pair an agent-manager" maxWidth={640}>
      <p style={{ margin: '0 0 12px 0', fontSize: 12, color: tokens.colors.textSecondary }}>
        Mint a one-time token, hand it to <code>awb-agent-manager pair --code &lt;CODE&gt;</code> on the host that
        will run the manager process. Tokens expire in 10 minutes; they cannot be retrieved after the modal closes.
      </p>

      {minted && <MintedTokenPanel rec={minted} onDismiss={() => setMinted(null)} />}

      {!minted && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              Agent name (optional)
            </label>
            <Input
              type="text"
              value={agentName}
              placeholder="e.g. desktop-mac-mini"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgentName(e.target.value)}
            />
          </div>
          <Button onClick={handleMint} disabled={busy} variant="primary">
            Mint token
          </Button>
        </div>
      )}

      <h3 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Active tokens ({pairings?.length ?? 0})
      </h3>
      {pairings === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
      ) : pairings.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No pairing tokens outstanding.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pairings.map((t) => (
            <li
              key={t.id}
              style={{
                padding: 10,
                background: tokens.colors.surface,
                borderRadius: tokens.radii.sm,
                fontSize: 12,
                color: tokens.colors.textStrong,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <code
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    color: tokens.colors.accent,
                  }}
                >
                  {t.code}
                </code>
                {t.agent_name && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}>· {t.agent_name}</span>
                )}
                <div style={{ marginTop: 2, fontSize: 11, color: tokens.colors.textMuted }}>
                  expires {formatRelative(t.expires_at)}
                  {t.redeemed_at && ` · redeemed ${formatRelative(t.redeemed_at)}`}
                </div>
              </div>
              {!t.redeemed_at && (
                <Button size="sm" variant="danger" onClick={() => handleRevoke(t.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

interface MintedTokenPanelProps {
  rec: PairingTokenMint;
  onDismiss(): void;
}

function MintedTokenPanel({ rec, onDismiss }: MintedTokenPanelProps) {
  const { showToast } = useToast();

  const copy = (value: string, label: string) => {
    if (!navigator.clipboard) {
      showToast(`Copy not supported in this browser — value: ${value}`, 'info');
      return;
    }
    navigator.clipboard
      .writeText(value)
      .then(() => showToast(`${label} copied`, 'success'))
      .catch(() => showToast('Copy failed', 'error'));
  };

  return (
    <div
      style={{
        padding: 12,
        marginBottom: 16,
        background: tokens.colors.surfaceHover,
        border: `1px solid ${tokens.colors.accent}`,
        borderRadius: tokens.radii.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.warning }}>
        ⚠ Show ONCE. The raw token is not retrievable later.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Display code</span>
        <code
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: tokens.colors.accent,
            background: tokens.colors.surface,
            padding: '4px 10px',
            borderRadius: tokens.radii.sm,
          }}
        >
          {rec.code}
        </code>
        <Button size="sm" variant="secondary" onClick={() => copy(rec.code, 'Code')}>
          Copy code
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Raw token</span>
        <code
          style={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: tokens.colors.textStrong,
            background: tokens.colors.surface,
            padding: '4px 8px',
            borderRadius: tokens.radii.sm,
            wordBreak: 'break-all',
            flex: 1,
            minWidth: 200,
          }}
        >
          {rec.token}
        </code>
        <Button size="sm" variant="secondary" onClick={() => copy(rec.token, 'Token')}>
          Copy token
        </Button>
      </div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
        Expires {formatRelative(rec.expires_at)}.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss (acknowledge that I copied it)
        </Button>
      </div>
    </div>
  );
}

// ─── Manager-agent identity dialog (rename / describe) ───────────────
//
// The manager Agent's `name` field is what server-side `manager_name`
// enrichment uses to prefix children as `<manager>/<agent>` in the UI.
// Header in InstanceDetail shows `inst.hostname` (OS hostname from the
// manager process), which can diverge from the Agent.name set at
// pair-mint — that mismatch is the entire reason this dialog exists.
// type/cli stay fixed as 'manager'.

interface EditAgentManagerDialogProps {
  isOpen: boolean;
  onClose(): void;
  managerAgentId: string;
  initialName: string;
  initialDescription: string;
  onSubmitted(): void;
}

function EditAgentManagerDialog({
  isOpen,
  onClose,
  managerAgentId,
  initialName,
  initialDescription,
  onSubmitted,
}: EditAgentManagerDialogProps) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName);
    setDescription(initialDescription);
    setBusy(false);
  }, [isOpen, initialName, initialDescription]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.updateAgent(managerAgentId, {
        name: trimmedName,
        description,
      });
      showToast(`Manager identity updated`, 'success');
      onSubmitted();
    } catch (err: any) {
      showToast(`Update failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit manager identity"
      maxWidth={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
            Name
          </label>
          <Input
            type="text"
            value={name}
            placeholder="e.g. Rolf"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
            Used as the <code>&lt;manager&gt;/&lt;agent&gt;</code> prefix for every child agent of this manager.
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
            Description (optional)
          </label>
          <Input
            type="text"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ─── ManagerVersionBadge — render `(→ vX.Y.Z available)` next to plugin_version
// when the manager's UpdateChecker says a newer build is on origin/<branch>. A
// pre-update manager (no UpdateChecker fields in the heartbeat) renders nothing
// so we don't gaslight operators on instances that genuinely don't ship the
// self-update path.
function ManagerVersionBadge({ inst }: { inst: AgentManagerInstance }) {
  // Field absence vs `false` matters here: undefined === pre-update manager
  // (silent fallback), false === checker ran and there's no update, true ===
  // checker ran and an update is on origin.
  if (inst.update_available === undefined) return null;
  // No git checkout under the manager process. An npm-global install still
  // auto-updates (via `npm i -g` on the Update button), so only fall back to
  // the "manual updates only" hint when the install is genuinely un-updatable —
  // 'unknown' mode, or a manager too old to report install_mode at all. For
  // npm-global we drop through to the normal update/up-to-date/available badges.
  if (inst.repo_root === null && inst.install_mode !== 'npm-global') {
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}
        title="Manager isn't running from a git checkout — upgrade it manually (e.g. npm i -g awb-agent-manager@latest)."
      >
        (manual updates only)
      </span>
    );
  }
  if (inst.update_last_error && !inst.latest_version) {
    // Hard failure: fetch failed AND no cached remote ref to fall back on.
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.warning }}
        title={`Self-update checker error: ${inst.update_last_error}`}
      >
        (update check failed)
      </span>
    );
  }
  if (!inst.update_available) {
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}
        title={
          inst.update_last_checked_at
            ? `Up to date as of ${inst.update_last_checked_at}`
            : 'Update checker has not yet completed its first poll'
        }
      >
        (up to date)
      </span>
    );
  }
  return (
    <span
      style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: tokens.colors.success }}
      title={
        inst.install_mode === 'npm-global'
          ? `Latest on npm: v${inst.latest_version}. Use the Update button to reinstall (npm i -g) + restart.`
          : `Latest on ${inst.default_branch || 'main'}: v${inst.latest_version}. Use the Update button to pull + rebuild.`
      }
    >
      → v{inst.latest_version} available
    </span>
  );
}

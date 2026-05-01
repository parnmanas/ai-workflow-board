import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentManagerInstance, SubagentSummary } from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';

/**
 * Phase 3 — admin dashboard for live daemon/proxy plugin instances.
 *
 * Layout: master/detail split. Left column lists every heartbeating instance
 * grouped by host; right column shows the selected instance's subagents,
 * recent server-side logs touching that agent, and a (Phase 4-stub) restart
 * button.
 *
 * Real-time refresh: subscribes to `agent_instance_update` SSE events fired
 * by InstanceRegistryService on every upsert / TTL eviction. Steady-state
 * heartbeats (every 30s) keep `last_seen_at` ticking; missing instances drop
 * off automatically when their TTL (90s) expires server-side.
 */

const REFRESH_FALLBACK_MS = 15_000;

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

function modeBadgeColor(mode: 'daemon' | 'proxy'): string {
  return mode === 'daemon' ? tokens.colors.accentLight : tokens.colors.successLight;
}

interface InstanceRowProps {
  inst: AgentManagerInstance;
  selected: boolean;
  onSelect(): void;
}

function InstanceRow({ inst, selected, onSelect }: InstanceRowProps) {
  const stale = Date.now() - new Date(inst.last_seen_at).getTime() > 60_000;
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
          <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {inst.hostname}
          </span>
        </div>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: stale ? tokens.colors.warning : tokens.colors.success,
            flexShrink: 0,
          }}
          title={stale ? 'Heartbeat stale' : 'Heartbeating'}
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
  const [subagents, setSubagents] = useState<SubagentSummary[] | null>(null);
  const [logs, setLogs] = useState<any[] | null>(null);
  const [restartPending, setRestartPending] = useState(false);

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

  useEffect(() => {
    setSubagents(null);
    setLogs(null);
    loadSubagents();
    loadLogs();
  }, [inst.instance_id, loadSubagents, loadLogs]);

  const handleRestart = async () => {
    if (restartPending) return;
    setRestartPending(true);
    try {
      const resp: any = await api.restartAgentManagerInstance(inst.instance_id).catch((err) => err);
      if (resp instanceof Error) throw resp;
      showToast(resp?.message || 'Restart triggered', 'info');
    } catch (err: any) {
      // 501 stub returns { error: 'not_implemented', message: '…' } — surface
      // the message so the operator knows exactly what to do until Phase 4.
      const msg = err?.message ? err.message : 'Restart endpoint is not implemented yet.';
      showToast(msg, 'info');
    } finally {
      setRestartPending(false);
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
            {inst.hostname}
          </h2>
          <span style={{ fontSize: 12, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>
            {inst.instance_id}
          </span>
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
        </dl>

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
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
            title="Phase 4 self-update will deliver SIGUSR1. Until then this is a stub."
          >
            Restart instance
          </button>
          <button
            onClick={() => { loadSubagents(); loadLogs(); }}
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
        <div style={{ marginBottom: 8, fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {loading ? 'Loading…' : `${instances.length} instance${instances.length === 1 ? '' : 's'}`}
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
    </div>
  );
}

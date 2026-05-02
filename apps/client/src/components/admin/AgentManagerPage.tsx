import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type {
  Agent,
  AgentManagerCommandKind,
  AgentManagerInstance,
  PairingTokenMint,
  PairingTokenSafe,
  SubagentSummary,
} from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { Button, Input, Modal, Select } from '../common';

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

function modeBadgeColor(mode: 'daemon' | 'proxy' | 'manager'): string {
  // manager → accent (admin-controllable), daemon → accentLight (legacy daemon),
  // proxy → success (passive Claude CLI bridge).
  if (mode === 'manager') return tokens.colors.accent;
  if (mode === 'daemon') return tokens.colors.accentLight;
  return tokens.colors.successLight;
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
            </>
          )}
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

function ManagedAgentsSection({ inst }: ManagedAgentsSectionProps) {
  const { showToast } = useToast();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingCmd, setPendingCmd] = useState<string | null>(null); // `${cmd}:${agentId}`

  // The manager Agent identity is `inst.agent_id` (created by pair/redeem).
  // Children are agents in the same workspace whose `manager_agent_id`
  // matches. Fetch the workspace agent listing once and filter client-side
  // — fewer endpoints, and the listing is already cheap (typically <50 rows).
  const refresh = useCallback(async () => {
    try {
      const all = await api.getAgents();
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
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
            Create agent…
          </Button>
        </div>
      </div>

      {agents === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
      ) : agents.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          No agents linked to this manager yet. Click <strong>Create agent…</strong> to add one.
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
                    <span style={{ fontWeight: 600 }}>{a.name}</span>
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
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
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
                {!a.working_dir && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: tokens.colors.warning }}>
                    <span>⚠ working_dir not set — manager will refuse to spawn.</span>
                    <SetWorkingDirInline
                      onSubmit={(dir) => sendCommand('set_working_dir', a.id, { working_dir: dir })}
                      pending={pendingCmd === `set_working_dir:${a.id}`}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CreateManagedAgentDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        managerAgentId={inst.agent_id}
        managerInstanceId={inst.instance_id}
        defaultCli={inst.cli}
        onCreated={() => {
          setCreateOpen(false);
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
    if (!confirm('Revoke this pairing token? Any in-flight bootstrap using it will fail.')) return;
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

// ─── Create managed-agent dialog ──────────────────────────────────────

interface CreateManagedAgentDialogProps {
  isOpen: boolean;
  onClose(): void;
  managerAgentId: string;
  /** Manager instance id — used to dispatch a follow-up spawn_agent SSE
   *  command after Create succeeds, so the operator gets one-click setup. */
  managerInstanceId: string;
  defaultCli: string;
  onCreated(): void;
}

const CLI_OPTIONS: { value: 'claude' | 'codex' | 'gemini' | 'custom'; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'custom', label: 'Custom' },
];

function CreateManagedAgentDialog({ isOpen, onClose, managerAgentId, managerInstanceId, defaultCli, onCreated }: CreateManagedAgentDialogProps) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [cli, setCli] = useState<'claude' | 'codex' | 'gemini' | 'custom'>('claude');
  const [workingDir, setWorkingDir] = useState('');
  const [description, setDescription] = useState('');
  const [autoSpawn, setAutoSpawn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setWorkingDir('');
    setDescription('');
    setAutoSpawn(true);
    // Default CLI tracks the manager's primary CLI, but the operator can
    // override it (e.g., spawn a Gemini agent under a Claude-default manager).
    const defaulted = CLI_OPTIONS.find((o) => o.value === defaultCli)?.value || 'claude';
    setCli(defaulted);
  }, [isOpen, defaultCli]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Name is required', 'error');
      return;
    }
    const trimmedWorkingDir = workingDir.trim();
    if (autoSpawn && !trimmedWorkingDir) {
      showToast('Working directory is required when "Spawn after create" is on', 'error');
      return;
    }
    setBusy(true);
    try {
      // Step 1: create the AWB Agent identity. Returns the new Agent row.
      const created = await api.createManagedAgent({
        name: trimmedName,
        cli,
        working_dir: trimmedWorkingDir || undefined,
        manager_agent_id: managerAgentId,
        description: description.trim() || undefined,
      });
      showToast(`Agent "${trimmedName}" created`, 'success');

      // Step 2 (optional): one-click spawn — dispatch spawn_agent on the
      // owning manager so it provisions the apiKey, writes per-agent
      // mcp-config, and starts routing matching SSE events to the new
      // agent's identity. Without this the operator has to click Spawn
      // separately on the row that just appeared.
      if (autoSpawn && created?.id) {
        try {
          const resp = await api.sendAgentManagerCommand(managerInstanceId, {
            command: 'spawn_agent',
            args: { agent_id: created.id },
          });
          showToast(`spawn_agent dispatched (id=${resp.command_id.slice(0, 8)})`, 'success');
        } catch (err: any) {
          showToast(`Auto-spawn failed: ${err?.message || err} (you can retry from the row)`, 'error');
        }
      }

      onCreated();
    } catch (err: any) {
      showToast(`Create failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create managed agent"
      maxWidth={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            Create
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
            placeholder="e.g. ralf-codex"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
            CLI
          </label>
          <Select
            value={cli}
            options={CLI_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCli(e.target.value as any)}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
            Working directory
          </label>
          <Input
            type="text"
            value={workingDir}
            placeholder="/abs/path/on/manager/host (can be set later)"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWorkingDir(e.target.value)}
          />
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
            Leave blank to set later via the agent row's <em>set_working_dir</em> action.
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
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colors.textPrimary }}>
            <input
              type="checkbox"
              checked={autoSpawn}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAutoSpawn(e.target.checked)}
            />
            <span>Spawn on this manager after create</span>
          </label>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
            One-click setup: the manager provisions an apiKey for this agent,
            writes its config + mcp-config files, and starts handling matching
            ticket / chat / mention events. Requires Working directory above.
          </div>
        </div>
      </div>
    </Modal>
  );
}

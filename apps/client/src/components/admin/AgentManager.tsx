import React, { useMemo, useState } from 'react';
import { api } from '../../api';
import { Agent, SubagentSummary } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useCrudList } from '../../hooks/useCrudList';
import { formatAgentDisplayName } from '../../utils/agentName';

/** Stale heartbeat threshold — matches the AgentManagerPage badge logic so the
 *  two pages agree on what "live" looks like. Ten seconds shy of the registry
 *  TTL (90s server-side), so a stale-but-still-registered instance shows as
 *  "stale" before it disappears from the list entirely. */
const HEARTBEAT_STALE_MS = 60_000;

function formatRelative(ts?: string | null): string {
  if (!ts) return '—';
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
}

function liveDotColor(agent: Agent): string {
  const inst = agent.live_instance;
  if (inst) {
    const stale = Date.now() - new Date(inst.last_seen_at).getTime() > HEARTBEAT_STALE_MS;
    return stale ? tokens.colors.warning : tokens.colors.success;
  }
  // Fall back to the legacy is_online flag for proxy-only agents that may not
  // appear in the InstanceRegistry yet (older plugins that ping but don't
  // heartbeat instances).
  if (agent.is_online) return tokens.colors.success;
  return tokens.colors.textMuted;
}

function liveDotTitle(agent: Agent): string {
  const inst = agent.live_instance;
  if (inst) {
    const stale = Date.now() - new Date(inst.last_seen_at).getTime() > HEARTBEAT_STALE_MS;
    if (stale) return `Heartbeat stale (last ${formatRelative(inst.last_seen_at)})`;
    return inst.supervised
      ? `Supervised by manager ${inst.hostname} (last seen ${formatRelative(inst.last_seen_at)})`
      : `Heartbeating from ${inst.hostname} (last seen ${formatRelative(inst.last_seen_at)})`;
  }
  if (agent.is_online) return `Online (last seen ${formatRelative(agent.last_seen_at)})`;
  return 'Offline — no recent heartbeat';
}

function modeBadgeColor(mode: 'daemon' | 'proxy' | 'manager'): string {
  if (mode === 'manager') return tokens.colors.accent;
  if (mode === 'daemon') return tokens.colors.accentLight;
  return tokens.colors.successLight;
}

function agentTypeBadgeVariant(type: string): 'info' | 'success' | 'neutral' {
  if (type === 'claude') return 'info';
  if (type === 'gpt') return 'success';
  return 'neutral';
}

interface AgentCardProps {
  agent: Agent;
  onEdit(): void;
  onDelete(): void;
  onShowSubagents(): void;
}

function AgentCard({ agent, onEdit, onDelete, onShowSubagents }: AgentCardProps) {
  const inst = agent.live_instance;
  const subRollup = agent.subagents;
  const dotColor = liveDotColor(agent);
  const dotTitle = liveDotTitle(agent);

  // Used for the agent avatar icon color
  const typeColors: Record<string, string> = {
    claude: tokens.colors.accentLight,
    gpt: tokens.colors.successLight,
    custom: tokens.colors.info,
    manager: tokens.colors.accent,
    codex: tokens.colors.warning,
    gemini: tokens.colors.successLight,
  };
  const avatarColor = typeColors[agent.type] || tokens.colors.border;

  return (
    <Card padding={0} style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: tokens.radii.lg,
            background: `${avatarColor}20`,
            border: `1px solid ${avatarColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 700,
            color: avatarColor,
            flexShrink: 0,
          }}
        >
          AI
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: dotColor,
                flexShrink: 0,
              }}
              title={dotTitle}
            />
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: tokens.colors.textStrong,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={formatAgentDisplayName(agent)}
            >
              {formatAgentDisplayName(agent)}
            </span>
          </div>
          <div
            style={{
              fontSize: '11px',
              color: tokens.colors.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.description || 'No description'}
          </div>
        </div>
        <Badge variant={agentTypeBadgeVariant(agent.type)}>{agent.type}</Badge>
        <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </div>

      {/* Live instance + working dir + subagents — only render when there's
          something to show, so legacy agents stay compact. */}
      {(inst || agent.working_dir || subRollup) && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 11,
          }}
        >
          {inst && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 3,
                  background: `${modeBadgeColor(inst.mode)}20`,
                  color: modeBadgeColor(inst.mode),
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
                title={inst.supervised ? 'Supervised by an agent-manager' : `Mode: ${inst.mode}`}
              >
                {inst.supervised ? `${inst.mode} · supervised` : inst.mode}
              </span>
              <span style={{ color: tokens.colors.textMuted }}>
                <span style={{ color: tokens.colors.textSecondary, fontWeight: 600 }}>v{inst.plugin_version}</span>
                {' · '}
                <span style={{ color: tokens.colors.textSecondary }}>{inst.cli}</span>
                {' · '}
                <span title={`Host: ${inst.hostname}`}>{inst.hostname}</span>
                {inst.pid > 0 && (
                  <>
                    {' · '}
                    <span title={`PID ${inst.pid}`}>pid {inst.pid}</span>
                  </>
                )}
              </span>
              <span style={{ marginLeft: 'auto', color: tokens.colors.textMuted }}>
                last seen {formatRelative(inst.last_seen_at)}
              </span>
            </div>
          )}

          {agent.working_dir && (
            <div
              style={{
                color: tokens.colors.textMuted,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 10,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={agent.working_dir}
            >
              cwd {agent.working_dir}
            </div>
          )}

          {subRollup && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: tokens.colors.textMuted }}>
                Subagents:{' '}
                <span style={{ color: tokens.colors.textSecondary, fontWeight: 600 }}>
                  {subRollup.active}
                </span>
                {' active'}
                {subRollup.total > subRollup.active && (
                  <>
                    {' · '}
                    <span style={{ color: tokens.colors.textMuted }}>
                      {subRollup.total} total
                    </span>
                  </>
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={onShowSubagents}>
                Details…
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

interface SubagentsModalProps {
  agent: Agent | null;
  onClose(): void;
}

function SubagentsModal({ agent, onClose }: SubagentsModalProps) {
  const subs = agent?.subagents?.recent || [];
  return (
    <Modal
      isOpen={!!agent}
      onClose={onClose}
      title={agent ? `Subagents · ${formatAgentDisplayName(agent)}` : 'Subagents'}
      maxWidth={640}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {agent?.subagents ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
            Showing {subs.length} most recent of {agent.subagents.total} total
            ({agent.subagents.active} currently active). Full transcripts and
            historical entries live under the AgentManager admin page.
          </div>
          {subs.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
              No subagents recorded for this agent yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {subs.map((s: SubagentSummary) => (
                <li
                  key={s.subagent_id}
                  style={{
                    padding: 8,
                    background: tokens.colors.surface,
                    borderRadius: tokens.radii.sm,
                    fontSize: 12,
                    color: tokens.colors.textStrong,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{s.label || s.session_key || s.subagent_id.slice(0, 8)}</span>
                      <span style={{ marginLeft: 8, fontSize: 10, color: tokens.colors.textMuted, textTransform: 'uppercase' }}>
                        {s.kind}
                      </span>
                      {s.role && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: tokens.colors.accentLight }}>
                          · {s.role}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: s.ended_at ? tokens.colors.textMuted : tokens.colors.success, fontWeight: 600 }}>
                      {s.ended_at ? `ended ${formatRelative(s.ended_at)}` : 'active'}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                    pid {s.pid} · {s.line_count} lines · started {formatRelative(s.started_at)}
                    {s.ticket_title && (
                      <>
                        {' · '}
                        <span title={s.ticket_id}>{s.ticket_title}</span>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          No subagent activity recorded.
        </div>
      )}
    </Modal>
  );
}

export default function AgentManager() {
  const { items: agents, showForm, setShowForm, editingId, setEditingId, refresh: load } =
    useCrudList<Agent>(() => api.getAgentsAll());
  const [form, setForm] = useState({ name: '', description: '', type: 'custom', role_prompt: '' });
  const [subagentDetailAgent, setSubagentDetailAgent] = useState<Agent | null>(null);

  // Re-resolve the live agent instance every render so the modal reflects the
  // most recent enrichment after `load()` refresh, not the snapshot taken when
  // the user clicked "Details…".
  const subagentDetailLive = useMemo(() => {
    if (!subagentDetailAgent) return null;
    return agents.find((a) => a.id === subagentDetailAgent.id) || subagentDetailAgent;
  }, [agents, subagentDetailAgent]);

  const resetForm = () => {
    setForm({ name: '', description: '', type: 'custom', role_prompt: '' });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (editingId) {
      await api.updateAgent(editingId, form);
    } else {
      await api.createAgent(form);
    }
    resetForm();
    await load();
  };

  const handleEdit = (agent: Agent) => {
    setForm({
      name: agent.name,
      description: agent.description,
      type: agent.type,
      role_prompt: agent.role_prompt || '',
    });
    setEditingId(agent.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this agent?')) return;
    await api.deleteAgent(id);
    await load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{agents.length} agents</span>
        <Button variant="primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Agent</Button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: tokens.spacing.md,
      }}>
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onEdit={() => handleEdit(agent)}
            onDelete={() => handleDelete(agent.id)}
            onShowSubagents={() => setSubagentDetailAgent(agent)}
          />
        ))}
        {agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No agents yet</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Add your first agent to get started.</div>
          </div>
        )}
      </div>

      <SubagentsModal agent={subagentDetailLive} onClose={() => setSubagentDetailAgent(null)} />

      <Modal
        isOpen={showForm}
        onClose={resetForm}
        title={editingId ? 'Edit Agent' : 'Create Agent'}
        maxWidth={600}
        footer={
          <>
            <Button variant="secondary" onClick={resetForm}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}>{editingId ? 'Update' : 'Create'}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Name *"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Agent name"
            />
            <Select
              label="Type"
              value={form.type}
              onChange={e => setForm({ ...form, type: (e.target as HTMLSelectElement).value })}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'gpt', label: 'GPT' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          </div>
          <Input
            label="Description"
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="What does this agent do?"
          />
          {/* Role Prompt section — ROLE-02 / D-14 */}
          <div>
            <label style={{ fontSize: '11px', color: tokens.colors.textSecondary, fontWeight: 600, display: 'block', marginBottom: 6 }}>
              Role Prompt
            </label>
            <div style={{ fontSize: '11px', fontWeight: 400, color: tokens.colors.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
              Markdown instructions delivered to this agent on every trigger. Persists across triggers and chat sessions.
            </div>
            <textarea
              value={form.role_prompt}
              onChange={e => setForm({ ...form, role_prompt: e.target.value })}
              placeholder="You are an agent responsible for..."
              style={{
                width: '100%',
                minHeight: 240,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '10px 12px',
                color: tokens.colors.textStrong,
                fontSize: '12px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                lineHeight: 1.5,
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

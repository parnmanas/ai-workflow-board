import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { Agent, AgentManagerCommandKind, Credential, ManagedAgentCreateBody, SubagentSummary } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Badge, Modal, Card } from '../common';
import { useCrudList } from '../../hooks/useCrudList';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { formatAgentDisplayName } from '../../utils/agentName';

/** Map agent.type → credential provider prefix used to filter the credential
 *  picker. CLIs whose adapter ships in agent-manager (claude / codex / antigravity)
 *  show only credentials with a matching provider prefix; legacy / custom
 *  agent types skip the picker entirely. */
const CLI_TO_CREDENTIAL_PREFIX: Record<string, string> = {
  claude: 'claude_',
  codex: 'codex_',
  antigravity: 'antigravity_',
  deepseek: 'deepseek_',
};

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
  if (type === 'codex' || type === 'antigravity') return 'success';
  return 'neutral';
}

/** Lifecycle commands surfaced on managed-agent cards. Mirrors the
 *  COMMAND_BUTTONS list in AgentManagerPage's ManagedAgentsSection so the
 *  two surfaces agree on what an operator can do with a managed agent.
 *  Spawn / Stop / Restart only — maintenance commands (update_plugins,
 *  refresh_mcp_config, pull_working_dir) stay on the per-manager page
 *  because they're rarely used from the workspace AI Agents view. */
const MANAGED_COMMAND_BUTTONS: {
  kind: AgentManagerCommandKind;
  label: string;
  variant: 'primary' | 'danger' | 'secondary';
  title: string;
}[] = [
  {
    kind: 'spawn_agent',
    label: 'Spawn',
    variant: 'primary',
    title: 'Dispatch spawn_agent to the owning manager — bootstraps on-disk dir + apiKey and registers runtime context.',
  },
  {
    kind: 'stop_agent',
    label: 'Stop',
    variant: 'danger',
    title: 'Dispatch stop_agent to the owning manager — drops runtime context + erases on-disk secrets. In-flight subagents keep running.',
  },
  {
    kind: 'restart_agent',
    label: 'Restart',
    variant: 'secondary',
    title: 'Dispatch restart_agent: stop + spawn (re-provisions a fresh apiKey).',
  },
];

interface AgentCardProps {
  agent: Agent;
  onEdit(): void;
  onDelete(): void;
  onShowSubagents(): void;
}

function AgentCard({ agent, onEdit, onDelete, onShowSubagents }: AgentCardProps) {
  const { showToast } = useToast();
  const inst = agent.live_instance;
  const subRollup = agent.subagents;
  const dotColor = liveDotColor(agent);
  const dotTitle = liveDotTitle(agent);

  // Managed agents (agent.manager_agent_id set) get the Spawn / Stop /
  // Restart action row. Standalone proxy / daemon / manager-identity rows
  // skip it — those don't have an owning manager to dispatch the command to.
  // `live_instance.instance_id` for a managed agent points at the
  // supervising manager process (see agents.controller _enrichLiveData),
  // which is exactly what /admin/agent-manager/instances/:id/command needs.
  const isManaged = !!agent.manager_agent_id;
  const managerInstanceId = inst?.instance_id ?? null;
  const [pendingCmd, setPendingCmd] = useState<AgentManagerCommandKind | null>(null);

  const sendCommand = useCallback(async (kind: AgentManagerCommandKind) => {
    if (!managerInstanceId) {
      showToast('Owning manager is offline — start it before dispatching a command.', 'error');
      return;
    }
    if (pendingCmd) return;
    setPendingCmd(kind);
    try {
      const resp = await api.sendAgentManagerCommand(managerInstanceId, {
        command: kind,
        args: { agent_id: agent.id },
      });
      showToast(`${kind} dispatched (id=${resp.command_id.slice(0, 8)})`, 'success');
    } catch (err: any) {
      showToast(`Command failed: ${err?.message || err}`, 'error');
    } finally {
      setPendingCmd(null);
    }
  }, [agent.id, managerInstanceId, pendingCmd, showToast]);

  // Used for the agent avatar icon color
  const typeColors: Record<string, string> = {
    claude: tokens.colors.accentLight,
    deepseek: tokens.colors.successLight,
    custom: tokens.colors.info,
    manager: tokens.colors.accent,
    codex: tokens.colors.warning,
    antigravity: tokens.colors.successLight,
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

      {/* Managed-agent lifecycle buttons. Only render for agents owned by a
          manager (agent.manager_agent_id set); standalone identities have no
          owning manager to route commands through. Disabled when the owning
          manager has no live instance — the command endpoint would 404. */}
      {isManaged && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '8px 12px',
            borderTop: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceCard,
          }}
        >
          {MANAGED_COMMAND_BUTTONS.map((btn) => (
            <Button
              key={btn.kind}
              size="sm"
              variant={btn.variant}
              disabled={!managerInstanceId || pendingCmd === btn.kind}
              onClick={() => sendCommand(btn.kind)}
              title={managerInstanceId ? btn.title : 'Owning manager is offline — start it before dispatching this command.'}
            >
              {btn.label}
            </Button>
          ))}
        </div>
      )}

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

/** CLI types the agent-manager can spawn — mirrors the server's
 *  createManagedAgent whitelist (common/types/cli-types.ts CLI_TYPES). Picking
 *  a manager from the optional dropdown switches the form into "managed agent"
 *  mode and constrains Type to one of these. */
const MANAGED_CLI_TYPES = new Set(['claude', 'codex', 'antigravity', 'deepseek', 'custom']);

interface ManagerOption {
  id: string;
  name: string;
  description: string;
  workspace_id: string;
  is_active: number;
}

export default function AgentManager() {
  const confirm = useConfirm();
  const { items: agents, showForm, setShowForm, editingId, setEditingId, refresh: load } =
    useCrudList<Agent>(() => api.getAgentsAll());
  const [form, setForm] = useState({
    name: '',
    description: '',
    type: 'custom',
    role_prompt: '',
    credential_id: '',
    manager_agent_id: '',
    working_dir: '',
  });
  const [subagentDetailAgent, setSubagentDetailAgent] = useState<Agent | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [managers, setManagers] = useState<ManagerOption[]>([]);

  // Pull credentials once per modal-open. Workspace-scoped: only credentials
  // in the active workspace are eligible (matches the server's
  // workspace-scoped FK validation in createManagedAgent).
  useEffect(() => {
    if (!showForm) return;
    const wsId = getActiveWorkspaceId() || '';
    if (!wsId) { setCredentials([]); return; }
    let alive = true;
    api.listCredentials(wsId)
      .then((rows) => { if (alive) setCredentials(rows); })
      .catch(() => { if (alive) setCredentials([]); });
    return () => { alive = false; };
  }, [showForm]);

  // Pull the cross-workspace manager list once per modal-open. Managers are
  // global (admin pairs them once); the picker lets an operator attach this
  // workspace's agent to a manager paired in any workspace. Empty list = no
  // managers paired yet, so the form silently falls back to legacy mode.
  useEffect(() => {
    if (!showForm) return;
    let alive = true;
    api.listAgentManagers()
      .then((rows) => { if (alive) setManagers(rows); })
      .catch(() => { if (alive) setManagers([]); });
    return () => { alive = false; };
  }, [showForm]);

  const eligibleCredentials = useMemo(() => {
    const prefix = CLI_TO_CREDENTIAL_PREFIX[form.type];
    if (!prefix) return [];
    return credentials.filter((c) => c.provider.startsWith(prefix));
  }, [credentials, form.type]);

  // Managed-agent mode: a manager is picked. The save path then routes to
  // createManagedAgent (which validates cli + manager_agent_id) and surfaces
  // the working_dir input so the manager knows where to spawn the CLI.
  const isManagedMode = !!form.manager_agent_id;
  const managedTypeInvalid = isManagedMode && !MANAGED_CLI_TYPES.has(form.type);

  // Re-resolve the live agent instance every render so the modal reflects the
  // most recent enrichment after `load()` refresh, not the snapshot taken when
  // the user clicked "Details…".
  const subagentDetailLive = useMemo(() => {
    if (!subagentDetailAgent) return null;
    return agents.find((a) => a.id === subagentDetailAgent.id) || subagentDetailAgent;
  }, [agents, subagentDetailAgent]);

  const resetForm = () => {
    setForm({
      name: '',
      description: '',
      type: 'custom',
      role_prompt: '',
      credential_id: '',
      manager_agent_id: '',
      working_dir: '',
    });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (managedTypeInvalid) return;
    // Drop credential_id when the CLI type doesn't support per-agent
    // credentials (only claude / codex / antigravity do); preserves the existing
    // null contract for custom / legacy types so the server treats them as
    // "no credential" rather than mis-setting an FK.
    const supportsCredential = !!CLI_TO_CREDENTIAL_PREFIX[form.type];
    const credential_id = supportsCredential && form.credential_id ? form.credential_id : null;

    if (editingId) {
      // Edit covers both modes — PATCH /api/agents/:id accepts every field
      // we need (manager_agent_id and working_dir included). Empty
      // manager_agent_id clears the link (detach to legacy proxy mode).
      await api.updateAgent(editingId, {
        name: form.name,
        description: form.description,
        type: form.type,
        role_prompt: form.role_prompt,
        credential_id,
        manager_agent_id: form.manager_agent_id || null,
        working_dir: form.working_dir,
      } as any);
    } else if (isManagedMode) {
      // Create-with-manager: route through the createManagedAgent contract
      // so the server validates cli + manager existence. role_prompt is not
      // part of that body, so we set it via a follow-up PATCH if non-empty.
      const body: ManagedAgentCreateBody = {
        name: form.name,
        cli: form.type as ManagedAgentCreateBody['cli'],
        working_dir: form.working_dir.trim() || undefined,
        manager_agent_id: form.manager_agent_id,
        description: form.description || undefined,
        credential_id: credential_id || undefined,
      };
      const created = await api.createManagedAgent(body);
      if (form.role_prompt) {
        await api.updateAgent(created.id, { role_prompt: form.role_prompt } as any);
      }
    } else {
      // Legacy create — no manager, plain workspace-scoped agent identity.
      await api.createAgent({
        name: form.name,
        description: form.description,
        type: form.type,
        role_prompt: form.role_prompt,
        credential_id,
      } as any);
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
      credential_id: agent.credential_id || '',
      manager_agent_id: agent.manager_agent_id || '',
      working_dir: agent.working_dir || '',
    });
    setEditingId(agent.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({ title: 'Delete agent', message: 'Delete this agent?' });
    if (!ok) return;
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
            <Button variant="primary" onClick={handleSave} disabled={managedTypeInvalid}>
              {editingId ? 'Update' : 'Create'}
            </Button>
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
                { value: 'codex', label: 'Codex' },
                { value: 'antigravity', label: 'Antigravity' },
                { value: 'deepseek', label: 'DeepSeek' },
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
          {/* Optional manager picker — empty = legacy proxy mode (no
              spawn supervision); picking a manager switches the form into
              managed-agent mode (working_dir + CLI restricted to the
              spawn whitelist). */}
          <div>
            <Select
              label="Agent Manager (optional)"
              value={form.manager_agent_id}
              onChange={e => setForm({ ...form, manager_agent_id: (e.target as HTMLSelectElement).value })}
              options={[
                { value: '', label: 'None — legacy / proxy mode' },
                ...managers.map(m => ({ value: m.id, label: m.name })),
              ]}
            />
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
              Pick a paired manager to have it spawn this agent's CLI. Leave blank to keep the existing proxy / standalone behaviour.
              {managers.length === 0 && ' No managers paired yet — pair one from the AgentManager admin page.'}
            </div>
          </div>
          {isManagedMode && (
            <div>
              <Input
                label={`Working directory${form.type === 'custom' ? ' (optional)' : ' *'}`}
                value={form.working_dir}
                onChange={e => setForm({ ...form, working_dir: e.target.value })}
                placeholder="/abs/path/on/manager/host"
              />
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                Path on the manager host where the CLI will be spawned. The manager will refuse to spawn this agent until a working_dir is set.
              </div>
            </div>
          )}
          {managedTypeInvalid && (
            <div style={{ fontSize: '11px', color: tokens.colors.warning, lineHeight: 1.5 }}>
              ⚠ Type "{form.type}" is not supported by the agent-manager spawn pipeline. Choose Claude, Codex, Antigravity, or Custom — or clear the Agent Manager picker to keep the legacy behaviour.
            </div>
          )}
          {CLI_TO_CREDENTIAL_PREFIX[form.type] && (
            <div>
              <Select
                label="CLI credential"
                value={form.credential_id}
                onChange={e => setForm({ ...form, credential_id: (e.target as HTMLSelectElement).value })}
                options={[
                  { value: '', label: 'None — fall back to operator HOME' },
                  ...eligibleCredentials.map(c => ({ value: c.id, label: `${c.name} · ${c.provider}` })),
                ]}
              />
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                Per-agent CLI auth. Subscription credentials drop the OAuth file into this agent's cli-home; API-key credentials export the matching env var on every spawn. Manage values in the Credentials page.
              </div>
            </div>
          )}
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

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import AgentCard from './AgentCard';
import DirectoryPicker from './admin/DirectoryPicker';
import { tokens } from '../tokens';
import { Button, Input, Select, Modal } from './common';
import type {
  DashboardAgent,
  AgentCurrentTask,
  Credential,
  ManagedAgentCreateBody,
} from '../types';

/** Map agent.type → credential provider prefix used to filter the credential
 *  picker. Mirrors the same map in admin/AgentManager.tsx — keep them in sync.
 *  CLIs whose adapter ships in agent-manager (claude / codex / antigravity) show
 *  only credentials with a matching provider prefix; `custom` skips it. */
const CLI_TO_CREDENTIAL_PREFIX: Record<string, string> = {
  claude: 'claude_',
  codex: 'codex_',
  antigravity: 'antigravity_',
};

/** CLI types the agent-manager spawn pipeline accepts — must match the
 *  server's ALLOWED_CLI_TYPES whitelist in agent-manager.controller.ts. */
type ManagedCli = ManagedAgentCreateBody['cli'];

/** CLI options surfaced in the Managed Agent picker. Mirrors the type
 *  whitelist in admin/AgentManager.tsx so the workspace form offers the same
 *  set the server's createManagedAgent contract accepts. */
const MANAGED_CLI_OPTIONS: Array<{ value: ManagedCli; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'custom', label: 'Custom' },
];

interface ManagerOption {
  id: string;
  name: string;
  description: string;
  workspace_id: string;
  is_active: number;
}

/** Initial state for the Managed Agent create form. Defaulting cli=claude
 *  matches the most common case (claude-code-driven agents) and lets the
 *  Working Directory field surface its required marker immediately. */
const EMPTY_MANAGED_FORM: {
  name: string;
  description: string;
  cli: ManagedCli;
  manager_agent_id: string;
  working_dir: string;
  credential_id: string;
  role_prompt: string;
} = {
  name: '',
  description: '',
  cli: 'claude',
  manager_agent_id: '',
  working_dir: '',
  credential_id: '',
  role_prompt: '',
};

/**
 * AgentsPage — card grid + modal layout matching BoardsIndexPage pattern.
 *
 * Card grid shows all workspace agents. Clicking a card opens AgentDetailModal
 * (right-panel slide-in). Real-time status via BoardStreamContext agent_status
 * envelopes (D-42/D-50). workspace sourced from URL params (wsId).
 */

interface StatusUpdate {
  agent_id: string;
  is_online: boolean;
  last_seen_at: string | null;
  current_task?: AgentCurrentTask;
}

function mergeAgentStatus(
  list: DashboardAgent[],
  update: StatusUpdate,
): DashboardAgent[] {
  const idx = list.findIndex((a) => a.id === update.agent_id);
  // Ignore status updates for agents not in this workspace
  if (idx === -1) return list;
  const next = list.slice();
  const existing = next[idx];
  next[idx] = {
    ...existing,
    is_online: !!update.is_online,
    last_seen_at: update.last_seen_at ?? existing.last_seen_at,
    current_task: update.current_task,
  };
  return next;
}

export default function AgentsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [agents, setAgents] = useState<DashboardAgent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const navigate = useNavigate();
  const openDetail = useCallback((id: string) => {
    if (wsId) navigate(`/ws/${wsId}/agents/${id}`);
  }, [navigate, wsId]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', type: 'custom' });

  // Managed-agent ("via AgentManager") creation surface — separate from the
  // legacy "+ New Agent" modal because the agent-manager spawn contract
  // requires extra fields (manager pick, working_dir, optional credential)
  // that don't apply to plain workspace agents. UI mirrors the managed-mode
  // form in admin/AgentManager.tsx.
  const [showManagedModal, setShowManagedModal] = useState(false);
  const [managedForm, setManagedForm] = useState<typeof EMPTY_MANAGED_FORM>(EMPTY_MANAGED_FORM);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [creatingManaged, setCreatingManaged] = useState(false);
  // ST-7 directory picker — opens a modal that browses the picked manager's
  // host filesystem via the existing /api/agents/:id/fs/* reverse-RPC, so
  // the operator clicks a directory instead of typing an absolute path that
  // is meaningful only on that specific manager host.
  const [pickerOpen, setPickerOpen] = useState(false);

  const pendingStatusRef = useRef<StatusUpdate[]>([]);
  const agentsReadyRef = useRef(false);

  // ─── Initial snapshot ─────────────────────────────────────────
  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setSnapshotError(null);
    agentsReadyRef.current = false;

    const result = await Promise.allSettled([
      api.getAgentDashboard(wsId || ''),
    ]);

    const agentsResult = result[0];

    if (agentsResult.status === 'fulfilled') {
      const base = agentsResult.value || [];
      const buffered = pendingStatusRef.current;
      pendingStatusRef.current = [];
      const merged = buffered.reduce(
        (acc, update) => mergeAgentStatus(acc, update),
        base,
      );
      setAgents(merged);
      agentsReadyRef.current = true;
    } else {
      setSnapshotError('Could not load agents. Retry.');
      setAgents((prev) => prev || []);
    }

    setLoading(false);
  }, [wsId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // ─── Live envelopes via BoardStreamContext ────────────────────
  useBoardStreamEvent('agent_status', (envelope: any) => {
    const payload = envelope?.payload;
    if (!payload || !payload.agent_id) return;
    const update: StatusUpdate = {
      agent_id: payload.agent_id,
      is_online: !!payload.is_online,
      last_seen_at: payload.last_seen_at ?? null,
      current_task: payload.current_task,
    };
    if (!agentsReadyRef.current) {
      pendingStatusRef.current.push(update);
      return;
    }
    setAgents((prev) => (prev ? mergeAgentStatus(prev, update) : prev));
  });

  // ─── Handlers ─────────────────────────────────────────────────
  // Track in-flight state so double-clicks on Create don't spawn parallel
  // POSTs, and so the button can disable + show "Creating..." feedback.
  const [creating, setCreating] = useState(false);
  const handleCreateAgent = useCallback(async () => {
    if (!createForm.name.trim() || creating) return;
    setCreating(true);
    try {
      // Pass the URL wsId explicitly so the request always lands in the
      // workspace the user is looking at, regardless of whether
      // localStorage.currentWorkspaceId has drifted.
      await api.createAgent({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        type: createForm.type,
        workspaceId: wsId,
      });
      setCreateForm({ name: '', description: '', type: 'custom' });
      setShowCreateModal(false);
      await loadSnapshot();
      showToast('Agent created', 'success');
    } catch (err: any) {
      // Surface the failure — prior silent-catch made "New Agent" appear to
      // do nothing when the POST was rejected (403 from WorkspaceGuard,
      // auth expiry, etc.). Keep the modal open so the user can retry.
      showToast(err?.message || 'Failed to create agent', 'error');
    } finally {
      setCreating(false);
    }
  }, [createForm, creating, loadSnapshot, wsId, showToast]);

  // ─── Managed-agent picker data ────────────────────────────────
  // Pull managers + credentials only when the managed modal opens to keep
  // the page boot lean. Managers list is cross-workspace (admins pair them
  // globally); credentials are scoped to the URL workspace because that's
  // where the new managed agent will be created.
  useEffect(() => {
    if (!showManagedModal) return;
    let alive = true;
    api.listAgentManagers()
      .then((rows) => { if (alive) setManagers(rows); })
      .catch(() => { if (alive) setManagers([]); });
    if (wsId) {
      api.listCredentials(wsId)
        .then((rows) => { if (alive) setCredentials(rows); })
        .catch(() => { if (alive) setCredentials([]); });
    } else {
      setCredentials([]);
    }
    return () => { alive = false; };
  }, [showManagedModal, wsId]);

  const eligibleCredentials = useMemo(() => {
    const prefix = CLI_TO_CREDENTIAL_PREFIX[managedForm.cli];
    if (!prefix) return [];
    return credentials.filter((c) => c.provider.startsWith(prefix));
  }, [credentials, managedForm.cli]);

  // working_dir is optional for `custom` (the manager doesn't know how to
  // launch a custom CLI without operator-supplied scripts anyway), required
  // otherwise — same rule the admin AgentManager surfaces in its label.
  const managedWorkingDirRequired = managedForm.cli !== 'custom';

  const resetManagedForm = useCallback(() => {
    setManagedForm(EMPTY_MANAGED_FORM);
    setPickerOpen(false);
    setShowManagedModal(false);
  }, []);

  // Switching the Agent Manager invalidates the previously-picked
  // working_dir: a path on host A is meaningless on host B (and the FS
  // browser will list a different filesystem entirely). Reset the field so
  // the operator has to re-pick from the new manager's tree.
  const handleManagerChange = useCallback((nextManagerId: string) => {
    setManagedForm((f) => (
      f.manager_agent_id === nextManagerId
        ? f
        : { ...f, manager_agent_id: nextManagerId, working_dir: '' }
    ));
    setPickerOpen(false);
  }, []);

  const handleCreateManagedAgent = useCallback(async () => {
    if (creatingManaged) return;
    if (!managedForm.name.trim()) return;
    if (!managedForm.manager_agent_id) {
      showToast('Pick an Agent Manager', 'error');
      return;
    }
    if (managedWorkingDirRequired && !managedForm.working_dir.trim()) {
      showToast('Working directory is required', 'error');
      return;
    }
    setCreatingManaged(true);
    try {
      // Drop credential_id when the CLI doesn't support per-agent
      // credentials (only claude / codex / antigravity do); preserves the
      // server's null contract for `custom` so it doesn't mis-set an FK.
      const supportsCredential = !!CLI_TO_CREDENTIAL_PREFIX[managedForm.cli];
      const credential_id = supportsCredential && managedForm.credential_id
        ? managedForm.credential_id
        : undefined;
      const body: ManagedAgentCreateBody = {
        name: managedForm.name.trim(),
        cli: managedForm.cli,
        manager_agent_id: managedForm.manager_agent_id,
        working_dir: managedForm.working_dir.trim() || undefined,
        description: managedForm.description.trim() || undefined,
        credential_id,
      };
      // Pin to the URL wsId — defensive against per-tab active workspace
      // drift, same pattern as createAgent above.
      const created = await api.createManagedAgent(body, wsId);
      // role_prompt isn't part of the createManagedAgent contract on the
      // server (admin AgentManager handles it the same way) — mirror the
      // follow-up PATCH so an operator can set a role at create time.
      if (managedForm.role_prompt.trim()) {
        try {
          await api.updateAgent(created.id, { role_prompt: managedForm.role_prompt } as any);
        } catch (err: any) {
          // Surface the partial failure but don't roll back — the agent is
          // already created and visible; the operator can edit role_prompt
          // from the admin panel.
          showToast(`Agent created, but role prompt failed: ${err?.message || 'unknown'}`, 'error');
        }
      }
      resetManagedForm();
      await loadSnapshot();
      showToast('Managed agent created', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to create managed agent', 'error');
    } finally {
      setCreatingManaged(false);
    }
  }, [
    managedForm,
    creatingManaged,
    managedWorkingDirRequired,
    wsId,
    loadSnapshot,
    showToast,
    resetManagedForm,
  ]);

  // ─── Render ───────────────────────────────────────────────────
  const agentsList = agents || [];
  const agentCount = agentsList.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="AI Agents"
        description="Live agent status"
        actions={
          user?.role === 'admin' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="md" onClick={() => setShowManagedModal(true)}>
                + New Managed Agent
              </Button>
              <Button variant="primary" size="md" onClick={() => setShowCreateModal(true)}>
                + New Agent
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Snapshot error banner */}
      {snapshotError && (
        <div
          style={{
            margin: '0 24px 0 24px',
            padding: '12px 16px',
            background: 'transparent',
            border: `1px solid ${tokens.colors.danger}`,
            borderRadius: tokens.radii.md,
            color: tokens.colors.danger,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          }}
          role="alert"
        >
          <span>{snapshotError}</span>
          <button
            type="button"
            onClick={loadSnapshot}
            style={{
              background: 'transparent',
              color: tokens.colors.danger,
              border: `1px solid ${tokens.colors.danger}`,
              borderRadius: tokens.radii.md,
              padding: '4px 12px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {/* Loading skeleton */}
        {agents === null ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  background: tokens.colors.surfaceCard,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg,
                  padding: 16,
                  minHeight: 136,
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 20, background: tokens.colors.border }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ height: 15, background: tokens.colors.border, borderRadius: 2, width: '60%' }} />
                    <div style={{ height: 11, background: tokens.colors.border, borderRadius: 2, width: '40%' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : agentCount === 0 ? (
          /* Empty state */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '48px 24px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>
              No agents in this workspace
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary, lineHeight: 1.5, maxWidth: 400, marginTop: 8 }}>
              Add an agent from the Admin panel to get started.
            </div>
          </div>
        ) : (
          /* Card grid */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
              alignItems: 'stretch',
            }}
          >
            {agentsList.map((agent) => (
              <div
                key={agent.id}
                onClick={() => openDetail(agent.id)}
                style={{
                  cursor: 'pointer',
                  borderRadius: tokens.radii.lg,
                }}
              >
                <AgentCard
                  agent={agent}
                  onOpenDetail={() => openDetail(agent.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent detail surface moved to a real route in v0.32.x —
         see AgentDetailPage. AgentsPage just navigates on click. */}

      {/* Create Agent modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowCreateModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: tokens.colors.surfaceCard, borderRadius: tokens.radii.xl, padding: 24, width: 440,
            border: `1px solid ${tokens.colors.border}`,
          }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 16 }}>
              New AI Agent
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Name *</label>
                <input
                  value={createForm.name}
                  onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Agent name"
                  autoFocus
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                  }}
                  onKeyDown={e => { if (e.key === 'Enter' && createForm.name.trim()) handleCreateAgent(); }}
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Description</label>
                <input
                  value={createForm.description}
                  onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What does this agent do?"
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Type</label>
                <select
                  value={createForm.type}
                  onChange={e => setCreateForm(f => ({ ...f, type: e.target.value }))}
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', boxSizing: 'border-box',
                  }}
                >
                  <option value="claude">Claude</option>
                  <option value="gpt">GPT</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setShowCreateModal(false)} style={{
                background: 'transparent', color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '6px 14px', fontSize: '12px', cursor: 'pointer',
              }}>Cancel</button>
              <button
                onClick={handleCreateAgent}
                disabled={!createForm.name.trim() || creating}
                style={{
                  background: createForm.name.trim() && !creating ? tokens.colors.accent : tokens.colors.border, color: 'white',
                  border: 'none', borderRadius: tokens.radii.md, padding: '6px 14px', fontSize: '12px',
                  fontWeight: 600, cursor: createForm.name.trim() && !creating ? 'pointer' : 'not-allowed',
                }}
              >{creating ? 'Creating...' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create Managed Agent modal — mirrors admin/AgentManager.tsx managed
          mode but as a dedicated surface so the workspace AI Agents tab can
          add agent-manager-spawned identities without dropping into Admin. */}
      <Modal
        isOpen={showManagedModal}
        onClose={resetManagedForm}
        title="New Managed Agent"
        maxWidth={600}
        footer={
          <>
            <Button variant="secondary" onClick={resetManagedForm} disabled={creatingManaged}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreateManagedAgent}
              disabled={
                !managedForm.name.trim() ||
                !managedForm.manager_agent_id ||
                (managedWorkingDirRequired && !managedForm.working_dir.trim()) ||
                creatingManaged
              }
            >
              {creatingManaged ? 'Creating…' : 'Create'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Name *"
              value={managedForm.name}
              onChange={e => setManagedForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Agent name"
              autoFocus
            />
            <Select
              label="Type"
              value={managedForm.cli}
              onChange={e => setManagedForm(f => ({ ...f, cli: (e.target as HTMLSelectElement).value as ManagedCli }))}
              options={MANAGED_CLI_OPTIONS}
            />
          </div>
          <Input
            label="Description"
            value={managedForm.description}
            onChange={e => setManagedForm(f => ({ ...f, description: e.target.value }))}
            placeholder="What does this agent do?"
          />
          <div>
            <Select
              label="Agent Manager *"
              value={managedForm.manager_agent_id}
              onChange={e => handleManagerChange((e.target as HTMLSelectElement).value)}
              options={[
                { value: '', label: managers.length === 0 ? 'No managers paired yet' : 'Select a manager…' },
                ...managers.map(m => ({ value: m.id, label: m.name })),
              ]}
            />
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
              The picked manager spawns this agent's CLI on its host. Changing this clears the working directory — paths are host-specific.
              {managers.length === 0 && ' Pair one from the AgentManager admin page first.'}
            </div>
          </div>
          <div>
            <label style={{
              fontSize: '11px',
              color: tokens.colors.textSecondary,
              fontWeight: 600,
              display: 'block',
              marginBottom: 6,
            }}>
              {`Working directory${managedWorkingDirRequired ? ' *' : ' (optional)'}`}
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}>
                <Input
                  value={managedForm.working_dir}
                  onChange={e => setManagedForm(f => ({ ...f, working_dir: e.target.value }))}
                  placeholder="/abs/path/on/manager/host (or click Browse)"
                />
              </div>
              <Button
                variant="ghost"
                onClick={() => setPickerOpen(true)}
                disabled={!managedForm.manager_agent_id}
                title={managedForm.manager_agent_id
                  ? "Browse the manager host's filesystem via SSE reverse-RPC"
                  : 'Pick an Agent Manager first.'}
              >
                📁 Browse…
              </Button>
            </div>
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
              Path on the manager host where the CLI will be spawned. The manager will refuse to spawn this agent until a working_dir is set.
            </div>
          </div>
          {/* Mounted only while the user has actually picked a manager —
              DirectoryPicker keys its fs/* requests off managerAgentId, so
              opening it without one would hit /agents//fs/roots and 404. */}
          {managedForm.manager_agent_id && (
            <DirectoryPicker
              isOpen={pickerOpen}
              onClose={() => setPickerOpen(false)}
              managerAgentId={managedForm.manager_agent_id}
              initialPath={managedForm.working_dir.trim() || undefined}
              onPick={(picked) => {
                setManagedForm(f => ({ ...f, working_dir: picked }));
              }}
            />
          )}
          {CLI_TO_CREDENTIAL_PREFIX[managedForm.cli] && (
            <div>
              <Select
                label="CLI credential"
                value={managedForm.credential_id}
                onChange={e => setManagedForm(f => ({ ...f, credential_id: (e.target as HTMLSelectElement).value }))}
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
          <div>
            <label style={{
              fontSize: '11px',
              color: tokens.colors.textSecondary,
              fontWeight: 600,
              display: 'block',
              marginBottom: 6,
            }}>
              Role Prompt
            </label>
            <div style={{ fontSize: '11px', fontWeight: 400, color: tokens.colors.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
              Markdown instructions delivered to this agent on every trigger. Persists across triggers and chat sessions.
            </div>
            <textarea
              value={managedForm.role_prompt}
              onChange={e => setManagedForm(f => ({ ...f, role_prompt: e.target.value }))}
              placeholder="You are an agent responsible for..."
              style={{
                width: '100%',
                minHeight: 180,
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

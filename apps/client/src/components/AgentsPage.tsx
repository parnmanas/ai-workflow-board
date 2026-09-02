import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import DirectoryPicker from './admin/DirectoryPicker';
import AgentManagerPage from './admin/AgentManagerPage';
import { tokens } from '../tokens';
import { credentialFallbackCopy } from '../utils/credentialFallback';
import { Button, Input, Select, Modal } from './common';
import RuntimeConfigFields, {
  buildRuntimeConfig,
  EMPTY_RUNTIME_SELECTION,
  type RuntimeSelection,
} from './admin/RuntimeConfigFields';
import type {
  DashboardAgent,
  AgentCurrentTask,
  AgentLifecycleState,
  AgentManagerInstance,
  ClaudeBackendProfile,
  Credential,
  ManagedAgentCreateBody,
} from '../types';

/** Map agent.type → credential provider prefix used to filter the credential
 *  picker. Keep this aligned with the server adapter credential mapping.
 *  CLIs whose adapter ships in agent-manager (claude / codex / antigravity) show
 *  only credentials with a matching provider prefix; `custom` skips it. `pi`
 *  has no provider prefix at all — it has no credential concept AWB manages
 *  (see cli-adapters/pi.ts) — so it's deliberately absent from this map,
 *  which is what keeps the credential picker below from rendering for it. */
const CLI_TO_CREDENTIAL_PREFIX: Record<string, string> = {
  claude: 'claude_',
  codex: 'codex_',
  antigravity: 'antigravity_',
  deepseek: 'deepseek_',
};

interface ManagerOption {
  id: string;
  name: string;
  description: string;
  workspace_id: string | null;
  is_active: number;
}

const EMPTY_MANAGED_FORM: {
  name: string;
  description: string;
  runtime: RuntimeSelection;
  manager_agent_id: string;
  working_dir: string;
  credential_id: string;
  role_prompt: string;
  runtime_profile: string;
} = {
  name: '',
  description: '',
  runtime: EMPTY_RUNTIME_SELECTION,
  manager_agent_id: '',
  working_dir: '',
  credential_id: '',
  role_prompt: '',
  runtime_profile: '',
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
  lifecycle_state?: AgentLifecycleState;
  lifecycle_detail?: string;
  current_task?: AgentCurrentTask;
  active_tasks?: AgentCurrentTask[];
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
    // Live 5-state lifecycle (ticket bfdd80b7) so the card badge reflects
    // starting/never_started/error without a refetch. Keep the existing value
    // when the update omits it (older server that doesn't send lifecycle_state).
    lifecycle_state:
      update.lifecycle_state !== undefined
        ? update.lifecycle_state
        : existing.lifecycle_state,
    // Concrete error reason (ticket 1f750878). Track the STATE's presence, not
    // its own — the wire omits detail for non-error states, so when a fresh
    // state arrives (e.g. error→online) take the update's detail (undefined =
    // clear the stale reason). Keep existing only when the whole state field is
    // absent (older server that sends neither).
    lifecycle_detail:
      update.lifecycle_state !== undefined
        ? update.lifecycle_detail
        : existing.lifecycle_detail,
    current_task: update.current_task,
    // The SSE agent_status wire now carries the full authoritative list —
    // board-ticket tasks (kind:'ticket') AND in-progress QA runs (kind:'qa'),
    // pushed live on QA start/finalize (ticket 09ed8def). So trust it wholesale:
    // QA runs appear and disappear live. When the update omits active_tasks
    // (older server that only sends current_task), keep the current list.
    active_tasks:
      update.active_tasks !== undefined
        ? update.active_tasks
        : existing.active_tasks,
  };
  return next;
}

export default function AgentsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const { user, hasPermission } = useAuth();
  const { showToast } = useToast();

  const [agents, setAgents] = useState<DashboardAgent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const canAccessAgentManager = hasPermission('admin.access');
  const navigate = useNavigate();
  const openDetail = useCallback((id: string) => {
    if (wsId) navigate(`/ws/${wsId}/agents/${id}`);
  }, [navigate, wsId]);
  // Every executable Agent is created through an explicit Runtime Host.
  const [showManagedModal, setShowManagedModal] = useState(false);
  const [managedForm, setManagedForm] = useState<typeof EMPTY_MANAGED_FORM>(EMPTY_MANAGED_FORM);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [managerInstances, setManagerInstances] = useState<AgentManagerInstance[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [runtimeProfiles, setRuntimeProfiles] = useState<ClaudeBackendProfile[]>([]);
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
      // Live lifecycle_state (ticket bfdd80b7); undefined on older servers.
      lifecycle_state: payload.lifecycle_state,
      // Concrete error reason (ticket 1f750878); present only when state='error'.
      lifecycle_detail: payload.lifecycle_detail,
      current_task: payload.current_task,
      // Forward the live active_tasks list (ticket 09ed8def) — board-ticket
      // tasks + in-progress QA runs. Previously omitted here, which froze the
      // card's task list at the REST snapshot until a full refetch.
      active_tasks: payload.active_tasks,
    };
    if (!agentsReadyRef.current) {
      pendingStatusRef.current.push(update);
      return;
    }
    setAgents((prev) => (prev ? mergeAgentStatus(prev, update) : prev));
  });

  // ─── Handlers ─────────────────────────────────────────────────
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
    api.listAgentManagerInstances()
      .then((rows) => { if (alive) setManagerInstances(rows); })
      .catch(() => { if (alive) setManagerInstances([]); });
    if (wsId) {
      api.listCredentials(wsId)
        .then((rows) => { if (alive) setCredentials(rows); })
        .catch(() => { if (alive) setCredentials([]); });
      api.getWorkspaceClaudeBackendProfiles(wsId)
        .then((data) => {
          if (!alive) return;
          const availableProfiles = data.profiles.filter(p => data.allowed_profile_ids.includes(p.id));
          setRuntimeProfiles(availableProfiles);
          // workspace 전환 뒤 생성 폼 상태가 유지돼도 이전 workspace의 profile
          // ID를 전송하지 않도록 현재 workspace의 권위 목록과 선택값을 맞춘다.
          setManagedForm(form => (
            !form.runtime_profile
              || form.runtime_profile === 'none'
              || availableProfiles.some(profile => profile.id === form.runtime_profile)
              ? form
              : { ...form, runtime_profile: '' }
          ));
        })
        .catch(() => { if (alive) setRuntimeProfiles([]); });
    } else {
      setCredentials([]);
      setRuntimeProfiles([]);
    }
    return () => { alive = false; };
  }, [showManagedModal, wsId]);

  const eligibleCredentials = useMemo(() => {
    const prefix = CLI_TO_CREDENTIAL_PREFIX[managedForm.runtime.runtime];
    if (!prefix) return [];
    return credentials.filter((c) => c.provider.startsWith(prefix));
  }, [credentials, managedForm.runtime.runtime]);

  const selectedRuntimeIds = useMemo(() => {
    if (!managedForm.manager_agent_id) return [];
    const host = managerInstances.find(
      (instance) => instance.agent_id === managedForm.manager_agent_id,
    );
    return Object.entries(host?.runtime_capabilities || {})
      .filter(([, health]) => health.installed && health.healthy)
      .map(([runtimeId]) => runtimeId);
  }, [managedForm.manager_agent_id, managerInstances]);

  // undefined([]가 아님)는 선택된 Host가 아직 hermes 프로파일을 리포트하지
  // 않았다는 뜻 — 그 경우 RuntimeConfigFields는 자유 입력으로 폴백한다.
  const selectedHermesProfiles = useMemo(() => {
    if (!managedForm.manager_agent_id) return undefined;
    const host = managerInstances.find(
      (instance) => instance.agent_id === managedForm.manager_agent_id,
    );
    return host?.runtime_capabilities?.hermes?.profiles;
  }, [managedForm.manager_agent_id, managerInstances]);

  // working_dir is optional for `custom` (the manager doesn't know how to
  // launch a custom CLI without operator-supplied scripts anyway), required
  // otherwise — same rule the admin AgentManager surfaces in its label.
  const managedWorkingDirRequired = !!managedForm.runtime.runtime;

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
        : {
            ...f,
            manager_agent_id: nextManagerId,
            working_dir: '',
            runtime: EMPTY_RUNTIME_SELECTION,
          }
    ));
    setPickerOpen(false);
  }, []);

  const handleCreateManagedAgent = useCallback(async () => {
    if (creatingManaged) return;
    if (!managedForm.name.trim()) return;
    if (!managedForm.manager_agent_id) {
      showToast('Pick a Runtime Host', 'error');
      return;
    }
    const runtimeConfig = buildRuntimeConfig(managedForm.runtime);
    if (!managedForm.runtime.runtime || !runtimeConfig) {
      showToast('Runtime, strategy, and permission mode are required', 'error');
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
      const supportsCredential = !!CLI_TO_CREDENTIAL_PREFIX[managedForm.runtime.runtime];
      const credential_id = supportsCredential && managedForm.credential_id
        ? managedForm.credential_id
        : undefined;
      // Only 'claude' agents have a backend profile concept — mirrors
      // ManagedAgentDialog's create-mode resolution (sentinel 'none' opts
      // out of board/workspace inheritance; '' / other CLIs omit the field
      // so the server falls back to inherit).
      const cli_runtime_profile = managedForm.runtime.runtime === 'claude' && managedForm.runtime_profile
        ? managedForm.runtime_profile
        : undefined;
      const body: ManagedAgentCreateBody = {
        name: managedForm.name.trim(),
        cli: managedForm.runtime.runtime,
        manager_agent_id: managedForm.manager_agent_id,
        runtime_config: runtimeConfig,
        working_dir: managedForm.working_dir.trim() || undefined,
        description: managedForm.description.trim() || undefined,
        credential_id,
        cli_runtime_profile,
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <PageHeader
        title="AI Agents"
        description="Manage workspace agents and the runtime managers that execute them"
        actions={
          user?.role === 'admin' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" size="md" onClick={() => setShowManagedModal(true)}>
                + New Agent
              </Button>
            </div>
          ) : undefined
        }
      />

      <div
        id="agent-manager-runtime"
        style={{ flex: 1, minHeight: 0, padding: 24, overflow: 'hidden' }}
      >
        <AgentManagerPage
          workspaceAgents={agents || []}
          agentsLoading={loading}
          agentsError={snapshotError}
          canManageRuntime={canAccessAgentManager}
          onRetryAgents={loadSnapshot}
          onOpenAgent={openDetail}
        />
      </div>

      {/* Agent detail surface moved to a real route in v0.32.x —
         see AgentDetailPage. AgentsPage just navigates on click. */}

      {/* Every executable Agent is created through a Runtime Host. */}
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
                !buildRuntimeConfig(managedForm.runtime) ||
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
          </div>
          <Input
            label="Description"
            value={managedForm.description}
            onChange={e => setManagedForm(f => ({ ...f, description: e.target.value }))}
            placeholder="What does this agent do?"
          />
          <div>
            <Select
              label="Runtime Host *"
              value={managedForm.manager_agent_id}
              onChange={e => handleManagerChange((e.target as HTMLSelectElement).value)}
              options={[
                { value: '', label: managers.length === 0 ? 'No Runtime Hosts paired yet' : 'Select a Runtime Host' },
                ...managers.map(m => ({ value: m.id, label: m.name })),
              ]}
            />
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
              The Runtime Host owns this Agent's execution process. Changing it clears runtime and working-directory choices.
              {managers.length === 0 && ' Pair a Runtime Host from the Runtime Host section below first.'}
            </div>
          </div>
          <RuntimeConfigFields
            value={managedForm.runtime}
            availableRuntimeIds={selectedRuntimeIds}
            hermesProfiles={selectedHermesProfiles}
            disabled={!managedForm.manager_agent_id}
            onChange={(runtime) => setManagedForm((form) => ({ ...form, runtime, credential_id: '' }))}
          />
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
          {CLI_TO_CREDENTIAL_PREFIX[managedForm.runtime.runtime] && (
            <div>
              <Select
                label="CLI credential"
                value={managedForm.credential_id}
                onChange={e => setManagedForm(f => ({ ...f, credential_id: (e.target as HTMLSelectElement).value }))}
                options={[
                  { value: '', label: credentialFallbackCopy(managedForm.runtime.runtime).optionLabel },
                  ...eligibleCredentials.map(c => ({ value: c.id, label: `${c.name} · ${c.provider}` })),
                ]}
              />
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                {credentialFallbackCopy(managedForm.runtime.runtime).meaning} Set a per-Agent credential only for isolated auth.
              </div>
            </div>
          )}
          {managedForm.runtime.runtime === 'claude' && (
            <div>
              <Select
                label="Claude backend profile"
                value={managedForm.runtime_profile}
                onChange={e => setManagedForm(f => ({ ...f, runtime_profile: (e.target as HTMLSelectElement).value }))}
                options={[
                  { value: '', label: 'Inherit board/workspace' },
                  { value: 'none', label: 'None — Anthropic default' },
                  ...runtimeProfiles.map(p => ({ value: p.id, label: p.name })),
                ]}
              />
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                Keeps the Claude CLI/tool loop and changes only its model backend. Applies on first spawn.
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

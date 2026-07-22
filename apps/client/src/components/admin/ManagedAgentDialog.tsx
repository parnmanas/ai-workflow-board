import React, { useEffect, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import type { Agent, Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { Button, Input, Modal, Select } from '../common';
import DirectoryPicker from './DirectoryPicker';
import { credentialFallbackCopy } from '../../utils/credentialFallback';

/**
 * ManagedAgentDialog — create / edit form for an agent-manager-supervised
 * agent. Extracted from `admin/AgentManagerPage.tsx` (where it was the only
 * caller) so the same surface can render from `AgentDetailModal` too.
 *
 * Why share: the AgentManager admin page and the workspace-level AgentDetail
 * page both list the same managed agents but used to expose totally
 * different Edit forms (admin: name + working_dir + description + credential
 * with CLI locked; AgentDetail: name + description + avatar_url only). The
 * mismatch was the second half of the bug reported on ticket
 * 7988c041 — same agent identity, two different edit shapes. Reusing this
 * component from both surfaces keeps them in lockstep.
 *
 * `managerInstanceId` is optional. The admin page always passes it (so
 * working_dir changes can ping the running manager via `set_working_dir`),
 * but AgentDetailModal may not have a known instance id — the dialog
 * skips the SSE notification in that case and tells the operator the cwd
 * change won't take effect until the agent is restarted.
 */

export type CliKind = 'claude' | 'deepseek' | 'codex' | 'antigravity' | 'pi' | 'custom';

export const MANAGED_CLI_OPTIONS: { value: CliKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'deepseek', label: 'DeepSeek (via Claude Code)' },
  { value: 'codex', label: 'Codex' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'pi', label: 'PI' },
  { value: 'custom', label: 'Custom' },
];

export interface ManagedAgentDialogProps {
  isOpen: boolean;
  onClose(): void;
  managerAgentId: string;
  /** Manager instance id — used to dispatch a follow-up spawn_agent SSE
   *  command (create mode) or set_working_dir (edit mode, when working_dir
   *  changed) so the running manager picks up the change live. Optional:
   *  AgentDetail callers may not have a heartbeating instance handy and
   *  just want the database row updated. */
  managerInstanceId?: string;
  defaultCli?: string;
  /** Create vs edit. In edit mode `agent` must be provided and CLI is locked. */
  mode: 'create' | 'edit';
  agent?: Agent | null;
  onSubmitted(): void;
}

export default function ManagedAgentDialog({
  isOpen,
  onClose,
  managerAgentId,
  managerInstanceId,
  defaultCli,
  mode,
  agent,
  onSubmitted,
}: ManagedAgentDialogProps) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [cli, setCli] = useState<CliKind>('claude');
  const [workingDir, setWorkingDir] = useState('');
  const [description, setDescription] = useState('');
  const [autoSpawn, setAutoSpawn] = useState(true);
  const [busy, setBusy] = useState(false);
  // ST-7 directory picker — opens a modal that browses the manager's host
  // filesystem via the existing fs reverse-RPC. Lets the user click a
  // directory instead of typing an absolute path.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Per-agent CLI credential. Only claude / codex / antigravity have adapters
  // that consume credentials; custom and pi CLIs leave this null (pi has no
  // credential concept at all — see cli-adapters/pi.ts).
  const [credentialId, setCredentialId] = useState<string>('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  // Per-agent default model + the per-CLI candidate lists the owning manager
  // reported via its heartbeat (`available_models`). The list is best-effort
  // and per-install dynamic; when a CLI has no enumeration we fall back to a
  // free-text input so the operator can still type a model id.
  const [model, setModel] = useState<string>('');
  const [availableModelsByCli, setAvailableModelsByCli] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!isOpen) return;
    setPickerOpen(false);
    setBusy(false);
    if (mode === 'edit' && agent) {
      setName(agent.name);
      setCli((MANAGED_CLI_OPTIONS.find((o) => o.value === agent.type)?.value as CliKind) || 'custom');
      setWorkingDir(agent.working_dir || '');
      setDescription(agent.description || '');
      setAutoSpawn(false);
      setCredentialId(agent.credential_id || '');
      setModel(agent.model || '');
    } else {
      setName('');
      setWorkingDir('');
      setDescription('');
      setAutoSpawn(true);
      setCredentialId('');
      setModel('');
      // Default CLI tracks the manager's primary CLI, but the operator can
      // override it (e.g., spawn an Antigravity agent under a Claude-default manager).
      const defaulted = MANAGED_CLI_OPTIONS.find((o) => o.value === defaultCli)?.value || 'claude';
      setCli(defaulted);
    }
  }, [isOpen, mode, agent, defaultCli]);

  // Load workspace-scoped credentials once per open. We keep all of them
  // and filter by the active CLI in the render path so changing CLI
  // doesn't refetch. Edit mode keeps the agent's own workspace_id over the
  // browser-level active workspace so a system admin editing a cross-
  // workspace managed agent still sees the correct credential pool.
  useEffect(() => {
    if (!isOpen) return;
    const wsId = (mode === 'edit' && agent?.workspace_id)
      ? agent.workspace_id
      : (getActiveWorkspaceId() || '');
    if (!wsId) { setCredentials([]); return; }
    let alive = true;
    api.listCredentials(wsId)
      .then((rows) => { if (alive) setCredentials(rows); })
      .catch(() => { if (alive) setCredentials([]); });
    return () => { alive = false; };
  }, [isOpen, mode, agent?.workspace_id]);

  // Pull the owning manager's reported model lists. The manager publishes one
  // `available_models` map (cliType → ids) per instance heartbeat; we locate
  // this dialog's manager by instance id (preferred) or by its agent id and
  // cache the map. Best-effort: any failure leaves the map empty and every CLI
  // falls back to the free-text model input.
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    api.listAgentManagerInstances()
      .then((instances) => {
        if (!alive) return;
        const match =
          (managerInstanceId && instances.find((i) => i.instance_id === managerInstanceId)) ||
          instances.find((i) => i.agent_id === managerAgentId) ||
          null;
        setAvailableModelsByCli(match?.available_models || {});
      })
      .catch(() => { if (alive) setAvailableModelsByCli({}); });
    return () => { alive = false; };
  }, [isOpen, managerInstanceId, managerAgentId]);

  const eligibleCredentials = credentials.filter((c) => c.provider.startsWith(`${cli}_`));
  // Candidate models for the selected CLI. When the manager reported a list we
  // render a dropdown (prepending the saved value if it's not in the list, so
  // editing never silently drops a hand-typed model); otherwise a free-text
  // input. `custom` CLIs have no adapter, so no model concept.
  const modelCandidates = availableModelsByCli[cli] || [];
  const hasModelList = modelCandidates.length > 0;
  const modelSelectOptions = [
    { value: '', label: 'Default — let the CLI decide (no --model)' },
    ...modelCandidates.map((m) => ({ value: m, label: m })),
    ...(model && !modelCandidates.includes(model) ? [{ value: model, label: `${model} (custom)` }] : []),
  ];

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Name is required', 'error');
      return;
    }
    const trimmedWorkingDir = workingDir.trim();
    if (mode === 'create' && autoSpawn && !trimmedWorkingDir) {
      showToast('Working directory is required when "Spawn after create" is on', 'error');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'edit') {
        if (!agent) throw new Error('edit mode without agent');
        // CLI (`type`) is editable here. Changing it repoints the agent to a
        // different underlying binary; the DB row updates immediately, but a
        // running agent keeps its current CLI until the operator restarts it
        // (restart_agent re-fetches `type` from AWB and re-provisions the
        // per-agent cli-home + adapter from the new CLI). Same
        // take-effect-on-restart contract as `model` below.
        // Per-agent credential is only meaningful when an adapter consumes it
        // (claude / codex / antigravity); for `custom` we always send null so a
        // stale id doesn't linger after the operator switched CLI. `pi` has no
        // credential concept AWB manages at all (see cli-adapters/pi.ts), so it
        // is excluded the same way. Switching CLI also clears the credential
        // selection (see the CLI onChange) so we never persist a credential
        // whose provider prefix mismatches the new CLI — the manager validates
        // `${cli}_…` and would reject it, silently falling back to
        // operator-HOME auth.
        const supportsCredential = cli !== 'custom' && cli !== 'pi';
        await api.updateAgent(agent.id, {
          name: trimmedName,
          description,
          type: cli,
          working_dir: trimmedWorkingDir,
          credential_id: supportsCredential && credentialId ? credentialId : null,
          // null clears (CLI default); custom CLIs have no model concept.
          model: cli !== 'custom' && model.trim() ? model.trim() : null,
        });
        showToast(`Agent "${trimmedName}" updated`, 'success');

        // CLI change only lands in the DB above; the running agent must be
        // restarted to actually switch binaries. Surface this like the
        // working_dir hint below so the operator isn't surprised the agent
        // keeps using the old CLI until restart_agent.
        const cliChanged = (agent.type || '') !== cli;
        if (cliChanged) {
          showToast(
            `CLI changed to "${cli}" — restart the agent (restart_agent) to run under the new CLI.`,
            'success',
          );
        }

        // Working_dir change on a running agent: ping the manager so its
        // in-memory registry reflects the new cwd immediately. Without this
        // the manager keeps using the old cwd until the next spawn cycle.
        // Skip when the caller didn't supply a managerInstanceId — only the
        // admin AgentManager page knows the live instance to ping; from the
        // workspace AgentDetail surface we just save and let the manager
        // pick it up on the next restart.
        const wdChanged = (agent.working_dir || '') !== trimmedWorkingDir;
        if (wdChanged && trimmedWorkingDir && managerInstanceId) {
          try {
            const resp = await api.sendAgentManagerCommand(managerInstanceId, {
              command: 'set_working_dir',
              args: { agent_id: agent.id, working_dir: trimmedWorkingDir },
            });
            showToast(
              `set_working_dir dispatched (id=${resp.command_id.slice(0, 8)}) — restart agent to pick up new cwd`,
              'success',
            );
          } catch (err: any) {
            showToast(
              `Saved, but failed to notify manager: ${err?.message || err}`,
              'error',
            );
          }
        } else if (wdChanged && trimmedWorkingDir && !managerInstanceId) {
          showToast(
            'Working directory saved — restart the agent on its manager to pick up the new cwd.',
            'success',
          );
        }
      } else {
        // Create flow.
        const supportsCredential = cli !== 'custom' && cli !== 'pi';
        const created = await api.createManagedAgent({
          name: trimmedName,
          cli,
          working_dir: trimmedWorkingDir || undefined,
          manager_agent_id: managerAgentId,
          description: description.trim() || undefined,
          credential_id: supportsCredential && credentialId ? credentialId : undefined,
          model: cli !== 'custom' && model.trim() ? model.trim() : undefined,
        });
        showToast(`Agent "${trimmedName}" created`, 'success');

        // One-click spawn — dispatch spawn_agent on the owning manager so it
        // provisions the apiKey, writes per-agent mcp-config, and starts
        // routing matching SSE events to the new agent's identity. Only
        // attempted when the caller supplied a manager instance id.
        if (autoSpawn && created?.id && managerInstanceId) {
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
      }

      onSubmitted();
    } catch (err: any) {
      showToast(
        `${mode === 'edit' ? 'Update' : 'Create'} failed: ${err?.message || err}`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const isEdit = mode === 'edit';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? 'Edit managed agent' : 'Create managed agent'}
      maxWidth={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {isEdit ? 'Save' : 'Create'}
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
            options={MANAGED_CLI_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setCli(e.target.value as any);
              // Model candidates AND the per-agent credential are per-CLI: a
              // value valid for the old CLI is meaningless (and, for the
              // credential, actively rejected by the manager's `${cli}_…`
              // provider check) under the new one, so clear both on switch.
              setModel('');
              setCredentialId('');
            }}
          />
          {isEdit && (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
              Changing the CLI updates the agent identity now, but a running agent keeps its current CLI until you restart it (restart_agent) — the manager re-provisions the cli-home and adapter from the new CLI on restart. Pick a matching credential above if the new CLI needs one.
            </div>
          )}
        </div>
        {cli !== 'custom' && cli !== 'pi' && (
          <div>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              CLI credential
            </label>
            <Select
              value={credentialId}
              options={[
                { value: '', label: credentialFallbackCopy(cli).optionLabel },
                ...eligibleCredentials.map((c) => ({ value: c.id, label: `${c.name} · ${c.provider}${c.scope === 'global' ? ' · Global' : ''}` })),
              ]}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCredentialId(e.target.value)}
            />
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
              {credentialFallbackCopy(cli).meaning} Set a per-agent credential only for isolated auth — subscription credentials drop the OAuth file into this agent's cli-home; API-key credentials export the matching env var on every spawn. Add or rotate values in the Credentials page.
            </div>
          </div>
        )}
        {cli !== 'custom' && (
          <div>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              Default model
            </label>
            {hasModelList ? (
              <Select
                value={model}
                options={modelSelectOptions}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
              />
            ) : (
              <Input
                type="text"
                value={model}
                placeholder="e.g. opus, claude-opus-4-8 (blank = CLI default)"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
              />
            )}
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
              {hasModelList
                ? 'Candidates are read live from the CLI installed on the manager host. The list reflects what that CLI build accepts — not necessarily what this account can access.'
                : 'This manager reported no model list for this CLI — type a model id the CLI accepts, or leave blank for its default.'}
              {' '}A running agent must be restarted (restart_agent) to pick up a model change.
            </div>
          </div>
        )}
        <div>
          <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
            Working directory
          </label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <div style={{ flex: 1 }}>
              <Input
                type="text"
                value={workingDir}
                placeholder="/abs/path/on/manager/host (or click Browse)"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWorkingDir(e.target.value)}
              />
            </div>
            <Button
              variant="ghost"
              onClick={() => setPickerOpen(true)}
              title="Browse the manager host's filesystem via SSE reverse-RPC"
            >
              📁 Browse…
            </Button>
          </div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
            {isEdit
              ? managerInstanceId
                ? 'Changing this dispatches set_working_dir to the manager — restart the agent to pick up the new cwd.'
                : 'Changing this updates the database; restart the agent on its manager to pick up the new cwd.'
              : 'Leave blank to set later via the agent row\'s set_working_dir action.'}
          </div>
        </div>
        <DirectoryPicker
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          managerAgentId={managerAgentId}
          initialPath={workingDir.trim() || undefined}
          onPick={(picked) => {
            setWorkingDir(picked);
          }}
        />
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
        {!isEdit && (
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
        )}
      </div>
    </Modal>
  );
}

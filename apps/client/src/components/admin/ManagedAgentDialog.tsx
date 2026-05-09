import React, { useEffect, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import type { Agent, Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { Button, Input, Modal, Select } from '../common';
import DirectoryPicker from './DirectoryPicker';

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

export type CliKind = 'claude' | 'codex' | 'gemini' | 'custom';

export const MANAGED_CLI_OPTIONS: { value: CliKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
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
  // Per-agent CLI credential. Only claude / codex / gemini have adapters
  // that consume credentials; custom CLIs leave this null.
  const [credentialId, setCredentialId] = useState<string>('');
  const [credentials, setCredentials] = useState<Credential[]>([]);

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
    } else {
      setName('');
      setWorkingDir('');
      setDescription('');
      setAutoSpawn(true);
      setCredentialId('');
      // Default CLI tracks the manager's primary CLI, but the operator can
      // override it (e.g., spawn a Gemini agent under a Claude-default manager).
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

  const eligibleCredentials = credentials.filter((c) => c.provider.startsWith(`${cli}_`));

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
        // Only send fields the user can actually change here. CLI (`type`)
        // is intentionally locked — changing the underlying binary on a
        // live agent identity would invalidate its on-disk per-agent CLI
        // home dir and confuse routing, so it stays a create-time decision.
        // Per-agent credential is only meaningful when an adapter consumes it
        // (claude / codex / gemini); for `custom` we always send null so a
        // stale id doesn't linger after the operator switched CLI.
        const supportsCredential = cli !== 'custom';
        await api.updateAgent(agent.id, {
          name: trimmedName,
          description,
          working_dir: trimmedWorkingDir,
          credential_id: supportsCredential && credentialId ? credentialId : null,
        });
        showToast(`Agent "${trimmedName}" updated`, 'success');

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
        const supportsCredential = cli !== 'custom';
        const created = await api.createManagedAgent({
          name: trimmedName,
          cli,
          working_dir: trimmedWorkingDir || undefined,
          manager_agent_id: managerAgentId,
          description: description.trim() || undefined,
          credential_id: supportsCredential && credentialId ? credentialId : undefined,
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
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCli(e.target.value as any)}
            disabled={isEdit}
          />
          {isEdit && (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
              CLI is fixed once the agent identity is created — make a new agent if you need a different CLI.
            </div>
          )}
        </div>
        {cli !== 'custom' && (
          <div>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              CLI credential
            </label>
            <Select
              value={credentialId}
              options={[
                { value: '', label: 'None — fall back to operator HOME' },
                ...eligibleCredentials.map((c) => ({ value: c.id, label: `${c.name} · ${c.provider}` })),
              ]}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCredentialId(e.target.value)}
            />
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
              Subscription credentials drop the OAuth file into this agent's cli-home; API-key credentials export the matching env var on every spawn. Add or rotate values in the Credentials page.
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

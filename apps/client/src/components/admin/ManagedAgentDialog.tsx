import React, { useEffect, useRef, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import type { Agent, ClaudeBackendProfile, Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { Button, Input, Modal, Select } from '../common';
import DirectoryPicker from './DirectoryPicker';
// ticket 40110b64 — Runtime Hosts 화면과 같은 모델 리프레시 흐름.
import { summarizeHostModels, useHostModels } from '../../cli/hostModels';
import { credentialFallbackCopy } from '../../utils/credentialFallback';
import {
  reconcileRuntimeProfileSelection,
  runtimeProfileForAgentUpdate,
  runtimeProfileForManagedAgentCreate,
  runtimeProfileSelectionReady,
  type RuntimeProfileLoadState,
} from '../../utils/claudeRuntimeProfile';
import RuntimeConfigFields, {
  buildRuntimeConfig,
  EMPTY_RUNTIME_SELECTION,
  runtimeOptions,
  runtimeSelectionFromAgent,
  type RuntimeSelection,
} from './RuntimeConfigFields';
import {
  cliCredentialPrefix,
  cliModelSelectable,
  cliRuntimeConfig,
  cliSupportsBackendProfile,
  cliSupportsCredential,
  useCliCatalog,
} from '../../cli/catalog';

/**
 * ManagedAgentDialog — create / edit form for an agent-manager-supervised
 * agent. Extracted from `admin/AgentManagerPage.tsx` (where it was the only
 * caller) so the same surface can render from `AgentDetailModal` too.
 *
 * Why share: the Agent Manager Runtime section and workspace-level AgentDetail
 * page both list the same managed agents but used to expose totally
 * different Edit forms (admin: name + working_dir + description + credential
 * with CLI locked; AgentDetail: name + description + avatar_url only). The
 * mismatch was the second half of the bug reported on ticket
 * 7988c041 — same agent identity, two different edit shapes. Reusing this
 * component from both surfaces keeps them in lockstep.
 *
 * `managerInstanceId` is optional. The runtime section always passes it (so
 * working_dir changes can ping the running manager via `set_working_dir`),
 * but AgentDetailModal may not have a known instance id — the dialog
 * skips the SSE notification in that case and tells the operator the cwd
 * change won't take effect until the agent is restarted.
 */

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
  mode,
  agent,
  onSubmitted,
}: ManagedAgentDialogProps) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection>(EMPTY_RUNTIME_SELECTION);
  const cli = runtimeSelection.runtime;
  const [workingDir, setWorkingDir] = useState('');
  const [description, setDescription] = useState('');
  const [autoSpawn, setAutoSpawn] = useState(true);
  const [busy, setBusy] = useState(false);
  // ST-7 directory picker — opens a modal that browses the manager's host
  // filesystem via the existing fs reverse-RPC. Lets the user click a
  // directory instead of typing an absolute path.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Per-agent CLI credential. claude / codex / antigravity / deepseek / opencode
  // have adapters that consume one; custom, pi and hermes leave this null
  // (pi has no credential concept at all — see cli-adapters/pi.ts).
  const [credentialId, setCredentialId] = useState<string>('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const catalog = useCliCatalog();
  // Per-agent default model + the per-CLI candidate lists the owning manager
  // reported via its heartbeat (`available_models`). The list is best-effort
  // and per-install dynamic; when a CLI has no enumeration we fall back to a
  // free-text input so the operator can still type a model id.
  const [model, setModel] = useState<string>('');
  const [runtimeProfile, setRuntimeProfile] = useState<string>('');
  const [runtimeProfiles, setRuntimeProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [runtimeProfilesState, setRuntimeProfilesState] = useState<RuntimeProfileLoadState>('idle');
  const [runtimeProfilesReloadKey, setRuntimeProfilesReloadKey] = useState(0);
  // 모델 목록은 모든 화면이 공유하는 스토어에서 온다(src/cli/hostModels.ts). 훅이 열릴 때
  // 오래된/빈 목록을 스스로 재열거하고, 아래 버튼은 같은 refresh() 를 부른다.
  const hostModels = useHostModels(isOpen ? managerAgentId : null, cli);
  const refreshingModels = hostModels.refreshing;
  const [availableRuntimeIds, setAvailableRuntimeIds] = useState<string[]>([]);
  // 이 manager의 마지막 heartbeat가 보고한 런타임별 named profile 목록
  // (`runtime_capabilities[<cli>].profiles`). 선택된 CLI 의 목록은 아래
  // `namedProfiles` 로 파생한다(카탈로그가 `runtime_config.profiles` 를 켠 CLI 만).
  // `undefined`(`[]`이 아님)는 "Host가 아직 이 값을 리포트하지 않음"을 뜻하며,
  // RuntimeConfigFields가 빈 드롭다운 대신 자유 입력으로 폴백할 수 있도록
  // 의도적으로 구분한다.
  const [profilesByCli, setProfilesByCli] = useState<Record<string, string[] | undefined>>({});
  // ticket 5851e435 — 런타임별 권한 등급 표현력. approve 선택 시 경고를 띄운다.
  const [permissionTiers, setPermissionTiers] = useState<
    Record<string, Record<'strict' | 'approve' | 'trusted', string> | undefined> | undefined
  >(undefined);

  useEffect(() => {
    if (!isOpen) return;
    setPickerOpen(false);
    setBusy(false);
    if (mode === 'edit' && agent) {
      setName(agent.name);
      setRuntimeSelection(runtimeSelectionFromAgent(agent.type, agent.runtime_config));
      setWorkingDir(agent.working_dir || '');
      setDescription(agent.description || '');
      setAutoSpawn(false);
      setCredentialId(agent.credential_id || '');
      setModel(agent.model || '');
      setRuntimeProfile(agent.cli_runtime_profile || '');
    } else {
      setName('');
      setWorkingDir('');
      setDescription('');
      setAutoSpawn(true);
      setCredentialId('');
      setModel('');
      setRuntimeProfile('');
      setRuntimeSelection(EMPTY_RUNTIME_SELECTION);
    }
  }, [isOpen, mode, agent]);

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
    setRuntimeProfilesState('loading');
    if (!wsId) {
      setCredentials([]);
      setRuntimeProfiles([]);
      setRuntimeProfilesState('error');
      return;
    }
    let alive = true;
    api.listCredentials(wsId)
      .then((rows) => { if (alive) setCredentials(rows); })
      .catch(() => { if (alive) setCredentials([]); });
    api.listClaudeBackendProfiles().then(data => {
      if (!alive) return;
      const profiles = data.profiles;
      setRuntimeProfiles(profiles);
      setRuntimeProfile((selected) => reconcileRuntimeProfileSelection(selected, profiles));
      setRuntimeProfilesState('ready');
    }).catch(() => {
      if (!alive) return;
      setRuntimeProfiles([]);
      setRuntimeProfilesState('error');
    });
    return () => { alive = false; };
  }, [isOpen, mode, agent?.workspace_id, runtimeProfilesReloadKey]);

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
        setAvailableRuntimeIds(
          Object.entries(match?.runtime_capabilities || {})
            .filter(([, health]) => health.installed && health.healthy)
            .map(([runtimeId]) => runtimeId),
        );
        setProfilesByCli(
          Object.fromEntries(
            Object.entries(match?.runtime_capabilities || {}).map(
              ([runtimeId, health]) => [runtimeId, health.profiles],
            ),
          ),
        );
        setPermissionTiers(
          match?.runtime_capabilities
            ? Object.fromEntries(
                Object.entries(match.runtime_capabilities).map(
                  ([runtimeId, health]) => [runtimeId, health.capabilities?.permission_tiers],
                ),
              )
            : undefined,
        );
      })
      .catch(() => {
        if (alive) {
          setAvailableRuntimeIds([]);
          setProfilesByCli({});
          setPermissionTiers(undefined);
        }
      });
    return () => { alive = false; };
  }, [isOpen, managerInstanceId, managerAgentId]);

  // 명시적 새로고침 — 서버가 호스트에 재열거를 시키고 ack 까지 기다린 뒤 새 목록을
  // 돌려준다(폴링 없음). 조용한 자동 갱신은 훅이 한다.
  const handleRefreshModels = async () => {
    if (refreshingModels) return;
    const fresh = await hostModels.refresh();
    if (!fresh) {
      showToast(`모델 목록 갱신 실패 — ${hostModels.error || '사유 미상'}`, 'error');
      return;
    }
    const summary = summarizeHostModels(fresh);
    showToast(`모델 목록 갱신 완료${summary ? ` — ${summary}` : ''}`, 'success');
  };

  // Credential providers are prefixed by CLI (a catalog fact); CLIs with no
  // credential concept get an empty list (and no picker — see below).
  const credentialPrefix = cliCredentialPrefix(cli);
  const eligibleCredentials = credentialPrefix
    ? credentials.filter((c) => c.provider.startsWith(credentialPrefix))
    : [];
  // Named profiles reported by the Host for the selected CLI — only CLIs
  // whose catalog descriptor enables `runtime_config.profiles` render them.
  const namedProfiles = cliRuntimeConfig(cli).profiles ? profilesByCli[cli] : undefined;
  // Candidate models for the selected CLI. When the manager reported a list we
  // render a dropdown (prepending the saved value if it's not in the list, so
  // editing never silently drops a hand-typed model); otherwise a free-text
  // input. `custom` CLIs have no adapter, so no model concept.
  const modelCandidates = hostModels.models;
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
    const runtimeConfig = buildRuntimeConfig(runtimeSelection);
    if (!cli || !runtimeConfig) {
      showToast('Runtime, strategy, and permission mode are required', 'error');
      return;
    }
    const trimmedWorkingDir = workingDir.trim();
    if (mode === 'create' && autoSpawn && !trimmedWorkingDir) {
      showToast('Working directory is required when "Spawn after create" is on', 'error');
      return;
    }
    if (!runtimeProfileSelectionReady(cli, runtimeProfilesState)) {
      showToast('Claude 프로필 목록을 확인할 수 없습니다. 다시 시도한 뒤 저장해 주세요.', 'error');
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
        // (claude / codex / antigravity / deepseek / opencode); for `custom` we
        // always send null so a stale id doesn't linger after the operator
        // switched CLI. `pi` has no credential concept AWB manages at all (see
        // cli-adapters/pi.ts), so it is excluded the same way. Switching CLI also clears the credential
        // selection (see the CLI onChange) so we never persist a credential
        // whose provider prefix mismatches the new CLI — the manager validates
        // `${cli}_…` and would reject it, silently falling back to
        // operator-HOME auth.
        const supportsCredential = cliSupportsCredential(cli);
        await api.updateAgent(agent.id, {
          name: trimmedName,
          description,
          type: cli,
          runtime_config: runtimeConfig,
          working_dir: trimmedWorkingDir,
          credential_id: supportsCredential && credentialId ? credentialId : null,
          // null clears (CLI default); CLIs without a model concept
          // (`model_selectable: false`) always send null.
          model: cliModelSelectable(cli) && model.trim() ? model.trim() : null,
          cli_runtime_profile: runtimeProfileForAgentUpdate(
            cli, runtimeProfile, runtimeProfiles, runtimeProfilesState,
          ),
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
        const supportsCredential = cliSupportsCredential(cli);
        const created = await api.createManagedAgent({
          name: trimmedName,
          cli,
          working_dir: trimmedWorkingDir || undefined,
          manager_agent_id: managerAgentId,
          runtime_config: runtimeConfig,
          description: description.trim() || undefined,
          credential_id: supportsCredential && credentialId ? credentialId : undefined,
          model: cliModelSelectable(cli) && model.trim() ? model.trim() : undefined,
          cli_runtime_profile: runtimeProfileForManagedAgentCreate(
            cli, runtimeProfile, runtimeProfiles, runtimeProfilesState,
          ),
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
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || !runtimeProfileSelectionReady(cli, runtimeProfilesState)}
          >
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
            Runtime *
          </label>
          <Select
            value={runtimeSelection.runtime}
            options={[
              { value: '', label: availableRuntimeIds.length ? 'Select a runtime' : 'No healthy runtime reported by this Host' },
              ...runtimeOptions(catalog).filter((option) => availableRuntimeIds.includes(option.value)),
            ]}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setRuntimeSelection({
                ...EMPTY_RUNTIME_SELECTION,
                runtime: e.target.value,
              });
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
        <RuntimeConfigFields
          value={runtimeSelection}
          availableRuntimeIds={availableRuntimeIds}
          namedProfiles={namedProfiles}
          permissionTiers={permissionTiers}
          showRuntime={false}
          onChange={setRuntimeSelection}
        />
        {cli && cliSupportsCredential(cli) && (
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
        {cli && cliModelSelectable(cli) && (
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
            {managerAgentId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <Button variant="ghost" onClick={() => void handleRefreshModels()} disabled={refreshingModels || busy}>
                  {refreshingModels ? '모델 갱신 중…' : '모델 목록 새로고침'}
                </Button>
                <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                  호스트에서 CLI 를 업그레이드했다면 눌러서 다시 열거하세요. 매니저는 재시작되지 않습니다.
                </span>
              </div>
            )}
          </div>
        )}
        {cliSupportsBackendProfile(cli) && (
          <div>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              Claude backend profile
            </label>
            <Select disabled={runtimeProfilesState !== 'ready'} value={runtimeProfile} options={[
              { value: '', label: 'Inherit board / global default' },
              { value: 'none', label: 'None — Anthropic default' },
              ...runtimeProfiles.map(profile => ({ value: profile.id, label: profile.name })),
            ]} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRuntimeProfile(e.target.value)} />
            {runtimeProfilesState === 'error' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 11, color: tokens.colors.danger }}>
                  프로필 목록을 불러오지 못했습니다. 기존 선택은 유지되며, 목록 확인 전에는 저장할 수 없습니다.
                </span>
                <Button
                  variant="ghost"
                  onClick={() => setRuntimeProfilesReloadKey((key) => key + 1)}
                  disabled={busy}
                >
                  다시 시도
                </Button>
              </div>
            )}
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
              Keeps the Claude CLI/tool loop and changes only its model backend.
              {isEdit ? ' Applies after restart.' : ' Applies on first spawn.'}
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

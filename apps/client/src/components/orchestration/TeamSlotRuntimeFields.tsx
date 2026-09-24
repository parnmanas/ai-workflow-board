import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type {
  ClaudeBackendProfile,
  Credential,
  OrchestrationFolderScope,
  OrchestrationRuntimeHost,
  OrchestrationSlotRuntime,
  OrchestrationSlotSpecInput,
} from '../../types';
import { Button, Input, Select } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';
import RuntimeConfigFields, {
  EMPTY_RUNTIME_SELECTION,
  buildRuntimeConfig,
  runtimeSelectionFromAgent,
  type RuntimeSelection,
} from '../admin/RuntimeConfigFields';
import { credentialFallbackCopy } from '../../utils/credentialFallback';

/**
 * The editor for one Orchestration team slot's runtime: Runtime Host, CLI,
 * model, working folder, folder scope.
 *
 * This form IS the team roster now. There is no agent picker any more — you
 * describe a worker (which machine, which CLI, which model, which folder) and
 * AWB provisions the identity behind it. One component serves both slots
 * (orchestrator and member) so the two can never drift apart, which is what
 * happened the last time the same concept had two forms.
 *
 * Reuses the admin agent dialog's `RuntimeConfigFields` (CLI + execution
 * strategy + permission tier) and `DirectoryPicker` (browse the host's
 * filesystem over the existing fs reverse-RPC) rather than restating them, so a
 * new CLI or permission tier lands in both places at once.
 */

export interface SlotDraft {
  manager_agent_id: string;
  /** CLI + execution strategy + permission tier, in RuntimeConfigFields' shape. */
  runtime: RuntimeSelection;
  model: string;
  working_dir: string;
  folder_scope: OrchestrationFolderScope;
  credential_id: string;
  cli_runtime_profile: string;
}

export function emptySlotDraft(): SlotDraft {
  return {
    manager_agent_id: '',
    runtime: EMPTY_RUNTIME_SELECTION,
    model: '',
    working_dir: '',
    // Shared is the default because sharing a folder is the point: a team spread
    // over several machines still wants co-located members to collaborate in one
    // tree. Isolation is the opt-in for missions that fan out conflicting builds.
    folder_scope: 'shared',
    credential_id: '',
    cli_runtime_profile: '',
  };
}

/** Load an existing slot's stored runtime into the form. */
export function slotDraftFromRuntime(rt: OrchestrationSlotRuntime | null): SlotDraft {
  if (!rt) return emptySlotDraft();
  return {
    manager_agent_id: rt.manager_agent_id,
    runtime: runtimeSelectionFromAgent(rt.cli, (rt.runtime_config as any) ?? null),
    model: rt.model ?? '',
    working_dir: rt.working_dir,
    folder_scope: rt.folder_scope,
    credential_id: rt.credential_id ?? '',
    cli_runtime_profile: rt.cli_runtime_profile ?? '',
  };
}

/**
 * What the form is still missing, as a sentence to show the operator — or null
 * when it is submittable. Returned rather than thrown so the caller can disable
 * its submit button and explain why in the same place.
 */
export function slotDraftProblem(draft: SlotDraft): string | null {
  if (!draft.manager_agent_id) return 'Pick a Runtime Host — the machine this member runs on.';
  if (!draft.runtime.runtime) return 'Pick a CLI.';
  if (!draft.runtime.strategy || !draft.runtime.permissionMode) {
    return 'Pick an execution strategy and a permission tier.';
  }
  if (!draft.working_dir.trim()) return 'Pick a working folder on that host.';
  if (!isAbsolutePath(draft.working_dir.trim())) {
    return 'The working folder must be an absolute path on the host (e.g. /home/you/repo or C:\\repo).';
  }
  return null;
}

export function slotDraftToSpec(draft: SlotDraft): OrchestrationSlotSpecInput {
  return {
    manager_agent_id: draft.manager_agent_id,
    cli: draft.runtime.runtime as string,
    model: draft.model.trim() || null,
    working_dir: draft.working_dir.trim(),
    folder_scope: draft.folder_scope,
    credential_id: draft.credential_id || null,
    cli_runtime_profile: draft.cli_runtime_profile || null,
    runtime_config: buildRuntimeConfig(draft.runtime),
  };
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Another slot on the same team, for the "you'd be sharing with…" hint. */
export interface SlotNeighbour {
  label: string;
  manager_agent_id: string;
  working_dir: string;
  folder_scope: OrchestrationFolderScope;
}

export default function TeamSlotRuntimeFields({
  value,
  onChange,
  hosts,
  credentials,
  backendProfiles,
  neighbours = [],
  onHostRefreshed,
  workspaceId,
  disabled = false,
}: {
  workspaceId: string;
  value: SlotDraft;
  onChange(next: SlotDraft): void;
  hosts: OrchestrationRuntimeHost[];
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  /** Other slots on this team — drives the shared-folder hint and the folder suggestions. */
  neighbours?: SlotNeighbour[];
  /**
   * Replace one host row after it re-listed its models. Required for the model
   * dropdown to fill itself in: a host enumerates models once at boot by
   * shelling out to each CLI with a short timeout, so a cold CLI (opencode is
   * the one that surfaced this) reports nothing and this form would otherwise
   * offer free text for it forever.
   */
  onHostRefreshed?(host: OrchestrationRuntimeHost): void;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customFolder, setCustomFolder] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelProbeNote, setModelProbeNote] = useState<string | null>(null);

  const host = hosts.find((h) => h.manager_agent_id === value.manager_agent_id) ?? null;
  const cli = value.runtime.runtime || '';

  const patch = (next: Partial<SlotDraft>) => onChange({ ...value, ...next });

  /**
   * Folder suggestions for the picked host: folders already used on it, plus the
   * folders this team's other slots on the SAME host chose. The second source is
   * what makes "share a folder with a teammate" a one-click choice even when the
   * teammate's slot was created seconds ago and no agent has spawned in it yet.
   */
  const folderOptions = useMemo(() => {
    if (!host) return [] as Array<{ path: string; note: string }>;
    const mates = new Map<string, string[]>();
    for (const n of neighbours) {
      if (n.manager_agent_id !== host.manager_agent_id || !n.working_dir) continue;
      const list = mates.get(n.working_dir) ?? [];
      list.push(n.label);
      mates.set(n.working_dir, list);
    }
    const paths = new Set<string>([...host.working_dirs, ...mates.keys()]);
    return Array.from(paths)
      .sort()
      .map((path) => ({
        path,
        note: mates.has(path) ? `shared with ${mates.get(path)!.join(', ')}` : 'used on this host',
      }));
  }, [host, neighbours]);

  const folderMates = useMemo(() => {
    const dir = value.working_dir.trim();
    if (!dir || !value.manager_agent_id) return [] as string[];
    return neighbours
      .filter((n) => n.manager_agent_id === value.manager_agent_id && n.working_dir === dir)
      .map((n) => n.label);
  }, [neighbours, value.manager_agent_id, value.working_dir]);

  const modelOptions = host && cli ? host.available_models[cli] ?? [] : [];

  /**
   * Ask the host to re-list its models. Shared by the automatic probe below and
   * the explicit button, so both report the same way.
   */
  const refreshModels = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!host || !onHostRefreshed || refreshingModels) return;
      setRefreshingModels(true);
      if (!opts.silent) setModelProbeNote('Asking the host to list its models…');
      try {
        const fresh = await api.refreshOrchestrationRuntimeHostModels(host.manager_agent_id, workspaceId);
        onHostRefreshed(fresh);
        const found = cli ? (fresh.available_models[cli] ?? []).length : 0;
        setModelProbeNote(
          found > 0
            ? null
            : `${host.manager_name} reported no model list for ${cli || 'this CLI'} — type a model id, or leave it blank for the CLI default.`,
        );
      } catch (e: any) {
        // Never block authoring on this: the free-text input below still works.
        setModelProbeNote(opts.silent ? null : e?.message || 'Could not refresh the model list.');
      } finally {
        setRefreshingModels(false);
      }
    },
    [host, onHostRefreshed, refreshingModels, cli, workspaceId],
  );

  /**
   * Probe once per (host, CLI) when the list is empty. Same contract as the admin
   * agent dialog's probe: silent, and at most one attempt per combination so a
   * CLI that genuinely has no model concept (antigravity, pi) does not hammer the
   * host on every render — falling back to free text is the right answer there.
   */
  const probed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!host || !cli || !onHostRefreshed) return;
    if (modelOptions.length > 0) return;
    if (!host.is_online) return; // an offline host cannot re-list anything
    const key = `${host.manager_agent_id}:${cli}`;
    if (probed.current.has(key)) return;
    probed.current.add(key);
    void refreshModels({ silent: true });
    // refreshModels is re-created per render; depending on it would re-run this
    // before the attempted-set can block the duplicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, cli, modelOptions.length, onHostRefreshed]);

  /**
   * Options for the dropdown, with the saved value prepended when the host does
   * not list it. Without that, editing a slot whose model was typed by hand (or
   * enumerated by an older host build) would render as "Default" — telling the
   * operator the model is unset while the slot still carries it.
   */
  const modelSelectOptions = [
    { value: '', label: `Default — let ${cli || 'the CLI'} decide (no --model)` },
    ...modelOptions.map((m) => ({ value: m, label: m })),
    ...(value.model && !modelOptions.includes(value.model)
      ? [{ value: value.model, label: `${value.model} (not listed by this host)` }]
      : []),
  ];
  // Credential providers are prefixed by CLI (`claude_subscription`,
  // `codex_api_key`, …) — same filter the admin agent dialog uses.
  const eligibleCredentials = cli ? credentials.filter((c) => c.provider.startsWith(`${cli}_`)) : [];
  const showBackendProfile = cli === 'claude' && backendProfiles.length > 0;

  return (
    <>
      <Select
        label="Runtime Host *"
        value={value.manager_agent_id}
        disabled={disabled}
        options={[
          { value: '', label: hosts.length ? 'Select a machine' : 'No Runtime Hosts paired yet' },
          ...hosts.map((h) => ({
            value: h.manager_agent_id,
            label: `${h.manager_name}${h.hostname ? ` (${h.hostname})` : ''}${h.is_online ? '' : ' — offline'}`,
          })),
        ]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          // Host change invalidates everything host-specific. Clearing rather
          // than keeping the old values is the honest move: a model id, a
          // credential and a path from machine A are all meaningless on B, and
          // silently carrying them over is how a slot ends up pointing at a
          // folder that does not exist there.
          patch({
            manager_agent_id: e.target.value,
            model: '',
            working_dir: '',
            credential_id: '',
          });
          setCustomFolder(false);
        }}
      />
      {host && !host.is_online && (
        <Hint tone="warning">
          This host is offline. You can still author the slot — work queues and the agent starts automatically
          when the host reconnects — but the CLI, model and folder lists below only show what AWB already knows
          about it.
        </Hint>
      )}

      <RuntimeConfigFields
        value={value.runtime}
        disabled={disabled || !value.manager_agent_id}
        availableRuntimeIds={host?.clis}
        onChange={(runtime) => {
          // A CLI change invalidates the model and credential for the same
          // reason a host change does.
          const cliChanged = runtime.runtime !== value.runtime.runtime;
          patch({
            runtime,
            ...(cliChanged ? { model: '', credential_id: '' } : {}),
          });
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {modelOptions.length > 0 || (value.model && modelSelectOptions.length > 1) ? (
            <Select
              label="Model"
              value={value.model}
              disabled={disabled || !cli}
              options={modelSelectOptions}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patch({ model: e.target.value })}
            />
          ) : (
            <Input
              label="Model"
              value={value.model}
              disabled={disabled || !cli}
              placeholder={
                refreshingModels
                  ? 'Asking the host for its model list…'
                  : cli
                    ? `Leave blank for the ${cli} default`
                    : 'Pick a CLI first'
              }
              onChange={(e) => patch({ model: e.target.value })}
            />
          )}
        </div>
        {host && cli && onHostRefreshed && (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || refreshingModels || !host.is_online}
            title={host.is_online ? 'Make this host re-list its models' : 'Host is offline'}
            onClick={() => void refreshModels()}
          >
            {refreshingModels ? 'Listing…' : 'Refresh'}
          </Button>
        )}
      </div>
      {modelProbeNote && <Hint>{modelProbeNote}</Hint>}

      {/* ── Working folder ─────────────────────────────────────────────── */}
      {folderOptions.length > 0 && !customFolder ? (
        <Select
          label="Working folder *"
          value={folderOptions.some((f) => f.path === value.working_dir) ? value.working_dir : ''}
          disabled={disabled || !value.manager_agent_id}
          options={[
            { value: '', label: 'Select a folder on this host' },
            ...folderOptions.map((f) => ({ value: f.path, label: `${f.path} — ${f.note}` })),
            { value: '__custom__', label: 'Another folder…' },
          ]}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            if (e.target.value === '__custom__') {
              setCustomFolder(true);
              patch({ working_dir: '' });
              return;
            }
            patch({ working_dir: e.target.value });
          }}
        />
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input
              label="Working folder *"
              value={value.working_dir}
              disabled={disabled || !value.manager_agent_id}
              placeholder={value.manager_agent_id ? '/home/you/projects/app' : 'Pick a Runtime Host first'}
              onChange={(e) => patch({ working_dir: e.target.value })}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || !value.manager_agent_id}
            onClick={() => setPickerOpen(true)}
          >
            Browse…
          </Button>
          {folderOptions.length > 0 && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setCustomFolder(false)}>
              Use an existing folder
            </Button>
          )}
        </div>
      )}
      {folderMates.length > 0 && (
        <Hint tone="accent">
          This folder is also used by <strong>{folderMates.join(', ')}</strong> on the same host. With scope
          &quot;shared&quot; they all work in the same tree — one can leave a file for another to pick up.
        </Hint>
      )}

      <Select
        label="Folder scope"
        value={value.folder_scope}
        disabled={disabled}
        options={[
          { value: 'shared', label: 'Shared — work directly in the folder above' },
          { value: 'isolated', label: 'Isolated — a fresh subfolder per step' },
        ]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
          patch({ folder_scope: e.target.value as OrchestrationFolderScope })
        }
      />
      {value.folder_scope === 'shared' ? (
        <Hint>
          Every step runs with the folder above as its current directory, exactly as it is on disk. AWB does not
          clone or wipe anything, so the mission&apos;s repo setting is ignored for this member — prepare the
          checkout on the host yourself. Two steps running at the same time share one working tree, so give a
          member that edits files a capacity of 1, or order the steps with dependencies.
        </Hint>
      ) : (
        <Hint>
          Each step gets its own <code>.awb/orch/&lt;mission&gt;/&lt;step&gt;</code> folder under the path above,
          checked out from the mission&apos;s repo. Steps cannot see each other&apos;s files — results travel
          through step reports and artifacts.
        </Hint>
      )}

      {/* ── Optional auth / backend ─────────────────────────────────────── */}
      {cli && (
        <Select
          label="CLI credential (optional)"
          value={value.credential_id}
          disabled={disabled}
          options={[
            { value: '', label: credentialFallbackCopy(cli).optionLabel },
            ...eligibleCredentials.map((c) => ({ value: c.id, label: `${c.name} (${c.provider})` })),
          ]}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patch({ credential_id: e.target.value })}
        />
      )}
      {showBackendProfile && (
        <Select
          label="Claude backend profile (optional)"
          value={value.cli_runtime_profile}
          disabled={disabled}
          options={[
            { value: '', label: 'Inherit the global default' },
            { value: 'none', label: 'None — plain Claude Code' },
            ...backendProfiles.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patch({ cli_runtime_profile: e.target.value })}
        />
      )}

      <DirectoryPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        managerAgentId={value.manager_agent_id}
        initialPath={value.working_dir || undefined}
        onPick={(path) => {
          patch({ working_dir: path });
          setPickerOpen(false);
        }}
      />
    </>
  );
}

function Hint({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warning' | 'accent' }) {
  const color =
    tone === 'warning'
      ? tokens.colors.warningLight
      : tone === 'accent'
        ? tokens.colors.accentLight
        : tokens.colors.textMuted;
  return <div style={{ fontSize: 11, color, marginTop: -8, lineHeight: 1.5 }}>{children}</div>;
}

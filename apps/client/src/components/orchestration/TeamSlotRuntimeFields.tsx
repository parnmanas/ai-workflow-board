import RuntimeSelectionFields from '../runtime/RuntimeSelectionFields';
import React, { useEffect, useMemo, useState } from 'react';
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
import {
  EMPTY_RUNTIME_SELECTION,
  buildRuntimeConfig,
  runtimeSelectionFromAgent,
  type RuntimeSelection,
} from '../admin/RuntimeConfigFields';
import { credentialFallbackCopy } from '../../utils/credentialFallback';
import { cliCredentialPrefix, cliSupportsBackendProfile } from '../../cli/catalog';

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
  effort: string;
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
    effort: '',
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
    effort: String((rt.runtime_config as any)?.extra?.effort || ''),
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
    runtime_config: { ...buildRuntimeConfig(draft.runtime)!, extra: { effort: draft.effort || null } },
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
  /** @deprecated 모델 목록은 공유 스토어(src/cli/hostModels.ts)가 갱신한다 — 더 이상 호출되지 않는다. */
  onHostRefreshed?(host: OrchestrationRuntimeHost): void;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customFolder, setCustomFolder] = useState(false);

  // P4: 구 spec(manager Agent uuid)과 신 spec(Host id) 둘 다 같은 Host 로 본다.
  const host = hosts.find(
    (h) => h.manager_agent_id === value.manager_agent_id || (h.legacy_agent_id != null && h.legacy_agent_id === value.manager_agent_id),
  ) ?? null;
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

  // Credential providers are prefixed by CLI (`claude_subscription`,
  // `codex_api_key`, …) — the prefix is a catalog fact, same filter the admin
  // agent dialog uses. CLIs without a credential concept get an empty list.
  const credentialPrefix = cliCredentialPrefix(cli);
  const eligibleCredentials = credentialPrefix
    ? credentials.filter((c) => c.provider.startsWith(credentialPrefix))
    : [];
  const showBackendProfile = cliSupportsBackendProfile(cli) && backendProfiles.length > 0;

  return (
    <>
      <RuntimeSelectionFields
        value={{ host_id: value.manager_agent_id, cli, model: value.model || null, effort: value.effort || null,
          runtime_config: buildRuntimeConfig(value.runtime) || { strategy: 'single', permission_mode: 'approve' } }}
        hosts={hosts.map((h) => ({ id: h.manager_agent_id, name: h.manager_name, clis: h.clis }))}
        disabled={disabled}
        onChange={(next) => {
          patch({ manager_agent_id: next.host_id, runtime: runtimeSelectionFromAgent(next.cli, next.runtime_config as any),
            model: next.model || '', effort: next.effort || '',
            ...(next.host_id !== value.manager_agent_id ? { working_dir: '', credential_id: '' } : {}),
            ...(next.cli !== cli ? { credential_id: '', cli_runtime_profile: '' } : {}),
          });
        }}
      />

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

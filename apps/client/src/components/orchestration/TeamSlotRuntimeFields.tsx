import RuntimeSelectionFields from '../runtime/RuntimeSelectionFields';
import React from 'react';
import { tokens } from '../../tokens';
import type {
  ClaudeBackendProfile,
  Credential,
  OrchestrationRuntimeHost,
  OrchestrationSlotRuntime,
  OrchestrationSlotSpecInput,
} from '../../types';
import { Select } from '../common';
import {
  EMPTY_RUNTIME_SELECTION,
  buildRuntimeConfig,
  runtimeSelectionFromAgent,
  type RuntimeSelection,
} from '../admin/RuntimeConfigFields';
import { credentialFallbackCopy } from '../../utils/credentialFallback';
import { cliCredentialPrefix, cliSupportsBackendProfile } from '../../cli/catalog';

/**
 * The editor for one Orchestration team slot: Runtime Host, CLI, model,
 * credential, backend.
 *
 * This form IS the team roster. There is no agent picker — you describe a
 * worker (which machine, which CLI, which model) and AWB runs it. There is no
 * folder either: a team is reused across missions, and each mission's projects
 * decide where a slot works (that project's folder on the slot's host). One
 * component serves both slots (orchestrator and member) so the two can never
 * drift apart, which is what happened the last time the same concept had two
 * forms.
 *
 * Reuses the shared `RuntimeSelectionFields` (host + CLI + model + effort +
 * execution strategy + permission tier) rather than restating it, so a new CLI
 * or permission tier lands everywhere at once.
 */

export interface SlotDraft {
  manager_agent_id: string;
  /** CLI + execution strategy + permission tier, in RuntimeConfigFields' shape. */
  runtime: RuntimeSelection;
  model: string;
  effort: string;
  credential_id: string;
  cli_runtime_profile: string;
}

export function emptySlotDraft(): SlotDraft {
  return {
    manager_agent_id: '',
    runtime: EMPTY_RUNTIME_SELECTION,
    model: '',
    effort: '',
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
  return null;
}

export function slotDraftToSpec(draft: SlotDraft): OrchestrationSlotSpecInput {
  return {
    manager_agent_id: draft.manager_agent_id,
    cli: draft.runtime.runtime as string,
    model: draft.model.trim() || null,
    credential_id: draft.credential_id || null,
    cli_runtime_profile: draft.cli_runtime_profile || null,
    runtime_config: { ...buildRuntimeConfig(draft.runtime)!, extra: { effort: draft.effort || null } },
  };
}

export default function TeamSlotRuntimeFields({
  value,
  onChange,
  hosts,
  credentials,
  backendProfiles,
  disabled = false,
}: {
  value: SlotDraft;
  onChange(next: SlotDraft): void;
  hosts: OrchestrationRuntimeHost[];
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  disabled?: boolean;
}) {
  const cli = value.runtime.runtime || '';
  const patch = (next: Partial<SlotDraft>) => onChange({ ...value, ...next });

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
            ...(next.host_id !== value.manager_agent_id ? { credential_id: '' } : {}),
            ...(next.cli !== cli ? { credential_id: '', cli_runtime_profile: '' } : {}),
          });
        }}
      />
      <Hint>
        No folder here — each mission picks its projects, and this member works in a project&apos;s folder on this
        host (Projects → host folders).
      </Hint>

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
    </>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: -8, lineHeight: 1.5 }}>{children}</div>;
}

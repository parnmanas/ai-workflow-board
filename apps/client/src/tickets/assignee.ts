// Assignee display + filter options (docs/tickets.md). The assignee is a
// RuntimeSpec, not an Agent row, so its display follows the spec rule in
// docs/runbooks/agent-display-name.md: the spec `label` (falling back to
// `<folder leaf>/<cli>`, the same default the server's normalizeRuntimeSpec
// stamps) under its Runtime Host's name — `<Host>/<label>` via the shared
// formatter. A raw host uuid is never rendered as a name; when the host name
// is unknown the label renders bare. React-free (unit tested).

import { formatAgentDisplayName } from '../utils/agentName';
import { workingDirLeaf, type RuntimeSpecDraft } from '../runtime/runtimeSpec';

type SpecLike = Partial<Pick<RuntimeSpecDraft, 'label' | 'cli' | 'working_dir' | 'manager_agent_id'>> | null | undefined;

/** The spec's own name (no host prefix). */
export function assigneeLeafName(spec: SpecLike): string {
  if (!spec) return '';
  const label = (spec.label || '').trim();
  if (label) return label;
  const leaf = workingDirLeaf((spec.working_dir || '').trim());
  const cli = (spec.cli || '').trim();
  if (leaf && cli) return `${leaf}/${cli}`;
  return cli || leaf || '';
}

/** `<Host>/<label>` — or the bare label when the host name is unknown. '' when unassigned. */
export function assigneeDisplayName(spec: SpecLike, hostNames?: Record<string, string> | null): string {
  const leaf = assigneeLeafName(spec);
  if (!leaf) return '';
  const hostName = spec?.manager_agent_id ? hostNames?.[spec.manager_agent_id] : undefined;
  return formatAgentDisplayName({ name: leaf, manager_name: hostName || null });
}

export interface AssigneeOption {
  key: string;
  label: string;
  count: number;
}

/**
 * Distinct assignees among the loaded tickets (children included — they carry
 * no assignee, so they never contribute), keyed by `assignee_key`, labelled
 * with the display name, sorted by label. Two specs can share an identity key
 * (same cli + folder + credential on different hosts/models); the first seen
 * names it and the count covers all of them.
 */
export function assigneeOptions(
  tickets: Array<{ assignee_key?: string | null; assignee?: SpecLike }>,
  hostNames?: Record<string, string> | null,
): AssigneeOption[] {
  const byKey = new Map<string, AssigneeOption>();
  for (const t of tickets) {
    const key = (t.assignee_key || '').trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) { existing.count += 1; continue; }
    byKey.set(key, { key, label: assigneeDisplayName(t.assignee, hostNames) || key, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

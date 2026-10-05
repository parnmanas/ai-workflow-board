/** Read legacy owner fields without changing the UUID used by on-disk keys. */
export function normalizeAccountScope<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'workspace_id')) return value;
  const normalized = { ...record };
  if (normalized.account_id === undefined) normalized.account_id = record.workspace_id;
  delete normalized.workspace_id;
  return normalized as T;
}

/**
 * Normalize known AWB envelopes only. Tool inputs, credential fields and CLI
 * configuration can use the same spelling for unrelated data and stay opaque.
 */
export function normalizeAccountEnvelope<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let normalized = normalizeAccountScope(value) as Record<string, unknown>;
  for (const key of ['payload', 'args', 'run_provision', 'ticket', 'ticket_context']) {
    const child = normalizeAccountEnvelope(normalized[key]);
    if (child !== normalized[key]) normalized = { ...normalized, [key]: child };
  }
  return normalized as T;
}

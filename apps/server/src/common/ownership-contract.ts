/** Legacy owner names are accepted only at transport boundaries. */
export function normalizeOwnershipFields(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return value;
  const out = { ...value };
  if (out.scope === 'workspace') out.scope = 'account';
  for (const [oldKey, newKey] of [['workspace_id', 'account_id'], ['owner_workspace_id', 'owner_account_id'], ['allowed_workspace_ids', 'allowed_account_ids'], ['requested_workspace_id', 'requested_account_id']]) {
    if (out[newKey] === undefined && out[oldKey] !== undefined) out[newKey] = out[oldKey];
    delete out[oldKey];
  }
  for (const key of ['payload', 'scope', 'args', 'run_provision']) {
    if (out[key] && typeof out[key] === 'object') out[key] = normalizeOwnershipFields(out[key]);
  }
  return out;
}

/** Older installed managers can continue consuming the new SSE contract. */
export function withLegacyOwnershipFields(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return value;
  const out = { ...value };
  if (out.account_id !== undefined) out.workspace_id = out.account_id;
  for (const key of ['payload', 'scope', 'args', 'run_provision']) {
    if (out[key] && typeof out[key] === 'object') out[key] = withLegacyOwnershipFields(out[key]);
  }
  return out;
}

import { EnvironmentConfig } from '../types';

// Pure, React-free logic for the board Environment Setup editor (ticket
// 8fbe90e9), extracted so it can be unit-tested without a DOM/jsdom mount (this
// repo has no jsdom — see root CLAUDE.md; mirrors the composerSend.ts DI-extract
// pattern). The editor is a SINGLE repository-Resource picker: only the first
// repository is ever provisioned (agent-manager resolveBootstrapRepository reads
// env.repositories[0]), so the UI edits exactly one selection. LOAD parses the
// stored JSON tolerantly down to that one resource_id (flagging any legacy field
// / extra repo so the UI can warn it will be dropped), and SAVE rebuilds the
// { repositories: [{ resource_id }] } write shape.

export interface ParsedEnvironmentRaw {
  /** resource_id of the single provisioned repository — the one the worktree
   *  bootstrap actually uses (env.repositories[0]). '' when the stored config
   *  has no resource-backed repository. */
  resourceId: string;
  /** True when the stored config still carries anything the editor no longer
   *  manages — legacy top-level keys (env_vars / setup_commands / …), per-repo
   *  url/branch/target_dir/…, EXTRA repositories beyond the first, or a url-only
   *  repository. All of it is dropped the next time the board is saved. */
  hasLegacy: boolean;
  /** True when the config's ONLY worktree source is a url-only (resource-less)
   *  repository: it keeps resolving/executing on the read path until Save, but
   *  saving through the repo picker removes it and leaves the board with no
   *  provisioning source. Drives a stronger, explicit warning. */
  losesWorktreeSourceOnSave: boolean;
}

// Tolerant parse: keep the first repository's resource_id, ignore every other
// key. Anything else present in the stored JSON — legacy keys, extra repos, or a
// url-only repo — is flagged as legacy-to-be-dropped so the editor can render a
// non-destructive "will be dropped on save" note.
export function parseEnvironmentConfigRaw(raw: string | null | undefined): ParsedEnvironmentRaw {
  const empty: ParsedEnvironmentRaw = { resourceId: '', hasLegacy: false, losesWorktreeSourceOnSave: false };
  if (!raw) return empty;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return empty;

  let hasLegacy = false;
  for (const k of Object.keys(obj)) {
    if (k !== 'repositories') hasLegacy = true; // env_vars / setup_commands / …
  }

  const repos = Array.isArray(obj.repositories) ? obj.repositories : [];
  const resourceIds: string[] = [];
  let urlOnlyCount = 0;
  for (const r of repos) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (k !== 'resource_id') hasLegacy = true; // url / target_dir / branch / …
    }
    const id = typeof r.resource_id === 'string' ? r.resource_id.trim() : '';
    if (id) resourceIds.push(id);
    else {
      urlOnlyCount++;
      hasLegacy = true; // url-only repo — can't be shown as a Resource pick
    }
  }
  // Only the first resource-backed repo is provisioned; any extra beyond it is
  // dead configuration that the single-selector save drops.
  if (resourceIds.length > 1) hasLegacy = true;
  const resourceId = resourceIds[0] || '';
  // The board loses its worktree source on Save only when there is NO
  // resource-backed repo left to keep but there IS a url-only one Save removes.
  const losesWorktreeSourceOnSave = resourceIds.length === 0 && urlOnlyCount > 0;
  return { resourceId, hasLegacy, losesWorktreeSourceOnSave };
}

// Rebuild the write shape from the single selected resource_id. A blank/empty
// selection is null (no provisioning — the column stays null).
export function buildEnvironmentConfig(resourceId: string | null | undefined): EnvironmentConfig | null {
  const id = (resourceId || '').trim();
  return id ? { repositories: [{ resource_id: id }] } : null;
}

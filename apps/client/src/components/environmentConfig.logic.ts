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
  /** True when the provisioned repository (repositories[0]) is a url-only
   *  (resource-less) entry: it keeps resolving/executing on the read path until
   *  Save, but saving through the repo picker removes it and leaves the board with
   *  no provisioning source unless the operator first picks a Resource. Set purely
   *  off index 0, so a later resource-backed row does NOT suppress it. Drives a
   *  stronger, explicit warning. */
  losesWorktreeSourceOnSave: boolean;
}

// Tolerant parse. Only repositories[0] is ever provisioned (agent-manager
// resolveBootstrapRepository reads env.repositories[0]), so the editable selection
// is STRICTLY array index 0 — never a later resource-backed row. Keying off the
// first row that merely HAS a resource_id would, for a mixed
// [{url-only}, {resource_id}] config, show the operator a repo the board is NOT
// running and, on Save, silently switch the live worktree source to it. Everything
// else in the stored JSON — legacy top-level keys, extra repos, per-repo url/…, or
// a url-only first repo — is flagged legacy-to-be-dropped so the editor can warn.
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
  // Any repository beyond the first is never provisioned → dead config the
  // single-selector save drops (covers a later repo's own legacy keys too).
  if (repos.length > 1) hasLegacy = true;

  // The selection is repositories[0] and nothing else — the repo the worktree
  // bootstrap actually consumes.
  const first = repos.length > 0 && repos[0] && typeof repos[0] === 'object' ? repos[0] : null;
  let resourceId = '';
  let losesWorktreeSourceOnSave = false;
  if (first) {
    for (const k of Object.keys(first)) {
      if (k !== 'resource_id') hasLegacy = true; // url / target_dir / branch / …
    }
    const id = typeof first.resource_id === 'string' ? first.resource_id.trim() : '';
    const url = typeof first.url === 'string' ? first.url.trim() : '';
    if (id) {
      resourceId = id;
    } else {
      // The provisioned repo (index 0) is not resource-backed, so it can't be
      // shown as a Resource pick and Save drops it. When it carries a url it is a
      // LIVE worktree source whose loss on Save must be called out loudly.
      hasLegacy = true;
      if (url) losesWorktreeSourceOnSave = true;
    }
  }
  return { resourceId, hasLegacy, losesWorktreeSourceOnSave };
}

// Rebuild the write shape from the single selected resource_id. A blank/empty
// selection is null (no provisioning — the column stays null).
export function buildEnvironmentConfig(resourceId: string | null | undefined): EnvironmentConfig | null {
  const id = (resourceId || '').trim();
  return id ? { repositories: [{ resource_id: id }] } : null;
}

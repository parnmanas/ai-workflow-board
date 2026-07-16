import { EnvironmentConfig } from '../types';

// Pure, React-free logic for the board Environment Setup editor (ticket
// 8fbe90e9), extracted so it can be unit-tested without a DOM/jsdom mount (this
// repo has no jsdom — see root CLAUDE.md; mirrors the composerSend.ts DI-extract
// pattern). The editor is a repository-Resource picker: LOAD parses the stored
// JSON tolerantly down to the selected resource_ids (flagging any legacy field so
// the UI can warn it will be dropped), and SAVE rebuilds the
// { repositories: [{ resource_id }] } write shape.

export interface ParsedEnvironmentRaw {
  /** resource_ids of repositories that reference a Resource (editable rows). */
  resourceIds: string[];
  /** True when the stored config carries any field the editor no longer manages
   *  (a legacy top-level key, a per-repo url/branch/…, or a url-only repository) —
   *  it will be dropped the next time the board is saved. */
  hasLegacy: boolean;
}

// Tolerant parse: keep each repository's resource_id, ignore every other key.
// Anything else present in the stored JSON is flagged as legacy-to-be-dropped so
// the editor can render a non-destructive "will be dropped on save" note.
export function parseEnvironmentConfigRaw(raw: string | null | undefined): ParsedEnvironmentRaw {
  const empty: ParsedEnvironmentRaw = { resourceIds: [], hasLegacy: false };
  if (!raw) return empty;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== 'object') return empty;

  const resourceIds: string[] = [];
  let hasLegacy = false;
  for (const k of Object.keys(obj)) {
    if (k !== 'repositories') hasLegacy = true; // env_vars / setup_commands / …
  }
  const repos = Array.isArray(obj.repositories) ? obj.repositories : [];
  for (const r of repos) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (k !== 'resource_id') hasLegacy = true; // url / target_dir / branch / …
    }
    const id = typeof r.resource_id === 'string' ? r.resource_id.trim() : '';
    if (id) resourceIds.push(id);
    else hasLegacy = true; // url-only repo — can't be shown as a Resource pick
  }
  return { resourceIds, hasLegacy };
}

// Rebuild the write shape from the selected resource_ids. Blank rows collapse; an
// empty selection is null (no provisioning — the column stays null).
export function buildEnvironmentConfig(resourceIds: string[]): EnvironmentConfig | null {
  const repositories = resourceIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((resource_id) => ({ resource_id }));
  return repositories.length > 0 ? { repositories } : null;
}

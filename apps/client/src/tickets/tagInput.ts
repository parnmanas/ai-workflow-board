// Tag entry helpers shared by the ticket form, the ticket panel and the
// QA/Security failure-ticket editors. Tags are free-form (an old board name
// like "AWB Dev" is a legitimate tag), so only commas separate them — spaces
// are part of a tag. React-free — `test/ticket-tags.test.mjs` imports it.

/** Split raw input on commas / newlines into trimmed, non-empty tags. */
export function parseTagInput(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^#/, '').trim())
    .filter(Boolean);
}

/** `current` plus the tags in `raw` — order kept, duplicates (case-insensitive) dropped. */
export function addTags(current: readonly string[], raw: string | readonly string[]): string[] {
  const incoming = typeof raw === 'string' ? parseTagInput(raw) : raw.map((t) => t.trim()).filter(Boolean);
  const out = [...current];
  for (const tag of incoming) {
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

export function removeTag(current: readonly string[], tag: string): string[] {
  return current.filter((t) => t !== tag);
}

/**
 * Suggestions for the tag input: known tags not already chosen, matching the
 * typed query case-insensitively (prefix matches first), most-used first when
 * counts are known.
 */
export function suggestTags(
  known: ReadonlyArray<string | { tag: string; count?: number }>,
  current: readonly string[],
  query: string,
  limit = 8,
): string[] {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  const chosen = new Set(current.map((t) => t.toLowerCase()));
  const seen = new Set<string>();
  const rows: Array<{ tag: string; count: number; prefix: boolean }> = [];
  for (const k of known) {
    const tag = typeof k === 'string' ? k : k.tag;
    const count = typeof k === 'string' ? 0 : k.count || 0;
    const lower = tag.toLowerCase();
    if (!tag || chosen.has(lower) || seen.has(lower)) continue;
    if (q && !lower.includes(q)) continue;
    seen.add(lower);
    rows.push({ tag, count, prefix: !!q && lower.startsWith(q) });
  }
  rows.sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.count - a.count || a.tag.localeCompare(b.tag));
  return rows.slice(0, limit).map((r) => r.tag);
}

/**
 * Union of several suggestion sources (workspace-wide `/ticket-tags`, the loaded
 * list's facet, …) — one row per tag (case-insensitive, first spelling wins),
 * keeping the highest count seen, most used first.
 */
export function mergeTagSuggestions(
  ...sources: ReadonlyArray<ReadonlyArray<string | { tag: string; count?: number }> | null | undefined>
): Array<{ tag: string; count: number }> {
  const byKey = new Map<string, { tag: string; count: number }>();
  for (const source of sources) {
    for (const item of source || []) {
      const tag = (typeof item === 'string' ? item : item.tag || '').trim();
      if (!tag) continue;
      const count = typeof item === 'string' ? 0 : item.count || 0;
      const key = tag.toLowerCase();
      const hit = byKey.get(key);
      if (hit) hit.count = Math.max(hit.count, count);
      else byKey.set(key, { tag, count });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

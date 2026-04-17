/**
 * Shared helpers for MCP tools.
 *
 * Extracted from mcp-tools.ts during Phase 3 refactor so that each domain
 * tool file can import them without pulling in the whole monolith.
 */

/**
 * Tolerant JSON parse: returns `fallback` for null/undefined/malformed input.
 * Used extensively to decode `labels` and `channel_ids` columns that are
 * stored as JSON strings.
 */
export function safeJsonParse(val: string | null | undefined, fallback: any = []): any {
  try { return JSON.parse(val || JSON.stringify(fallback)); }
  catch { return fallback; }
}

/**
 * Standard MCP tool success shape.
 */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Standard MCP tool error shape.
 */
export function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

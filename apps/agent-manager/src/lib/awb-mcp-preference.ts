/** The account connector can read a different account from the Runtime Host credential. */
export const HOST_AWB_MCP_INSTRUCTION =
  'Use the Runtime Host MCP server named `awb` for every AWB read and write (in Codex and Claude, `mcp__awb__*`). '
  + 'Report a host connection failure. Use a personal AWB connector only if the user explicitly selects it.';

export function hostAwbRolePrompt(rolePrompt?: string | null): string {
  return [rolePrompt, HOST_AWB_MCP_INSTRUCTION].filter(Boolean).join('\n\n');
}

import { z } from 'zod';

/**
 * Agent harness configuration (ticket 7122600c).
 *
 * A harness describes how a subagent CLI should be launched for tickets on a
 * board: extra system prompt, tool allow/deny lists, model and permission
 * mode. Stored as a JSON text column on both Workspace (`harness_config` =
 * workspace-wide default) and Board (`harness_config` = per-board override),
 * mirroring the `Board.routing_config` / `Board.column_prompts` convention.
 *
 * Resolution is KEY-LEVEL: a board only overrides the keys it sets; unset
 * keys fall through to the workspace default. Both unset → null, which every
 * consumer must treat as "no harness — current behaviour" (null-safe
 * contract). The resolved object is what dispatch ships to agent-manager
 * (follow-up ticket e9c7a896); agent-manager maps the keys onto claude CLI
 * flags (--append-system-prompt / --allowedTools / --disallowedTools /
 * --model / --permission-mode).
 */
export const HarnessConfigSchema = z
  .object({
    /** Merged into the subagent's --append-system-prompt. */
    system_prompt_append: z.string().optional(),
    /** claude CLI --allowedTools entries. */
    allowed_tools: z.array(z.string()).optional(),
    /** claude CLI --disallowedTools entries. */
    disallowed_tools: z.array(z.string()).optional(),
    /** --model override (free text — CLIs validate their own model ids). */
    model: z.string().optional(),
    /**
     * Ordered fallback model chain (ticket 61f4dd18). When the primary model
     * (the resolved `model`, or an effort-preset / per-agent model) errors with
     * a fallback-eligible failure (usage cap / model unavailable / spawn
     * failure) BEFORE producing any deliverable, agent-manager retries the next
     * model in this list, highest-priority first. NOT a CLI flag — a
     * manager-side retry policy — so it is deliberately excluded from
     * HARNESS_CONFIG_KEYS' per-flag partition on the agent-manager side.
     */
    fallback_models: z.array(z.string()).optional(),
    /** --permission-mode override (free text for forward-compat). */
    permission_mode: z.string().optional(),
  })
  .strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const HARNESS_CONFIG_KEYS = [
  'system_prompt_append',
  'allowed_tools',
  'disallowed_tools',
  'model',
  'fallback_models',
  'permission_mode',
] as const;

/**
 * Parse a stored harness_config text column. Returns null for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to "no
 * harness", never throw on a read path.
 */
export function parseHarnessConfig(raw: string | null | undefined): HarnessConfig | null {
  if (!raw) return null;
  try {
    const parsed = HarnessConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyHarness(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Unlike
 * parseHarnessConfig this REJECTS bad input so the caller can 400 — silent
 * null-coercion on a write would make a typo'd key vanish without feedback.
 */
export function validateHarnessConfigInput(
  input: unknown,
): { ok: true; value: HarnessConfig } | { ok: false; error: string } {
  const parsed = HarnessConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid harness_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Serialize for storage: empty configs collapse to null (column stays null →
 * "no harness" stays representable as the single falsy state, same as
 * column_prompts).
 */
export function serializeHarnessConfig(value: HarnessConfig | null | undefined): string | null {
  if (!value || isEmptyHarness(value)) return null;
  return JSON.stringify(value);
}

/**
 * Key-level merge of the workspace default with the board override. The
 * board wins per key it explicitly sets; keys it leaves unset inherit from
 * the workspace. Both null → null (caller keeps current behaviour).
 *
 * Shared resolve point for REST/MCP consumers and the dispatch path
 * (TriggerLoopService — follow-up ticket e9c7a896) so every reader agrees
 * on the same precedence.
 */
export function resolveHarnessConfig(
  workspaceRaw: string | null | undefined,
  boardRaw: string | null | undefined,
): HarnessConfig | null {
  const ws = parseHarnessConfig(workspaceRaw);
  const board = parseHarnessConfig(boardRaw);
  if (!ws) return board;
  if (!board) return ws;
  const merged: HarnessConfig = { ...ws };
  for (const key of HARNESS_CONFIG_KEYS) {
    if (board[key] !== undefined) (merged as any)[key] = board[key];
  }
  return isEmptyHarness(merged) ? null : merged;
}

export function buildBoardLanguageInstruction(language: string | null | undefined): string | null {
  const trimmed = language?.trim();
  if (!trimmed) return null;
  return `Respond in ${trimmed}. Write all ticket comments, chat messages, commit messages, PR descriptions, and code comments in ${trimmed}.`;
}

export function appendBoardLanguageInstruction(
  harnessConfig: HarnessConfig | null,
  language: string | null | undefined,
): HarnessConfig | null {
  const instruction = buildBoardLanguageInstruction(language);
  if (!instruction) return harnessConfig;
  const next: HarnessConfig = { ...(harnessConfig ?? {}) };
  next.system_prompt_append = [next.system_prompt_append, instruction]
    .filter((s) => s && s.trim())
    .join('\n\n');
  return next;
}

export function prependBoardLanguageInstruction(
  content: string,
  language: string | null | undefined,
): string {
  const instruction = buildBoardLanguageInstruction(language);
  if (!instruction) return content;
  return [instruction, content].filter((s) => s && s.trim()).join('\n\n');
}

function isEmptyHarness(value: HarnessConfig): boolean {
  return HARNESS_CONFIG_KEYS.every(k => value[k] === undefined);
}

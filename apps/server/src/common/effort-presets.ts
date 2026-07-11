import { z } from 'zod';

/**
 * Ticket-level abstract "effort preset" → per-CLI option mapping.
 *
 * A Ticket carries an ABSTRACT effort option (a preset id slug — NOT a
 * CLI-specific flag). Board settings define the presets; each preset maps the
 * abstract level onto per-CLI options. Stored as a JSON text column on Board
 * (`effort_presets` = the board's preset catalog) plus a scalar `effort_preset`
 * id on each Ticket, mirroring the `Board.harness_config` /
 * `Board.column_prompts` convention.
 *
 * Resolution is SINGLE-MATCH: dispatch picks the ticket's preset id (or the
 * board default when the ticket leaves it unset) out of the board catalog and
 * ships that one preset object on the agent_trigger payload (field name
 * `effort_preset`). Unresolvable → null, which every consumer must treat as
 * "no effort override — spawn exactly as before" (null-safe contract, same as
 * harness_config).
 *
 * Per-CLI mapping (agent-manager applies this at spawn time):
 *   - claude: `effort` → `--effort <low|medium|high|max>` (session-level);
 *     `ultracode: true` appends the literal PROMPT KEYWORD "ultracode" to the
 *     task text (oneshot) / first user turn (session) — it is NOT a CLI flag.
 *     `model` → `--model`.
 *   - codex / antigravity: model-only (`-m`/`--model`); they gracefully skip
 *     whatever the preset expresses that they can't (effort / ultracode).
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'max']);

/** Per-CLI option blocks. Claude supports the rich set; codex/antigravity model-only. */
export const EffortPresetSchema = z
  .object({
    /** Stable slug, e.g. 'standard'. Referenced by Ticket.effort_preset. */
    id: z.string().min(1),
    /** Human label shown in the board settings UI / ticket picker. */
    label: z.string().min(1),
    claude: z
      .object({
        effort: EffortLevelSchema.optional(),
        ultracode: z.boolean().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        model: z.string().optional(),
      })
      .strict()
      .optional(),
    antigravity: z
      .object({
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const EffortPresetsConfigSchema = z
  .object({
    /** Preset id used when a ticket leaves `effort_preset` unset. */
    default: z.string().min(1),
    presets: z.array(EffortPresetSchema),
  })
  .strict();

export type EffortPreset = z.infer<typeof EffortPresetSchema>;
export type EffortPresetsConfig = z.infer<typeof EffortPresetsConfigSchema>;
/** The single matched preset shipped on the SSE agent_trigger payload. */
export type ResolvedEffortPreset = EffortPreset;

/**
 * Built-in preset catalog used when a board has none stored. Defined
 * identically on the client (board settings UI) so the two never drift.
 */
export const BUILTIN_EFFORT_PRESETS: EffortPresetsConfig = {
  default: 'standard',
  presets: [
    { id: 'light', label: 'Light', claude: { effort: 'low' } },
    { id: 'standard', label: 'Standard', claude: { effort: 'medium' } },
    { id: 'deep', label: 'Deep', claude: { effort: 'high' } },
    { id: 'max', label: 'Max', claude: { effort: 'max', ultracode: true } },
  ],
};

/**
 * Parse a stored effort_presets text column. Returns BUILTIN for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to the
 * built-in catalog, never throw on a read path (mirrors parseHarnessConfig
 * except the fallback is BUILTIN rather than null, since a board always needs
 * SOME catalog to resolve against).
 */
export function parseEffortPresets(raw: string | null | undefined): EffortPresetsConfig {
  if (!raw) return BUILTIN_EFFORT_PRESETS;
  try {
    const parsed = EffortPresetsConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return BUILTIN_EFFORT_PRESETS;
    return parsed.data;
  } catch {
    return BUILTIN_EFFORT_PRESETS;
  }
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Unlike
 * parseEffortPresets this REJECTS bad input so the caller can 400 — silent
 * coercion on a write would make a typo'd key vanish without feedback.
 * Additionally enforces the cross-field invariant that `default` names an
 * existing preset id (an empty preset list is allowed — it serializes to a
 * "no presets" catalog the resolver returns null for).
 */
export function validateEffortPresetsInput(
  input: unknown,
): { ok: true; value: EffortPresetsConfig } | { ok: false; error: string } {
  const parsed = EffortPresetsConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid effort_presets: ${issues}` };
  }
  const value = parsed.data;
  if (value.presets.length > 0 && !value.presets.some(p => p.id === value.default)) {
    return { ok: false, error: `Invalid effort_presets: default '${value.default}' does not match any preset id` };
  }
  const ids = value.presets.map(p => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    return { ok: false, error: `Invalid effort_presets: duplicate preset id(s): ${[...new Set(dupes)].join(', ')}` };
  }
  return { ok: true, value };
}

/**
 * Serialize for storage. Empty preset list → null ("no catalog / clear the
 * override"). A non-empty catalog ALWAYS persists — even when it equals the
 * built-in set — so that explicitly saving the board settings opts the board
 * into board-wide effort defaults. This is the meaningful distinction from a
 * board that never configured anything (column stays null → dormant, see
 * resolveEffortPreset's null-safe rollout). Collapsing builtin→null here would
 * make "save the defaults to turn it on" silently a no-op.
 */
export function serializeEffortPresets(value: EffortPresetsConfig | null | undefined): string | null {
  if (!value) return null;
  if (value.presets.length === 0) return null;
  return JSON.stringify(value);
}

/**
 * Resolve the single preset that applies to a ticket at dispatch.
 *   - null-safe rollout: an unconfigured board (column null) + a ticket with no
 *     explicit pick → null ("no effort override", spawn exactly as before). An
 *     unconfigured board must not change behaviour just by deploying this — same
 *     contract as resolveHarnessConfig / column_prompts.
 *   - otherwise parse the board catalog (BUILTIN when malformed — never throws),
 *     pick preset id = ticketPresetId (when non-empty) else config.default, and
 *     return the matching preset object, or null if not found / no presets.
 *
 * The built-in catalog still backs explicit ticket picks (so a ticket can opt
 * into an effort level on a board that hasn't saved its settings) and the
 * settings UI; it just isn't force-applied to every dispatch. Shared resolve
 * point so REST/MCP consumers and the dispatch path agree (mirrors
 * resolveHarnessConfig).
 */
export function resolveEffortPreset(
  boardPresetsRaw: string | null | undefined,
  ticketPresetId: string | null | undefined,
): ResolvedEffortPreset | null {
  const ticketPick = ticketPresetId && ticketPresetId.trim();
  if (!boardPresetsRaw && !ticketPick) return null;
  const config = parseEffortPresets(boardPresetsRaw);
  if (!config.presets.length) return null;
  const wanted = ticketPick || config.default;
  return config.presets.find(p => p.id === wanted) || null;
}

/**
 * QA multi-phase model (ticket 90cc22f7).
 *
 * The single-`running` QaRun model applies ONE timeout to a whole run. Real
 * workloads have distinct stages with wildly different normal durations — a
 * Unity drive is import (tens of seconds) → build (tens of minutes) → run
 * (hours). A single timeout either false-reaps the long stage or never catches a
 * hang in the short one. This module lets a board (and, overriding it, a
 * scenario) declare an ordered list of phases, each with its own `timeout_sec`,
 * so the reaper can judge "is THIS phase overdue" instead of "is the whole run
 * overdue".
 *
 * It deliberately mirrors qa-liveness-policy.ts: a zod WRITE schema, a fail-safe
 * READ parse (never throws mid-sweep — a malformed config falls back to null so
 * one bad board can't break reaping for everyone), and a scenario-?? -board-??
 * -null precedence resolver. The `phase_timeouts` LivenessDetector that consumes
 * this lives in qa-liveness-policy.ts (the detector registry); this file owns
 * only the data model + its parsing.
 *
 * null config = no phase model → legacy single-running behavior, fully
 * regression-safe.
 */

import { z } from 'zod';

export interface QaPhase {
  /** Stable phase id the run stamps as current_phase (e.g. 'import', 'build', 'run'). */
  id: string;
  /** Human label for the timeline UI (defaults to id when omitted). */
  label?: string;
  /** Seconds this phase may run before the reaper treats it as a hung/dead phase. */
  timeout_sec: number;
}

export interface QaPhasesConfig {
  /** Ordered phases — array order IS the phase order. */
  phases: QaPhase[];
}

/**
 * Zod schema for the WRITE path (future MCP update_board / create|update_qa_scenario).
 * A non-empty array of phases; ids must be unique and non-empty; timeout_sec a
 * positive integer (a phase with no/zero timeout is meaningless).
 */
export const QaPhasesSchema = z.object({
  phases: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1).optional(),
        timeout_sec: z.number().int().positive(),
      }),
    )
    .min(1)
    .refine(
      (phases) => new Set(phases.map((p) => p.id)).size === phases.length,
      { message: 'phase ids must be unique' },
    ),
});

/** Serialize a validated config (or null) for storage as the entity's text column. */
export function serializeQaPhases(config: QaPhasesConfig | null | undefined): string | null {
  if (!config) return null;
  return JSON.stringify(config);
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Parse a stored qa_phases JSON string into a validated config. FAILS SAFE to
 * null for empty/unparseable/structurally-invalid input — we never throw
 * mid-sweep so one malformed board config can't break reaping for every other
 * run (same contract as parseLivenessPolicy). Normalizes by dropping malformed
 * phase entries; if nothing valid remains, returns null. Duplicate ids collapse
 * to the first occurrence so a later bad entry can't shadow a good one.
 */
export function parseQaPhases(raw: string | null | undefined): QaPhasesConfig | null {
  if (!raw) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.phases)) return null;
  const seen = new Set<string>();
  const phases: QaPhase[] = [];
  for (const p of obj.phases) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id || seen.has(id)) continue;
    if (!isPosInt(p.timeout_sec)) continue;
    seen.add(id);
    const phase: QaPhase = { id, timeout_sec: Math.floor(p.timeout_sec) };
    if (typeof p.label === 'string' && p.label.trim()) phase.label = p.label;
    phases.push(phase);
  }
  if (phases.length === 0) return null;
  return { phases };
}

/**
 * Resolve the effective phase model for a run: scenario-level config wins over
 * the board-level config, which wins over null (legacy single-running). Each
 * scope's raw JSON is parsed independently so a malformed scenario config falls
 * through to the board, then to null — mirroring resolveLivenessPolicy.
 */
export function resolveQaPhases(
  scenarioRaw: string | null | undefined,
  boardRaw: string | null | undefined,
): QaPhasesConfig | null {
  return parseQaPhases(scenarioRaw) ?? parseQaPhases(boardRaw) ?? null;
}

/** Look up a phase by id within a resolved config (null when absent/unmatched). */
export function findPhase(config: QaPhasesConfig | null, phaseId: string | null | undefined): QaPhase | null {
  if (!config || !phaseId) return null;
  return config.phases.find((p) => p.id === phaseId) ?? null;
}

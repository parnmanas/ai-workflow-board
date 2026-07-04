import { z } from 'zod';
import type { HarnessConfig } from './harness-config';

/**
 * Board Lessons / Runbook (ticket 9d0d6ac4).
 *
 * A board accumulates short, imperative "lessons" learned from past incidents.
 * At dispatch time the board's ACTIVE lessons are composed into a block and
 * appended onto the resolved `harness_config.system_prompt_append` so every
 * subagent spawned on the board sees them — the knowledge stops dying in one
 * ticket's comment thread.
 *
 * This module is the single source of truth for:
 *  - the abuse caps (per-lesson length + count + total injected bytes),
 *  - write-path validation (MCP/REST reject over-long input so a typo can't
 *    silently truncate),
 *  - the compose function that turns lessons into the injected block, applying
 *    the caps AGAIN at compose time (belt-and-suspenders: a legacy over-long
 *    row can never bloat a live prompt),
 *  - the null-safe append onto harness_config (zero lessons ⇒ harness returned
 *    unchanged ⇒ byte-identical prompt, the DoD regression guard).
 */

// ── Abuse caps ──────────────────────────────────────────────────────────────
/** Max length of a lesson title (headline). */
export const MAX_LESSON_TITLE_LEN = 120;
/** Max length of a lesson body (the imperative runbook that lands in the prompt). */
export const MAX_LESSON_BODY_LEN = 600;
/** Max number of tags on a lesson. */
export const MAX_LESSON_TAGS = 8;
/** Max length of a single tag. */
export const MAX_LESSON_TAG_LEN = 40;
/** Max number of lessons injected into any one dispatch prompt. */
export const MAX_INJECTED_LESSONS = 20;
/**
 * Hard ceiling on the total UTF-8 byte size of the composed lesson block. Keeps
 * a runaway board from bloating every prompt (perf guard called out in the
 * ticket's abuse-prevention item). Lessons past this ceiling are dropped and a
 * short truncation note is emitted instead.
 */
export const MAX_INJECTED_LESSON_BYTES = 4000;

// ── Write-path validation ────────────────────────────────────────────────────
/**
 * Zod schema for the mutable fields of a lesson (add/update payload). Length
 * caps are enforced here so the MCP tool / REST endpoint can 400 on an
 * over-long lesson instead of silently storing something that will be truncated
 * (or rejected) at inject time.
 */
export const BoardLessonInputSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(MAX_LESSON_TITLE_LEN),
    body: z.string().trim().min(1, 'body is required').max(MAX_LESSON_BODY_LEN),
    tags: z
      .array(z.string().trim().min(1).max(MAX_LESSON_TAG_LEN))
      .max(MAX_LESSON_TAGS)
      .optional(),
    source_ticket_id: z.string().trim().optional(),
  })
  .strict();

export type BoardLessonInput = z.infer<typeof BoardLessonInputSchema>;

export function validateBoardLessonInput(
  input: unknown,
): { ok: true; value: BoardLessonInput } | { ok: false; error: string } {
  const parsed = BoardLessonInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid lesson: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Partial-update schema — every mutable field optional (so an update can touch
 * one field), plus `active` for the deactivate path. Same length caps as the
 * add schema.
 */
export const BoardLessonUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'title cannot be empty').max(MAX_LESSON_TITLE_LEN).optional(),
    body: z.string().trim().min(1, 'body cannot be empty').max(MAX_LESSON_BODY_LEN).optional(),
    tags: z
      .array(z.string().trim().min(1).max(MAX_LESSON_TAG_LEN))
      .max(MAX_LESSON_TAGS)
      .optional(),
    source_ticket_id: z.string().trim().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type BoardLessonUpdate = z.infer<typeof BoardLessonUpdateSchema>;

export function validateBoardLessonUpdate(
  input: unknown,
): { ok: true; value: BoardLessonUpdate } | { ok: false; error: string } {
  const parsed = BoardLessonUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid lesson update: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

// ── Tag (de)serialization ────────────────────────────────────────────────────
/** Parse the JSON-array-as-text `tags` column to a string[]; null/malformed ⇒ []. */
export function parseLessonTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

/** Serialize a tag list for storage; empty ⇒ null (column stays the single falsy state). */
export function serializeLessonTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

// ── Compose + inject ─────────────────────────────────────────────────────────
/** The subset of a BoardLesson needed to render the injected block. */
export interface LessonForInjection {
  title: string;
  body: string;
  source_ticket_id?: string | null;
}

const LESSON_BLOCK_HEADER =
  '# Board Lessons / Runbook\n\n' +
  'Hard-won lessons captured from past tickets on THIS board. Treat each as a ' +
  'standing instruction: before you act, check whether one applies so you do ' +
  'not repeat a known mistake.\n';

/**
 * Compose the active lessons into a single system-prompt block, applying the
 * count cap and the total-byte ceiling. Returns null when there is nothing to
 * inject (no lessons, or every candidate was blank) — the null return is what
 * lets the caller keep the prompt byte-identical for a lessons-free board.
 *
 * Lessons are rendered in the order given (the caller decides ordering — e.g.
 * most-recently-updated first), included until either MAX_INJECTED_LESSONS or
 * MAX_INJECTED_LESSON_BYTES is reached; any remainder is summarized in a short
 * "(+N more…)" note rather than silently dropped.
 */
export function composeLessonsAppend(lessons: LessonForInjection[] | null | undefined): string | null {
  if (!lessons || lessons.length === 0) return null;

  // Clean + hard-truncate each candidate at compose time so a legacy over-long
  // row can never bloat a live prompt (validation guards new writes; this
  // guards reads).
  const cleaned = lessons
    .map((l) => ({
      title: (l.title || '').trim().slice(0, MAX_LESSON_TITLE_LEN),
      body: (l.body || '').trim().slice(0, MAX_LESSON_BODY_LEN),
      source_ticket_id: (l.source_ticket_id || '').trim(),
    }))
    .filter((l) => l.body.length > 0 || l.title.length > 0);

  if (cleaned.length === 0) return null;

  const capped = cleaned.slice(0, MAX_INJECTED_LESSONS);

  const lines: string[] = [];
  let bytes = Buffer.byteLength(LESSON_BLOCK_HEADER, 'utf8');
  let included = 0;

  for (let i = 0; i < capped.length; i++) {
    const l = capped[i];
    const ref = l.source_ticket_id ? ` [ref: ${l.source_ticket_id}]` : '';
    const headline = l.title ? `**${l.title}** — ` : '';
    const line = `${included + 1}. ${headline}${l.body}${ref}`;
    const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
    if (bytes + lineBytes > MAX_INJECTED_LESSON_BYTES && included > 0) {
      // Byte ceiling reached — stop and note the remainder below.
      break;
    }
    lines.push(line);
    bytes += lineBytes;
    included += 1;
  }

  if (included === 0) return null;

  const omitted = cleaned.length - included;
  const note = omitted > 0 ? `\n\n(+${omitted} more lesson(s) not shown — trim or deactivate stale ones.)` : '';

  return `${LESSON_BLOCK_HEADER}\n${lines.join('\n')}${note}`;
}

/**
 * Append the composed lessons block onto a resolved harness config's
 * `system_prompt_append`, mirroring `appendBoardLanguageInstruction`. APPEND,
 * never overwrite, so a board harness's own system_prompt_append and the
 * language instruction are both preserved. Null/empty lessons ⇒ the harness is
 * returned untouched (identical object, byte-identical downstream prompt).
 */
export function appendBoardLessons(
  harnessConfig: HarnessConfig | null,
  lessons: LessonForInjection[] | null | undefined,
): HarnessConfig | null {
  const block = composeLessonsAppend(lessons);
  if (!block) return harnessConfig;
  const next: HarnessConfig = { ...(harnessConfig ?? {}) };
  next.system_prompt_append = [next.system_prompt_append, block]
    .filter((s) => s && s.trim())
    .join('\n\n');
  return next;
}

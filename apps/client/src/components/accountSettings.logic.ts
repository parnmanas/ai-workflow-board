// Account "Ticket dispatch" settings ⇄ form (docs/tickets.md → Account
// settings). These used to live on each board; with boards gone they are
// workspace-wide: output language, per-agent concurrency, done-ticket
// auto-archive and the dispatch pause switch. React-free so `node --test`
// imports it directly (test/workspace-settings-logic.test.mjs).

import type { Account } from '../types';

export const DEFAULT_MAX_CONCURRENT_TICKETS_PER_AGENT = 1;
/** Server bound for max_concurrent_tickets_per_agent (1..50). */
export const MAX_CONCURRENT_TICKETS_PER_AGENT_MAX = 50;
export const AUTO_ARCHIVE_DAYS_MIN = 1;
export const AUTO_ARCHIVE_DAYS_MAX = 365;

export type DispatchSettingsSource = Pick<
  Account,
  'language' | 'max_concurrent_tickets_per_agent' | 'auto_archive_days' | 'dispatch_paused_at'
>;

/** Editable fields kept as raw input strings so a half-typed value is not coerced away. */
export interface DispatchSettingsForm {
  /** '' = agent default (stored as null). */
  language: string;
  /** Integer 1..50. */
  maxConcurrent: string;
  /** '' = disabled (stored as null), else 1..365. */
  autoArchiveDays: string;
}

export type DispatchSettingsField = keyof DispatchSettingsForm;
export type DispatchSettingsErrors = Partial<Record<DispatchSettingsField, string>>;

/** Body keys of PATCH /accounts/:id owned by this section. */
export interface DispatchSettingsPatch {
  language?: string | null;
  max_concurrent_tickets_per_agent?: number;
  auto_archive_days?: number | null;
  dispatch_paused_at?: string | null;
}

export function dispatchSettingsToForm(ws: DispatchSettingsSource | null | undefined): DispatchSettingsForm {
  const max = ws?.max_concurrent_tickets_per_agent;
  const days = ws?.auto_archive_days;
  return {
    language: typeof ws?.language === 'string' ? ws.language : '',
    maxConcurrent: String(
      typeof max === 'number' && Number.isFinite(max) && max >= 1 ? max : DEFAULT_MAX_CONCURRENT_TICKETS_PER_AGENT,
    ),
    autoArchiveDays: typeof days === 'number' && Number.isFinite(days) ? String(days) : '',
  };
}

/** Strict decimal integer — rejects '1.5', '1e3', ' 2x', '' and the like. */
function parseWholeNumber(raw: string): number | null {
  const s = (raw || '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function validateDispatchSettings(form: DispatchSettingsForm): DispatchSettingsErrors {
  const errors: DispatchSettingsErrors = {};
  const max = parseWholeNumber(form.maxConcurrent);
  if (max === null || max < 1 || max > MAX_CONCURRENT_TICKETS_PER_AGENT_MAX) {
    errors.maxConcurrent = `Enter a whole number from 1 to ${MAX_CONCURRENT_TICKETS_PER_AGENT_MAX}.`;
  }
  if (form.autoArchiveDays.trim() !== '') {
    const days = parseWholeNumber(form.autoArchiveDays);
    if (days === null || days < AUTO_ARCHIVE_DAYS_MIN || days > AUTO_ARCHIVE_DAYS_MAX) {
      errors.autoArchiveDays = `Enter ${AUTO_ARCHIVE_DAYS_MIN}–${AUTO_ARCHIVE_DAYS_MAX} days, or leave blank to disable.`;
    }
  }
  return errors;
}

function normalizedLanguage(raw: string): string | null {
  const s = (raw || '').trim();
  return s ? s : null;
}

/**
 * The PATCH body for the form: only keys whose value differs from the stored
 * workspace, so saving one field never rewrites another an admin changed in
 * another tab. Returns `{ errors }` instead when the form is invalid.
 */
export function buildDispatchSettingsPatch(
  form: DispatchSettingsForm,
  stored: DispatchSettingsSource | null | undefined,
): { patch: DispatchSettingsPatch; errors: DispatchSettingsErrors } {
  const errors = validateDispatchSettings(form);
  if (Object.keys(errors).length > 0) return { patch: {}, errors };

  const current = dispatchSettingsToForm(stored);
  const patch: DispatchSettingsPatch = {};

  const language = normalizedLanguage(form.language);
  if (language !== normalizedLanguage(current.language)) patch.language = language;

  const max = parseWholeNumber(form.maxConcurrent)!;
  if (max !== parseWholeNumber(current.maxConcurrent)) patch.max_concurrent_tickets_per_agent = max;

  const days = form.autoArchiveDays.trim() === '' ? null : parseWholeNumber(form.autoArchiveDays)!;
  const storedDays = current.autoArchiveDays === '' ? null : parseWholeNumber(current.autoArchiveDays);
  if (days !== storedDays) patch.auto_archive_days = days;

  return { patch, errors };
}

export function isDispatchPaused(ws: DispatchSettingsSource | null | undefined): boolean {
  return !!ws?.dispatch_paused_at;
}

/** Pause → stamp "now"; resume → null. */
export function buildDispatchPausePatch(paused: boolean, now: Date = new Date()): DispatchSettingsPatch {
  return { dispatch_paused_at: paused ? now.toISOString() : null };
}

import { getLocaleTag } from '../../../i18n/core';
import { t as translate } from '../../../i18n/core';
// ─── Time / date utility functions ────────────────────────────────────────────
// Extracted from ChatPage.tsx (Phase 7 C1). Pure helpers — no React.

export function relativeTimeShort(iso: string | undefined | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return translate('just now');
  const min = Math.floor(sec / 60);
  if (min < 60) return translate('{0}m', { 0: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate('{0}h', { 0: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return translate('{0}d', { 0: day });
  const d = new Date(then);
  return d.toLocaleDateString(getLocaleTag(), { month: 'short', day: 'numeric' });
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (isToday) return `${hh}:${mm}`;
  return `${d.toLocaleDateString(getLocaleTag(), { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

export function daySeparatorLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (dt: Date) =>
    new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return translate('Today');
  if (diffDays === 1) return translate('Yesterday');
  return d
    .toLocaleDateString(getLocaleTag(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase();
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

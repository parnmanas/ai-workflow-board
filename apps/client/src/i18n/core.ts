import english from './locales/en.json';

export const LANGUAGE_STORAGE_KEY = 'awb.locale';
export const LANGUAGES = [
  { code: 'en', name: 'English', tag: 'en-US' },
  { code: 'ko', name: '한국어', tag: 'ko-KR' },
  { code: 'ja', name: '日本語', tag: 'ja-JP' },
  { code: 'zh-CN', name: '中文（简体）', tag: 'zh-CN' },
] as const;
export type Locale = typeof LANGUAGES[number]['code'];
type Catalog = Record<string, string>;
type Parameters = Record<string, string | number | null | undefined>;

const catalogs: Partial<Record<Locale, Catalog>> = { en: english };
const loaders = {
  ko: () => import('./locales/ko.json'),
  ja: () => import('./locales/ja.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
};
let locale: Locale = 'en';
let request = 0;
const listeners = new Set<() => void>();

export function isLocale(value: unknown): value is Locale {
  return LANGUAGES.some(language => language.code === value);
}

export function getLocale(): Locale { return locale; }
export function getLocaleTag(): string {
  return LANGUAGES.find(language => language.code === locale)!.tag;
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The product default is English, independently of the browser/OS language. */
export function savedLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(saved) ? saved : 'en';
  } catch { return 'en'; }
}

export async function setLocale(next: Locale, persist = true): Promise<void> {
  if (!isLocale(next)) next = 'en';
  const currentRequest = ++request;
  if (!catalogs[next] && next !== 'en') {
    catalogs[next] = (await loaders[next]()).default;
  }
  // A slower download must not replace a newer selection.
  if (currentRequest !== request) return;
  locale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh-CN' ? 'zh-Hans' : next;
  if (persist) {
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Private browsing can disable storage. */ }
  }
  listeners.forEach(listener => listener());
}

export async function initializeLocale(): Promise<void> {
  try { await setLocale(savedLocale(), false); }
  catch { await setLocale('en', false); }
}

/** Translate application copy only. User content and protocol values are never passed here. */
export function t(message: string, values: Parameters = {}): string {
  const base = english as Catalog;
  const current = catalogs[locale];
  const translated = current && Object.prototype.hasOwnProperty.call(current, message)
    ? current[message]
    : Object.prototype.hasOwnProperty.call(base, message) ? base[message] : message;
  return translated.replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : slot);
}

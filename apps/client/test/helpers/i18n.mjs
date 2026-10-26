import english from '../../src/i18n/locales/en.json' with { type: 'json' };
import { t } from '../../src/i18n/core.ts';

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expected application copy, including a rendered message with fixture values. */
export function ui(source, values) {
  if (Object.hasOwn(english, source) || values) return t(source, values);
  for (const key of Object.keys(english)) {
    const slots = [...key.matchAll(/\{(\d+)\}/g)].map(match => match[1]);
    if (!slots.length) continue;
    const pattern = escapeRegExp(key).replace(/\\\{\d+\\\}/g, '(.+?)');
    const match = new RegExp(`^${pattern}$`, 's').exec(source);
    if (match) return t(key, Object.fromEntries(slots.map((slot, index) => [slot, match[index + 1]])));
  }
  return source;
}

/** Match a full translated message; fixture interpolation values remain literal. */
export function uiPattern(source, values) {
  return new RegExp(escapeRegExp(ui(source, values)).replace(/\\\{\d+\\\}/g, '.*?'), 's');
}

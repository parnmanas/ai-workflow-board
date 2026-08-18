/**
 * Notification preferences — single persisted record shared by every
 * notification surface.
 *
 * Why this lives outside React: the preference is read by two providers that
 * sit on opposite sides of the tree. ToastProvider (audio cue + the floating
 * mute button) is mounted above AuthProvider, NotificationProvider (browser
 * notifications, badges) well below it. They used to keep separate copies —
 * ToastContext read the legacy `chat_notify_muted` key, NotificationContext
 * read `awb.notifications.prefs` — so flipping "Audio cue" in the settings
 * panel left the chat sound playing and toggling the floating mute button
 * left the panel showing the opposite state.
 *
 * A module-level store with a subscribe() hook lets both read and write the
 * same record. The legacy key is still mirrored on every write so a user who
 * downgrades (or a surface we missed) keeps working.
 */

export interface NotificationPrefs {
  /** Per-source OS/toast notification toggles. Default: all enabled. */
  mentions: boolean;
  chat: boolean;
  tickets: boolean;
  admin: boolean;
  /** Audio cue toggle. Mirrors the legacy `chat_notify_muted` key inverted. */
  audio: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  mentions: true,
  chat: true,
  tickets: true,
  admin: true,
  audio: true,
};

const PREFS_KEY = 'awb.notifications.prefs';
// Legacy key owned by ToastContext's mute button. Still written so the two
// controls stay interchangeable.
const LEGACY_MUTE_KEY = 'chat_notify_muted';

function read(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_NOTIFICATION_PREFS, ...parsed };
    }
    // First load — migrate the legacy mute so returning users keep their choice.
    const legacyMuted = localStorage.getItem(LEGACY_MUTE_KEY) === 'true';
    return { ...DEFAULT_NOTIFICATION_PREFS, audio: !legacyMuted };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

let current: NotificationPrefs = read();
const listeners = new Set<(p: NotificationPrefs) => void>();

export function getNotificationPrefs(): NotificationPrefs {
  return current;
}

export function setNotificationPref(key: keyof NotificationPrefs, value: boolean): NotificationPrefs {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(current));
    localStorage.setItem(LEGACY_MUTE_KEY, String(!current.audio));
  } catch {
    /* quota / private mode — keep the in-memory value */
  }
  for (const fn of listeners) fn(current);
  return current;
}

export function subscribeNotificationPrefs(fn: (p: NotificationPrefs) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

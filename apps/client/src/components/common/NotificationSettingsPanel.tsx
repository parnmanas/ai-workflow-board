import React, { useState } from 'react';
import { tokens } from '../../tokens';
import { useNotifications } from '../../contexts/NotificationContext';
import { UserChannelsModal } from './UserChannelsModal';

/**
 * Dropdown panel for browser notification preferences.
 *
 * Mounted in the sidebar alongside the mention inbox. One icon button
 * toggles the panel; inside the user gets:
 *   - Big "Enable browser notifications" CTA when permission === 'default'
 *     (the only state where requestPermission() is legal to call).
 *   - Denied-state messaging with instructions when the user explicitly
 *     blocked — can't un-block programmatically, has to be in site settings.
 *   - Per-source on/off toggles for mentions, chat, tickets, admin, and
 *     the audio cue. Defaults mirror the legacy chat_notify_muted key.
 */
export function NotificationSettingsPanel() {
  const { prefs, setPref, notificationPermission, requestNotificationPermission } = useNotifications();
  const [open, setOpen] = useState(false);
  const [channelsModalOpen, setChannelsModalOpen] = useState(false);
  const hasNotificationAPI = typeof window !== 'undefined' && 'Notification' in window;
  const permission = notificationPermission;

  const buttonHasAttention = hasNotificationAPI && permission === 'default';

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0',
    fontSize: 12,
    color: tokens.colors.textSecondary,
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Notification settings"
        title={
          !hasNotificationAPI
            ? 'Browser does not support notifications'
            : permission === 'granted'
              ? 'Notification settings'
              : permission === 'denied'
                ? 'Notifications blocked in browser settings'
                : 'Enable browser notifications'
        }
        style={{
          width: 28,
          height: 28,
          borderRadius: tokens.radii.md,
          background: buttonHasAttention
            ? `${tokens.colors.accent}20`
            : 'transparent',
          border: `1px solid ${buttonHasAttention ? tokens.colors.accent : tokens.colors.border}`,
          color: buttonHasAttention
            ? tokens.colors.accentLight
            : permission === 'denied'
              ? tokens.colors.dangerLight
              : tokens.colors.textMuted,
          cursor: hasNotificationAPI ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          padding: 0,
        }}
      >
        {/* bell glyph — uses hair-thin unicode so we stay icon-font-free */}
        {'\u{1F514}'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 36,
            right: 0,
            width: 260,
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            boxShadow: tokens.shadows.overlay,
            padding: '10px 12px',
            zIndex: 1000,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 6 }}>
            Notifications
          </div>
          {!hasNotificationAPI ? (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
              This browser does not expose the Notification API. Only in-app
              toasts and audio will work.
            </div>
          ) : permission === 'default' ? (
            <button
              onClick={async () => {
                await requestNotificationPermission();
              }}
              style={{
                width: '100%',
                padding: '6px 10px',
                fontSize: 12,
                fontWeight: 600,
                background: tokens.colors.accent,
                color: '#fff',
                border: 'none',
                borderRadius: tokens.radii.md,
                cursor: 'pointer',
                marginBottom: 8,
              }}
            >
              Enable browser notifications
            </button>
          ) : permission === 'denied' ? (
            <div
              style={{
                fontSize: 11,
                color: tokens.colors.dangerLight,
                background: `${tokens.colors.dangerBg}30`,
                border: `1px solid ${tokens.colors.dangerBg}`,
                borderRadius: tokens.radii.sm,
                padding: '6px 8px',
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              Browser notifications are blocked. Re-enable them in your
              browser's site settings, then reload.
            </div>
          ) : (
            <div
              style={{
                fontSize: 11,
                color: tokens.colors.successLight,
                marginBottom: 8,
              }}
            >
              Browser notifications enabled.
            </div>
          )}

          <div style={{ borderTop: `1px solid ${tokens.colors.border}`, margin: '6px 0' }} />
          <div style={{ fontSize: 10, fontWeight: 700, color: tokens.colors.borderStrong, textTransform: 'uppercase', marginBottom: 4 }}>
            When notified
          </div>
          <Toggle label="Mentions" checked={prefs.mentions} onChange={(v) => setPref('mentions', v)} rowStyle={rowStyle} />
          <Toggle label="Chat messages" checked={prefs.chat} onChange={(v) => setPref('chat', v)} rowStyle={rowStyle} />
          <Toggle label="Ticket comments" checked={prefs.tickets} onChange={(v) => setPref('tickets', v)} rowStyle={rowStyle} />
          <Toggle label="Admin (pending users, agent errors)" checked={prefs.admin} onChange={(v) => setPref('admin', v)} rowStyle={rowStyle} />
          <div style={{ borderTop: `1px solid ${tokens.colors.border}`, margin: '6px 0' }} />
          <Toggle label="Audio cue" checked={prefs.audio} onChange={(v) => setPref('audio', v)} rowStyle={rowStyle} />
          <div style={{ borderTop: `1px solid ${tokens.colors.border}`, margin: '8px 0 6px' }} />
          <button
            onClick={() => { setOpen(false); setChannelsModalOpen(true); }}
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 600,
              background: 'transparent',
              color: tokens.colors.textPrimary,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.sm,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            External channels (Discord / Slack / Telegram)…
          </button>
        </div>
      )}
      <UserChannelsModal isOpen={channelsModalOpen} onClose={() => setChannelsModalOpen(false)} />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  rowStyle,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  rowStyle: React.CSSProperties;
}) {
  return (
    <label style={{ ...rowStyle, cursor: 'pointer' }}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: tokens.colors.accent }}
      />
    </label>
  );
}

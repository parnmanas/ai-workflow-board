import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { tokens } from '../../tokens';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import type { UserNotificationChannel } from '../../types';

const PROVIDER_LABELS: Record<string, string> = {
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
};

const PROVIDER_TARGET_HINT: Record<string, string> = {
  discord: 'Recipient Discord user ID (snowflake) — bot must share a guild with the user, or a Discord channel ID.',
  slack: 'Slack member ID (e.g. U12345) for DMs, or a channel ID (C…) the bot has access to.',
  telegram: 'Telegram chat ID — usually the user\'s id after they /start the bot.',
};

const PROVIDER_TOKEN_HINT: Record<string, string> = {
  discord: 'Discord bot token (starts with MTk… etc.)',
  slack: 'Slack bot user OAuth token (xoxb-…)',
  telegram: 'Telegram bot token (<bot_id>:<secret>)',
};

interface UserChannelsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Self-service CRUD for the current user's outbound notification channel
 * bindings. Lists existing bindings, lets the user add/edit/delete, and
 * exposes a per-binding "test" button that fires a real send through the
 * configured provider.
 */
export function UserChannelsModal({ isOpen, onClose }: UserChannelsModalProps) {
  const { showToast } = useToast();
  const [items, setItems] = useState<UserNotificationChannel[]>([]);
  const [providers, setProviders] = useState<{ id: string; required_credentials: string[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<UserNotificationChannel | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [list, provs] = await Promise.all([api.getMyChannels(), api.getMyChannelProviders()]);
      setItems(list);
      setProviders(provs);
    } catch (err: any) {
      showToast(err.message || 'Failed to load channels', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleSave = async (
    state: ChannelFormState,
    existing: UserNotificationChannel | null,
  ) => {
    try {
      const credentials: Record<string, string> = {};
      if (state.bot_token) credentials.bot_token = state.bot_token;

      if (existing) {
        const patch: Record<string, any> = {
          target: state.target,
          label: state.label,
          is_active: state.is_active,
          notify_mention: state.notify_mention,
          notify_chat: state.notify_chat,
          notify_ticket: state.notify_ticket,
        };
        // Only include credentials if user typed a new token; otherwise
        // server-side `existing.has_credentials` continues to apply.
        if (state.bot_token) patch.credentials = credentials;
        await api.updateMyChannel(existing.id, patch);
        showToast('Channel updated', 'success');
      } else {
        await api.createMyChannel({
          provider: state.provider,
          target: state.target,
          label: state.label,
          credentials,
          is_active: state.is_active,
          notify_mention: state.notify_mention,
          notify_chat: state.notify_chat,
          notify_ticket: state.notify_ticket,
        });
        showToast('Channel created', 'success');
      }
      setAdding(false);
      setEditing(null);
      await refresh();
    } catch (err: any) {
      showToast(err.message || 'Failed to save channel', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this notification channel? This cannot be undone.')) return;
    try {
      await api.deleteMyChannel(id);
      showToast('Channel deleted', 'success');
      await refresh();
    } catch (err: any) {
      showToast(err.message || 'Failed to delete channel', 'error');
    }
  };

  const handleTest = async (id: string) => {
    try {
      const res = await api.testMyChannel(id);
      if (res.success) {
        showToast('Test message sent', 'success');
        await refresh();
      } else {
        showToast(res.error || 'Test failed', 'error');
      }
    } catch (err: any) {
      showToast(err.message || 'Test failed', 'error');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="My notification channels" maxWidth={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.md }}>
        <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
          AWB sends mention pings, chat-room messages, and ticket activity to the
          channels you bind here. Bot tokens are encrypted at rest and never
          echoed back over the API.
        </div>

        {(adding || editing) ? (
          <ChannelForm
            providers={providers}
            initial={editing}
            onCancel={() => { setAdding(false); setEditing(null); }}
            onSubmit={(state) => handleSave(state, editing)}
          />
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setAdding(true)}
                style={primaryButton}
              >
                + Add channel
              </button>
            </div>
            {loading ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
            ) : items.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: tokens.colors.textMuted,
                  textAlign: 'center',
                  padding: '20px 0',
                  border: `1px dashed ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                }}
              >
                No channels yet. Add Discord / Slack / Telegram targets to start
                receiving notifications outside AWB.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((ch) => (
                  <ChannelRow
                    key={ch.id}
                    channel={ch}
                    onEdit={() => setEditing(ch)}
                    onDelete={() => handleDelete(ch.id)}
                    onTest={() => handleTest(ch.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

interface ChannelFormState {
  provider: string;
  target: string;
  label: string;
  bot_token: string;
  is_active: number;
  notify_mention: number;
  notify_chat: number;
  notify_ticket: number;
}

function ChannelForm({
  providers,
  initial,
  onSubmit,
  onCancel,
}: {
  providers: { id: string; required_credentials: string[] }[];
  initial: UserNotificationChannel | null;
  onSubmit: (state: ChannelFormState) => void | Promise<void>;
  onCancel: () => void;
}) {
  const defaultProvider = useMemo(() => initial?.provider || providers[0]?.id || 'discord', [initial, providers]);
  const [state, setState] = useState<ChannelFormState>({
    provider: defaultProvider,
    target: initial?.target || '',
    label: initial?.label || '',
    bot_token: '',
    is_active: initial?.is_active ?? 1,
    notify_mention: initial?.notify_mention ?? 1,
    notify_chat: initial?.notify_chat ?? 1,
    notify_ticket: initial?.notify_ticket ?? 0,
  });

  const isEdit = !!initial;
  const tokenPlaceholder = isEdit && initial?.has_credentials
    ? 'Leave blank to keep existing token'
    : PROVIDER_TOKEN_HINT[state.provider] || 'Bot token';

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(state); }}
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textPrimary }}>
        {isEdit ? `Edit ${PROVIDER_LABELS[initial!.provider] || initial!.provider} channel` : 'New channel'}
      </div>

      {!isEdit && (
        <Field label="Provider">
          <select
            value={state.provider}
            onChange={(e) => setState({ ...state, provider: e.target.value })}
            style={inputStyle}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{PROVIDER_LABELS[p.id] || p.id}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Label" hint="Friendly name shown in this list">
        <input
          type="text"
          value={state.label}
          onChange={(e) => setState({ ...state, label: e.target.value })}
          placeholder={`My ${PROVIDER_LABELS[state.provider] || state.provider}`}
          style={inputStyle}
        />
      </Field>

      <Field label="Target" hint={PROVIDER_TARGET_HINT[state.provider] || ''}>
        <input
          type="text"
          required
          value={state.target}
          onChange={(e) => setState({ ...state, target: e.target.value })}
          placeholder="e.g. 123456789012345678"
          style={inputStyle}
        />
      </Field>

      <Field label="Bot token" hint={tokenPlaceholder}>
        <input
          type="password"
          autoComplete="new-password"
          value={state.bot_token}
          onChange={(e) => setState({ ...state, bot_token: e.target.value })}
          placeholder={tokenPlaceholder}
          style={inputStyle}
        />
      </Field>

      <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: tokens.spacing.sm }}>
        <div style={{ fontSize: 11, color: tokens.colors.borderStrong, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
          Notify on
        </div>
        <ToggleRow label="Mentions of me" checked={!!state.notify_mention} onChange={(v) => setState({ ...state, notify_mention: v ? 1 : 0 })} />
        <ToggleRow label="Chat messages in my rooms" checked={!!state.notify_chat} onChange={(v) => setState({ ...state, notify_chat: v ? 1 : 0 })} />
        <ToggleRow label="Ticket activity (assigned/reported/reviewed)" checked={!!state.notify_ticket} onChange={(v) => setState({ ...state, notify_ticket: v ? 1 : 0 })} />
        <div style={{ borderTop: `1px solid ${tokens.colors.border}`, marginTop: 6, paddingTop: 6 }}>
          <ToggleRow label="Channel active" checked={!!state.is_active} onChange={(v) => setState({ ...state, is_active: v ? 1 : 0 })} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={onCancel} style={secondaryButton}>Cancel</button>
        <button type="submit" style={primaryButton}>{isEdit ? 'Save' : 'Create'}</button>
      </div>
    </form>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onDelete,
  onTest,
}: {
  channel: UserNotificationChannel;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const status = channel.verified_at
    ? `verified ${new Date(channel.verified_at).toLocaleDateString()}`
    : channel.has_credentials
      ? 'unverified'
      : 'no credentials';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: tokens.colors.surfaceSubtle,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textPrimary }}>
            {PROVIDER_LABELS[channel.provider] || channel.provider}
          </span>
          {channel.label && (
            <span style={{ fontSize: 12, color: tokens.colors.textSecondary }}>· {channel.label}</span>
          )}
          {!channel.is_active && (
            <span style={{ fontSize: 10, color: tokens.colors.textMuted, padding: '1px 6px', border: `1px solid ${tokens.colors.border}`, borderRadius: 6 }}>
              inactive
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
          target: {channel.target} · {status}
        </div>
      </div>
      <button onClick={onTest} style={smallButton}>Test</button>
      <button onClick={onEdit} style={smallButton}>Edit</button>
      <button onClick={onDelete} style={{ ...smallButton, color: tokens.colors.dangerLight, borderColor: tokens.colors.dangerBg }}>Delete</button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10, color: tokens.colors.textMuted, lineHeight: 1.4 }}>{hint}</span>}
    </label>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', fontSize: 12, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: tokens.colors.accent }} />
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  background: tokens.colors.surface,
  color: tokens.colors.textPrimary,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.sm,
  outline: 'none',
};

const primaryButton: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  background: tokens.colors.accent,
  color: '#fff',
  border: 'none',
  borderRadius: tokens.radii.md,
  cursor: 'pointer',
};

const secondaryButton: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  background: 'transparent',
  color: tokens.colors.textSecondary,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  cursor: 'pointer',
};

const smallButton: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 600,
  background: 'transparent',
  color: tokens.colors.textSecondary,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.sm,
  cursor: 'pointer',
};

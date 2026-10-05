import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAccounts } from '../hooks/useAccounts';
import AccountSelector from './AccountSelector';
import { Account } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import HarnessConfigEditor from './HarnessConfigEditor';
import ClonePolicyEditor from './ClonePolicyEditor';
import { Button, Input, PermissionNotice } from './common';
import { tokens } from '../tokens';
import {
  AUTO_ARCHIVE_DAYS_MAX,
  AUTO_ARCHIVE_DAYS_MIN,
  buildDispatchPausePatch,
  buildDispatchSettingsPatch,
  dispatchSettingsToForm,
  isDispatchPaused,
  type DispatchSettingsForm,
  MAX_CONCURRENT_TICKETS_PER_AGENT_MAX,
} from './accountSettings.logic';

// Account Settings (ticket 7122600c). Account-wide defaults for ticket
// work: the dispatch settings (language, per-agent concurrency, auto-archive,
// pause — formerly per board, docs/tickets.md), the agent harness shipped on
// every ticket dispatch, and the repo clone policy (a Project overrides it per
// key from its own Clone Policy, ticket bddb63ee). Admin-gated — these apply to
// every ticket and every repo checkout in the account, so edits belong to
// operators.
export default function AccountSettingsPage() {
  const { currentAccountId, setCurrentAccount, refreshUser } = useAuth();
  const wsId = currentAccountId || '';
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const { accounts, createAccount, updateAccount, deleteAccount, refresh } = useAccounts();
  const [account, setAccount] = useState<Account | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const ws = await api.getAccount(wsId);
      setAccount(ws);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load account', 'error');
    }
  }, [wsId, showToast]);

  useEffect(() => { load(); }, [load]);

  const pageStyle: React.CSSProperties = {
    padding: '24px',
    background: tokens.colors.surface,
    color: tokens.colors.textStrong,
    boxSizing: 'border-box',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  };

  if (!hasPermission('admin.access')) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader title="Ownership & defaults" />
        <div style={pageStyle}>
          <PermissionNotice
            title="Admin access required"
            message="Admin access is required to edit account settings."
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Ownership & defaults" description={account?.name} />
      <div style={pageStyle}>
        <section style={{ marginBottom: 24 }}>
          <p style={{ color: tokens.colors.textSecondary, fontSize: 13, marginTop: 0 }}>
            Manage personal and organization ownership. This account supplies defaults for new work;
            sessions, tickets and missions remain accessible from their direct links.
          </p>
          <AccountSelector
            accounts={accounts}
            currentAccountId={currentAccountId}
            onSelect={setCurrentAccount}
            onCreate={async (name, description) => {
              const created = await createAccount(name, description);
              await refreshUser();
              if (created?.id) setCurrentAccount(created.id);
            }}
            onUpdate={async (id, data) => { await updateAccount(id, data); await load(); }}
            onDelete={async (id) => {
              await deleteAccount(id);
              await refresh();
              await refreshUser();
            }}
          />
        </section>
        {!account ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <TicketDispatchSettings account={account} onSaved={setAccount} />
            <HarnessConfigEditor
              raw={account.harness_config}
              title="Agent Harness (account default)"
              description={
                <>
                  Harness shipped with <strong>every ticket dispatch</strong> in this account:
                  extra system prompt, tool allow/deny lists, model and permission mode. Leave
                  everything empty for the current (no-harness) behaviour.
                </>
              }
              onSave={async (config) => {
                try {
                  await api.updateAccount(account.id, { harness_config: config });
                  await load();
                  showToast(config === null ? 'Account default harness cleared' : 'Account default harness saved', 'success');
                } catch (err: any) {
                  // Server zod rejection (400) surfaces its message here.
                  showToast(err?.message || 'Failed to save harness', 'error');
                }
              }}
            />
            <ClonePolicyEditor
              raw={account.clone_policy}
              title="Repository Clone Policy (account default)"
              description={
                <>
                  Default clone budget and strategy for <strong>every project repository</strong> checked
                  out in this account: wall-clock timeout, idle-stall timeout, and the
                  shallow / partial / single-branch flags. A project overrides individual keys from
                  its own Clone Policy. Leave everything empty for the system defaults (clone
                  timeout 3600s, idle timeout off, full clone).
                </>
              }
              onSave={async (policy) => {
                try {
                  await api.updateAccount(account.id, { clone_policy: policy });
                  await load();
                  showToast(policy === null ? 'Account clone policy cleared' : 'Account clone policy saved', 'success');
                } catch (err: any) {
                  // 서버 zod 거부(400) 메시지가 여기로 올라온다.
                  showToast(err?.message || 'Failed to save clone policy', 'error');
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface TicketDispatchSettingsProps {
  account: Account;
  /** Receives the PATCH response so the page shows what the server stored. */
  onSaved(next: Account): void;
}

/**
 * "Ticket dispatch" section. Language / concurrency / auto-archive save
 * together (only changed keys are sent); the pause switch saves on its own
 * immediately — it is an operational stop, not a draft.
 */
export function TicketDispatchSettings({ account, onSaved }: TicketDispatchSettingsProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<DispatchSettingsForm>(() => dispatchSettingsToForm(account));
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);

  // Re-sync when the row refreshes (saved here or by another section).
  useEffect(() => {
    setForm(dispatchSettingsToForm(account));
  }, [account.id, account.language, account.max_concurrent_tickets_per_agent, account.auto_archive_days]);

  // Validated live so a bad value explains itself instead of just greying Save.
  const { patch, errors } = buildDispatchSettingsPatch(form, account);
  const dirty = Object.keys(patch).length > 0;
  const paused = isDispatchPaused(account);

  const patchForm = (next: Partial<DispatchSettingsForm>) => {
    setForm((prev) => ({ ...prev, ...next }));
  };

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const saved = await api.updateAccount(account.id, patch);
      onSaved({ ...account, ...patch, ...(saved || {}) });
      showToast('Ticket dispatch settings saved', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to save ticket dispatch settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const togglePause = async (nextPaused: boolean) => {
    const pausePatch = buildDispatchPausePatch(nextPaused);
    setPausing(true);
    try {
      const saved = await api.updateAccount(account.id, pausePatch);
      onSaved({ ...account, ...pausePatch, ...(saved || {}) });
      showToast(nextPaused ? 'Ticket dispatch paused' : 'Ticket dispatch resumed', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to change ticket dispatch', 'error');
    } finally {
      setPausing(false);
    }
  };

  const hintStyle: React.CSSProperties = { fontSize: 11, color: tokens.colors.textMuted, marginTop: 4 };

  return (
    <section
      aria-label="Ticket dispatch"
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Ticket dispatch
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        How tickets in this account are handed to their assignee agents.
      </div>

      <label
        style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 14,
          borderRadius: tokens.radii.md,
          border: `1px solid ${paused ? tokens.colors.danger : tokens.colors.border}`,
          background: tokens.colors.surface,
          cursor: pausing ? 'wait' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={paused}
          disabled={pausing}
          onChange={(e) => { void togglePause(e.target.checked); }}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ fontSize: 13, fontWeight: 600, color: paused ? tokens.colors.danger : tokens.colors.textPrimary }}>
            Pause ticket dispatch
          </span>
          <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
            {paused
              ? `Paused since ${formatPausedAt(account.dispatch_paused_at)} — no ticket is sent to an agent. People can still edit, comment on and move tickets.`
              : 'Stops every ticket dispatch in this account until resumed. People can still edit, comment on and move tickets.'}
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 200px', minWidth: 200 }}>
          <Input
            label="Language"
            value={form.language}
            placeholder="e.g. Korean (empty = agent default)"
            onChange={(e) => patchForm({ language: (e.target as HTMLInputElement).value })}
            error={errors.language}
          />
          <div style={hintStyle}>Language agents write in when working a ticket here.</div>
        </div>
        <div style={{ flex: '0 1 200px', minWidth: 180 }}>
          <Input
            label="Max concurrent tickets per agent"
            type="number"
            min={1}
            max={MAX_CONCURRENT_TICKETS_PER_AGENT_MAX}
            step={1}
            value={form.maxConcurrent}
            onChange={(e) => patchForm({ maxConcurrent: (e.target as HTMLInputElement).value })}
            error={errors.maxConcurrent}
          />
          <div style={hintStyle}>In-progress tickets one agent works at once; the rest wait in To Do.</div>
        </div>
        <div style={{ flex: '0 1 200px', minWidth: 180 }}>
          <Input
            label="Auto-archive done tickets (days)"
            type="number"
            min={AUTO_ARCHIVE_DAYS_MIN}
            max={AUTO_ARCHIVE_DAYS_MAX}
            step={1}
            value={form.autoArchiveDays}
            placeholder="off"
            onChange={(e) => patchForm({ autoArchiveDays: (e.target as HTMLInputElement).value })}
            error={errors.autoArchiveDays}
          />
          <div style={hintStyle}>
            Done tickets idle this long are archived ({AUTO_ARCHIVE_DAYS_MIN}–{AUTO_ARCHIVE_DAYS_MAX}). Empty = never.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

function formatPausedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

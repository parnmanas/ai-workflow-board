import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { CatalogScope, CliLoginInstanceOption, CliLoginSession } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select } from '../common';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const POLL_INTERVAL_MS = 3000;

function instanceLabel(inst: CliLoginInstanceOption): string {
  if (inst.codex_installed && inst.codex_healthy) return inst.hostname;
  if (inst.codex_installed) return `${inst.hostname} (codex installed, health unknown)`;
  return `${inst.hostname} (codex not detected — may still work)`;
}

function statusMessage(session: CliLoginSession): string {
  switch (session.status) {
    case 'starting':
      return 'Starting Codex login on the Runtime Host…';
    case 'awaiting_user':
      return 'Open the link below and enter the code to approve.';
    case 'completing':
      return 'Approved — finishing up…';
    case 'succeeded':
      return 'Codex credential created.';
    case 'failed':
      return session.error_detail || 'Login failed.';
    case 'timed_out':
      return session.error_detail || 'Login timed out before it was approved.';
    case 'cancelled':
      return session.error_detail || 'Login cancelled.';
    default:
      return '';
  }
}

export default function CliAutoLogin({
  workspaceId,
  createScope = 'workspace',
  onCreated,
}: {
  workspaceId: string;
  createScope?: CatalogScope;
  onCreated?: () => void | Promise<void>;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [instances, setInstances] = useState<CliLoginInstanceOption[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [credentialName, setCredentialName] = useState('Codex login');
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<CliLoginSession | null>(null);
  const [error, setError] = useState('');

  const isGlobal = createScope === 'global';

  const loadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const list = await api.listCliLoginInstances(isGlobal ? undefined : workspaceId);
      setInstances(list);
      if (list.length > 0 && !instanceId) setInstanceId(list[0].instance_id);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Runtime Host instances.');
    } finally {
      setInstancesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGlobal, workspaceId]);

  useEffect(() => {
    if (open && !session) void loadInstances();
  }, [open, session, loadInstances]);

  const reset = () => {
    setSession(null);
    setError('');
    setCredentialName('Codex login');
  };

  const close = () => {
    setOpen(false);
    // Don't reset while a session is still in flight — a poll/SSE update
    // arriving after close would otherwise be silently dropped and the user
    // has no way to check whether their login actually finished.
    if (session && TERMINAL_STATUSES.has(session.status)) reset();
  };

  const start = async () => {
    if (!credentialName.trim()) {
      setError('Credential name is required.');
      return;
    }
    if (!instanceId) {
      setError('Select a Runtime Host instance first.');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const started = await api.startCliLogin({
        scope: isGlobal ? 'global' : 'workspace',
        workspace_id: isGlobal ? undefined : workspaceId,
        cli: 'codex',
        credential_name: credentialName.trim(),
        instance_id: instanceId,
      });
      setSession(started);
    } catch (err: any) {
      setError(err?.message || 'Failed to start login.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    try {
      const cancelled = await api.cancelCliLogin(session.id, isGlobal ? undefined : workspaceId);
      setSession(cancelled);
    } catch (err: any) {
      showToast(err?.message || 'Failed to cancel login.', 'error');
    }
  };

  // SSE push — fast path. Filtered to this session so a second admin's
  // concurrent login attempt on another manager never bleeds into this one.
  useBoardStreamEvent('cli_login_progress', (data: any) => {
    setSession((prev) => {
      if (!prev || !data || data.session_id !== prev.id) return prev;
      return {
        ...prev,
        status: data.status,
        verification_url: data.verification_url ?? prev.verification_url,
        user_code: data.user_code ?? prev.user_code,
        error_detail: data.error_detail || prev.error_detail,
        created_credential_id: data.created_credential_id ?? prev.created_credential_id,
      };
    });
  });

  // Poll fallback — in case an SSE frame is dropped/delayed, the modal never
  // gets permanently stuck on a stale status.
  useEffect(() => {
    if (!session || TERMINAL_STATUSES.has(session.status)) return;
    const sessionId = session.id;
    const timer = setInterval(async () => {
      try {
        const fresh = await api.getCliLoginSession(sessionId, isGlobal ? undefined : workspaceId);
        setSession(fresh);
      } catch {
        // best-effort — SSE or the next tick will catch up
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [session?.id, session?.status, isGlobal, workspaceId]);

  // succeeded → refresh the credentials list once so the new row appears
  // without the user having to close the modal first.
  useEffect(() => {
    if (session?.status === 'succeeded') void onCreated?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status]);

  return (
    <>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        Log in with Codex
      </Button>
      <Modal
        isOpen={open}
        onClose={close}
        title="Codex Login"
        maxWidth={520}
        footer={
          !session ? (
            <>
              <Button variant="secondary" onClick={close} disabled={starting}>
                Cancel
              </Button>
              <Button variant="primary" onClick={start} disabled={starting} loading={starting}>
                Start Login
              </Button>
            </>
          ) : TERMINAL_STATUSES.has(session.status) ? (
            <>
              {session.status !== 'succeeded' && (
                <Button variant="secondary" onClick={reset}>
                  Try Again
                </Button>
              )}
              <Button variant="primary" onClick={close}>
                Close
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={cancel}>
              Cancel Login
            </Button>
          )
        }
      >
        {!session ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
              AWB runs <code>codex login --device-auth</code> on a Runtime Host for you — no terminal or
              file upload needed. You'll just approve the login in your browser.
            </div>
            <Select
              label="Runtime Host"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              disabled={instancesLoading || instances.length === 0}
              placeholder={instancesLoading ? 'Loading…' : instances.length === 0 ? 'No Runtime Host online' : undefined}
              options={instances.map((i) => ({ value: i.instance_id, label: instanceLabel(i) }))}
            />
            {!instancesLoading && instances.length === 0 && (
              <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                No Runtime Host instance is currently online. Use "Import from File" instead, or start a
                Runtime Host and reopen this dialog.
              </div>
            )}
            <Input
              label="Credential Name"
              value={credentialName}
              onChange={(e) => setCredentialName(e.target.value)}
              error={error || undefined}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
              {statusMessage(session)}
            </div>
            {session.status === 'awaiting_user' && session.verification_url && (
              <div
                style={{
                  padding: 14,
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.border}`,
                  background: tokens.colors.surfaceSubtle,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <a href={session.verification_url} target="_blank" rel="noreferrer">
                  {session.verification_url}
                </a>
                {session.user_code && (
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: tokens.typography.fontWeightSemibold,
                      letterSpacing: 2,
                      textAlign: 'center',
                      padding: '8px 0',
                    }}
                  >
                    {session.user_code}
                  </div>
                )}
              </div>
            )}
            {(session.status === 'starting' || session.status === 'awaiting_user' || session.status === 'completing') && (
              <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                Waiting for approval — this dialog updates automatically.
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

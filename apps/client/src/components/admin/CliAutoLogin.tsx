import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { CatalogScope, CliLoginInstanceOption, CliLoginSession } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select } from '../common';
import { cliLabel, cliLoginInfo, loginCapableClis, useCliCatalog, type CliLoginDescriptor } from '../../cli/catalog';
import { defaultLoginCli } from '../../cli/presentation';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const POLL_INTERVAL_MS = 3000;

/**
 * Some CLIs log in per **provider inside the CLI** rather than as one account
 * (`login.provider_scoped`, e.g. opencode's `-p <provider> -m <method>`). The
 * catalog ships presets for the combinations that finish in a browser; API-key
 * providers are quicker to add from the Credentials screen. Method strings are
 * matched verbatim by the CLI, so anything outside the presets stays a free
 * text entry (a CLI growing its list never needs a UI change).
 */
const PROVIDER_CUSTOM = '__custom__';

function presetId(index: number): string {
  return `preset-${index}`;
}

// 로그인 다이얼로그 설명문에만 쓰는 안내용 커맨드 문자열 — 실제 spawn은
// agent-manager의 CliLoginManager가 담당(apps/agent-manager/src/lib/cli-login.ts).
// provider_scoped CLI 는 카탈로그 커맨드의 <provider>/<method> 자리에 현재 선택을 채운다.
export function cliLoginCommand(cli: string, provider: string, method: string): string {
  const login = cliLoginInfo(cli);
  if (!login) return '';
  if (!login.provider_scoped) return login.command;
  return login.command
    .replace('<provider>', provider || '<provider>')
    .replace('<method>', method || '<method>');
}

/** Install/health of `cli` on a Runtime Host: the keyed `clis` map first,
 *  then the legacy flat `<cli>_installed` / `<cli>_healthy` keys. */
function cliHealthOf(inst: CliLoginInstanceOption, cli: string): { installed: boolean; healthy: boolean } {
  const keyed = inst.clis?.[cli];
  if (keyed) return { installed: !!keyed.installed, healthy: !!keyed.healthy };
  const flat = inst as unknown as Record<string, unknown>;
  return { installed: !!flat[`${cli}_installed`], healthy: !!flat[`${cli}_healthy`] };
}

export function instanceLabel(inst: CliLoginInstanceOption, cli: string): string {
  const { installed, healthy } = cliHealthOf(inst, cli);
  const label = cliLabel(cli).toLowerCase();
  if (installed && healthy) return inst.hostname;
  if (installed) return `${inst.hostname} (${label} installed, health unknown)`;
  return `${inst.hostname} (${label} not detected — may still work)`;
}

function statusMessage(session: CliLoginSession): string {
  const label = cliLabel(session.cli);
  switch (session.status) {
    case 'starting':
      return `Starting ${label} login on the Runtime Host…`;
    case 'awaiting_user':
      // claude의 device-auth 흐름은 codex와 달리 사용자가 입력할 one-time
      // code가 없다 — 링크를 여는 것 자체가 승인의 전부다.
      return session.user_code
        ? 'Open the link below and enter the code to approve.'
        : 'Open the link below in your browser to approve.';
    case 'completing':
      return 'Approved — finishing up…';
    case 'succeeded':
      return `${label} credential created.`;
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

function defaultCredentialName(cli: string): string {
  return `${cliLabel(cli)} login`;
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
  const catalog = useCliCatalog();
  const loginClis = loginCapableClis(catalog);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>(() => defaultLoginCli());
  const [instances, setInstances] = useState<CliLoginInstanceOption[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [credentialName, setCredentialName] = useState(() => defaultCredentialName(defaultLoginCli()));
  // provider_scoped CLI 전용 — 프리셋 id 또는 직접 입력.
  const [providerPreset, setProviderPreset] = useState<string>(presetId(0));
  const [customProvider, setCustomProvider] = useState('');
  const [customMethod, setCustomMethod] = useState('');
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<CliLoginSession | null>(null);
  const [error, setError] = useState('');

  const isGlobal = createScope === 'global';
  const login: CliLoginDescriptor | null = cliLoginInfo(provider);
  const providerScoped = !!login?.provider_scoped;
  const presets = login?.presets ?? [];
  const presetIndex = providerPreset.startsWith('preset-') ? Number(providerPreset.slice('preset-'.length)) : -1;
  const preset = providerScoped && presetIndex >= 0 ? presets[presetIndex] ?? null : null;
  const scopedProvider = (preset ? preset.provider : customProvider).trim();
  const scopedMethod = (preset ? preset.method : customMethod).trim();

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

  const reset = (nextProvider: string = provider) => {
    setSession(null);
    setError('');
    setProvider(nextProvider);
    setCredentialName(defaultCredentialName(nextProvider));
  };

  const changeProvider = (next: string) => {
    // Only overwrite the name if it still matches the outgoing provider's
    // default — an operator-typed custom name must never be clobbered by a
    // provider switch.
    if (!credentialName.trim() || credentialName === defaultCredentialName(provider)) {
      setCredentialName(defaultCredentialName(next));
    }
    setProvider(next);
    setProviderPreset(presetId(0));
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
    if (providerScoped && (!scopedProvider || !scopedMethod)) {
      // 빈 채로 보내면 CLI 가 선택 UI 를 띄우려다 파이프 뒤에서 멎는다 — 서버도
      // 막지만, 여기서 막으면 왕복 없이 바로 알려줄 수 있다.
      setError(`Enter both the ${cliLabel(provider)} provider and the login method.`);
      return;
    }
    setStarting(true);
    setError('');
    try {
      const started = await api.startCliLogin({
        scope: isGlobal ? 'global' : 'workspace',
        workspace_id: isGlobal ? undefined : workspaceId,
        cli: provider,
        ...(providerScoped ? { cli_provider: scopedProvider, cli_method: scopedMethod } : {}),
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
        // Server sends this verbatim (including explicit null once a real
        // url/code supersedes it) — no `??` fallback, the server is
        // authoritative on whether the raw fallback should still show.
        raw_output_fallback: data.raw_output_fallback,
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
        Log in with CLI
      </Button>
      <Modal
        isOpen={open}
        onClose={close}
        title={`${cliLabel(session?.cli ?? provider)} Login`}
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
                <Button variant="secondary" onClick={() => reset()}>
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
              AWB runs <code>{cliLoginCommand(provider, scopedProvider, scopedMethod)}</code> on a Runtime
              Host for you — no terminal or file upload needed. You'll just approve the login in your browser.
            </div>
            <Select
              label="CLI"
              value={provider}
              onChange={(e) => changeProvider(e.target.value)}
              options={loginClis.map((d) => ({ value: d.id, label: d.label }))}
            />
            {providerScoped && (
              <>
                <Select
                  label={`${cliLabel(provider)} Provider`}
                  value={providerPreset}
                  onChange={(e) => setProviderPreset(e.target.value)}
                  options={[
                    ...presets.map((p, index) => ({ value: presetId(index), label: p.label })),
                    { value: PROVIDER_CUSTOM, label: 'Other (enter manually)…' },
                  ]}
                />
                {!preset && (
                  <>
                    <Input
                      label="Provider id"
                      placeholder="e.g. openai"
                      value={customProvider}
                      onChange={(e) => setCustomProvider(e.target.value)}
                    />
                    <Input
                      label="Login method"
                      placeholder='exact label, e.g. ChatGPT Pro/Plus (headless)'
                      value={customMethod}
                      onChange={(e) => setCustomMethod(e.target.value)}
                    />
                  </>
                )}
                <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                  {cliLabel(provider)} logs in per provider. Only methods that finish in a browser work here —
                  providers that just want an API key pasted are quicker to add with "Import from File".
                  Run <code>{cliLoginCommand(provider, '<provider>', '?')}</code> on the host to see the
                  exact method labels it accepts.
                </div>
              </>
            )}
            <Select
              label="Runtime Host"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              disabled={instancesLoading || instances.length === 0}
              placeholder={instancesLoading ? 'Loading…' : instances.length === 0 ? 'No Runtime Host online' : undefined}
              options={instances.map((i) => ({ value: i.instance_id, label: instanceLabel(i, provider) }))}
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
            {session.status === 'awaiting_user' && !session.verification_url && session.raw_output_fallback && (
              <div
                style={{
                  padding: 14,
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.border}`,
                  background: tokens.colors.surfaceSubtle,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                  Couldn't recognize the login prompt automatically — here's what {cliLabel(session.cli)} printed.
                  Look for a URL (and a one-time code, if shown) below.
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: tokens.typography.fontSizeXs,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {session.raw_output_fallback}
                </pre>
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

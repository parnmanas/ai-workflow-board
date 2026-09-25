import React, { useRef, useState } from 'react';
import { api } from '../../api';
import type { CatalogScope } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal } from '../common';
import { cliLabel, cliLoginInfo, loginCapableClis, useCliCatalog } from '../../cli/catalog';
import { defaultLoginCli } from '../../cli/presentation';

/** What the importer needs to know about one CLI — all read from the catalog
 *  login descriptor (`cliLoginInfo`): the command that produces the file, where
 *  the CLI writes it, which credential provider/field stores it, and an
 *  optional companion file (codex's config.toml). */
interface ImportDetails {
  label: string;
  command: string;
  file: string;
  provider: string;
  field: string;
  extraFile: string | null;
}

export function importDetailsFor(cli: string): ImportDetails | null {
  const login = cliLoginInfo(cli);
  if (!login) return null;
  return {
    label: `${cliLabel(cli)} CLI`,
    command: login.command,
    file: login.file_path ?? '',
    provider: login.harvest_provider,
    field: login.harvest_field,
    extraFile: login.extra_file_field,
  };
}

function validateJsonFile(contents: string): string | null {
  if (!contents.trim()) return 'Select the credential file created by the CLI login.';
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return 'The credential file must contain a JSON object.';
    }
    return null;
  } catch {
    return 'The selected credential file is not valid JSON.';
  }
}

export default function CliCredentialImport({
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
  const credentialInput = useRef<HTMLInputElement | null>(null);
  const configInput = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>(() => defaultLoginCli());
  const [name, setName] = useState('');
  const [credentialJson, setCredentialJson] = useState('');
  const [extraFileContents, setExtraFileContents] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const details = importDetailsFor(provider) ?? importDetailsFor(defaultLoginCli());

  const reset = (nextProvider: string = provider) => {
    setProvider(nextProvider);
    setName('');
    setCredentialJson('');
    setExtraFileContents('');
    setFileName('');
    setError('');
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    reset(defaultLoginCli());
  };

  const readFile = async (file: File, kind: 'credential' | 'extra') => {
    const contents = await file.text();
    if (kind === 'credential') {
      setCredentialJson(contents);
      setFileName(file.name);
      setError('');
      if (!name.trim() && details) setName(`${details.label} login`);
    } else {
      setExtraFileContents(contents);
    }
  };

  const copyCommand = async () => {
    if (!details) return;
    await navigator.clipboard.writeText(details.command);
    showToast('Login command copied.', 'success');
  };

  const createCredential = async () => {
    if (!details) {
      setError('No CLI in the catalog supports file import.');
      return;
    }
    const jsonError = validateJsonFile(credentialJson);
    if (!name.trim()) {
      setError('Credential name is required.');
      return;
    }
    if (jsonError) {
      setError(jsonError);
      return;
    }
    if (createScope !== 'global' && !workspaceId) {
      setError('Select a workspace first.');
      return;
    }

    setSaving(true);
    try {
      await api.createCredential({
        scope: createScope === 'global' ? 'global' : 'workspace',
        workspace_id: createScope === 'global' ? undefined : workspaceId,
        name: name.trim(),
        description: `Imported from ${details.file} after ${details.command}.`,
        provider: details.provider,
        credentials: {
          [details.field]: credentialJson.trim(),
          ...(details.extraFile && extraFileContents.trim() ? { [details.extraFile]: extraFileContents } : {}),
        },
      });
      showToast(`${details.label} credential created.`, 'success');
      setOpen(false);
      reset(defaultLoginCli());
      await onCreated?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to create credential.');
    } finally {
      setSaving(false);
    }
  };

  const extraFileName = details?.extraFile ? details.extraFile.replace(/_/g, '.') : '';

  return (
    <>
      {/* 티켓 b2e79108 — 자동 로그인(CliAutoLogin)이 1차 진입점이 된 뒤로, 이
          버튼은 매니저 오프라인/원격 호스트 로그인 등 자동 경로가 안 될 때의
          수동 폴백이다. */}
      <Button variant="ghost" size="md" onClick={() => setOpen(true)}>Import from File</Button>
      <Modal
        isOpen={open}
        onClose={close}
        title="Import CLI Login Credential"
        maxWidth={620}
        footer={(
          <>
            <Button variant="secondary" onClick={close} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={createCredential} disabled={saving || !details} loading={saving}>
              Create Credential
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: 13, lineHeight: 1.55 }}>
            Log in on this computer, then import the generated credential file. AWB encrypts it as a reusable
            workspace credential, so each managed agent and computer can select the account it needs.
          </p>

          <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="CLI provider">
            {loginClis.map((d) => (
              <Button
                key={d.id}
                variant={provider === d.id ? 'primary' : 'secondary'}
                onClick={() => reset(d.id)}
              >
                {importDetailsFor(d.id)?.label ?? d.label}
              </Button>
            ))}
          </div>

          {details && (
            <>
              <div style={{ padding: 14, borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface }}>
                <div style={{ color: tokens.colors.textStrong, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>1. Run the login command</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ flex: 1, padding: '9px 10px', borderRadius: tokens.radii.sm, background: tokens.colors.surfaceCard, color: tokens.colors.textPrimary }}>
                    {details.command}
                  </code>
                  <Button variant="secondary" size="sm" onClick={copyCommand}>Copy</Button>
                </div>
                <div style={{ marginTop: 8, color: tokens.colors.textMuted, fontSize: 12 }}>
                  Complete the browser sign-in opened by the CLI. Your login remains local until you choose the file below.
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface }}>
                <div style={{ color: tokens.colors.textStrong, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>2. Select the generated credential file</div>
                <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginBottom: 10 }}>
                  File location: <code>{details.file}</code>. Hidden folders can be shown with Ctrl/Cmd + Shift + . in most file pickers.
                </div>
                <input
                  ref={credentialInput}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file, 'credential');
                    event.target.value = '';
                  }}
                />
                <Button variant="secondary" onClick={() => credentialInput.current?.click()}>
                  {fileName ? `Selected: ${fileName}` : `Choose ${details.file.split('/').pop()}`}
                </Button>
                {details.extraFile && (
                  <>
                    <input
                      ref={configInput}
                      type="file"
                      accept=".toml,.json,text/plain"
                      style={{ display: 'none' }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void readFile(file, 'extra');
                        event.target.value = '';
                      }}
                    />
                    <Button variant="secondary" onClick={() => configInput.current?.click()} style={{ marginLeft: 8 }}>
                      {extraFileContents ? `${extraFileName} selected` : `Add ${extraFileName} (optional)`}
                    </Button>
                  </>
                )}
              </div>

              <Input
                label="Credential Name"
                value={name}
                onChange={(event) => { setName(event.target.value); setError(''); }}
                placeholder={`e.g. ${details.label} · work account`}
                error={error || undefined}
              />
            </>
          )}
          <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
            Importing copies the current login snapshot. If the CLI rotates or expires it, log in again and import a new credential before switching agents to it.
          </div>
        </div>
      </Modal>
    </>
  );
}

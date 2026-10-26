import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useRef, useState } from 'react';
import { api } from '../../api';
import type { Credential, CatalogScope } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select } from '../common';
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
    label: translate('{0} CLI', { 0: cliLabel(cli) }),
    command: login.command,
    file: login.file_path ?? '',
    provider: login.harvest_provider,
    field: login.harvest_field,
    extraFile: login.extra_file_field,
  };
}

function validateJsonFile(contents: string): string | null {
  if (!contents.trim()) return translate('Select the credential file created by the CLI login.');
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return translate('The credential file must contain a JSON object.');
    }
    return null;
  } catch {
    return translate('The selected credential file is not valid JSON.');
  }
}

export default function CliCredentialImport({
  accountId,
  createScope = 'account',
  credentials = [],
  onCreated,
}: {
  accountId: string;
  createScope?: CatalogScope;
  credentials?: Credential[];
  onCreated?: () => void | Promise<void>;
}) {
  useLocale();
  const { showToast } = useToast();
  const catalog = useCliCatalog();
  const loginClis = loginCapableClis(catalog);
  const credentialInput = useRef<HTMLInputElement | null>(null);
  const configInput = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const target = credentials.find((c) => c.id === targetId);
  const [provider, setProvider] = useState<string>(() => defaultLoginCli());
  const [name, setName] = useState('');
  const [credentialJson, setCredentialJson] = useState('');
  const [extraFileContents, setExtraFileContents] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const details = importDetailsFor(provider) ?? importDetailsFor(defaultLoginCli());

  const reset = (nextProvider: string = provider) => {
    setTargetId('');
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
    showToast(translate('Login command copied.'), 'success');
  };

  const createCredential = async () => {
    if (targetId && !target) {
      setError(translate('The selected credential is no longer available. Select another credential.'));
      return;
    }
    if (!details) {
      setError(translate('No CLI in the catalog supports file import.'));
      return;
    }
    const jsonError = validateJsonFile(credentialJson);
    if (!target && !name.trim()) {
      setError(translate('Credential name is required.'));
      return;
    }
    if (jsonError) {
      setError(jsonError);
      return;
    }
    if (!target && createScope !== 'global' && !accountId) {
      setError(translate('Ownership defaults are unavailable.'));
      return;
    }

    setSaving(true);
    try {
      const fields = {
        [details.field]: credentialJson.trim(),
        ...(details.extraFile && extraFileContents.trim() ? { [details.extraFile]: extraFileContents } : {}),
      };
      if (target) {
        await api.updateCredential(target.id, {
          account_id: target.account_id || undefined,
          credentials: fields,
        });
      } else {
        await api.createCredential({
          scope: createScope === 'global' ? 'global' : 'account',
          account_id: createScope === 'global' ? undefined : accountId,
          name: name.trim(),
          description: translate('Imported from {0} after {1}.', { 0: details.file, 1: details.command }),
          provider: details.provider,
          credentials: {
            [details.field]: credentialJson.trim(),
            ...(details.extraFile && extraFileContents.trim() ? { [details.extraFile]: extraFileContents } : {}),
          },
        });
      }
      showToast(translate('{0} credential {1}.', { 0: details.label, 1: target ? 'updated' : 'created' }), 'success');
      setOpen(false);
      reset(defaultLoginCli());
      await onCreated?.();
    } catch (err: any) {
      setError(err?.message || translate('Failed to create credential.'));
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
      <Button variant="ghost" size="md" onClick={() => setOpen(true)}>{translate('Import from File')}</Button>
      <Modal
        isOpen={open}
        onClose={close}
        title={translate('Import CLI Login Credential')}
        maxWidth={620}
        footer={(
          <>
            <Button variant="secondary" onClick={close} disabled={saving}>{translate('Cancel')}</Button>
            <Button variant="primary" onClick={createCredential} disabled={saving || !details} loading={saving}>
              {target ? translate('Update Credential') : translate('Create Credential')}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: 13, lineHeight: 1.55 }}>
            {translate('Log in on this computer, then import the generated credential file. AWB encrypts it as a reusable account credential, so each managed agent and computer can select the account it needs.')}</p>

          <div style={{ display: 'flex', gap: 8 }} role="group" aria-label={translate('CLI provider')}>
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
                <div style={{ color: tokens.colors.textStrong, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{translate('1. Run the login command')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ flex: 1, padding: '9px 10px', borderRadius: tokens.radii.sm, background: tokens.colors.surfaceCard, color: tokens.colors.textPrimary }}>
                    {details.command}
                  </code>
                  <Button variant="secondary" size="sm" onClick={copyCommand}>{translate('Copy')}</Button>
                </div>
                <div style={{ marginTop: 8, color: tokens.colors.textMuted, fontSize: 12 }}>
                  {translate('Complete the browser sign-in opened by the CLI. Your login remains local until you choose the file below.')}</div>
              </div>

              <div style={{ padding: 14, borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface }}>
                <div style={{ color: tokens.colors.textStrong, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{translate('2. Select the generated credential file')}</div>
                <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginBottom: 10 }}>
                  {translate('File location:')} <code>{details.file}</code>{translate('. Hidden folders can be shown with Ctrl/Cmd + Shift + . in most file pickers.')}</div>
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
                  {fileName ? translate('Selected: {0}', { 0: fileName }) : translate('Choose {0}', { 0: details.file.split('/').pop() })}
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
                      {extraFileContents ? translate('{0} selected', { 0: extraFileName }) : translate('Add {0} (optional)', { 0: extraFileName })}
                    </Button>
                  </>
                )}
              </div>

              <Select
                label={translate('Save login to')}
                value={targetId}
                onChange={(e) => { setTargetId(e.target.value); setError(''); }}
                options={[
                  { value: '', label: translate('Create a new credential') },
                  ...credentials.filter((c) => c.provider === details.provider)
                    .map((c) => ({ value: c.id, label: translate('Update {0}', { 0: c.name }) })),
                ]}
              />
              {target && <div style={{ fontSize: 13 }}>{translate('Existing session and runtime settings keep using this credential.')}</div>}
              <Input
                label={translate('Credential Name')}
                value={target?.name || name}
                disabled={!!target}
                onChange={(event) => { setName(event.target.value); setError(''); }}
                placeholder={translate('e.g. {0} · work account', { 0: details.label })}
                error={error || undefined}
              />
            </>
          )}
          <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
            {translate('Importing copies the current login snapshot. If the CLI rotates or expires it, log in again and update the existing credential here.')}</div>
        </div>
      </Modal>
    </>
  );
}

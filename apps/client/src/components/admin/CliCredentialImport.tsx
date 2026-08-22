import React, { useRef, useState } from 'react';
import { api } from '../../api';
import type { CatalogScope } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal } from '../common';

type CliProvider = 'codex' | 'claude';

const CLI_DETAILS: Record<CliProvider, {
  label: string;
  command: string;
  file: string;
  provider: 'codex_subscription' | 'claude_subscription';
  field: 'auth_json' | 'credentials_json';
}> = {
  codex: {
    label: 'Codex CLI',
    command: 'codex login',
    file: '~/.codex/auth.json',
    provider: 'codex_subscription',
    field: 'auth_json',
  },
  claude: {
    label: 'Claude CLI',
    command: 'claude auth login',
    file: '~/.claude/.credentials.json',
    provider: 'claude_subscription',
    field: 'credentials_json',
  },
};

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
  const credentialInput = useRef<HTMLInputElement | null>(null);
  const configInput = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<CliProvider>('codex');
  const [name, setName] = useState('');
  const [credentialJson, setCredentialJson] = useState('');
  const [configToml, setConfigToml] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const details = CLI_DETAILS[provider];

  const reset = (nextProvider: CliProvider = provider) => {
    setProvider(nextProvider);
    setName('');
    setCredentialJson('');
    setConfigToml('');
    setFileName('');
    setError('');
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    reset('codex');
  };

  const readFile = async (file: File, kind: 'credential' | 'config') => {
    const contents = await file.text();
    if (kind === 'credential') {
      setCredentialJson(contents);
      setFileName(file.name);
      setError('');
      if (!name.trim()) setName(`${CLI_DETAILS[provider].label} login`);
    } else {
      setConfigToml(contents);
    }
  };

  const copyCommand = async () => {
    await navigator.clipboard.writeText(details.command);
    showToast('Login command copied.', 'success');
  };

  const createCredential = async () => {
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
          ...(provider === 'codex' && configToml.trim() ? { config_toml: configToml } : {}),
        },
      });
      showToast(`${details.label} credential created.`, 'success');
      setOpen(false);
      reset('codex');
      await onCreated?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to create credential.');
    } finally {
      setSaving(false);
    }
  };

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
            <Button variant="primary" onClick={createCredential} disabled={saving} loading={saving}>
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
            {(['codex', 'claude'] as const).map((item) => (
              <Button
                key={item}
                variant={provider === item ? 'primary' : 'secondary'}
                onClick={() => reset(item)}
              >
                {CLI_DETAILS[item].label}
              </Button>
            ))}
          </div>

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
            {provider === 'codex' && (
              <>
                <input
                  ref={configInput}
                  type="file"
                  accept=".toml,text/plain"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file, 'config');
                    event.target.value = '';
                  }}
                />
                <Button variant="secondary" onClick={() => configInput.current?.click()} style={{ marginLeft: 8 }}>
                  {configToml ? 'config.toml selected' : 'Add config.toml (optional)'}
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
          <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
            Importing copies the current login snapshot. If the CLI rotates or expires it, log in again and import a new credential before switching agents to it.
          </div>
        </div>
      </Modal>
    </>
  );
}

import React, { useEffect, useState } from 'react';
import { EnvironmentConfig, EnvironmentRepository, Resource } from '../types';
import { tokens } from '../tokens';
import { Button, Input, Select } from './common';

// Board environment setup editor (ticket 354d336b). Edits the same
// EnvironmentConfig shape the server stores on Board.environment_config (and
// could store on Workspace as a default). The raw JSON string from the server
// is parsed here; saving hands the structured object (or null when everything
// is empty) to the caller, which PATCHes it and re-fetches. Server-side zod is
// the validation authority — this component only normalises input shapes
// (commands one-per-line, env_vars as KEY=VALUE lines).

interface EnvironmentConfigEditorProps {
  /** Raw environment_config JSON string from the Board row. */
  raw: string | null | undefined;
  /** Repository resources (type='repository') for the per-repo dropdown. */
  repoOptions: Resource[];
  onSave(next: EnvironmentConfig | null): Promise<void>;
}

export function parseEnvironmentConfigRaw(raw: string | null | undefined): EnvironmentConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const linesToList = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
const listToLines = (list: string[] | undefined): string => (list ?? []).join('\n');

// env_vars edited as KEY=VALUE lines (first '=' splits). Lines without a key drop.
function envVarsToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}
function textToEnvVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

// Editor row model — keeps post_clone_commands as raw text for the textarea.
interface RepoRow {
  resource_id: string;
  url: string;
  target_dir: string;
  branch: string;
  postCloneText: string;
}

function toRepoRows(repos: EnvironmentRepository[] | undefined): RepoRow[] {
  return (repos ?? []).map((r) => ({
    resource_id: r.resource_id ?? '',
    url: r.url ?? '',
    target_dir: r.target_dir ?? '',
    branch: r.branch ?? '',
    postCloneText: listToLines(r.post_clone_commands),
  }));
}

export default function EnvironmentConfigEditor({ raw, repoOptions, onSave }: EnvironmentConfigEditorProps) {
  const initial = parseEnvironmentConfigRaw(raw);
  const [repos, setRepos] = useState<RepoRow[]>(toRepoRows(initial.repositories));
  const [envVarsText, setEnvVarsText] = useState(envVarsToText(initial.env_vars));
  const [setupText, setSetupText] = useState(listToLines(initial.setup_commands));
  const [timeout, setTimeoutSec] = useState(
    initial.setup_timeout_seconds ? String(initial.setup_timeout_seconds) : '',
  );
  const [version, setVersion] = useState(initial.version != null ? String(initial.version) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const next = parseEnvironmentConfigRaw(raw);
    setRepos(toRepoRows(next.repositories));
    setEnvVarsText(envVarsToText(next.env_vars));
    setSetupText(listToLines(next.setup_commands));
    setTimeoutSec(next.setup_timeout_seconds ? String(next.setup_timeout_seconds) : '');
    setVersion(next.version != null ? String(next.version) : '');
    setErr('');
  }, [raw]);

  const buildConfig = (): EnvironmentConfig | null => {
    const repositories: EnvironmentRepository[] = [];
    for (const row of repos) {
      const resource_id = row.resource_id.trim();
      const url = row.url.trim();
      if (!resource_id && !url) continue; // a repo with neither id nor url is incomplete — drop
      const repo: EnvironmentRepository = {};
      if (resource_id) repo.resource_id = resource_id;
      if (url) repo.url = url;
      if (row.target_dir.trim()) repo.target_dir = row.target_dir.trim();
      if (row.branch.trim()) repo.branch = row.branch.trim();
      const post = linesToList(row.postCloneText);
      if (post.length > 0) repo.post_clone_commands = post;
      repositories.push(repo);
    }
    const env_vars = textToEnvVars(envVarsText);
    const setup_commands = linesToList(setupText);
    const next: EnvironmentConfig = {};
    if (repositories.length > 0) next.repositories = repositories;
    if (Object.keys(env_vars).length > 0) next.env_vars = env_vars;
    if (setup_commands.length > 0) next.setup_commands = setup_commands;
    const t = parseInt(timeout, 10);
    if (Number.isFinite(t) && t > 0) next.setup_timeout_seconds = t;
    const v = parseInt(version, 10);
    if (Number.isFinite(v) && v >= 0) next.version = v;
    // setup_timeout / version alone are meaningless — collapse to null.
    if (!next.repositories && !next.env_vars && !next.setup_commands) return null;
    return next;
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: 13,
    fontFamily: 'monospace',
    boxSizing: 'border-box',
    resize: 'vertical',
  };
  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    color: tokens.colors.textMuted,
    marginBottom: 4,
    textTransform: 'uppercase',
    fontWeight: 600,
  };

  const updateRepo = (idx: number, patch: Partial<RepoRow>) => {
    setRepos((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeRepo = (idx: number) => setRepos((prev) => prev.filter((_, i) => i !== idx));
  const addRepo = () =>
    setRepos((prev) => [...prev, { resource_id: '', url: '', target_dir: '', branch: '', postCloneText: '' }]);

  const repoSelectOptions = [
    { value: '', label: '— Direct URL (no resource) —' },
    ...repoOptions.map((r) => ({ value: r.id, label: r.name })),
  ];

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Environment Setup (board)
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Provisioned once per agent before the first dispatch on this board: repositories are cloned
        (and kept up to date) under the agent home, <code>setup_commands</code> run, and the
        non-secret <code>env_vars</code> are injected into the subagent. Re-runs only when this config
        changes (or you bump <em>version</em>). Secrets belong in the agent's credential, not here.
        Leave everything empty for no provisioning (current behaviour).
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Repositories */}
        <div>
          <label style={fieldLabelStyle}>Repositories</label>
          {repos.length === 0 && (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginBottom: 8 }}>
              No repositories configured.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {repos.map((row, idx) => (
              <div
                key={idx}
                style={{
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Select
                      label="Repository resource"
                      value={row.resource_id}
                      options={repoSelectOptions}
                      onChange={(e) => updateRepo(idx, { resource_id: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Input
                      label="Target dir (relative to agent home)"
                      value={row.target_dir}
                      onChange={(e) => updateRepo(idx, { target_dir: e.target.value })}
                      placeholder="repos/my-app (default: repos/<name>)"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Input
                      label="Direct URL (when no resource)"
                      value={row.url}
                      onChange={(e) => updateRepo(idx, { url: e.target.value })}
                      placeholder="https://github.com/org/repo.git"
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Input
                      label="Branch (default: repo's default)"
                      value={row.branch}
                      onChange={(e) => updateRepo(idx, { branch: e.target.value })}
                      placeholder="main"
                    />
                  </div>
                </div>
                <div>
                  <label style={fieldLabelStyle}>Post-clone commands (one per line, fresh clone only)</label>
                  <textarea
                    rows={2}
                    value={row.postCloneText}
                    onChange={(e) => updateRepo(idx, { postCloneText: e.target.value })}
                    placeholder={'npm ci'}
                    style={textareaStyle}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="ghost" size="sm" onClick={() => removeRepo(idx)}>
                    Remove repository
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" size="sm" onClick={addRepo}>
              + Add repository
            </Button>
          </div>
        </div>

        {/* env_vars + setup_commands */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={fieldLabelStyle}>Env vars (KEY=VALUE, one per line)</label>
            <textarea
              rows={4}
              value={envVarsText}
              onChange={(e) => setEnvVarsText(e.target.value)}
              placeholder={'NODE_ENV=development'}
              style={textareaStyle}
            />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={fieldLabelStyle}>Setup commands (one per line, run in agent home)</label>
            <textarea
              rows={4}
              value={setupText}
              onChange={(e) => setSetupText(e.target.value)}
              placeholder={'npm ci\nnpm run build'}
              style={textareaStyle}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 220 }}>
            <Input
              label="Setup timeout (seconds, 1–3600)"
              value={timeout}
              onChange={(e) => setTimeoutSec(e.target.value)}
              placeholder="600"
            />
          </div>
          <div style={{ width: 160 }}>
            <Input
              label="Version (bump to re-provision)"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr('');
              try {
                await onSave(buildConfig());
              } catch (e: any) {
                setErr(e?.message || 'Failed to save');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {err && <div style={{ fontSize: 12, color: tokens.colors.danger }}>{err}</div>}
      </div>
    </section>
  );
}

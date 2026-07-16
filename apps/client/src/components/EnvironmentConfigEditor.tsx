import React, { useEffect, useMemo, useState } from 'react';
import { EnvironmentConfig, Resource } from '../types';
import { tokens } from '../tokens';
import { Button, Select } from './common';
import { buildEnvironmentConfig, parseEnvironmentConfigRaw } from './environmentConfig.logic';

// Board environment setup editor (ticket 354d336b; simplified to a SINGLE
// repository-Resource picker in 8fbe90e9). The only field an operator sets is
// which repository Resource the board provisions — the server derives the clone
// url / default_branch / credential from the Resource and owns the worktree
// checkout, so URL / branch / target dir / post-clone commands / env_vars /
// setup_commands / timeout / version are no longer entered here. Only the first
// repository is ever provisioned (agent-manager reads env.repositories[0]), so
// the picker edits exactly one selection rather than a multi-row list. The raw
// JSON from the server is parsed tolerantly: a board saved before this change may
// still carry legacy keys, extra repositories, or a url-only repo; they keep
// resolving/executing until the next Save, which removes them. Saving hands the
// caller { repositories: [{ resource_id }] } (or null when nothing is selected).

interface EnvironmentConfigEditorProps {
  /** Raw environment_config JSON string from the Board row. */
  raw: string | null | undefined;
  /** Repository resources (type='repository') for the picker dropdown. */
  repoOptions: Resource[];
  onSave(next: EnvironmentConfig | null): Promise<void>;
}

export default function EnvironmentConfigEditor({ raw, repoOptions, onSave }: EnvironmentConfigEditorProps) {
  const parsed = useMemo(() => parseEnvironmentConfigRaw(raw), [raw]);
  const [repo, setRepo] = useState<string>(parsed.resourceId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRepo(parsed.resourceId);
    setErr('');
  }, [parsed]);

  // Only the selected repository is written; empty selection → null.
  const buildConfig = (): EnvironmentConfig | null => buildEnvironmentConfig(repo);

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    color: tokens.colors.textMuted,
    marginBottom: 4,
    textTransform: 'uppercase',
    fontWeight: 600,
  };

  const baseOptions = [
    { value: '', label: '— No repository (no provisioning) —' },
    ...repoOptions.map((r) => ({ value: r.id, label: r.name })),
  ];
  // Preserve a selected resource_id whose Resource is missing from the list
  // (deleted / not yet loaded) so re-selecting can't silently drop it.
  const options =
    repo && !repoOptions.some((r) => r.id === repo)
      ? [...baseOptions, { value: repo, label: `(unknown resource ${repo.slice(0, 8)})` }]
      : baseOptions;

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
        Pick the repository Resource this board provisions. The server derives the clone{' '}
        <code>url</code>, default <code>branch</code>, and <code>credential</code> from the selected
        Resource, and checks it out as each ticket's worktree when the ticket has no repository of its
        own. Leave empty for no provisioning (current behaviour).
      </div>

      <div>
        <label style={fieldLabelStyle}>Repository</label>
        <div style={{ maxWidth: 420 }}>
          <Select
            label="Repository resource (worktree bootstrap)"
            value={repo}
            options={options}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
      </div>

      {parsed.losesWorktreeSourceOnSave ? (
        <div style={{ fontSize: 11, color: tokens.colors.danger, marginTop: 12 }}>
          ⚠️ This board's only worktree source is a legacy <strong>url-only</strong> repository (no
          Resource). It stays active until you Save — but saving through this picker removes it, and
          with no Resource selected the board would be left with <strong>no provisioning source</strong>.
          Select a repository Resource before saving to keep worktree bootstrap working.
        </div>
      ) : (
        parsed.hasLegacy && (
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 12 }}>
            ⚠️ This board's saved config still holds legacy fields (env vars, setup/post-clone
            commands, per-repo url/branch/target dir, timeout, version, or extra repositories). They
            remain active until you Save; saving removes them and provisions only the selected
            repository.
          </div>
        )
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
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
        {err && <div style={{ fontSize: 12, color: tokens.colors.danger }}>{err}</div>}
      </div>
    </section>
  );
}

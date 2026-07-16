import React, { useEffect, useMemo, useState } from 'react';
import { EnvironmentConfig, Resource } from '../types';
import { tokens } from '../tokens';
import { Button, Select } from './common';
import { buildEnvironmentConfig, parseEnvironmentConfigRaw } from './environmentConfig.logic';

// Board environment setup editor (ticket 354d336b; simplified to a repository-
// Resource picker in 8fbe90e9). The only field an operator sets is which
// repository Resource(s) the board provisions — the server derives the clone
// url / default_branch / credential from the Resource and owns the worktree
// checkout, so URL / branch / target dir / post-clone commands / env_vars /
// setup_commands / timeout / version are no longer entered here. The raw JSON
// from the server is parsed tolerantly: a board saved before this change may
// still carry those legacy keys; they are surfaced as a "will be dropped on
// save" note and removed the next time the board is saved. Saving hands the
// caller { repositories: [{ resource_id }] } (or null when nothing is selected).

interface EnvironmentConfigEditorProps {
  /** Raw environment_config JSON string from the Board row. */
  raw: string | null | undefined;
  /** Repository resources (type='repository') for the per-repo dropdown. */
  repoOptions: Resource[];
  onSave(next: EnvironmentConfig | null): Promise<void>;
}

export default function EnvironmentConfigEditor({ raw, repoOptions, onSave }: EnvironmentConfigEditorProps) {
  const parsed = useMemo(() => parseEnvironmentConfigRaw(raw), [raw]);
  const [repos, setRepos] = useState<string[]>(parsed.resourceIds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRepos(parsed.resourceIds);
    setErr('');
  }, [parsed]);

  // Only selected repositories are written; blank rows collapse. Empty → null.
  const buildConfig = (): EnvironmentConfig | null => buildEnvironmentConfig(repos);

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    color: tokens.colors.textMuted,
    marginBottom: 4,
    textTransform: 'uppercase',
    fontWeight: 600,
  };

  const updateRepo = (idx: number, value: string) =>
    setRepos((prev) => prev.map((r, i) => (i === idx ? value : r)));
  const removeRepo = (idx: number) => setRepos((prev) => prev.filter((_, i) => i !== idx));
  const addRepo = () => setRepos((prev) => [...prev, '']);

  const baseOptions = [
    { value: '', label: '— Select a repository —' },
    ...repoOptions.map((r) => ({ value: r.id, label: r.name })),
  ];
  // Preserve a resource_id whose Resource is missing from the list (deleted /
  // not yet loaded) so editing another row can't silently drop it.
  const optionsFor = (id: string) =>
    id && !repoOptions.some((r) => r.id === id)
      ? [...baseOptions, { value: id, label: `(unknown resource ${id.slice(0, 8)})` }]
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
        Pick the repository Resource(s) this board provisions. The server derives the clone{' '}
        <code>url</code>, default <code>branch</code>, and <code>credential</code> from the selected
        Resource, and checks the <strong>first</strong> repository out as each ticket's worktree when
        the ticket has no repository of its own. Leave empty for no provisioning (current behaviour).
      </div>

      <div>
        <label style={fieldLabelStyle}>Repositories</label>
        {repos.length === 0 && (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginBottom: 8 }}>
            No repositories configured.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {repos.map((id, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Select
                  label={idx === 0 ? 'Repository resource (worktree bootstrap)' : `Repository resource #${idx + 1}`}
                  value={id}
                  options={optionsFor(id)}
                  onChange={(e) => updateRepo(idx, e.target.value)}
                />
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeRepo(idx)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={addRepo}>
            + Add repository
          </Button>
        </div>
      </div>

      {parsed.hasLegacy && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 12 }}>
          ⚠️ This board's saved config still holds legacy fields (env vars, setup/post-clone commands,
          per-repo url/branch/target dir, timeout, or version). They no longer affect execution and
          will be dropped the next time you Save.
        </div>
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

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Skill, SkillSyncSummary, SkillTap } from '../../types';
import { tokens } from '../../tokens';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Button, Card, Input } from '../common';

/**
 * Instance-wide skill registry.
 *
 * Two sources feed the GLOBAL skill scope, and the distinction is the whole
 * point of this screen:
 *
 *   - the **built-in pack** that ships inside the AWB repo (`skills/`), seeded
 *     at every boot with no network access — this is why a fresh install has
 *     skills at all;
 *   - **taps**, external git repositories an admin registers. They are
 *     disabled by default and never sync at boot, because a skill body becomes
 *     agent-facing prompt text.
 *
 * Both are append-only: a sync publishes a new immutable version and never
 * edits or deletes an existing one, so an assignment pinned to a version keeps
 * running exactly what it pinned.
 */
export default function SkillRegistryPage() {
  const { showToast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [taps, setTaps] = useState<SkillTap[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ tapId: string; text: string } | null>(null);

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('skills');
  const [licenses, setLicenses] = useState('MIT, Apache-2.0');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [skillRows, tapRows] = await Promise.all([api.listGlobalSkills(), api.listSkillTaps()]);
      setSkills(skillRows);
      setTaps(tapRows);
    } catch (error: any) {
      showToast(error?.message || 'Failed to load the skill registry', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  const describe = (summary: SkillSyncSummary) =>
    `created ${summary.created} · updated ${summary.updated} · already current ${summary.alreadyCurrent}`
    + ` · quarantined ${summary.quarantined} · conflicts ${summary.conflicted} · skipped ${summary.skipped}`;

  const reseed = async () => {
    setBusy('builtin');
    try {
      const result = await api.reseedBuiltinSkills();
      showToast(
        result.dir ? `Built-in pack: ${describe(result)}` : 'No built-in pack directory found',
        result.dir ? 'success' : 'error',
      );
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Re-seed failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const addTap = async () => {
    if (!repoUrl.trim()) return;
    setBusy('add');
    try {
      await api.createSkillTap({
        name: name.trim() || repoUrl.trim(),
        repo_url: repoUrl.trim(),
        ref: ref.trim(),
        path: path.trim(),
        allowed_licenses: licenses.split(',').map((v) => v.trim()).filter(Boolean),
      });
      showToast('Tap registered — run a dry run before enabling it', 'success');
      setName(''); setRepoUrl(''); setRef('');
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Failed to register the tap', 'error');
    } finally {
      setBusy(null);
    }
  };

  const sync = async (tap: SkillTap, dryRun: boolean) => {
    setBusy(tap.id);
    try {
      const result = await api.syncSkillTap(tap.id, { dryRun, force: !dryRun && !tap.enabled });
      const skippedLines = result.skipped.slice(0, 12).map((s) => `· ${s.path} — ${s.reason}`);
      setPreview({
        tapId: tap.id,
        text: [
          `${dryRun ? 'DRY RUN' : 'SYNCED'} @ ${result.commit.slice(0, 12)}`,
          `${result.loaded} skill(s) accepted, ${result.skipped.length} skipped`,
          describe(result.summary),
          ...(skippedLines.length ? ['', 'Skipped:', ...skippedLines] : []),
          ...(result.skipped.length > 12 ? [`… and ${result.skipped.length - 12} more`] : []),
        ].join('\n'),
      });
      if (!dryRun) await load();
    } catch (error: any) {
      showToast(error?.message || 'Sync failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card>
        <strong style={{ color: tokens.colors.textPrimary }}>Global skills are inherited by every workspace</strong>
        <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 4 }}>
          A workspace can fork any of these; the fork shadows the global by slug while the global keeps
          receiving upstream updates. Syncing is append-only and never changes what an already-assigned
          agent runs — assignments pin a specific version.
        </div>
      </Card>

      <Card style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            <strong style={{ color: tokens.colors.textPrimary }}>Built-in pack</strong>
            <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 4 }}>
              Ships in the AWB repo under <code>skills/</code> and is seeded at every boot. Upgrading the
              server is what updates it. Point <code>AWB_BUILTIN_SKILLS_DIR</code> at your own git checkout
              to manage it yourself.
            </div>
          </div>
          <Button onClick={reseed} loading={busy === 'builtin'}>Re-seed now</Button>
        </div>
      </Card>

      <Card style={{ display: 'grid', gap: 10 }}>
        <strong style={{ color: tokens.colors.textPrimary }}>Add a tap</strong>
        <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
          An https git repository laid out as <code>&lt;path&gt;/&lt;category&gt;/&lt;slug&gt;/SKILL.md</code>.
          Only listed licenses are accepted — a repo mixing permissive and proprietary skills syncs just the
          permissive ones. New taps start <strong>disabled</strong>; dry-run first.
        </div>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Community skills" />
        <Input label="Repository URL (https)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/skills" />
        <Input label="Ref (branch/tag, blank = default)" value={ref} onChange={(e) => setRef(e.target.value)} />
        <Input label="Path inside the repo" value={path} onChange={(e) => setPath(e.target.value)} placeholder="skills" />
        <Input label="Allowed licenses (comma separated, blank = all)" value={licenses} onChange={(e) => setLicenses(e.target.value)} />
        <Button onClick={addTap} loading={busy === 'add'}>Register tap</Button>
      </Card>

      {loading && <div style={{ color: tokens.colors.textMuted }}>Loading…</div>}

      {taps.map((tap) => (
        <Card key={tap.id} style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <div>
              <strong style={{ color: tokens.colors.textPrimary }}>{tap.name}</strong>
              <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
                {tap.repo_url}{tap.ref ? `#${tap.ref}` : ''}{tap.path ? ` /${tap.path}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Badge variant={tap.enabled ? 'success' : 'neutral'} size="sm">
                {tap.enabled ? 'enabled' : 'disabled'}
              </Badge>
              {tap.last_sync_status && (
                <Badge variant={tap.last_sync_status === 'ok' ? 'success' : 'danger'} size="sm">
                  {tap.last_sync_status}
                </Badge>
              )}
            </div>
          </div>
          {tap.last_sync_error && (
            <div style={{ color: tokens.colors.danger, fontSize: 12 }}>{tap.last_sync_error}</div>
          )}
          {tap.last_synced_commit && (
            <div style={{ color: tokens.colors.textMuted, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
              {tap.last_synced_commit.slice(0, 12)}
              {tap.last_synced_at ? ` · ${new Date(tap.last_synced_at).toLocaleString()}` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" loading={busy === tap.id} onClick={() => void sync(tap, true)}>
              Dry run
            </Button>
            <Button size="sm" loading={busy === tap.id} onClick={() => void sync(tap, false)}>
              Sync now
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await api.updateSkillTap(tap.id, { enabled: !tap.enabled });
                await load();
              }}
            >
              {tap.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await api.deleteSkillTap(tap.id);
                // Skills already synced from this tap are intentionally kept —
                // deleting them would pull definitions out from under agents.
                showToast('Tap removed. Skills it already synced were kept.', 'success');
                await load();
              }}
            >
              Remove
            </Button>
          </div>
          {preview?.tapId === tap.id && (
            <pre style={{
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: 10,
              fontSize: 11,
              color: tokens.colors.textSecondary,
              whiteSpace: 'pre-wrap',
              maxHeight: 260,
              overflow: 'auto',
            }}>{preview.text}</pre>
          )}
        </Card>
      ))}

      <Card style={{ display: 'grid', gap: 8 }}>
        <strong style={{ color: tokens.colors.textPrimary }}>Global skills ({skills.length})</strong>
        {skills.length === 0 && <span style={{ color: tokens.colors.textMuted }}>None yet.</span>}
        {skills.map((skill) => (
          <div key={skill.id} style={{
            display: 'flex', justifyContent: 'space-between', gap: 8,
            borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8,
          }}>
            <div>
              <div style={{ color: tokens.colors.textPrimary }}>{skill.name}</div>
              <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
                {skill.slug}
                {skill.source_path ? ` · ${skill.source_path}` : ''}
                {skill.source_license ? ` · ${skill.source_license}` : ''}
                {skill.source_author ? ` · ${skill.source_author}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <Badge variant="neutral" size="sm">{skill.source_kind || 'local'}</Badge>
              <Badge variant={skill.status === 'active' ? 'success' : 'danger'} size="sm">{skill.status}</Badge>
              {skill.status === 'active' && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    await api.quarantineGlobalSkill(skill.id);
                    // Quarantine is an operator veto: a later sync skips this
                    // slug rather than reviving it.
                    showToast('Quarantined — future syncs will skip this slug', 'success');
                    await load();
                  }}
                >
                  Quarantine
                </Button>
              )}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

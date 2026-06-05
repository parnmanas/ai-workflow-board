import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';
import { Button } from './common';
import MoveBlockerList from './MoveBlockerList';
import type { AgentDetail, AgentMovePreview, AgentApiKeyPolicy, AgentCrossRefPolicy, MoveBlocker, MoveRemedy } from '../types';

interface AgentMoveToWorkspaceSectionProps {
  agent: AgentDetail;
  /** Called after a successful commit so the parent can refresh / navigate. */
  onMoved?: (targetWorkspaceId: string) => void;
}

// Cross-workspace agent move (ticket 868ead64 — companion to the board move
// 8882056b). Admin-gated on the server. Flow: pick destination + policies →
// Preview (dry-run, writes nothing) → review the restamp/copy/remap plan and
// any blockers → Move (commits atomically). A preview with blockers disables
// the commit button. Manager-type agents are workspace-less and never render
// this section (the caller gates on agent.type).
export default function AgentMoveToWorkspaceSection({ agent, onMoved }: AgentMoveToWorkspaceSectionProps) {
  const { showToast } = useToast();
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [target, setTarget] = useState<string>('');
  const [apiKeyPolicy, setApiKeyPolicy] = useState<AgentApiKeyPolicy>('migrate');
  const [crossRefPolicy, setCrossRefPolicy] = useState<AgentCrossRefPolicy>('block');
  const [preview, setPreview] = useState<AgentMovePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const sourceWorkspaceId = agent.workspace_id || '';

  // Destination candidates = every workspace except this agent's own.
  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(
          (list || [])
            .filter((w: any) => w.id !== sourceWorkspaceId)
            .map((w: any) => ({ id: w.id, name: w.name })),
        );
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, [sourceWorkspaceId]);

  // Any change to destination / policy invalidates a stale preview — the
  // operator must re-run Preview before they can commit.
  const invalidate = () => { setPreview(null); setConfirming(false); };
  const onTargetChange = (id: string) => { setTarget(id); invalidate(); };
  const onApiKeyPolicyChange = (v: AgentApiKeyPolicy) => { setApiKeyPolicy(v); invalidate(); };
  const onCrossRefPolicyChange = (v: AgentCrossRefPolicy) => { setCrossRefPolicy(v); invalidate(); };

  // Preview honours optional overrides so an inline repreview-remedy can apply a
  // freshly-chosen policy without racing React's async setState.
  const runPreview = async (overrides?: { apiKeyPolicy?: AgentApiKeyPolicy; crossRefPolicy?: AgentCrossRefPolicy }) => {
    if (!target) return;
    setBusy(true);
    try {
      const report = await api.moveAgent(agent.id, target, {
        dryRun: true,
        apiKeyPolicy: overrides?.apiKeyPolicy ?? apiKeyPolicy,
        crossRefPolicy: overrides?.crossRefPolicy ?? crossRefPolicy,
      });
      setPreview(report);
    } catch (err: any) {
      showToast(err?.message || 'Preview failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Inline blocker remedy. repreview → flip a policy locally and re-preview (no
  // write). mutation → call the remedy endpoint, then re-preview so a resolved
  // blocker drops off automatically.
  const onRemedy = async (_blocker: MoveBlocker, remedy: MoveRemedy) => {
    if (remedy.kind === 'repreview') {
      if (remedy.action === 'set_api_key_policy' && remedy.params?.value) {
        const value = remedy.params.value as AgentApiKeyPolicy;
        setApiKeyPolicy(value);
        await runPreview({ apiKeyPolicy: value });
      } else if (remedy.action === 'set_cross_ref_policy' && remedy.params?.value) {
        const value = remedy.params.value as AgentCrossRefPolicy;
        setCrossRefPolicy(value);
        await runPreview({ crossRefPolicy: value });
      }
      return;
    }
    // mutation
    setBusy(true);
    try {
      await api.moveAgentRemedy(agent.id, remedy.action, remedy.params || {});
    } catch (err: any) {
      showToast(err?.message || 'Remedy failed', 'error');
      setBusy(false);
      return;
    }
    setBusy(false);
    await runPreview();
  };

  const runCommit = async () => {
    if (!target || !preview || preview.blockers.length > 0) return;
    setBusy(true);
    try {
      await api.moveAgent(agent.id, target, { dryRun: false, apiKeyPolicy, crossRefPolicy });
      const destName = workspaces.find((w) => w.id === target)?.name || target;
      showToast(`Agent moved to “${destName}”.`, 'success');
      setConfirming(false);
      setPreview(null);
      onMoved?.(target);
    } catch (err: any) {
      showToast(err?.message || 'Move failed', 'error');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const blocked = !!preview && preview.blockers.length > 0;

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, color: tokens.colors.textMuted,
    marginBottom: 4, textTransform: 'uppercase', fontWeight: 600,
  };
  const selectStyle: React.CSSProperties = {
    width: '100%', background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: 13,
    fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    <section
      style={{
        padding: 16,
        marginTop: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.danger}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Move to workspace
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Move this agent to a different workspace. A workspace is a scope boundary, so the move
        re-stamps the agent's <code>workspace_id</code>, copies its referenced credential into the
        destination by name if absent (non-destructive), and re-scopes its API keys. Role
        assignments and <code>assignee/reporter/reviewer</code> references on tickets outside the
        destination become cross-workspace links — by default the move is <strong>blocked</strong>
        and reported. <strong>Always Preview first</strong> — it writes nothing. Admin-only.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Destination workspace</label>
          <select value={target} onChange={(e) => onTargetChange(e.target.value)} style={selectStyle}>
            <option value="">Select a workspace…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label style={labelStyle}>API keys</label>
          <select value={apiKeyPolicy} onChange={(e) => onApiKeyPolicyChange(e.target.value as AgentApiKeyPolicy)} style={selectStyle}>
            <option value="migrate">Migrate (re-stamp)</option>
            <option value="clear">Clear (detach)</option>
            <option value="refuse">Refuse (block)</option>
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label style={labelStyle}>Cross-ws refs</label>
          <select value={crossRefPolicy} onChange={(e) => onCrossRefPolicyChange(e.target.value as AgentCrossRefPolicy)} style={selectStyle}>
            <option value="block">Block + report</option>
            <option value="clear">Clear refs</option>
          </select>
        </div>
        <Button variant="secondary" size="sm" disabled={!target || busy} onClick={() => runPreview()}>
          {busy && !confirming ? 'Previewing…' : 'Preview'}
        </Button>
      </div>

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: tokens.colors.textStrong, marginBottom: 8 }}>
            Plan: <strong>{preview.counts.api_keys}</strong> api key(s) ·{' '}
            <strong>{preview.counts.copied}</strong> credential(s) copied ·{' '}
            <strong>{preview.counts.cross_refs}</strong> cross-ws ref(s)
            {preview.counts.cleared ? <> · <strong>{preview.counts.cleared}</strong> cleared</> : null}
            {preview.committed ? ' · committed' : ' · dry-run'}
          </div>

          <MoveBlockerList blockers={preview.blockers} busy={busy} onRemedy={onRemedy} />

          {preview.items.length > 0 && (
            <div
              style={{
                maxHeight: 220, overflow: 'auto', border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '6px 8px', marginBottom: 10,
              }}
            >
              {preview.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0', color: tokens.colors.textStrong }}>
                  <span
                    style={{
                      flex: '0 0 64px', textTransform: 'uppercase', fontWeight: 600,
                      color: it.kind === 'block' ? tokens.colors.danger
                        : it.kind === 'warn' ? tokens.colors.textPrimary
                        : tokens.colors.textMuted,
                    }}
                  >
                    {it.kind}
                  </span>
                  <span style={{ flex: '0 0 110px', color: tokens.colors.textMuted }}>{it.entity}</span>
                  <span style={{ flex: 1 }}>{it.detail}</span>
                </div>
              ))}
            </div>
          )}

          {!confirming ? (
            <Button variant="danger" size="sm" disabled={blocked || busy} onClick={() => setConfirming(true)}>
              Move agent to workspace…
            </Button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: tokens.colors.textStrong }}>
                Commit this move? This applies atomically and cannot be auto-undone.
              </span>
              <Button variant="danger" size="sm" disabled={busy} onClick={runCommit}>
                {busy ? 'Moving…' : 'Confirm move'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

import React, { useState } from 'react';
import { tokens } from '../tokens';
import { Button } from './common';
import type { MoveBlocker, MoveRemedy } from '../types';

// Shared inline-remedy renderer for the cross-workspace board/agent move
// previews (ticket 9efa643b). A blocked preview ships structured blockers
// (code + entity refs + remedies[]); this component renders each blocker bullet
// with its remedy controls inline so the operator never has to leave the screen
// to resolve one. Both MoveToWorkspaceSetting (board) and
// AgentMoveToWorkspaceSection (agent) render this with their own `onRemedy`.
//
// Remedy kinds:
//   repreview — fires immediately; the parent flips a local move option (policy
//               or carry exclusion) and re-runs the dry-run preview. No write.
//   mutation  — gated behind an inline confirm; the parent POSTs to
//               …/move-to-workspace/remedy, then re-previews so the blocker
//               disappears iff the underlying condition is gone.

// Permissive input: accepts the legacy `string[]` blocker shape too (acceptance
// criterion (a) — string fallback) and normalizes it to a remedy-less blocker.
function normalize(b: MoveBlocker | string): MoveBlocker {
  if (typeof b === 'string') return { code: 'legacy', message: b, remedies: [] };
  return { ...b, remedies: Array.isArray(b.remedies) ? b.remedies : [] };
}

interface MoveBlockerListProps {
  blockers: Array<MoveBlocker | string>;
  busy: boolean;
  onRemedy: (blocker: MoveBlocker, remedy: MoveRemedy) => void | Promise<void>;
}

export default function MoveBlockerList({ blockers, busy, onRemedy }: MoveBlockerListProps) {
  // Which mutation remedy is awaiting its confirm, keyed `${blockerIdx}:${remedyIdx}`.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  if (!blockers || blockers.length === 0) return null;
  const normalized = blockers.map(normalize);

  return (
    <div
      style={{
        border: `1px solid ${tokens.colors.danger}`, borderRadius: tokens.radii.md,
        padding: '8px 10px', marginBottom: 8, background: 'rgba(220,40,40,0.06)',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.danger, marginBottom: 6 }}>
        Move blocked — resolve these first (each can be fixed inline):
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {normalized.map((b, bi) => (
          <li key={bi} style={{ fontSize: 12, color: tokens.colors.textStrong }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: tokens.colors.danger }}>•</span>
              <span>{b.message}</span>
            </div>
            {b.ticket_ids && b.ticket_ids.length > 0 && (
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginLeft: 12, marginTop: 2 }}>
                {b.ticket_ids.length} ticket(s): {b.ticket_ids.map((t) => t.slice(0, 8)).join(', ')}
              </div>
            )}
            {b.remedies.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 12, marginTop: 6, alignItems: 'center' }}>
                {b.remedies.map((r, ri) => {
                  const key = `${bi}:${ri}`;
                  if (r.kind === 'mutation' && confirmKey === key) {
                    return (
                      <span key={ri} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: tokens.colors.textStrong }}>Apply “{r.label}”?</span>
                        <Button
                          variant="danger" size="sm" disabled={busy}
                          onClick={async () => { await onRemedy(b, r); setConfirmKey(null); }}
                        >
                          {busy ? 'Applying…' : 'Confirm'}
                        </Button>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmKey(null)}>
                          Cancel
                        </Button>
                      </span>
                    );
                  }
                  return (
                    <Button
                      key={ri}
                      variant={r.kind === 'mutation' ? 'danger' : 'secondary'}
                      size="sm"
                      disabled={busy}
                      onClick={() => { if (r.kind === 'mutation') setConfirmKey(key); else onRemedy(b, r); }}
                    >
                      {r.label}
                    </Button>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

import React from 'react';
import { tokens } from '../tokens';
import { Button } from './common';
import { QaPhase, QaPhasesConfig } from '../types';

/**
 * Shared QA-phases editing UI (ticket 90cc22f7). The board-level editor (Board
 * Settings) and the per-scenario override (QaManager scenario form) both render
 * the same row editor — only the surrounding "save / inherit" chrome differs.
 *
 * Client read-parse mirrors the server fail-safe READ contract
 * (apps/server/src/modules/qa/qa-phases.ts parseQaPhases): accept either the
 * parsed object or the raw JSON string the entity ships, drop malformed phase
 * entries, collapse duplicate ids, and degrade to null (no phase model) rather
 * than throw. null = legacy single-running behavior.
 */
export function parseQaPhasesValue(
  raw: QaPhasesConfig | string | null | undefined,
): QaPhasesConfig | null {
  if (!raw) return null;
  let cfg: any = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { cfg = JSON.parse(trimmed); } catch { return null; }
  }
  if (!cfg || !Array.isArray(cfg.phases)) return null;
  const seen = new Set<string>();
  const phases: QaPhase[] = [];
  for (const p of cfg.phases) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const t = Number(p.timeout_sec);
    if (!Number.isFinite(t) || t <= 0) continue;
    seen.add(id);
    const phase: QaPhase = { id, timeout_sec: Math.floor(t) };
    if (typeof p.label === 'string' && p.label.trim()) phase.label = p.label;
    phases.push(phase);
  }
  if (phases.length === 0) return null;
  return { phases };
}

/** Human-friendly "1h 5m 30s" rendering of a seconds count for the timeout helper. */
export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '0s';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

/**
 * Validate phase rows against the server WRITE contract (QaPhasesSchema): every
 * id non-empty + unique, every timeout_sec a positive integer. Returns the first
 * problem as a human message, or null when the rows are savable. An empty list is
 * valid (the caller clears the override to null). Lets the UI block save with a
 * clear toast instead of relying on the server 400.
 */
export function qaPhasesError(phases: QaPhase[]): string | null {
  const ids = new Set<string>();
  for (const p of phases) {
    const id = (p.id ?? '').trim();
    if (!id) return 'Every phase needs a non-empty id.';
    if (ids.has(id)) return `Duplicate phase id "${id}" — ids must be unique.`;
    ids.add(id);
    if (!Number.isFinite(p.timeout_sec) || p.timeout_sec <= 0) {
      return `Phase "${id}" needs a positive timeout (seconds).`;
    }
  }
  return null;
}

interface QaPhaseRowsEditorProps {
  phases: QaPhase[];
  onChange(phases: QaPhase[]): void;
}

/**
 * The reusable phase-rows editor: per-row id / label / timeout_sec inputs with
 * a live duration helper, reorder (▲▼ — array order IS the phase order),
 * remove, and an "Add phase" button. Order matters (import → build → run), so
 * reorder is exposed via up/down rather than drag-and-drop to keep it lightweight
 * and work identically inside the modal scenario form.
 */
export function QaPhaseRowsEditor({ phases, onChange }: QaPhaseRowsEditorProps) {
  const fieldLabel: React.CSSProperties = {
    display: 'block', fontSize: 10, color: tokens.colors.textMuted,
    marginBottom: 3, textTransform: 'uppercase', fontWeight: 600,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
    padding: '6px 8px', color: tokens.colors.textStrong, fontSize: 12,
    fontFamily: 'inherit', boxSizing: 'border-box',
  };

  const updatePhase = (idx: number, patch: Partial<QaPhase>) =>
    onChange(phases.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const removePhase = (idx: number) => onChange(phases.filter((_, i) => i !== idx));
  const movePhase = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= phases.length) return;
    const next = phases.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };
  const addPhase = () => {
    // Generate a unique slug.
    let n = phases.length + 1;
    let id = `phase-${n}`;
    const ids = new Set(phases.map((p) => p.id));
    while (ids.has(id)) { n += 1; id = `phase-${n}`; }
    onChange([...phases, { id, label: '', timeout_sec: 600 }]);
  };

  const arrowBtn: React.CSSProperties = {
    background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.sm, color: tokens.colors.textSecondary,
    cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: '2px 6px',
  };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {phases.map((p, idx) => (
          <div
            key={idx}
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: 12,
              background: tokens.colors.surface,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              {/* Reorder controls — array order is the phase order. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 2 }}>
                <button
                  type="button"
                  style={{ ...arrowBtn, opacity: idx === 0 ? 0.4 : 1 }}
                  disabled={idx === 0}
                  onClick={() => movePhase(idx, -1)}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  style={{ ...arrowBtn, opacity: idx === phases.length - 1 ? 0.4 : 1 }}
                  disabled={idx === phases.length - 1}
                  onClick={() => movePhase(idx, 1)}
                  title="Move down"
                >
                  ▼
                </button>
              </div>
              <div style={{ width: 36, textAlign: 'center', paddingBottom: 6, fontSize: 12, fontWeight: 700, color: tokens.colors.textMuted }}>
                #{idx + 1}
              </div>
              <div style={{ flex: 1.2 }}>
                <label style={fieldLabel}>Id (slug)</label>
                <input
                  value={p.id}
                  placeholder="import"
                  onChange={(e) => updatePhase(idx, { id: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1.2 }}>
                <label style={fieldLabel}>Label</label>
                <input
                  value={p.label ?? ''}
                  placeholder={p.id || '(defaults to id)'}
                  onChange={(e) => updatePhase(idx, { label: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>Timeout (sec)</label>
                <input
                  type="number"
                  min={1}
                  value={Number.isFinite(p.timeout_sec) ? p.timeout_sec : ''}
                  onChange={(e) => updatePhase(idx, { timeout_sec: Math.floor(Number(e.target.value)) })}
                  style={inputStyle}
                />
                <div style={{ fontSize: 10, color: tokens.colors.textMuted, marginTop: 2 }}>
                  = {formatDuration(p.timeout_sec)}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => removePhase(idx)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Button variant="secondary" size="sm" onClick={addPhase}>
          Add phase
        </Button>
      </div>
    </div>
  );
}

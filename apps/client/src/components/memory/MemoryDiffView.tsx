import React, { useMemo, useState } from 'react';
import { tokens } from '../../tokens';
import { diffStats, lineDiff, type DiffLine } from './memoryFormat.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** 바뀐 줄 앞뒤로 보여 줄 같은 줄 수. 나머지는 접는다. */
const CONTEXT = 3;

type Row = { kind: 'line'; line: DiffLine; a: number | null; b: number | null } | { kind: 'fold'; count: number; id: number };

function toRows(diff: DiffLine[], expanded: ReadonlySet<number>): Row[] {
  const numbered: Array<{ line: DiffLine; a: number | null; b: number | null }> = [];
  let a = 0;
  let b = 0;
  for (const line of diff) {
    if (line.type === 'eq') numbered.push({ line, a: ++a, b: ++b });
    else if (line.type === 'del') numbered.push({ line, a: ++a, b: null });
    else numbered.push({ line, a: null, b: ++b });
  }
  const keep = new Array(numbered.length).fill(false);
  numbered.forEach((row, i) => {
    if (row.line.type === 'eq') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(numbered.length - 1, i + CONTEXT); j += 1) keep[j] = true;
  });
  const rows: Row[] = [];
  let i = 0;
  let foldId = 0;
  while (i < numbered.length) {
    if (keep[i]) {
      rows.push({ kind: 'line', ...numbered[i] });
      i += 1;
      continue;
    }
    let j = i;
    while (j < numbered.length && !keep[j]) j += 1;
    const id = foldId++;
    if (expanded.has(id)) for (let k = i; k < j; k += 1) rows.push({ kind: 'line', ...numbered[k] });
    else rows.push({ kind: 'fold', count: j - i, id });
    i = j;
  }
  return rows;
}

/** 줄 단위 diff — 바뀐 곳 앞뒤 3줄만 보이고 나머지는 눌러서 편다. */
export default function MemoryDiffView({ before, after, maxHeight = 420, emptyLabel = 'No changes.' }: {
  before: string;
  after: string;
  maxHeight?: number | string;
  emptyLabel?: string;
}) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = useMemo(() => diffStats(diff), [diff]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const rows = useMemo(() => toRows(diff, expanded), [diff, expanded]);
  if (!stats.added && !stats.removed) {
    return <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: '8px 0' }}>{emptyLabel}</div>;
  }
  return (
    <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden' }}>
      <div style={{ fontSize: 11, padding: '4px 10px', background: tokens.colors.surfaceSubtle, color: tokens.colors.textSecondary, borderBottom: `1px solid ${tokens.colors.border}` }}>
        <span style={{ color: tokens.colors.success, fontWeight: 600 }}>+{stats.added}</span>
        {'  '}
        <span style={{ color: tokens.colors.danger, fontWeight: 600 }}>−{stats.removed}</span>
        {' lines'}
      </div>
      <div style={{ maxHeight, overflow: 'auto', fontFamily: MONO, fontSize: 11.5, lineHeight: 1.55 }}>
        {rows.map((row, i) => {
          if (row.kind === 'fold') {
            return (
              <button
                key={`f${row.id}`}
                type="button"
                onClick={() => setExpanded((prev) => new Set(prev).add(row.id))}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: tokens.colors.surfaceSubtle, color: tokens.colors.textMuted, padding: '2px 10px', cursor: 'pointer', fontFamily: MONO, fontSize: 11 }}
              >
                ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
              </button>
            );
          }
          const bg = row.line.type === 'add' ? `${tokens.colors.success}1f` : row.line.type === 'del' ? `${tokens.colors.danger}1f` : 'transparent';
          const sign = row.line.type === 'add' ? '+' : row.line.type === 'del' ? '−' : ' ';
          return (
            <div key={i} style={{ display: 'flex', background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <span style={{ width: 36, flexShrink: 0, textAlign: 'right', paddingRight: 6, color: tokens.colors.textDisabled, userSelect: 'none' }}>{row.a ?? ''}</span>
              <span style={{ width: 36, flexShrink: 0, textAlign: 'right', paddingRight: 6, color: tokens.colors.textDisabled, userSelect: 'none' }}>{row.b ?? ''}</span>
              <span style={{ width: 14, flexShrink: 0, color: row.line.type === 'add' ? tokens.colors.success : row.line.type === 'del' ? tokens.colors.danger : tokens.colors.textDisabled, userSelect: 'none' }}>{sign}</span>
              <span style={{ flex: 1, minWidth: 0, color: tokens.colors.textPrimary, paddingRight: 8 }}>{row.line.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

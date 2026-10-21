import React from 'react';
import { tokens } from '../../tokens';
import type { CliMemorySnapshot, MemoryDirInfo, MemoryFileInfo, MemoryHostSnapshot } from '../../types';
import { findingAppliesTo, type MemoryFinding } from './memoryAnalysis.logic';
import { fileTokenCount, formatBytes, homeTitle, treeGroups } from './memoryState.logic';

const SEVERITY_COLOR = { critical: tokens.colors.danger, warning: tokens.colors.warning, info: tokens.colors.textMuted } as const;

/** 왼쪽 파일 트리 — 그룹(전역 / 프로젝트 / auto memory …) 아래 파일과 "새 파일" 자리. */
export default function MemoryFileTree({ snapshot, cli, homeId, onHomeChange, query, onQueryChange, selectedPath, findings, onSelect, onNewFile }: {
  snapshot: MemoryHostSnapshot;
  cli: CliMemorySnapshot;
  homeId: string;
  onHomeChange: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  selectedPath: string;
  findings: MemoryFinding[];
  onSelect: (file: MemoryFileInfo) => void;
  onNewFile: (dir: MemoryDirInfo) => void;
}) {
  const groups = treeGroups(snapshot, cli, homeId, query);
  const worstFor = (path: string) => {
    const hits = findings.filter((f) => findingAppliesTo(f, cli.cli) && f.paths[0] === path);
    if (hits.some((f) => f.severity === 'critical')) return 'critical';
    if (hits.some((f) => f.severity === 'warning')) return 'warning';
    return hits.length ? 'info' : null;
  };
  const sharedCount = cli.files.filter((f) => f.home_id === homeId && f.shared_with).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cli.homes.length > 1 && (
          <select
            value={homeId}
            onChange={(e) => onHomeChange(e.target.value)}
            aria-label="CLI home"
            style={{ fontSize: 12, padding: '4px 6px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
          >
            {cli.homes.map((h) => <option key={h.id} value={h.id}>{homeTitle(h)}</option>)}
          </select>
        )}
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search names and content…"
          aria-label="Search memory"
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 12px' }}>
        {groups.length === 0 && (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: '8px 6px' }}>{query ? 'Nothing matches.' : 'No memory files here.'}</div>
        )}
        {groups.map((g) => (
          <div key={g.key} style={{ marginTop: 8 }}>
            <div title={g.subtitle} style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: tokens.colors.textMuted, padding: '2px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {g.title}
            </div>
            {g.files.map((f) => {
              const active = f.path === selectedPath;
              const worst = worstFor(f.path);
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => onSelect(f)}
                  title={f.display_path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '5px 8px', marginTop: 1,
                    border: 'none', borderRadius: tokens.radii.md, cursor: 'pointer', fontFamily: 'inherit',
                    background: active ? tokens.colors.badgeAgentBg : 'transparent',
                    opacity: f.exists ? 1 : 0.65,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: worst ? SEVERITY_COLOR[worst] : 'transparent' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, color: active ? tokens.colors.accentSubtle : tokens.colors.textPrimary, fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.exists ? '' : '＋ '}{f.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 10.5, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.exists
                        ? `${formatBytes(f.size)} · ≈${fileTokenCount(f).toLocaleString()} tok${f.loaded === 'always' || f.loaded === 'index_head' ? ' · loaded' : ''}${f.link_target ? ' · link' : ''}`
                        : 'not created'}
                    </span>
                  </span>
                </button>
              );
            })}
            {g.dirs.map((d) => (
              <button
                key={d.path}
                type="button"
                onClick={() => onNewFile(d)}
                title={d.display_path}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px 4px 20px', border: 'none', background: 'transparent', color: tokens.colors.accentSubtle, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                + New {d.kind === 'auto_topic' ? 'memory' : 'rule'} file{d.exists ? '' : ' (creates the folder)'}
              </button>
            ))}
          </div>
        ))}
        {sharedCount > 0 && (
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, padding: '10px 6px 0' }}>
            {sharedCount} file(s) here are the same files as the operator home (linked) and are listed there.
          </div>
        )}
      </div>
    </div>
  );
}

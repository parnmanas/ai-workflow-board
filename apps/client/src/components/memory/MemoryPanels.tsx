import React, { useState } from 'react';
import { tokens } from '../../tokens';
import type { CliMemorySnapshot, MemoryHostSnapshot } from '../../types';
import { Button } from '../common';
import {
  BUDGET_CRITICAL_TOKENS,
  BUDGET_WARN_TOKENS,
  findingAppliesTo,
  type CliMemoryStats,
  type FindingSeverity,
  type MemoryAnalysis,
  type MemoryFinding,
  type MemoryFix,
} from './memoryAnalysis.logic';
import { basenameOf } from './memoryFormat.logic';
import { formatBytes, homeTitle } from './memoryState.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SEVERITY_COLOR: Record<FindingSeverity, string> = { critical: tokens.colors.danger, warning: tokens.colors.warning, info: tokens.colors.textMuted };
const SEVERITY_ICON: Record<FindingSeverity, string> = { critical: '●', warning: '▲', info: '•' };

export function fixLabel(fix: MemoryFix): string {
  switch (fix.kind) {
    case 'rebuild_index': return 'Rebuild index';
    case 'link_home': return 'Link to operator copy';
    case 'dedupe_lines': return 'Remove repeats';
    case 'normalize_entries': return 'Normalize';
    case 'delete_empty': return 'Delete';
    case 'apply': return 'Apply…';
  }
}

/** 한 번에 고쳐도 안전한 것 — 내용을 잃지 않는다(색인 맞추기 · 링크 · 반복 줄 · 형식 정리). */
export function isSafeFix(fix: MemoryFix | undefined): fix is MemoryFix {
  return !!fix && (fix.kind === 'rebuild_index' || fix.kind === 'link_home' || fix.kind === 'dedupe_lines' || fix.kind === 'normalize_entries');
}

export function ScoreBadge({ score, size = 'sm' }: { score: number; size?: 'sm' | 'lg' }) {
  const color = score >= 85 ? tokens.colors.success : score >= 60 ? tokens.colors.warning : tokens.colors.danger;
  const dim = size === 'lg' ? 44 : 22;
  return (
    <span
      title="Memory health — 100 minus 15 per critical, 5 per warning, 1 per info finding"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: dim, height: dim, borderRadius: '50%',
        border: `2px solid ${color}`, color, fontSize: size === 'lg' ? 15 : 10, fontWeight: 700, flexShrink: 0,
      }}
    >
      {score}
    </span>
  );
}

/** 오른쪽 분석 패널 — 이 CLI 에 해당하는 지적과 한 번에 고치기. */
export function FindingsPanel({ cli, analysis, selectedPath, onOpenPath, onFix, onFixAll, onOptimize, canOptimize }: {
  cli: CliMemorySnapshot;
  analysis: MemoryAnalysis;
  selectedPath: string;
  onOpenPath: (path: string) => void;
  onFix: (finding: MemoryFinding) => void;
  onFixAll: (findings: MemoryFinding[]) => void;
  onOptimize: () => void;
  canOptimize: boolean;
}) {
  const [filter, setFilter] = useState<'all' | FindingSeverity | 'file'>('all');
  const mine = analysis.findings.filter((f) => findingAppliesTo(f, cli.cli));
  const shown = mine.filter((f) => (filter === 'all' ? true : filter === 'file' ? f.paths.includes(selectedPath) : f.severity === filter));
  const safe = mine.filter((f) => isSafeFix(f.fix));
  const stats = analysis.stats.find((s) => s.cli === cli.cli);
  const counts = { critical: 0, warning: 0, info: 0 } as Record<FindingSeverity, number>;
  for (const f of mine) counts[f.severity] += 1;
  const chip = (key: typeof filter, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      style={{
        border: `1px solid ${filter === key ? tokens.colors.accent : tokens.colors.border}`, background: filter === key ? tokens.colors.badgeAgentBg : 'transparent',
        color: filter === key ? tokens.colors.accentSubtle : tokens.colors.textSecondary, borderRadius: 999, padding: '1px 9px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: '12px 14px 8px', borderBottom: `1px solid ${tokens.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ScoreBadge score={stats?.score ?? 100} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>Analysis</div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
              {counts.critical} critical · {counts.warning} warning · {counts.info} info
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {safe.length > 0 && <Button size="sm" variant="secondary" onClick={() => onFixAll(safe)}>Fix {safe.length} safe issue{safe.length === 1 ? '' : 's'}</Button>}
          {canOptimize && <Button size="sm" variant="primary" onClick={onOptimize}>Optimize with agent</Button>}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {chip('all', `All ${mine.length}`)}
          {counts.critical > 0 && chip('critical', `Critical ${counts.critical}`)}
          {counts.warning > 0 && chip('warning', `Warning ${counts.warning}`)}
          {counts.info > 0 && chip('info', `Info ${counts.info}`)}
          {selectedPath && chip('file', 'This file')}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.length === 0 && (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{mine.length ? 'Nothing in this filter.' : 'No issues found. Nice and tidy.'}</div>
        )}
        {shown.map((f) => (
          <div key={f.id} style={{ borderLeft: `3px solid ${SEVERITY_COLOR[f.severity]}`, padding: '4px 0 4px 9px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.colors.textPrimary }}>
              <span style={{ color: SEVERITY_COLOR[f.severity], marginRight: 4 }}>{SEVERITY_ICON[f.severity]}</span>
              {f.title}
            </div>
            <div style={{ fontSize: 11.5, color: tokens.colors.textSecondary, marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>{f.detail}</div>
            {f.also_clis?.length ? (
              <div style={{ fontSize: 10.5, color: tokens.colors.textMuted, marginTop: 2 }}>Shared file — also read by {[f.cli, ...f.also_clis].filter((c) => c !== cli.cli).join(', ')}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              {f.paths.slice(0, 3).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onOpenPath(p)}
                  title={p}
                  style={{ border: 'none', background: 'none', padding: 0, color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 11, fontFamily: MONO }}
                >
                  {basenameOf(p)}
                </button>
              ))}
              {f.fix && (
                <Button size="sm" variant="secondary" onClick={() => onFix(f)} style={{ marginLeft: 'auto' }}>{fixLabel(f.fix)}</Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BudgetBar({ tokens: value, label, sub }: { tokens: number; label: string; sub?: string }) {
  const pct = Math.min(100, (value / BUDGET_CRITICAL_TOKENS) * 100);
  const color = value >= BUDGET_CRITICAL_TOKENS ? tokens.colors.danger : value >= BUDGET_WARN_TOKENS ? tokens.colors.warning : tokens.colors.accent;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', fontSize: 12, color: tokens.colors.textPrimary, gap: 8 }}>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ marginLeft: 'auto', color, fontWeight: 700 }}>≈{value.toLocaleString()} tokens</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: tokens.colors.surfaceSubtle, overflow: 'hidden', position: 'relative' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
        <div style={{ position: 'absolute', left: `${(BUDGET_WARN_TOKENS / BUDGET_CRITICAL_TOKENS) * 100}%`, top: 0, bottom: 0, width: 1, background: tokens.colors.borderStrong }} />
      </div>
      {sub && <div style={{ fontSize: 10.5, color: tokens.colors.textMuted }}>{sub}</div>}
    </div>
  );
}

/** 파일을 고르지 않았을 때 가운데 — CLI 개요(매 세션 비용 · 홈 · 설정)와 장비 전체 CLI 표. */
export function CliOverview({ snapshot, cli, stats, allStats, onPickCli, onOpenPath }: {
  snapshot: MemoryHostSnapshot;
  cli: CliMemorySnapshot;
  stats: CliMemoryStats | undefined;
  allStats: CliMemoryStats[];
  onPickCli: (cli: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const projectName = (dir: string | null) => (dir ? snapshot.project_dirs.find((p) => p.path === dir)?.project_name || basenameOf(dir) : 'Global only');
  const settings = Object.entries(cli.settings);
  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>{cli.label}</div>
        <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary, marginTop: 4, lineHeight: 1.5 }}>{cli.summary}</div>
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          {[
            ['Files', `${stats.existing}`],
            ['Size', formatBytes(stats.bytes)],
            ['Every session', `≈${stats.worst_budget.tokens.toLocaleString()} tok`],
            ['On demand', `≈${stats.on_demand_tokens.toLocaleString()} tok`],
          ].map(([k, v]) => (
            <div key={k} style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, padding: '8px 12px', background: tokens.colors.surfaceCard }}>
              <div style={{ fontSize: 10.5, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {stats && stats.budgets.some((b) => b.tokens > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>Loaded into every session</div>
          {stats.budgets.filter((b) => b.tokens > 0).map((b) => (
            <div key={b.project_dir ?? 'global'}>
              <BudgetBar tokens={b.tokens} label={projectName(b.project_dir)} sub={b.files.slice(0, 4).map((f) => `${f.label} ≈${f.tokens.toLocaleString()}`).join(' · ')} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                {b.files.slice(0, 4).map((f) => (
                  <button key={f.path} type="button" onClick={() => onOpenPath(f.path)} style={{ border: 'none', background: 'none', padding: 0, color: tokens.colors.accentSubtle, fontSize: 11, cursor: 'pointer', fontFamily: MONO }}>
                    {basenameOf(f.path)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>Token counts are estimates. The line marks {BUDGET_WARN_TOKENS.toLocaleString()} tokens — beyond it memory starts crowding the task.</div>
        </div>
      )}

      {cli.homes.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>Homes</div>
          {cli.homes.map((h) => (
            <div key={h.id} style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
              <b style={{ color: tokens.colors.textPrimary }}>{homeTitle(h)}</b> <span style={{ fontFamily: MONO, fontSize: 11 }}>{h.display_path}</span>
              {' — '}{cli.files.filter((f) => f.home_id === h.id && f.exists && !f.shared_with).length} own file(s)
            </div>
          ))}
          <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>AWB sessions bound to a credential run with their own CLI home; only the history folder is linked to the operator home.</div>
        </div>
      )}

      {settings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>Settings that affect memory</div>
          {settings.map(([k, v]) => (
            <div key={k} style={{ fontSize: 12, color: tokens.colors.textSecondary, fontFamily: MONO }}>{k} = {String(v)}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>All CLIs on {snapshot.manager_name}</div>
        <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden' }}>
          {allStats.map((s) => (
            <button
              key={s.cli}
              type="button"
              onClick={() => onPickCli(s.cli)}
              style={{
                display: 'grid', gridTemplateColumns: '28px minmax(100px, 1fr) 70px 110px 120px', gap: 8, alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '7px 10px', border: 'none', borderBottom: `1px solid ${tokens.colors.border}`, cursor: 'pointer', fontFamily: 'inherit',
                background: s.cli === cli.cli ? tokens.colors.badgeAgentBg : 'transparent', color: tokens.colors.textPrimary, fontSize: 12,
              }}
            >
              <ScoreBadge score={s.score} />
              <span style={{ fontWeight: 600 }}>{s.label}</span>
              <span style={{ color: tokens.colors.textSecondary }}>{s.existing} files</span>
              <span style={{ color: tokens.colors.textSecondary }}>≈{s.worst_budget.tokens.toLocaleString()} tok</span>
              <span style={{ color: s.counts.critical ? tokens.colors.danger : s.counts.warning ? tokens.colors.warning : tokens.colors.textMuted }}>
                {s.counts.critical} / {s.counts.warning} / {s.counts.info}
              </span>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>Issues: critical / warning / info.</div>
      </div>
    </div>
  );
}

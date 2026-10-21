import React, { useMemo, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { MemoryBatchResultItem, MemoryFileInfo, MemoryHostSnapshot } from '../../types';
import { Button, Modal } from '../common';
import {
  buildBundle,
  bundleToMarkdown,
  importOps,
  parseBundle,
  planImport,
  type ConflictStrategy,
  type ImportAction,
  type MemoryBundle,
} from './memoryBundle.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const BATCH_CHUNK = 200;

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

const selectStyle: React.CSSProperties = {
  fontSize: 12.5, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`,
  background: tokens.colors.surface, color: tokens.colors.textPrimary,
};

/**
 * 내보내기 — JSON 번들(가져오기용, 위치로 적혀 다른 장비에서도 같은 자리를 찾는다) 또는 사람이 읽는 markdown.
 * 스냅샷에서 내용이 생략·잘린 파일은 내보내기 전에 전문을 다시 읽는다.
 */
export function MemoryExportModal({ snapshot, currentCli, onClose }: { snapshot: MemoryHostSnapshot; currentCli: string; onClose: () => void }) {
  const { showToast } = useToast();
  const detected = snapshot.clis.filter((c) => c.detected);
  const [clis, setClis] = useState<Set<string>>(() => new Set([currentCli]));
  const [format, setFormat] = useState<'json' | 'markdown'>('json');
  const [homes, setHomes] = useState<'operator' | 'all'>('operator');
  const [busy, setBusy] = useState(false);

  const count = detected
    .filter((c) => clis.has(c.cli))
    .reduce((n, c) => n + c.files.filter((f) => f.exists && !f.shared_with && (homes === 'all' || f.home_id === 'operator')).length, 0);

  const run = async () => {
    setBusy(true);
    try {
      const scoped: MemoryHostSnapshot = {
        ...snapshot,
        clis: snapshot.clis.map((c) => ({ ...c, files: c.files.filter((f) => homes === 'all' || f.home_id === 'operator') })),
      };
      const full = new Map<string, string>();
      for (const c of scoped.clis.filter((c) => clis.has(c.cli))) {
        for (const f of c.files.filter((f) => f.exists && !f.shared_with && (f.truncated || f.omitted || f.content === null))) {
          const read = await api.readMemoryFile(snapshot.manager_id, c.cli, f.path);
          if (read.content !== null && !read.truncated) full.set(`${c.cli}|${f.path}`, read.content);
        }
      }
      const { bundle, skipped } = buildBundle(scoped, {
        clis: Array.from(clis),
        contentOf: (cli: string, f: MemoryFileInfo) => full.get(`${cli}|${f.path}`) ?? (f.truncated || f.omitted ? null : f.content),
      });
      const base = `awb-memory-${(snapshot.hostname || 'host').replace(/[^A-Za-z0-9-]+/g, '-')}-${stamp()}`;
      if (format === 'json') download(`${base}.json`, JSON.stringify(bundle, null, 2), 'application/json');
      else download(`${base}.md`, bundleToMarkdown(bundle), 'text/markdown');
      showToast(`Exported ${bundle.files.length} file(s)${skipped.length ? ` — ${skipped.length} skipped (too large or outside known locations)` : ''}.`, skipped.length ? 'info' : 'success');
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Export memory"
      maxWidth={560}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!clis.size || !count || busy} onClick={run}>{busy ? 'Exporting…' : `Export ${count} file${count === 1 ? '' : 's'}`}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: tokens.colors.textPrimary }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>CLIs</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {detected.map((c) => (
              <label key={c.cli} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input
                  type="checkbox"
                  checked={clis.has(c.cli)}
                  onChange={(e) => setClis((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.cli); else next.delete(c.cli);
                    return next;
                  })}
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Homes
          <select value={homes} onChange={(e) => setHomes(e.target.value as 'operator' | 'all')} style={selectStyle}>
            <option value="operator">Operator home only</option>
            <option value="all">Also AWB session homes and profiles</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'markdown')} style={selectStyle}>
            <option value="json">JSON bundle — can be imported on any host</option>
            <option value="markdown">Markdown — one readable document</option>
          </select>
        </label>
        <div style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>
          Memory can hold private notes — treat the exported file like the originals.
        </div>
      </div>
    </Modal>
  );
}

const ACTION_COLOR: Record<ImportAction, string> = {
  create: tokens.colors.success,
  update: tokens.colors.warning,
  same: tokens.colors.textMuted,
  unmapped: tokens.colors.danger,
};

/**
 * 가져오기 — 번들을 이 장비의 같은 위치로 옮긴다. 계획을 먼저 보여 주고(새로 만들기 / 바꾸기 / 같음 /
 * 자리 없음), 이미 있는 파일은 고른 전략(건너뛰기 · 덮어쓰기 · 합치기)대로 쓴다. 덮어써도 이전 내용은
 * 매니저가 백업한다.
 */
export function MemoryImportModal({ snapshot, onClose, onImported }: { snapshot: MemoryHostSnapshot; onClose: () => void; onImported: () => void }) {
  const { showToast } = useToast();
  const [bundle, setBundle] = useState<MemoryBundle | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [homeMode, setHomeMode] = useState<'same' | 'operator'>('operator');
  const [strategy, setStrategy] = useState<ConflictStrategy>('skip');
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<MemoryBatchResultItem[] | null>(null);

  const plan = useMemo(() => (bundle ? planImport(snapshot, bundle, { homeMode }) : []), [bundle, snapshot, homeMode]);
  const included = plan.filter((_, i) => !excluded.has(i));
  const ops = useMemo(() => (bundle ? importOps(included, strategy, bundle) : []), [bundle, included, strategy]);

  const readFile = async (file: File) => {
    setParseError(null);
    setResults(null);
    try {
      const parsed = parseBundle(await file.text());
      setBundle(parsed);
      setExcluded(new Set());
    } catch (err: any) {
      setBundle(null);
      setParseError(err?.message || 'Could not read the bundle.');
    }
  };

  const run = async () => {
    if (!ops.length || !bundle) return;
    setRunning(true);
    const out: MemoryBatchResultItem[] = [];
    try {
      // 합치기는 대상의 전문이 있어야 한다 — 스냅샷에서 생략·잘린 대상은 다시 읽는다(남의 내용을 잘라 쓰지 않게).
      const fullPlan = [];
      for (const item of included) {
        const t = item.target;
        if (strategy === 'merge' && item.action === 'update' && t && (t.truncated || t.omitted || t.content === null)) {
          fullPlan.push({ ...item, target: await api.readMemoryFile(snapshot.manager_id, item.file.cli, t.path) });
        } else {
          fullPlan.push(item);
        }
      }
      const finalOps = importOps(fullPlan, strategy, bundle);
      for (let i = 0; i < finalOps.length; i += BATCH_CHUNK) {
        const { results: chunk } = await api.memoryBatch(snapshot.manager_id, finalOps.slice(i, i + BATCH_CHUNK));
        out.push(...chunk);
      }
      setResults(out);
      const ok = out.filter((r) => r.ok).length;
      showToast(`Imported ${ok} of ${out.length} file(s).`, ok === out.length ? 'success' : 'error');
    } catch (err: any) {
      setResults(out);
      showToast(err?.message || 'Import failed.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    if (results?.some((r) => r.ok)) onImported();
    onClose();
  };

  const counts = plan.reduce((acc, p) => ({ ...acc, [p.action]: (acc[p.action] ?? 0) + 1 }), {} as Record<string, number>);

  return (
    <Modal
      isOpen
      onClose={close}
      title={`Import memory into ${snapshot.manager_name}`}
      maxWidth={1040}
      footer={(
        <>
          <Button variant="secondary" onClick={close}>{results ? 'Done' : 'Cancel'}</Button>
          {!results && (
            <Button variant="primary" disabled={!ops.length || running} onClick={run}>
              {running ? 'Importing…' : `Write ${ops.length} file${ops.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: tokens.colors.textPrimary }}>
        <input type="file" accept="application/json,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        {parseError && <div style={{ color: tokens.colors.danger }}>{parseError}</div>}
        {bundle && (
          <>
            <div style={{ color: tokens.colors.textSecondary }}>
              {bundle.files.length} file(s) from <b>{bundle.source.manager_name || bundle.source.hostname || 'unknown host'}</b>
              {bundle.exported_at ? `, exported ${new Date(bundle.exported_at).toLocaleString()}` : ''}.
              {' '}{Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Session-home files
                <select value={homeMode} onChange={(e) => setHomeMode(e.target.value as 'same' | 'operator')} style={selectStyle}>
                  <option value="operator">Write into the operator home</option>
                  <option value="same">Keep their session home (if it exists here)</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Existing files
                <select value={strategy} onChange={(e) => setStrategy(e.target.value as ConflictStrategy)} style={selectStyle}>
                  <option value="skip">Skip — only create missing files</option>
                  <option value="merge">Merge — add as a managed block / new entries</option>
                  <option value="overwrite">Overwrite — previous content goes to History</option>
                </select>
              </label>
            </div>
            <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, maxHeight: 440, overflowY: 'auto' }}>
              {plan.map((item, i) => {
                const result = results?.find((r) => r.path === item.target_path);
                const actionable = item.action === 'create' || item.action === 'update';
                return (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 70px minmax(160px, 1fr) minmax(200px, 1.4fr) 120px', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: `1px solid ${tokens.colors.border}` }}>
                    <input
                      type="checkbox"
                      disabled={!actionable || !!results}
                      checked={actionable && !excluded.has(i)}
                      onChange={(e) => setExcluded((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(i); else next.add(i);
                        return next;
                      })}
                    />
                    <span style={{ fontSize: 11, fontWeight: 700, color: ACTION_COLOR[item.action], textTransform: 'uppercase' }}>{item.action}</span>
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.file.cli} · {item.file.label}</div>
                      <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.file.anchor === 'home' ? `${item.file.home}/` : `${item.file.project_name || item.file.project_id}/`}{item.file.rel}
                      </div>
                    </span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: item.target_path ? tokens.colors.textSecondary : tokens.colors.danger, wordBreak: 'break-all' }}>
                      {item.target_path || item.reason}
                      {item.target_path && item.reason ? ` — ${item.reason}` : ''}
                    </span>
                    <span style={{ fontSize: 11, color: result ? (result.ok ? tokens.colors.success : tokens.colors.danger) : tokens.colors.textMuted }}>
                      {result ? (result.ok ? '✓ written' : `✗ ${result.code || result.error}`) : item.action === 'update' ? strategy : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

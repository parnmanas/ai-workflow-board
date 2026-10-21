import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ApiError } from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { CliMemorySnapshot, MemoryFileInfo } from '../../types';
import { Button } from '../common';
import { renderMarkdown } from '../chat/utils/markdown';
import MemoryDiffView from './MemoryDiffView';
import type { MemoryFinding } from './memoryAnalysis.logic';
import {
  AUTO_MEMORY_TYPES,
  charCount,
  entriesCharCount,
  estimateTokens,
  memoryType,
  parseEntries,
  parseFrontmatter,
  serializeEntries,
  setAutoMemoryFields,
} from './memoryFormat.logic';
import { formatBytes, loadedBadge, relativeTime } from './memoryState.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

type ViewMode = 'edit' | 'preview' | 'diff';

interface Conflict {
  currentHash: string | null;
  theirs: string | null;
}

function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warning' | 'danger'; title?: string }) {
  const color = tone === 'accent' ? tokens.colors.accentSubtle : tone === 'warning' ? tokens.colors.warning : tone === 'danger' ? tokens.colors.danger : tokens.colors.textMuted;
  return (
    <span title={title} style={{ border: `1px solid ${color}55`, color, borderRadius: 999, padding: '1px 8px', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const color = used > limit ? tokens.colors.danger : pct >= 90 ? tokens.colors.warning : tokens.colors.accent;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: tokens.colors.textSecondary }}>
      <span>{label}</span>
      <div style={{ width: 120, height: 6, borderRadius: 3, background: tokens.colors.surfaceSubtle, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <span style={{ color, fontWeight: 600 }}>{used.toLocaleString()} / {limit.toLocaleString()}</span>
    </div>
  );
}

/** Hermes 항목 편집 — 한 항목이 한 칸. 직렬화는 항상 hermes-agent 와 같은 `\n§\n`. */
function EntriesEditor({ value, onChange, readOnly, limit }: { value: string; onChange: (next: string) => void; readOnly: boolean; limit: number | null }) {
  const entries = useMemo(() => parseEntries(value), [value]);
  const [adding, setAdding] = useState('');
  const set = (next: string[]) => onChange(serializeEntries(next));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entries.length === 0 && <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No entries yet.</div>}
      {entries.map((entry, i) => (
        <div key={`${i}:${entries.length}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, width: 22, paddingTop: 7, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
          <textarea
            value={entry}
            readOnly={readOnly}
            onChange={(e) => set(entries.map((x, j) => (j === i ? e.target.value : x)))}
            rows={Math.min(8, Math.max(2, Math.ceil(charCount(entry) / 90)))}
            style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, padding: '6px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, resize: 'vertical' }}
          />
          {!readOnly && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button type="button" title="Move up" disabled={i === 0} onClick={() => set(entries.map((x, j) => (j === i - 1 ? entries[i] : j === i ? entries[i - 1] : x)))} style={iconBtn}>↑</button>
              <button type="button" title="Move down" disabled={i === entries.length - 1} onClick={() => set(entries.map((x, j) => (j === i + 1 ? entries[i] : j === i ? entries[i + 1] : x)))} style={iconBtn}>↓</button>
              <button type="button" title="Remove entry" onClick={() => set(entries.filter((_, j) => j !== i))} style={{ ...iconBtn, color: tokens.colors.danger }}>×</button>
            </div>
          )}
          <span style={{ fontSize: 10.5, color: limit && charCount(entry) > limit ? tokens.colors.danger : tokens.colors.textMuted, width: 44, paddingTop: 7, flexShrink: 0 }}>{charCount(entry)}</span>
        </div>
      ))}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4 }}>
          <span style={{ width: 22 }} />
          <textarea
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="New entry…"
            rows={2}
            style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 12.5, padding: '6px 8px', borderRadius: tokens.radii.md, border: `1px dashed ${tokens.colors.border}`, background: 'transparent', color: tokens.colors.textPrimary, resize: 'vertical' }}
          />
          <Button size="sm" variant="secondary" disabled={!adding.trim()} onClick={() => { set([...entries, adding]); setAdding(''); }}>Add</Button>
        </div>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  width: 22, height: 20, padding: 0, fontSize: 12, lineHeight: '18px', border: `1px solid ${tokens.colors.border}`, borderRadius: 4,
  background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer',
};

/** Claude auto memory 주제 파일의 frontmatter(name / description / type) — 고치면 본문 원문에 반영된다. */
function AutoMemoryFields({ value, onChange, readOnly }: { value: string; onChange: (next: string) => void; readOnly: boolean }) {
  const fm = parseFrontmatter(value);
  const type = memoryType(fm);
  const input: React.CSSProperties = { fontSize: 12, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontFamily: 'inherit' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '6px 10px', alignItems: 'center', padding: '8px 10px', borderRadius: tokens.radii.md, background: tokens.colors.surfaceSubtle, marginBottom: 8 }}>
      <label style={{ fontSize: 11, color: tokens.colors.textSecondary }}>name</label>
      <input style={input} readOnly={readOnly} value={fm.fields.name ?? ''} onChange={(e) => onChange(setAutoMemoryFields(value, { name: e.target.value }))} />
      <label style={{ fontSize: 11, color: tokens.colors.textSecondary }}>description</label>
      <input style={input} readOnly={readOnly} value={fm.fields.description ?? ''} placeholder="One line the agent reads to decide relevance" onChange={(e) => onChange(setAutoMemoryFields(value, { description: e.target.value }))} />
      <label style={{ fontSize: 11, color: tokens.colors.textSecondary }}>type</label>
      <select style={input} disabled={readOnly} value={(AUTO_MEMORY_TYPES as readonly string[]).includes(type) ? type : ''} onChange={(e) => onChange(setAutoMemoryFields(value, { type: e.target.value }))}>
        <option value="" disabled>{type ? `${type} (unknown)` : 'choose…'}</option>
        {AUTO_MEMORY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  );
}

export interface MemoryEditorProps {
  managerId: string;
  cli: CliMemorySnapshot;
  file: MemoryFileInfo;
  /** 새 파일이면 처음 보여 줄 내용. */
  template?: string;
  findings: MemoryFinding[];
  onSaved: (info: MemoryFileInfo) => void;
  onDeleted: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenHistory: () => void;
  onOpenApply: (content: string) => void;
}

/**
 * 메모리 파일 하나의 편집기. 파일마다 새로 마운트된다(부모가 `key={cli+path}` 로 그린다) — 다른 파일로
 * 옮겨 갈 때 초안·충돌 상태가 새지 않게.
 */
export default function MemoryEditor({ managerId, cli, file, template, findings, onSaved, onDeleted, onDirtyChange, onOpenHistory, onOpenApply }: MemoryEditorProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const needsFull = file.exists && (file.truncated || file.omitted || file.content === null);
  const [loading, setLoading] = useState(needsFull);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string>(file.exists ? file.content ?? '' : '');
  const [baseHash, setBaseHash] = useState<string | null>(file.exists ? file.hash : null);
  const [draft, setDraft] = useState<string>(file.exists ? file.content ?? '' : template ?? '');
  const [readOnly, setReadOnly] = useState(!file.editable);
  const [mode, setMode] = useState<ViewMode>('edit');
  const [entriesView, setEntriesView] = useState<'list' | 'raw'>('list');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const exists = baseHash !== null;
  const dirty = draft !== saved;

  useEffect(() => { onDirtyChange(dirty && !readOnly); }, [dirty, readOnly, onDirtyChange]);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const full = await api.readMemoryFile(managerId, cli.cli, file.path);
      const text = full.content ?? '';
      setSaved(full.exists ? text : '');
      setDraft(full.exists ? text : template ?? '');
      setBaseHash(full.exists ? full.hash : null);
      setReadOnly(!full.editable || full.truncated);
      setConflict(null);
      return full;
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to read the file.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [managerId, cli.cli, file.path, template]);

  useEffect(() => {
    if (needsFull) void reload();
    // 파일마다 새로 마운트되므로 처음 한 번만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** `hash` 를 주면 그 해시를 기준으로 쓴다(충돌 뒤 "Overwrite theirs"). */
  const save = useCallback(async (opts?: { hash: string | null }) => {
    if (readOnly || saving) return;
    setSaving(true);
    try {
      const info = await api.writeMemoryFile(managerId, {
        cli: cli.cli,
        path: file.path,
        content: draft,
        base_hash: opts ? opts.hash : baseHash,
      });
      setSaved(info.content ?? draft);
      setDraft(info.content ?? draft);
      setBaseHash(info.hash);
      setConflict(null);
      onSaved(info);
      showToast(exists ? 'Saved — the previous version is in History.' : 'Created.', 'success');
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409 && e.code === 'conflict') {
        setConflict({ currentHash: e.body?.detail?.current_hash ?? null, theirs: null });
      } else {
        showToast(e.message || 'Save failed.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }, [readOnly, saving, managerId, cli.cli, file.path, draft, baseHash, exists, onSaved, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, save]);

  const showTheirs = async () => {
    try {
      const full = await api.readMemoryFile(managerId, cli.cli, file.path);
      setConflict({ currentHash: full.hash, theirs: full.content ?? '' });
    } catch (err: any) {
      showToast(err?.message || 'Failed to read the host copy.', 'error');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${file.label}?`,
      message: `${file.display_path} will be removed from the host. A backup is kept in History${file.link_target ? ' (this is a link — only the link is removed)' : ''}.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.deleteMemoryFile(managerId, { cli: cli.cli, path: file.path, ...(baseHash ? { base_hash: baseHash } : {}) });
      showToast('Deleted.', 'success');
      onDeleted(file.path);
    } catch (err: any) {
      showToast(err?.message || 'Delete failed.', 'error');
    }
  };

  const badge = loadedBadge(file);
  const lines = draft ? draft.split(/\r?\n/).length : 0;
  const entries = file.format === 'section_entries' ? parseEntries(draft) : null;
  const fileFindings = findings.filter((f) => f.paths.includes(file.path));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${tokens.colors.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>{file.label}</span>
          <Chip tone={badge.tone}>{badge.label}</Chip>
          {file.kind === 'generated' && <Chip tone="warning" title="The CLI rewrites this file from past sessions — your edits may be replaced.">regenerated by {cli.label}</Chip>}
          {file.link_target && <Chip title={file.link_target}>link → {file.link_target}</Chip>}
          {readOnly && <Chip tone="warning">{file.truncated ? 'too large to edit here' : 'read-only'}</Chip>}
          {!exists && <Chip tone="accent">new file</Chip>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {exists && <Button size="sm" variant="ghost" onClick={onOpenHistory}>History</Button>}
            {exists && <Button size="sm" variant="ghost" onClick={() => onOpenApply(draft)}>Apply to…</Button>}
            {exists && !readOnly && <Button size="sm" variant="ghost" onClick={remove}>Delete</Button>}
            {!readOnly && (
              <Button size="sm" variant="primary" disabled={!dirty || saving || loading} onClick={() => save()} title="Ctrl/⌘+S">
                {saving ? 'Saving…' : exists ? 'Save' : 'Create'}
              </Button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: tokens.colors.textMuted }}>
          <span style={{ fontFamily: MONO, color: tokens.colors.textSecondary, wordBreak: 'break-all' }}>{file.display_path}</span>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(file.path).then(() => showToast('Path copied.', 'info')); }}
            style={{ border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 11, padding: 0 }}
          >copy path</button>
          {exists && <span>{formatBytes(utf8Bytes(draft))}</span>}
          <span>{lines} lines</span>
          <span>≈{estimateTokens(draft).toLocaleString()} tokens</span>
          {file.mtime && <span>modified {relativeTime(file.mtime)}</span>}
        </div>
        {entries && file.char_limit && <Meter used={entriesCharCount(entries)} limit={file.char_limit} label="Hermes cap" />}
        {file.loaded === 'index_head' && file.load_limit_lines && (
          <div style={{ fontSize: 11, color: lines > file.load_limit_lines ? tokens.colors.warning : tokens.colors.textMuted }}>
            {lines > file.load_limit_lines
              ? `Only the first ${file.load_limit_lines} of ${lines} lines are loaded into sessions — lines below the marker are invisible.`
              : `${file.load_limit_lines - lines} of ${file.load_limit_lines} loadable lines left.`}
          </div>
        )}
        {fileFindings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {fileFindings.slice(0, 4).map((f) => (
              <div key={f.id} style={{ fontSize: 11.5, color: f.severity === 'critical' ? tokens.colors.danger : f.severity === 'warning' ? tokens.colors.warning : tokens.colors.textSecondary }}>
                {f.severity === 'critical' ? '●' : f.severity === 'warning' ? '▲' : '•'} {f.title}
              </div>
            ))}
          </div>
        )}
      </div>

      {conflict && (
        <div style={{ margin: '10px 16px 0', padding: '10px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.warning}66`, background: tokens.colors.warningBg, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12.5, color: tokens.colors.textPrimary }}>
            <b>{file.label} changed on the host</b> since you opened it — the CLI may have updated its own memory. Your edit was not saved.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" onClick={showTheirs}>Compare</Button>
            <Button size="sm" variant="secondary" onClick={() => void reload()}>Discard mine &amp; reload</Button>
            <Button size="sm" variant="danger" onClick={() => void save({ hash: conflict.currentHash })}>Overwrite theirs</Button>
          </div>
          {conflict.theirs !== null && <MemoryDiffView before={conflict.theirs} after={draft} maxHeight={260} emptyLabel="Their copy matches yours." />}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, padding: '8px 16px 0' }}>
        {(['edit', 'preview', 'diff'] as ViewMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              border: `1px solid ${mode === m ? tokens.colors.accent : tokens.colors.border}`, background: mode === m ? tokens.colors.badgeAgentBg : 'transparent',
              color: mode === m ? tokens.colors.accentSubtle : tokens.colors.textSecondary, borderRadius: tokens.radii.md, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {m === 'edit' ? 'Edit' : m === 'preview' ? 'Preview' : `Changes${dirty ? ' •' : ''}`}
          </button>
        ))}
        {file.format === 'section_entries' && mode === 'edit' && (
          <button
            type="button"
            onClick={() => setEntriesView(entriesView === 'list' ? 'raw' : 'list')}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: tokens.colors.accentSubtle, fontSize: 11.5, cursor: 'pointer' }}
          >
            {entriesView === 'list' ? 'Raw text' : 'Entry list'}
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 16px 16px' }}>
        {loading ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading the full file…</div>
        ) : loadError ? (
          <div style={{ fontSize: 12, color: tokens.colors.danger }}>{loadError} <Button size="sm" variant="ghost" onClick={() => void reload()}>Retry</Button></div>
        ) : mode === 'preview' ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: tokens.colors.textPrimary, wordBreak: 'break-word' }}>
            {file.format === 'section_entries'
              ? parseEntries(draft).map((e, i) => <div key={i} style={{ padding: '6px 0', borderBottom: `1px dashed ${tokens.colors.border}` }}>{renderMarkdown(e)}</div>)
              : renderMarkdown(parseFrontmatter(draft).body)}
          </div>
        ) : mode === 'diff' ? (
          <MemoryDiffView before={saved} after={draft} maxHeight="100%" emptyLabel="No unsaved changes." />
        ) : file.format === 'section_entries' && entriesView === 'list' ? (
          <EntriesEditor value={draft} onChange={setDraft} readOnly={readOnly} limit={file.char_limit} />
        ) : (
          <>
            {file.kind === 'auto_topic' && <AutoMemoryFields value={draft} onChange={setDraft} readOnly={readOnly} />}
            <textarea
              value={draft}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={exists ? '' : `${file.display_path} does not exist yet — write it and press Create.`}
              style={{
                width: '100%', minHeight: 420, height: 'calc(100% - 4px)', boxSizing: 'border-box', resize: 'vertical',
                fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6, padding: '10px 12px', borderRadius: tokens.radii.md,
                border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, tabSize: 2,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** UTF-8 바이트 수(브라우저에는 Buffer 가 없다). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

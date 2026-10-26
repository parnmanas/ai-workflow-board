import { getLocaleTag } from '../../i18n/core';
import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { tokens } from '../../tokens';
import type { CliMemorySnapshot, MemoryDirInfo, MemoryFileInfo, MemoryHostInfo, MemoryHostSnapshot } from '../../types';
import { Button, ErrorState, Modal } from '../common';
import PageHeader from '../PageHeader';
import MemoryApplyModal from './MemoryApplyModal';
import MemoryDiffView from './MemoryDiffView';
import MemoryEditor from './MemoryEditor';
import MemoryFileTree from './MemoryFileTree';
import MemoryHistoryModal from './MemoryHistoryModal';
import MemoryOptimizeModal from './MemoryOptimizeModal';
import { CliOverview, FindingsPanel, ScoreBadge, isSafeFix } from './MemoryPanels';
import { MemoryExportModal, MemoryImportModal } from './MemoryTransferModals';
import { analyzeSnapshot, dedupeLines, findingAppliesTo, type MemoryFinding, type MemoryFix } from './memoryAnalysis.logic';
import { basenameOf, isSafeMemoryFileName, parseEntries, rebuildIndex, serializeEntries } from './memoryFormat.logic';
import { markSnapshotFileDeleted, newFileInDir, newFileTemplate, patchSnapshotFile } from './memoryState.logic';

type ModalState =
  | { kind: 'history'; cli: string; file: MemoryFileInfo }
  | { kind: 'apply'; cli: string; file: MemoryFileInfo; content: string; preselect: { cli: string; path: string } | null }
  | { kind: 'export' }
  | { kind: 'import' }
  | { kind: 'optimize' }
  | { kind: 'new'; dir: MemoryDirInfo }
  | null;

interface FixPreview {
  title: string;
  cli: string;
  path: string;
  before: string;
  after: string;
  baseHash: string | null;
}

/**
 * 한 Runtime Host 의 CLI 메모리 — 왼쪽 파일 트리, 가운데 편집기(또는 CLI 개요), 오른쪽 분석.
 * URL `?cli=&file=` 이 선택을 들고 있어 새로고침·공유해도 같은 파일이 열린다.
 */
export default function MemoryHostView({ managerId, hosts }: { managerId: string; hosts: MemoryHostInfo[] }) {
  useLocale();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const narrow = useMediaQuery('(max-width: 1100px)');
  const [searchParams, setSearchParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<MemoryHostSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [homeId, setHomeId] = useState('operator');
  const [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<ModalState>(null);
  const [fixPreview, setFixPreview] = useState<FixPreview | null>(null);
  const [fixing, setFixing] = useState(false);
  const [newName, setNewName] = useState('');
  const [pane, setPane] = useState<'files' | 'editor' | 'analysis'>('files');
  /** 편집기를 다시 마운트시킨다 — 되돌리기·일괄 수정처럼 편집기 밖에서 파일이 바뀐 뒤. */
  const [editorNonce, setEditorNonce] = useState(0);
  const dirtyRef = useRef(false);

  const cliId = searchParams.get('cli') || '';
  const selectedPath = searchParams.get('file') || '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.getMemorySnapshot(managerId, { checkPaths: true }));
    } catch (err: any) {
      setError(err?.message || translate('Failed to read memory from this host.'));
    } finally {
      setLoading(false);
    }
  }, [managerId]);

  useEffect(() => { void load(); }, [load]);

  const analysis = useMemo(() => (snapshot ? analyzeSnapshot(snapshot) : null), [snapshot, getLocale()]);
  const detected = useMemo(() => snapshot?.clis.filter((c) => c.detected) ?? [], [snapshot, getLocale()]);
  const cli: CliMemorySnapshot | null = detected.find((c) => c.cli === cliId) ?? detected[0] ?? null;
  const selectedFile = cli
    ? cli.files.find((f) => f.path === selectedPath && !f.shared_with) ?? cli.files.find((f) => f.path === selectedPath) ?? null
    : null;

  useEffect(() => {
    if (cli && !cli.homes.some((h) => h.id === homeId)) setHomeId('operator');
  }, [cli, homeId]);

  const guardLeave = useCallback(async () => {
    if (!dirtyRef.current) return true;
    const ok = await confirm({ title: translate('Discard unsaved changes?'), message: translate('The file you are editing has changes that are not saved on the host.'), confirmLabel: translate('Discard') });
    if (ok) dirtyRef.current = false;
    return ok;
  }, [confirm]);

  const select = useCallback(async (cliName: string, file: MemoryFileInfo | null) => {
    if (file?.path === selectedPath && cliName === cli?.cli) return;
    if (!(await guardLeave())) return;
    const next = new URLSearchParams(searchParams);
    next.set('cli', cliName);
    if (file) next.set('file', file.path); else next.delete('file');
    setSearchParams(next, { replace: false });
    if (file && file.home_id !== homeId && !file.shared_with) setHomeId(file.home_id);
    if (narrow) setPane(file ? 'editor' : 'files');
  }, [selectedPath, cli, guardLeave, searchParams, setSearchParams, homeId, narrow]);

  /** 경로로 연다 — 다른 CLI 의 파일이면 그 CLI 로 넘어간다. */
  const openPath = useCallback((path: string) => {
    if (!snapshot) return;
    const owner = (cli && cli.files.some((f) => f.path === path) ? cli : null) ?? detected.find((c) => c.files.some((f) => f.path === path)) ?? null;
    const file = owner?.files.find((f) => f.path === path && !f.shared_with) ?? owner?.files.find((f) => f.path === path) ?? null;
    if (owner && file) void select(owner.cli, file);
  }, [snapshot, cli, detected, select]);

  const fullContent = useCallback(async (cliName: string, file: MemoryFileInfo): Promise<MemoryFileInfo> => {
    if (!file.exists || (file.content !== null && !file.truncated && !file.omitted)) return file;
    return api.readMemoryFile(managerId, cliName, file.path);
  }, [managerId]);

  const fileOf = (cliName: string, path: string) => snapshot?.clis.find((c) => c.cli === cliName)?.files.find((f) => f.path === path && !f.shared_with) ?? null;

  /** 고칠 내용을 계산한다(그 순간의 전문으로). 쓰기가 필요 없는 수정(링크·지우기·적용)은 null. */
  const computeFix = useCallback(async (fix: MemoryFix): Promise<FixPreview | null> => {
    if (!snapshot) return null;
    const target = fileOf(fix.cli, fix.path);
    if (fix.kind === 'rebuild_index') {
      const owner = snapshot.clis.find((c) => c.cli === fix.cli);
      if (!owner || !target) return null;
      const index = await fullContent(fix.cli, target);
      const topics = await Promise.all(owner.files
        .filter((f) => f.group === target.group && f.kind === 'auto_topic' && f.exists && !f.shared_with)
        .map(async (t) => ({ file: basenameOf(t.path), content: (await fullContent(fix.cli, t)).content ?? '' })));
      const before = index.exists ? index.content ?? '' : '';
      const { content } = rebuildIndex(before, topics);
      return { title: translate('Rebuild {0}', { 0: target.label }), cli: fix.cli, path: fix.path, before, after: content, baseHash: index.exists ? index.hash : null };
    }
    if ((fix.kind === 'dedupe_lines' || fix.kind === 'normalize_entries') && target) {
      const full = await fullContent(fix.cli, target);
      const before = full.content ?? '';
      const after = fix.kind === 'dedupe_lines' ? dedupeLines(before) : serializeEntries(parseEntries(before));
      return { title: `${fix.kind === 'dedupe_lines' ? translate('Remove repeated lines in') : translate('Normalize')} ${target.label}`, cli: fix.cli, path: fix.path, before, after, baseHash: full.hash };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, fullContent]);

  const runFix = useCallback(async (finding: MemoryFinding) => {
    const fix = finding.fix;
    if (!fix || !snapshot) return;
    try {
      if (fix.kind === 'apply') {
        const source = fileOf(fix.cli, fix.path);
        if (!source) return;
        const full = await fullContent(fix.cli, source);
        setModal({ kind: 'apply', cli: fix.cli, file: source, content: full.content ?? '', preselect: { cli: fix.target_cli, path: fix.target_path } });
        return;
      }
      if (fix.kind === 'link_home') {
        const slot = fileOf(fix.cli, fix.path);
        const ok = await confirm({
          title: translate('Link to the operator copy?'),
          message: translate('{0} will become a link to {1}, so sessions using that credential load the same instructions and stay in sync.', { 0: slot?.display_path ?? fix.path, 1: fix.target }),
          confirmLabel: translate('Link'),
          danger: false,
        });
        if (!ok) return;
        const res = await api.linkMemoryFile(managerId, { cli: fix.cli, path: fix.path, target: fix.target, base_hash: slot?.exists ? slot.hash : null });
        showToast(res.linked ? translate('Linked.') : translate('Symbolic links are not available here — copied instead (re-link after edits).'), res.linked ? 'success' : 'info');
        await load();
        return;
      }
      if (fix.kind === 'delete_empty') {
        const target = fileOf(fix.cli, fix.path);
        const ok = await confirm({ title: translate('Delete {0}?', { 0: target?.label ?? 'file' }), message: translate('{0} is empty. A backup is kept in History.', { 0: target?.display_path ?? fix.path }), confirmLabel: translate('Delete') });
        if (!ok) return;
        await api.deleteMemoryFile(managerId, { cli: fix.cli, path: fix.path, ...(target?.hash ? { base_hash: target.hash } : {}) });
        setSnapshot((prev) => (prev ? markSnapshotFileDeleted(prev, fix.cli, fix.path) : prev));
        showToast(translate('Deleted.'), 'success');
        return;
      }
      const preview = await computeFix(fix);
      if (preview) setFixPreview(preview);
    } catch (err: any) {
      showToast(err?.message || translate('Could not prepare the fix.'), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, managerId, confirm, showToast, load, computeFix, fullContent]);

  const applyPreview = async () => {
    if (!fixPreview) return;
    setFixing(true);
    try {
      const info = await api.writeMemoryFile(managerId, { cli: fixPreview.cli, path: fixPreview.path, content: fixPreview.after, base_hash: fixPreview.baseHash, reason: 'fix' });
      setSnapshot((prev) => (prev ? patchSnapshotFile(prev, fixPreview.cli, info) : prev));
      setEditorNonce((n) => n + 1);
      showToast(translate('Fixed — the previous version is in History.'), 'success');
      setFixPreview(null);
    } catch (err: any) {
      showToast(err?.message || translate('Fix failed.'), 'error');
    } finally {
      setFixing(false);
    }
  };

  /** 안전한 수정(색인 · 링크 · 반복 줄 · 형식)을 한 번에 — 한 번 묻고, 각각 그 순간의 내용으로 계산해 쓴다. */
  const fixAll = async (findings: MemoryFinding[]) => {
    const safe = findings.filter((f) => isSafeFix(f.fix));
    if (!safe.length) return;
    const ok = await confirm({
      title: translate('Fix {0} issue{1}?', { 0: safe.length, 1: safe.length === 1 ? '' : translate('s') }),
      message: (
        <div>
          <div style={{ marginBottom: 6 }}>{translate('These changes keep every fact; each file is backed up first.')}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{safe.map((f) => <li key={f.id}>{f.title}</li>)}</ul>
        </div>
      ),
      confirmLabel: translate('Fix all'),
      danger: false,
    });
    if (!ok) return;
    setFixing(true);
    let done = 0;
    const failed: string[] = [];
    for (const f of safe) {
      const fix = f.fix as MemoryFix;
      try {
        if (fix.kind === 'link_home') {
          const slot = fileOf(fix.cli, fix.path);
          await api.linkMemoryFile(managerId, { cli: fix.cli, path: fix.path, target: fix.target, base_hash: slot?.exists ? slot.hash : null });
        } else {
          const preview = await computeFix(fix);
          if (preview && preview.after !== preview.before) {
            await api.writeMemoryFile(managerId, { cli: preview.cli, path: preview.path, content: preview.after, base_hash: preview.baseHash, reason: 'fix' });
          }
        }
        done += 1;
      } catch (err: any) {
        failed.push(`${f.title}: ${err?.message || 'failed'}`);
      }
    }
    setFixing(false);
    showToast(failed.length ? translate('Fixed {0}; {1} failed — {2}', { 0: done, 1: failed.length, 2: failed[0] }) : translate('Fixed {0} issue{1}.', { 0: done, 1: done === 1 ? '' : translate('s') }), failed.length ? 'error' : 'success');
    setEditorNonce((n) => n + 1);
    await load();
  };

  const createNew = () => {
    if (modal?.kind !== 'new' || !snapshot || !cli) return;
    const name = /\.md$/i.test(newName.trim()) ? newName.trim() : `${newName.trim()}.md`;
    if (!isSafeMemoryFileName(name)) {
      showToast(translate('Use letters, numbers, dashes or underscores, ending in .md.'), 'error');
      return;
    }
    const info = newFileInDir(snapshot.platform, modal.dir, name);
    const existing = cli.files.find((f) => f.path === info.path);
    setModal(null);
    setNewName('');
    if (existing?.exists) {
      void select(cli.cli, existing);
      return;
    }
    setSnapshot((prev) => (prev ? patchSnapshotFile(prev, cli.cli, info) : prev));
    setTemplates((prev) => ({ ...prev, [info.path]: newFileTemplate(info, name) }));
    void select(cli.cli, info);
  };

  const canOptimize = hasPermission('agent_sessions.use');
  const cliFindings = analysis && cli ? analysis.findings.filter((f) => findingAppliesTo(f, cli.cli)) : [];

  if (error && !snapshot) {
    return (
      <>
        <PageHeader title={translate('Memory')} description={translate('LLM CLI memory on this Runtime Host.')} />
        <div style={{ padding: 20 }}><ErrorState message={error} onRetry={() => void load()} /></div>
      </>
    );
  }

  const header = (
    <PageHeader
      title={translate('{0} · Memory', { 0: snapshot?.manager_name || "Runtime Host" })}
      description={snapshot
        ? translate('{0} CLI{1} on {2}{3} · scanned {4}{5}', { 0: detected.length, 1: detected.length === 1 ? '' : translate('s'), 2: snapshot.hostname, 3: snapshot.platform ? ` · ${snapshot.platform}` : '', 4: new Date(snapshot.generated_at).toLocaleTimeString(getLocaleTag()), 5: snapshot.content_budget_exhausted ? translate(' · some large files load on open') : '' })
        : translate('Scanning memory files on this host…')}
      actions={(
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={() => navigate('/memory?tab=hosts')}>{translate('Hosts')}</Button>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void (async () => { if (await guardLeave()) { setEditorNonce((n) => n + 1); await load(); } })()}>
            {loading ? translate('Scanning…') : translate('Refresh')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!snapshot} onClick={() => setModal({ kind: 'import' })}>{translate('Import')}</Button>
          <Button size="sm" variant="secondary" disabled={!snapshot} onClick={() => setModal({ kind: 'export' })}>{translate('Export')}</Button>
        </div>
      )}
    />
  );

  if (!snapshot || !analysis) {
    return (
      <>
        {header}
        <div style={{ padding: 20, color: tokens.colors.textMuted, fontSize: 13 }}>{translate('Reading memory files from the host…')}</div>
      </>
    );
  }

  if (!cli) {
    return (
      <>
        {header}
        <div style={{ padding: 20, color: tokens.colors.textMuted, fontSize: 13 }}>{translate('No supported LLM CLI has a home on this host yet.')}</div>
      </>
    );
  }

  const cliTabs = (
    <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: `1px solid ${tokens.colors.border}`, overflowX: 'auto', flexShrink: 0 }}>
      {detected.map((c) => {
        const s = analysis.stats.find((x) => x.cli === c.cli);
        const active = c.cli === cli.cli;
        return (
          <button
            key={c.cli}
            type="button"
            onClick={() => void (async () => { if (c.cli !== cli.cli && (await guardLeave())) { const next = new URLSearchParams(); next.set('cli', c.cli); setSearchParams(next); setHomeId('operator'); setQuery(''); } })()}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: tokens.radii.md, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              border: `1px solid ${active ? tokens.colors.accent : tokens.colors.border}`, background: active ? tokens.colors.badgeAgentBg : 'transparent',
              color: active ? tokens.colors.accentSubtle : tokens.colors.textPrimary, fontSize: 12.5, fontWeight: 600,
            }}
          >
            {s && <ScoreBadge score={s.score} />}
            {c.label}
            <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontWeight: 500 }}>{c.files.filter((f) => f.exists && !f.shared_with).length}</span>
          </button>
        );
      })}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>
        {translate('host health')} <ScoreBadge score={analysis.score} />
      </span>
    </div>
  );

  const tree = (
    <MemoryFileTree
      snapshot={snapshot}
      cli={cli}
      homeId={homeId}
      onHomeChange={setHomeId}
      query={query}
      onQueryChange={setQuery}
      selectedPath={selectedFile?.path ?? ''}
      findings={analysis.findings}
      onSelect={(f) => void select(cli.cli, f)}
      onNewFile={(dir) => { setNewName(''); setModal({ kind: 'new', dir }); }}
    />
  );

  const center = selectedFile ? (
    <MemoryEditor
      key={`${cli.cli}|${selectedFile.path}|${editorNonce}`}
      managerId={managerId}
      cli={cli}
      file={selectedFile}
      template={templates[selectedFile.path]}
      findings={cliFindings}
      onSaved={(info) => {
        setSnapshot((prev) => (prev ? patchSnapshotFile(prev, cli.cli, info) : prev));
        setTemplates((prev) => { const { [info.path]: _gone, ...rest } = prev; return rest; });
      }}
      onDeleted={(path) => {
        dirtyRef.current = false;
        setSnapshot((prev) => (prev ? markSnapshotFileDeleted(prev, cli.cli, path) : prev));
        const next = new URLSearchParams(searchParams);
        next.delete('file');
        setSearchParams(next);
      }}
      onDirtyChange={(dirty) => { dirtyRef.current = dirty; }}
      onOpenHistory={() => setModal({ kind: 'history', cli: cli.cli, file: selectedFile })}
      onOpenApply={(content) => setModal({ kind: 'apply', cli: cli.cli, file: selectedFile, content, preselect: null })}
    />
  ) : (
    <CliOverview
      snapshot={snapshot}
      cli={cli}
      stats={analysis.stats.find((s) => s.cli === cli.cli)}
      allStats={analysis.stats}
      onPickCli={(id) => { const next = new URLSearchParams(); next.set('cli', id); setSearchParams(next); setHomeId('operator'); }}
      onOpenPath={openPath}
    />
  );

  const findingsPanel = (
    <FindingsPanel
      cli={cli}
      analysis={analysis}
      selectedPath={selectedFile?.path ?? ''}
      onOpenPath={openPath}
      onFix={(f) => void runFix(f)}
      onFixAll={(list) => void fixAll(list)}
      onOptimize={() => setModal({ kind: 'optimize' })}
      canOptimize={canOptimize}
    />
  );

  const paneStyle: React.CSSProperties = { minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' };

  return (
    <>
      {header}
      {cliTabs}
      {narrow ? (
        <>
          <div style={{ display: 'flex', gap: 4, padding: '6px 16px', borderBottom: `1px solid ${tokens.colors.border}` }}>
            {(['files', 'editor', 'analysis'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPane(p)}
                style={{
                  flex: 1, padding: '4px 0', borderRadius: tokens.radii.md, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${pane === p ? tokens.colors.accent : tokens.colors.border}`, background: pane === p ? tokens.colors.badgeAgentBg : 'transparent',
                  color: pane === p ? tokens.colors.accentSubtle : tokens.colors.textSecondary,
                }}
              >
                {p === 'files' ? translate('Files') : p === 'editor' ? (selectedFile ? translate('Editor') : translate('Overview')) : translate('Analysis ({0})', { 0: cliFindings.length })}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, ...paneStyle }}>
            {pane === 'files' ? tree : pane === 'editor' ? center : findingsPanel}
          </div>
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr) 340px' }}>
          <div style={{ ...paneStyle, borderRight: `1px solid ${tokens.colors.border}` }}>{tree}</div>
          <div style={paneStyle}>{center}</div>
          <div style={{ ...paneStyle, borderLeft: `1px solid ${tokens.colors.border}` }}>{findingsPanel}</div>
        </div>
      )}

      {fixPreview && (
        <Modal
          isOpen
          onClose={() => setFixPreview(null)}
          title={fixPreview.title}
          maxWidth={900}
          footer={(
            <>
              <Button variant="secondary" onClick={() => setFixPreview(null)}>{translate('Cancel')}</Button>
              <Button variant="primary" disabled={fixing || fixPreview.before === fixPreview.after} onClick={applyPreview}>{fixing ? translate('Writing…') : translate('Apply fix')}</Button>
            </>
          )}
        >
          <MemoryDiffView before={fixPreview.before} after={fixPreview.after} maxHeight={480} emptyLabel={translate('Already fine — nothing to change.')} />
        </Modal>
      )}

      {modal?.kind === 'new' && (
        <Modal
          isOpen
          onClose={() => setModal(null)}
          title={translate('New file in {0}', { 0: modal.dir.label })}
          maxWidth={520}
          footer={(
            <>
              <Button variant="secondary" onClick={() => setModal(null)}>{translate('Cancel')}</Button>
              <Button variant="primary" disabled={!newName.trim()} onClick={createNew}>{translate('Continue')}</Button>
            </>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: tokens.colors.textPrimary }}>
            <div style={{ color: tokens.colors.textSecondary }}>
              {translate('In')} <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{modal.dir.display_path}</span>.
              {modal.dir.kind === 'auto_topic' ? translate(' Remember to add a line for it in MEMORY.md — or run "Rebuild index" afterwards.') : ''}
            </div>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) createNew(); }}
              placeholder={modal.dir.kind === 'auto_topic' ? 'feedback-prefer-small-commits.md' : 'testing.md'}
              style={{ fontSize: 13, padding: '6px 10px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
            />
          </div>
        </Modal>
      )}

      {modal?.kind === 'history' && (
        <MemoryHistoryModal
          managerId={managerId}
          cli={modal.cli}
          file={modal.file}
          onClose={() => setModal(null)}
          onRestored={(info) => {
            setSnapshot((prev) => (prev ? patchSnapshotFile(prev, modal.cli, info) : prev));
            dirtyRef.current = false;
            setEditorNonce((n) => n + 1);
          }}
        />
      )}

      {modal?.kind === 'apply' && (
        <MemoryApplyModal
          snapshot={snapshot}
          hosts={hosts}
          source={{ cli: modal.cli, file: modal.file, content: modal.content }}
          preselect={modal.preselect}
          onClose={() => setModal(null)}
          onApplied={(id) => { if (id === managerId) { setEditorNonce((n) => n + 1); void load(); } }}
        />
      )}

      {modal?.kind === 'export' && <MemoryExportModal snapshot={snapshot} currentCli={cli.cli} onClose={() => setModal(null)} />}
      {modal?.kind === 'import' && (
        <MemoryImportModal snapshot={snapshot} onClose={() => setModal(null)} onImported={() => { setEditorNonce((n) => n + 1); void load(); }} />
      )}
      {modal?.kind === 'optimize' && (
        <MemoryOptimizeModal snapshot={snapshot} cli={cli} findings={analysis.findings} onClose={() => setModal(null)} />
      )}
    </>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { MemoryBatchOp, MemoryBatchResultItem, MemoryFileInfo, MemoryHostInfo, MemoryHostSnapshot } from '../../types';
import { Button, Modal } from '../common';
import MemoryDiffView from './MemoryDiffView';
import {
  applyCandidates,
  applyContent,
  defaultApplyMode,
  hasAppliedBlock,
  type ApplyMode,
  type ApplySource,
} from './memoryBundle.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

interface TargetState {
  selected: boolean;
  mode: ApplyMode;
  open: boolean;
}

const MODE_LABEL: Record<ApplyMode, string> = {
  block: 'Managed block (re-apply updates it)',
  replace: 'Replace whole file',
  entries: 'Add as entries (skip duplicates)',
};

/**
 * 한 메모리 파일을 다른 CLI(같은 장비 또는 다른 Runtime Host)의 메모리에 적용한다. 기본은 관리 블록 —
 * 대상의 나머지 내용은 그대로 두고, 같은 출처를 다시 적용하면 그 블록만 바뀐다. Hermes 처럼 항목 파일이면
 * 항목으로 바꿔 없는 것만 더한다. 쓰기는 대상의 현재 해시를 걸고 한 번의 batch 로 나간다.
 */
export default function MemoryApplyModal({ snapshot, hosts, source, preselect, onClose, onApplied }: {
  snapshot: MemoryHostSnapshot;
  hosts: MemoryHostInfo[];
  source: { cli: string; file: MemoryFileInfo; content: string };
  preselect?: { cli: string; path: string } | null;
  onClose: () => void;
  onApplied: (managerId: string) => void;
}) {
  const { showToast } = useToast();
  const [hostId, setHostId] = useState(snapshot.manager_id);
  const [target, setTarget] = useState<MemoryHostSnapshot | null>(snapshot);
  const [loadingHost, setLoadingHost] = useState(false);
  const [state, setState] = useState<Record<string, TargetState>>({});
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<MemoryBatchResultItem[] | null>(null);
  // 쓴 호스트는 닫을 때 알린다 — 바로 알리면 부모가 스냅샷을 다시 읽어 이 창의 결과 표시가 지워진다.
  const appliedHosts = useRef(new Set<string>());
  const close = () => {
    for (const id of appliedHosts.current) onApplied(id);
    onClose();
  };

  const sourceProjectId = source.file.project_dir
    ? snapshot.project_dirs.find((p) => p.path === source.file.project_dir)?.project_id ?? null
    : null;
  const applySource: ApplySource = { cli: source.cli, host: snapshot.hostname || snapshot.manager_id, file: source.file, content: source.content };

  useEffect(() => {
    if (hostId === snapshot.manager_id) {
      setTarget(snapshot);
      return;
    }
    let cancelled = false;
    setLoadingHost(true);
    setTarget(null);
    api.getMemorySnapshot(hostId)
      .then((s) => { if (!cancelled) setTarget(s); })
      .catch((err: any) => { if (!cancelled) showToast(err?.message || 'Failed to load that host.', 'error'); })
      .finally(() => { if (!cancelled) setLoadingHost(false); });
    return () => { cancelled = true; };
  }, [hostId, snapshot, showToast]);

  const candidates = useMemo(() => (target
    ? applyCandidates(target, { cli: source.cli, file: source.file, sameHost: target.manager_id === snapshot.manager_id, projectId: sourceProjectId })
    : []), [target, source.cli, source.file, snapshot.manager_id, sourceProjectId]);

  useEffect(() => {
    const next: Record<string, TargetState> = {};
    for (const c of candidates) {
      const key = `${c.cli.cli}|${c.file.path}`;
      next[key] = {
        selected: !!preselect && preselect.cli === c.cli.cli && preselect.path === c.file.path,
        mode: defaultApplyMode(c.file),
        open: false,
      };
    }
    setState(next);
    setResults(null);
  }, [candidates, preselect]);

  const chosen = candidates.filter((c) => state[`${c.cli.cli}|${c.file.path}`]?.selected);

  /** 대상 파일 전문 — 스냅샷에서 내용이 생략·잘렸으면 적용 전에 다시 읽는다(남의 내용을 잘라 쓰지 않게). */
  const fullTarget = async (file: MemoryFileInfo, cli: string): Promise<MemoryFileInfo> => {
    if (!file.exists || (!file.truncated && !file.omitted && file.content !== null)) return file;
    return api.readMemoryFile(hostId, cli, file.path);
  };

  const run = async () => {
    if (!chosen.length) return;
    setRunning(true);
    try {
      const ops: MemoryBatchOp[] = [];
      for (const c of chosen) {
        const file = await fullTarget(c.file, c.cli.cli);
        const mode = state[`${c.cli.cli}|${c.file.path}`].mode;
        const content = applyContent(applySource, file, mode);
        if (file.exists && content === (file.content ?? '')) continue;
        ops.push({ op: 'write', cli: c.cli.cli, path: file.path, content, base_hash: file.exists ? file.hash : null, reason: 'apply' });
      }
      if (!ops.length) {
        showToast('Every target already has this content.', 'info');
        setRunning(false);
        return;
      }
      const { results: out } = await api.memoryBatch(hostId, ops);
      setResults(out);
      const ok = out.filter((r) => r.ok).length;
      showToast(`Applied to ${ok} of ${out.length} file(s).`, ok === out.length ? 'success' : 'error');
      if (ok) appliedHosts.current.add(hostId);
    } catch (err: any) {
      showToast(err?.message || 'Apply failed.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const supported = hosts.filter((h) => h.supported);

  return (
    <Modal
      isOpen
      onClose={close}
      title={`Apply ${source.file.label}`}
      maxWidth={980}
      footer={(
        <>
          <Button variant="secondary" onClick={close}>{results ? 'Done' : 'Cancel'}</Button>
          {!results && (
            <Button variant="primary" disabled={!chosen.length || running || loadingHost} onClick={run}>
              {running ? 'Applying…' : `Apply to ${chosen.length} file${chosen.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary }}>
          From <span style={{ fontFamily: MONO }}>{source.file.display_path}</span> ({source.cli}). Each write keeps a backup on the target host.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: tokens.colors.textPrimary }}>
          Target host
          <select
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            style={{ fontSize: 12.5, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
          >
            {supported.map((h) => <option key={h.manager_id} value={h.manager_id}>{h.name}{h.manager_id === snapshot.manager_id ? ' (this host)' : ''}</option>)}
          </select>
          {source.file.scope === 'project' && (
            <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>Project files go to the same project's folder on the target host.</span>
          )}
        </label>

        {loadingHost ? (
          <div style={{ fontSize: 12.5, color: tokens.colors.textMuted }}>Scanning that host…</div>
        ) : !candidates.length ? (
          <div style={{ fontSize: 12.5, color: tokens.colors.textMuted }}>
            No matching memory file on that host{source.file.scope === 'project' ? ' for this project (does it have a folder there?)' : ''}.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 520, overflowY: 'auto' }}>
            {candidates.map((c) => {
              const key = `${c.cli.cli}|${c.file.path}`;
              const st = state[key];
              if (!st) return null;
              const result = results?.find((r) => r.path === c.file.path);
              const again = hasAppliedBlock(applySource, c.file);
              const modes: ApplyMode[] = c.file.format === 'section_entries' ? ['entries', 'replace'] : ['block', 'replace'];
              return (
                <div key={key} style={{ border: `1px solid ${st.selected ? tokens.colors.accent : tokens.colors.border}`, borderRadius: tokens.radii.md, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="checkbox"
                      checked={st.selected}
                      disabled={!!results}
                      onChange={(e) => setState((prev) => ({ ...prev, [key]: { ...prev[key], selected: e.target.checked } }))}
                    />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: tokens.colors.textPrimary }}>{c.cli.label} · {c.file.label}</span>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: tokens.colors.textMuted }}>{c.file.display_path}</span>
                    {!c.file.exists && <span style={{ fontSize: 10.5, color: tokens.colors.accentSubtle }}>new</span>}
                    {again && <span style={{ fontSize: 10.5, color: tokens.colors.accentSubtle }}>applied before — will update</span>}
                    {result && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: result.ok ? tokens.colors.success : tokens.colors.danger }}>
                        {result.ok ? '✓ written' : `✗ ${result.error}`}
                      </span>
                    )}
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        value={st.mode}
                        disabled={!!results}
                        onChange={(e) => setState((prev) => ({ ...prev, [key]: { ...prev[key], mode: e.target.value as ApplyMode } }))}
                        style={{ fontSize: 11.5, padding: '2px 6px', borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
                      >
                        {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => setState((prev) => ({ ...prev, [key]: { ...prev[key], open: !prev[key].open } }))}
                        style={{ border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 11.5 }}
                      >
                        {st.open ? 'Hide preview' : 'Preview'}
                      </button>
                    </div>
                  </div>
                  {st.open && (
                    <div style={{ marginTop: 8 }}>
                      {c.file.truncated || c.file.omitted
                        ? <div style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>The target is large; the full file is read when you apply.</div>
                        : <MemoryDiffView before={c.file.exists ? c.file.content ?? '' : ''} after={applyContent(applySource, c.file, st.mode)} maxHeight={280} emptyLabel="Already up to date." />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

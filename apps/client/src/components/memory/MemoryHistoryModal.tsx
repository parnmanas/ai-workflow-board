import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { MemoryFileInfo, MemoryVersionInfo } from '../../types';
import { Button, Modal } from '../common';
import MemoryDiffView from './MemoryDiffView';
import { formatBytes, relativeTime } from './memoryState.logic';

/**
 * 백업 버전 — 매니저가 쓰기·지우기·되돌리기 직전마다 떠 둔 사본(파일당 최근 30개). 고르면 지금 내용과의
 * 차이를 보이고, Restore 는 지금 내용도 백업한 뒤 되돌린다.
 */
export default function MemoryHistoryModal({ managerId, cli, file, onClose, onRestored }: {
  managerId: string;
  cli: string;
  file: MemoryFileInfo;
  onClose: () => void;
  onRestored: (info: MemoryFileInfo) => void;
}) {
  useLocale();
  const { showToast } = useToast();
  const [versions, setVersions] = useState<MemoryVersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ content: string; hash: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, full] = await Promise.all([
          api.listMemoryVersions(managerId, cli, file.path),
          file.exists ? api.readMemoryFile(managerId, cli, file.path) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setVersions(list);
        setCurrent({ content: full?.exists ? full.content ?? '' : '', hash: full?.exists ? full.hash : null });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || translate('Failed to load history.'));
      }
    })();
    return () => { cancelled = true; };
  }, [managerId, cli, file.path, file.exists]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setSelectedContent(null);
    api.readMemoryVersion(managerId, cli, file.path, selected)
      .then((v) => { if (!cancelled) setSelectedContent(v.content); })
      .catch((err: any) => { if (!cancelled) showToast(err?.message || translate('Failed to read that version.'), 'error'); });
    return () => { cancelled = true; };
  }, [selected, managerId, cli, file.path, showToast]);

  const restore = async () => {
    if (!selected || !current) return;
    setRestoring(true);
    try {
      const info = await api.restoreMemoryVersion(managerId, { cli, path: file.path, version_id: selected, base_hash: current.hash });
      showToast(translate('Restored — the version you replaced is now in History too.'), 'success');
      onRestored(info);
      onClose();
    } catch (err: any) {
      showToast(err?.message || translate('Restore failed.'), 'error');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={translate('History · {0}', { 0: file.label })}
      maxWidth={980}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('Close')}</Button>
          <Button variant="primary" disabled={!selected || selectedContent === null || restoring} onClick={restore}>
            {restoring ? translate('Restoring…') : translate('Restore this version')}
          </Button>
        </>
      )}
    >
      {error ? (
        <div style={{ color: tokens.colors.danger, fontSize: 13 }}>{error}</div>
      ) : !versions ? (
        <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>{translate('Loading…')}</div>
      ) : versions.length === 0 ? (
        <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>
          {translate('No backups yet. AWB keeps a copy every time it changes this file — edits made directly by the CLI are not versioned.')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 12, minHeight: 320 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 460, overflowY: 'auto' }}>
            {versions.map((v) => (
              <button
                key={v.version_id}
                type="button"
                onClick={() => setSelected(v.version_id)}
                style={{
                  textAlign: 'left', padding: '6px 10px', borderRadius: tokens.radii.md, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${selected === v.version_id ? tokens.colors.accent : tokens.colors.border}`,
                  background: selected === v.version_id ? tokens.colors.badgeAgentBg : 'transparent',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textPrimary }}>{new Date(v.created_at).toLocaleString(getLocaleTag())}</div>
                <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                  {translate('before')} {v.reason} · {formatBytes(v.size)} · {relativeTime(v.created_at)}
                  {current?.hash === v.hash ? translate(' · same as now') : ''}
                </div>
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            {!selected ? (
              <div style={{ color: tokens.colors.textMuted, fontSize: 12.5 }}>{translate('Pick a version to compare it with the current file.')}</div>
            ) : selectedContent === null ? (
              <div style={{ color: tokens.colors.textMuted, fontSize: 12.5 }}>{translate('Loading version…')}</div>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: tokens.colors.textSecondary, marginBottom: 6 }}>{translate('Changes if you restore (current → this version):')}</div>
                <MemoryDiffView before={current?.content ?? ''} after={selectedContent} maxHeight={420} emptyLabel={translate('Identical to the current file.')} />
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Manager-host directory picker (ST-7) ────────────────────────────
// Modal that browses the manager process's filesystem via the existing
// /api/agents/:id/fs/{roots,list} reverse-RPC. Used by the
// Create-managed-agent dialog so the user picks the working_dir from a
// directory tree instead of typing an absolute path.
//
// Differences from the existing AgentFileBrowser:
//   - Directories only — files are hidden from the listing.
//   - Adds a "Use this directory" action that resolves the parent's
//     onPick callback with the currently-shown path.
//   - Self-contained empty / error states; no file viewer pane.
//
// Caller passes the MANAGER's agent_id (the manager Agent row created
// during pairing). The fs_browser section in the manager's config.json
// must list at least one root, otherwise the roots fetch returns
// `enabled: false` and we render an actionable error pointing the user
// at the config file.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { FsDriveEntry, FsListResult, FsRootsResult } from '../../types';
import { tokens } from '../../tokens';
import { Button, Modal } from '../common';

// Sentinel value parentOf returns for a drive root on Windows. The picker
// reads this and flips into drive-list mode (renders the volume list as
// pseudo-directories) instead of trying to traverse off the file system.
const DRIVES_SENTINEL = '__drives__';

function isWindowsDriveRoot(path: string): boolean {
  // Strict drive root: `C:\`, `D:/`, ... — exactly drive letter + sep + nothing.
  return /^[A-Za-z]:[\\/]?$/.test(path);
}

interface DirectoryPickerProps {
  isOpen: boolean;
  onClose(): void;
  /** Manager's own agent_id (instance.agent_id from the dashboard row). */
  managerAgentId: string;
  /** Pre-fill the listing with this directory if set; else use the
   *  manager's configured first root or its cwd. */
  initialPath?: string;
  /** User confirmed the currently-shown directory. */
  onPick(path: string): void;
}

interface Crumb {
  label: string;
  path: string;
}

function splitCrumbs(path: string): Crumb[] {
  // Same shape as AgentFileBrowser's helper — kept local rather than
  // imported so this picker stays standalone (no shared module needed).
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindows ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const crumbs: Crumb[] = [];
  if (isWindows) {
    const drive = path.slice(0, 2);
    crumbs.push({ label: drive, path: `${drive}${sep}` });
  } else {
    crumbs.push({ label: '/', path: '/' });
  }
  let cursor = crumbs[0].path;
  for (const part of parts) {
    cursor = cursor.endsWith(sep) ? `${cursor}${part}` : `${cursor}${sep}${part}`;
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}

function parentOf(path: string): string | null {
  if (!path) return null;
  // At a Windows drive root, "up" surfaces the drive list rather than
  // looping back onto the same path. Caller switches into drive-list mode
  // when it sees the sentinel.
  if (isWindowsDriveRoot(path)) return DRIVES_SENTINEL;
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindows ? '\\' : '/';
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return isWindows ? `${trimmed.slice(0, 2)}${sep}` : '/';
  return trimmed.slice(0, idx);
}

export default function DirectoryPicker({
  isOpen,
  onClose,
  managerAgentId,
  initialPath,
  onPick,
}: DirectoryPickerProps) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FsListResult | null>(null);
  const [roots, setRoots] = useState<FsRootsResult | null>(null);
  // 'browse' renders directory entries from `listing`; 'drives' renders
  // the volume-root list (Windows multi-drive only — UNIX collapses to a
  // single `/` so we never enter this mode there).
  const [mode, setMode] = useState<'browse' | 'drives'>('browse');
  const [drives, setDrives] = useState<FsDriveEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWindowsManager = roots?.platform === 'win32' || (path && /^[A-Za-z]:[\\/]/.test(path));
  const crumbs = useMemo(() => (path ? splitCrumbs(path) : []), [path]);
  const directories = useMemo(
    () => (listing?.entries || []).filter((e) => e.type === 'directory'),
    [listing],
  );

  const loadDrives = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAgentFsDrives(managerAgentId);
      setDrives(result.drives || []);
      setMode('drives');
    } catch (err: any) {
      setError(err?.message || 'Failed to enumerate drives');
    } finally {
      setLoading(false);
    }
  }, [managerAgentId]);

  const loadPath = useCallback(
    async (target: string) => {
      if (!target) return;
      // Caller routes the sentinel through here so a single click handler
      // works for crumbs / parent / root buttons.
      if (target === DRIVES_SENTINEL) {
        await loadDrives();
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await api.listAgentFs(managerAgentId, target);
        setListing(result);
        setPath(result.path);
        setMode('browse');
      } catch (err: any) {
        setListing(null);
        setError(err?.message || 'Failed to list directory');
      } finally {
        setLoading(false);
      }
    },
    [managerAgentId, loadDrives],
  );

  // Initial discovery on open: fetch roots + cwd, choose a sensible start.
  useEffect(() => {
    if (!isOpen) return;
    setPath('');
    setListing(null);
    setError(null);
    setRoots(null);
    setMode('browse');
    setDrives(null);
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getAgentFsRoots(managerAgentId);
        if (cancelled) return;
        setRoots(info);
        // ST-7: fs_browser defaults to enabled with $HOME + cwd as starting
        // points; the picker only fails here if the manager is offline or
        // the request times out. Older managers may still report
        // enabled=false, so we keep a fallback path of "use cwd if we got
        // it" rather than blocking the picker.
        const fallbackStart = initialPath || info.cwd || (info.roots[0] || '');
        if (info.roots.length === 0) {
          if (fallbackStart) {
            await loadPath(fallbackStart);
          } else {
            setError('Manager returned no starting directories.');
          }
          return;
        }
        const start = initialPath
          || (info.roots.some((r) => info.cwd === r || info.cwd.startsWith(r + '/') || info.cwd.startsWith(r + '\\'))
            ? info.cwd
            : info.roots[0]);
        if (start) await loadPath(start);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to query manager filesystem');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, managerAgentId, initialPath, loadPath]);

  const handleUseHere = useCallback(() => {
    if (!path) return;
    onPick(path);
    onClose();
  }, [path, onPick, onClose]);

  const parent = path ? parentOf(path) : null;
  // ST-7: scope check is informational only now (manager defaults to
  // unrestricted browsing). When the operator has pinned roots we still
  // surface "outside scope" as a hint; we don't block confirmation since
  // a manual override could still be intentional.
  const hasExplicitRoots = roots && roots.roots.length > 0;
  const outsideExplicitRoots = hasExplicitRoots
    && !roots.roots.some((r) => path === r || path.startsWith(r + '/') || path.startsWith(r + '\\'));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Pick working directory on manager host"
      maxWidth={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleUseHere} disabled={!path || mode === 'drives'}>
            Use this directory
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 360 }}>
        {/* Roots row — quick jump to any configured root. */}
        {roots && roots.enabled && roots.roots.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontWeight: 700 }}>
              Roots:
            </span>
            {roots.roots.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => loadPath(r)}
                style={{
                  padding: '3px 8px',
                  border: `1px solid ${tokens.colors.border}`,
                  background: r === path ? tokens.colors.surfaceSubtle : 'transparent',
                  color: tokens.colors.textPrimary,
                  borderRadius: tokens.radii.sm,
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                }}
                title={r}
              >
                {r}
              </button>
            ))}
          </div>
        )}

        {/* Breadcrumbs + parent button */}
        {(path || mode === 'drives') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => parent && loadPath(parent)}
              disabled={mode === 'drives' || !parent || loading}
              style={{
                padding: '2px 8px',
                border: `1px solid ${tokens.colors.border}`,
                background: 'transparent',
                borderRadius: tokens.radii.sm,
                fontSize: 11,
                cursor: mode === 'drives' || !parent ? 'not-allowed' : 'pointer',
                color: tokens.colors.textSecondary,
              }}
              title={mode === 'drives' ? 'Already at the volume list' : 'Up one level'}
            >
              ↑
            </button>
            {/* Windows-only: a virtual "💻 Drives" crumb so the user can
                jump back to the volume list from any depth without
                clicking ↑ repeatedly. Hidden on UNIX where there is only
                one root. */}
            {isWindowsManager && (
              <button
                type="button"
                onClick={loadDrives}
                disabled={loading || mode === 'drives'}
                style={{
                  padding: '2px 6px',
                  background: 'transparent',
                  border: 'none',
                  color: mode === 'drives' ? tokens.colors.textStrong : tokens.colors.accent,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
                title="Show drive list"
              >
                💻 Drives
              </button>
            )}
            {mode === 'browse' && crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {(i > 0 || isWindowsManager) && <span style={{ color: tokens.colors.textMuted }}>/</span>}
                <button
                  type="button"
                  onClick={() => loadPath(c.path)}
                  disabled={loading}
                  style={{
                    padding: '2px 6px',
                    background: 'transparent',
                    border: 'none',
                    color: i === crumbs.length - 1 ? tokens.colors.textStrong : tokens.colors.accent,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Listing — directories only (browse mode) or volume roots (drives mode) */}
        <div
          style={{
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            background: tokens.colors.surfaceCard,
            minHeight: 240,
            maxHeight: 400,
            overflow: 'auto',
          }}
        >
          {loading && <div style={{ padding: 12, fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>}
          {!loading && error && (
            <div style={{ padding: 12, fontSize: 12, color: tokens.colors.danger, lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          {!loading && !error && mode === 'drives' && drives && drives.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              Manager reported no accessible volume roots.
            </div>
          )}
          {!loading && !error && mode === 'drives' && drives && drives.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => loadPath(d.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${tokens.colors.border}`,
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontSize: 12,
                color: tokens.colors.textPrimary,
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surfaceSubtle; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span>💽</span>
              <span>{d.name}</span>
              <span style={{ marginLeft: 'auto', color: tokens.colors.textMuted }}>{d.path}</span>
            </button>
          ))}
          {!loading && !error && mode === 'browse' && directories.length === 0 && listing && (
            <div style={{ padding: 12, fontSize: 12, color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              No subdirectories here. Use the "Use this directory" button below to pick the
              current path, or navigate up.
            </div>
          )}
          {!loading && !error && mode === 'browse' && directories.map((d) => {
            const sep = /^[A-Za-z]:[\\/]/.test(path) ? '\\' : '/';
            const childPath = path.endsWith(sep) ? `${path}${d.name}` : `${path}${sep}${d.name}`;
            return (
              <button
                key={d.name}
                type="button"
                onClick={() => loadPath(childPath)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 12px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${tokens.colors.border}`,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: tokens.colors.textPrimary,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surfaceSubtle; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <span>📁</span>
                <span>{d.name}</span>
              </button>
            );
          })}
        </div>

        {/* Selected path summary */}
        {mode === 'browse' && path && (
          <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>
            <strong style={{ color: tokens.colors.textPrimary }}>Selected:</strong>{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{path}</code>
            {outsideExplicitRoots && (
              <span style={{ color: tokens.colors.warning, marginLeft: 8 }}>
                (outside the manager's configured fs_browser.roots — pick anyway if intentional)
              </span>
            )}
          </div>
        )}
        {mode === 'drives' && (
          <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>
            Pick a volume to browse. Use the breadcrumbs above to drill in once a drive is open.
          </div>
        )}
      </div>
    </Modal>
  );
}

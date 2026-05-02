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
import type { FsListResult, FsRootsResult } from '../../types';
import { tokens } from '../../tokens';
import { Button, Modal } from '../common';

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
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindows ? '\\' : '/';
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return isWindows ? trimmed.slice(0, 3) : '/';
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crumbs = useMemo(() => (path ? splitCrumbs(path) : []), [path]);
  const directories = useMemo(
    () => (listing?.entries || []).filter((e) => e.type === 'directory'),
    [listing],
  );

  const loadPath = useCallback(
    async (target: string) => {
      if (!target) return;
      setLoading(true);
      setError(null);
      try {
        const result = await api.listAgentFs(managerAgentId, target);
        setListing(result);
        setPath(result.path);
      } catch (err: any) {
        setListing(null);
        setError(err?.message || 'Failed to list directory');
      } finally {
        setLoading(false);
      }
    },
    [managerAgentId],
  );

  // Initial discovery on open: fetch roots + cwd, choose a sensible start.
  useEffect(() => {
    if (!isOpen) return;
    setPath('');
    setListing(null);
    setError(null);
    setRoots(null);
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getAgentFsRoots(managerAgentId);
        if (cancelled) return;
        setRoots(info);
        if (!info.enabled || info.roots.length === 0) {
          setError(
            'fs_browser is not enabled on this manager. Add `"fs_browser": ' +
              '{ "enabled": true, "roots": ["/abs/path"] }` to the manager\'s ' +
              'config.json (~/.config/awb-agent-manager/config.json) and restart it.',
          );
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
  const inScope = roots && roots.roots.some((r) => path === r || path.startsWith(r + '/') || path.startsWith(r + '\\'));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Pick working directory on manager host"
      maxWidth={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleUseHere} disabled={!path || !inScope}>
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
        {path && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => parent && loadPath(parent)}
              disabled={!parent || loading}
              style={{
                padding: '2px 8px',
                border: `1px solid ${tokens.colors.border}`,
                background: 'transparent',
                borderRadius: tokens.radii.sm,
                fontSize: 11,
                cursor: parent ? 'pointer' : 'not-allowed',
                color: tokens.colors.textSecondary,
              }}
              title="Up one level"
            >
              ↑
            </button>
            {crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {i > 0 && <span style={{ color: tokens.colors.textMuted }}>/</span>}
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

        {/* Listing — directories only */}
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
          {!loading && !error && directories.length === 0 && listing && (
            <div style={{ padding: 12, fontSize: 12, color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              No subdirectories here. Use the "Use this directory" button below to pick the
              current path, or navigate up.
            </div>
          )}
          {!loading && !error && directories.map((d) => {
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
        {path && (
          <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>
            <strong style={{ color: tokens.colors.textPrimary }}>Selected:</strong>{' '}
            <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{path}</code>
            {!inScope && (
              <span style={{ color: tokens.colors.danger, marginLeft: 8 }}>
                (outside configured roots — adjust manager fs_browser.roots to use)
              </span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { FsListEntry, FsListResult, FsReadResult, FsRootsResult } from '../types';
import { tokens } from '../tokens';

interface AgentFileBrowserProps {
  agentId: string;
  isOnline: boolean;
}

// Each crumb carries both the full absolute path (for API calls) and the label
// (last path segment) so we can render the breadcrumb without another split
// on every render.
interface Crumb {
  label: string;
  path: string;
}

function splitCrumbs(path: string): Crumb[] {
  // Accept both POSIX and Windows-ish input. The server returned `path` was
  // resolved on the agent side, so whatever separator it uses is canonical.
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindows ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const crumbs: Crumb[] = [];
  if (isWindows) {
    const drive = path.slice(0, 2);
    crumbs.push({ label: drive, path: `${drive}${sep}` });
    // The split above keeps the drive-letter segment (`C:`) as parts[0]; it is
    // already represented by the root crumb pushed above. Drop it — otherwise
    // the drive shows twice in the breadcrumb AND every child crumb path gets
    // a doubled `C:\C:\…` prefix that the manager rejects as an invalid path.
    parts.shift();
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

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function iconFor(entry: FsListEntry): string {
  if (entry.type === 'directory') return '📁';
  if (entry.type === 'symlink') return '🔗';
  if (entry.type === 'other') return '❓';
  return '📄';
}

export default function AgentFileBrowser({ agentId, isOnline }: AgentFileBrowserProps) {
  const [path, setPath] = useState<string>('');
  const [inputPath, setInputPath] = useState<string>('');
  const [listing, setListing] = useState<FsListResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<FsReadResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [rootsInfo, setRootsInfo] = useState<FsRootsResult | null>(null);

  const crumbs = useMemo(() => (path ? splitCrumbs(path) : []), [path]);

  const loadPath = useCallback(async (nextPath: string) => {
    if (!nextPath) return;
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const result = await api.listAgentFs(agentId, nextPath);
      setListing(result);
      setPath(result.path);
      setInputPath(result.path);
    } catch (err: any) {
      setListing(null);
      setError(err?.message || 'Failed to list directory');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const openFile = useCallback(async (filePath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.readAgentFs(agentId, filePath, { limit: 1024 * 1024 });
      setSelectedFile(result);
    } catch (err: any) {
      setSelectedFile(null);
      setError(err?.message || 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // Reset view, then auto-discover the starting directory: ask the plugin
    // for its cwd + configured roots and list whichever makes sense. Without
    // this step the user would have to guess an absolute path to begin with,
    // which defeats the "file explorer" affordance.
    setPath('');
    setInputPath('');
    setListing(null);
    setSelectedFile(null);
    setError(null);
    setRootsInfo(null);

    if (!isOnline) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getAgentFsRoots(agentId);
        if (cancelled) return;
        setRootsInfo(info);
        if (!info.enabled) {
          setError('File browsing is disabled on this agent. Add a fs_browser.roots list to the plugin config.');
          return;
        }
        // Prefer cwd when it's already inside a configured root — the human
        // usually wants to start where the agent is actually working. Fall
        // back to the first root when cwd is outside scope.
        const cwdInScope = info.roots.some(r => info.cwd === r || info.cwd.startsWith(r + '/') || info.cwd.startsWith(r + '\\'));
        const starting = cwdInScope ? info.cwd : (info.roots[0] || '');
        if (starting) loadPath(starting);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to fetch agent scope roots');
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, isOnline, loadPath]);

  if (!isOnline) {
    return (
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: 8 }}>
        Agent is offline — file browsing unavailable.
      </div>
    );
  }

  return (
    // height:100% + minHeight:0 + flex column so the panel fills the agent-detail
    // body. Listing + file viewer below claim flex:1 to share remaining space and
    // scroll inside themselves — without this the natural sum of header + listing
    // (maxHeight 320) + viewer (maxHeight 400) overflows the body and the outer
    // wrapper's overflow:hidden clips the bottom of the viewer.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      {rootsInfo && rootsInfo.roots.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginRight: 2 }}>
            Roots
          </span>
          {rootsInfo.roots.map((root) => {
            const isActive = path === root || path.startsWith(root + '/') || path.startsWith(root + '\\');
            return (
              <button
                key={root}
                type="button"
                onClick={() => loadPath(root)}
                title={root}
                style={{
                  background: isActive ? tokens.colors.accent : tokens.colors.surfaceCard,
                  color: isActive ? 'white' : tokens.colors.textSecondary,
                  border: `1px solid ${isActive ? tokens.colors.accent : tokens.colors.border}`,
                  borderRadius: tokens.radii.full,
                  padding: '2px 10px',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  cursor: 'pointer',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {root.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || root}
              </button>
            );
          })}
          {rootsInfo.cwd && !rootsInfo.roots.includes(rootsInfo.cwd) && (
            <button
              type="button"
              onClick={() => loadPath(rootsInfo.cwd)}
              title={`cwd: ${rootsInfo.cwd}`}
              style={{
                background: 'transparent',
                color: tokens.colors.textMuted,
                border: `1px dashed ${tokens.colors.border}`,
                borderRadius: tokens.radii.full,
                padding: '2px 10px',
                fontSize: 11,
                fontFamily: 'monospace',
                cursor: 'pointer',
              }}
            >cwd</button>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); loadPath(inputPath.trim()); }}
        style={{ display: 'flex', gap: 6 }}
      >
        <input
          value={inputPath}
          onChange={(e) => setInputPath(e.target.value)}
          placeholder="/absolute/path/on/agent"
          style={{
            flex: 1,
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.sm,
            padding: '6px 10px',
            color: tokens.colors.textStrong,
            fontSize: 12,
            fontFamily: 'monospace',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={loading || !inputPath.trim()}
          style={{
            background: tokens.colors.accent,
            color: 'white',
            border: 'none',
            borderRadius: tokens.radii.sm,
            padding: '6px 12px',
            fontSize: 12,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading || !inputPath.trim() ? 0.6 : 1,
          }}
        >Go</button>
      </form>

      {crumbs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11, fontFamily: 'monospace' }}>
          {crumbs.map((c, i) => (
            <button
              key={c.path}
              type="button"
              onClick={() => loadPath(c.path)}
              style={{
                background: 'transparent',
                color: i === crumbs.length - 1 ? tokens.colors.textStrong : tokens.colors.accent,
                border: 'none',
                padding: '2px 4px',
                cursor: 'pointer',
                textDecoration: i === crumbs.length - 1 ? 'none' : 'underline',
                fontSize: 11,
              }}
            >{c.label}</button>
          )).reduce<React.ReactNode[]>((acc, el, i) => {
            if (i > 0) acc.push(<span key={`sep-${i}`} style={{ color: tokens.colors.textMuted }}>/</span>);
            acc.push(el);
            return acc;
          }, [])}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: tokens.colors.danger, padding: 6, background: `${tokens.colors.danger}15`, borderRadius: tokens.radii.sm }}>
          {error}
        </div>
      )}

      {listing && (
        <div style={{
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.sm,
          flex: '1 1 0',
          minHeight: 120,
          overflowY: 'auto',
        }}>
          {listing.entries.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: tokens.colors.textMuted, textAlign: 'center' }}>
              (empty directory)
            </div>
          ) : (
            listing.entries.map((entry) => {
              const full = `${listing.path}${listing.path.endsWith('/') || listing.path.endsWith('\\') ? '' : '/'}${entry.name}`;
              const clickable = entry.type === 'directory' || entry.type === 'file' || entry.type === 'symlink';
              return (
                <div
                  key={entry.name}
                  onClick={() => {
                    if (entry.type === 'directory') loadPath(full);
                    else if (entry.type === 'file') openFile(full);
                    else if (entry.type === 'symlink') openFile(full);
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 1fr 80px 140px',
                    padding: '4px 8px',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    borderBottom: `1px solid ${tokens.colors.border}40`,
                    cursor: clickable ? 'pointer' : 'default',
                    color: tokens.colors.textPrimary,
                  }}
                  onMouseEnter={(e) => { if (clickable) (e.currentTarget as HTMLDivElement).style.background = `${tokens.colors.accent}15`; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                >
                  <span>{iconFor(entry)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
                  <span style={{ textAlign: 'right', color: tokens.colors.textMuted }}>{entry.type === 'directory' ? '—' : formatSize(entry.size)}</span>
                  <span style={{ textAlign: 'right', color: tokens.colors.textMuted, fontSize: 11 }}>{entry.mtime ? new Date(entry.mtime).toLocaleString() : ''}</span>
                </div>
              );
            })
          )}
          {listing.truncated && (
            <div style={{ padding: 8, fontSize: 11, color: tokens.colors.textMuted, textAlign: 'center', borderTop: `1px solid ${tokens.colors.border}` }}>
              Listing truncated — directory has more entries than the plugin returns.
            </div>
          )}
        </div>
      )}

      {selectedFile && (
        <div style={{
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.sm,
          background: tokens.colors.surface,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flex: '1 1 0',
          minHeight: 120,
          overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace', flexShrink: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedFile.path}</span>
            <span>
              {selectedFile.encoding} · {formatSize(selectedFile.read_bytes)}
              {selectedFile.truncated ? ` / ${formatSize(selectedFile.size)} (truncated)` : ''}
            </span>
          </div>
          {selectedFile.encoding === 'utf8' ? (
            <pre style={{
              margin: 0,
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              fontSize: 12,
              fontFamily: 'monospace',
              lineHeight: 1.4,
              color: tokens.colors.textPrimary,
              whiteSpace: 'pre',
            }}>{selectedFile.content}</pre>
          ) : (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
              Binary file ({formatSize(selectedFile.size)}). Download link not yet wired — copy via base64 in the meantime if needed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

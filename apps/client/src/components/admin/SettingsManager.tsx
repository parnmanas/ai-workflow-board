import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Card } from '../common';

interface DiscoveredItem { id: string; name: string }
interface DiscoveryState {
  loading: boolean;
  mode: 'local' | 'remote' | null;
  items: DiscoveredItem[];
  error: string | null;
}
const EMPTY_DISCOVERY: DiscoveryState = { loading: false, mode: null, items: [], error: null };

function isMaskedValue(v: string): boolean {
  return typeof v === 'string' && v.includes('••••');
}

function isSelfUrl(url: string): boolean {
  const trimmed = (url || '').trim().replace(/\/$/, '');
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    const here = `${window.location.protocol}//${window.location.host}`.toLowerCase();
    return `${parsed.protocol}//${parsed.host}`.toLowerCase() === here;
  } catch {
    return false;
  }
}

function shortLabelForUnknown(id: string): string {
  const head = (id || '').slice(0, 8);
  return `Unknown (${head}…)`;
}

function dropdownOptions(currentId: string, discovered: DiscoveryState): DiscoveredItem[] {
  const out: DiscoveredItem[] = [];
  for (const it of discovered.items) out.push(it);
  if (currentId && !out.some((x) => x.id === currentId)) {
    out.unshift({ id: currentId, name: shortLabelForUnknown(currentId) });
  }
  return out;
}

interface SettingRow {
  key: string;
  value: string;
  description: string;
  is_secret: boolean;
  updated_at: string | null;
}

const PROVIDER_OPTIONS = [
  { value: 'none', label: 'None (disabled)' },
  { value: 'openai', label: 'OpenAI' },
];

type RemoteTestStatus = { ok: boolean; status?: number; message: string } | null;

export default function SettingsManager() {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [testingRemote, setTestingRemote] = useState(false);
  const [remoteTestResult, setRemoteTestResult] = useState<RemoteTestStatus>(null);

  // ─── Self-Improvement cascade discovery ────────────────────────────
  // Three independent fetches keyed on (URL, API key) and the upstream
  // selection. Each populates a dropdown; the user's stored id stays
  // selected even if it no longer appears in the discovered set
  // (rendered as an "Unknown (uuid…)" option so they can see + replace).
  const [wsDiscovery, setWsDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [boardDiscovery, setBoardDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [colDiscovery, setColDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.getSettings();
      setSettings(list);
      const vals: Record<string, string> = {};
      list.forEach((s) => { vals[s.key] = s.value; });
      setFormValues(vals);
      setDirty(false);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleChange = (key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateSettings(formValues);
      showToast('Settings saved.', 'success');
      await loadSettings();
      setRemoteTestResult(null);
    } catch (err: any) {
      showToast(err?.message || 'Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTestRemote = async () => {
    setTestingRemote(true);
    setRemoteTestResult(null);
    try {
      const result = await api.testSelfImprovementRemote();
      setRemoteTestResult(result);
    } catch (err: any) {
      setRemoteTestResult({ ok: false, message: err?.message || 'Test failed' });
    } finally {
      setTestingRemote(false);
    }
  };

  // Resolve the discovery target from the live form state. The API key is
  // only meaningful to the server when targeting a remote URL — for self
  // mode the body field is ignored. We still send the masked value to
  // keep the body shape uniform; the server detects masked and falls back
  // to the stored key.
  const remoteUrl = formValues['self_improvement.remote_awb_url'] || '';
  const remoteApiKey = formValues['self_improvement.remote_awb_api_key'] || '';
  const selfImprovementWorkspaceId = formValues['self_improvement.remote_awb_workspace_id'] || '';
  const selfImprovementBoardId = formValues['self_improvement.remote_awb_board_id'] || '';
  const selfImprovementColumnId = formValues['self_improvement.remote_awb_column_id'] || '';
  const isLocalMode = useMemo(() => isSelfUrl(remoteUrl), [remoteUrl]);

  // For remote-mode dropdowns to function before Save, the typed-but-not-yet-
  // saved API key must reach the discover endpoints. Skip discovery when
  // remote-mode but the key is empty AND nothing is stored (settings list
  // returns empty string when no value is saved).
  const storedApiKeyExists = useMemo(
    () => !!settings.find((s) => s.key === 'self_improvement.remote_awb_api_key' && s.value),
    [settings],
  );
  const remoteKeyAvailable = !isLocalMode && (
    (remoteApiKey && !isMaskedValue(remoteApiKey)) ||  // user typed a fresh key
    isMaskedValue(remoteApiKey) ||                       // masked → server falls back
    storedApiKeyExists                                    // empty input but key is saved
  );

  // Debounce URL/key edits so we don't fire a discovery request per
  // keystroke. 400ms matches the cadence used by other admin probes.
  const debounceRef = useRef<number | null>(null);
  const [debouncedUrl, setDebouncedUrl] = useState(remoteUrl);
  const [debouncedKey, setDebouncedKey] = useState(remoteApiKey);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setDebouncedUrl(remoteUrl);
      setDebouncedKey(remoteApiKey);
    }, 400);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [remoteUrl, remoteApiKey]);

  // Workspaces — fires whenever URL or key changes (after settings load).
  // Remote-mode without a usable key short-circuits to a friendly error so
  // the dropdown shows guidance instead of a stale spinner.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const localMode = isSelfUrl(debouncedUrl);
    if (!localMode && !remoteKeyAvailable) {
      setWsDiscovery({ loading: false, mode: 'remote', items: [], error: 'API key required for remote URL.' });
      setBoardDiscovery(EMPTY_DISCOVERY);
      setColDiscovery(EMPTY_DISCOVERY);
      return;
    }
    setWsDiscovery((prev) => ({ ...prev, loading: true, error: null }));
    api.discoverSelfImprovementWorkspaces({ url: debouncedUrl, api_key: debouncedKey })
      .then((r) => {
        if (cancelled) return;
        setWsDiscovery({ loading: false, mode: r.mode, items: r.items, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setWsDiscovery({ loading: false, mode: localMode ? 'local' : 'remote', items: [], error: err?.message || 'Discovery failed' });
      });
    return () => { cancelled = true; };
  }, [loading, debouncedUrl, debouncedKey, remoteKeyAvailable]);

  // Boards — depends on the selected workspace; resets when the workspace
  // changes so the cascading state stays consistent.
  useEffect(() => {
    if (loading) return;
    if (!selfImprovementWorkspaceId) {
      setBoardDiscovery(EMPTY_DISCOVERY);
      return;
    }
    let cancelled = false;
    const localMode = isSelfUrl(debouncedUrl);
    if (!localMode && !remoteKeyAvailable) {
      setBoardDiscovery({ loading: false, mode: 'remote', items: [], error: 'API key required for remote URL.' });
      return;
    }
    setBoardDiscovery((prev) => ({ ...prev, loading: true, error: null }));
    api.discoverSelfImprovementBoards({ url: debouncedUrl, api_key: debouncedKey, workspace_id: selfImprovementWorkspaceId })
      .then((r) => {
        if (cancelled) return;
        setBoardDiscovery({ loading: false, mode: r.mode, items: r.items, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setBoardDiscovery({ loading: false, mode: localMode ? 'local' : 'remote', items: [], error: err?.message || 'Discovery failed' });
      });
    return () => { cancelled = true; };
  }, [loading, debouncedUrl, debouncedKey, selfImprovementWorkspaceId, remoteKeyAvailable]);

  // Columns — depends on the selected board.
  useEffect(() => {
    if (loading) return;
    if (!selfImprovementBoardId) {
      setColDiscovery(EMPTY_DISCOVERY);
      return;
    }
    let cancelled = false;
    const localMode = isSelfUrl(debouncedUrl);
    if (!localMode && !remoteKeyAvailable) {
      setColDiscovery({ loading: false, mode: 'remote', items: [], error: 'API key required for remote URL.' });
      return;
    }
    setColDiscovery((prev) => ({ ...prev, loading: true, error: null }));
    api.discoverSelfImprovementColumns({ url: debouncedUrl, api_key: debouncedKey, board_id: selfImprovementBoardId })
      .then((r) => {
        if (cancelled) return;
        setColDiscovery({ loading: false, mode: r.mode, items: r.items, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setColDiscovery({ loading: false, mode: localMode ? 'local' : 'remote', items: [], error: err?.message || 'Discovery failed' });
      });
    return () => { cancelled = true; };
  }, [loading, debouncedUrl, debouncedKey, selfImprovementBoardId, remoteKeyAvailable]);

  // Cascade reset: clearing a parent selection clears child selections
  // (and `setDirty(true)` flags the form for save).
  const handleWorkspacePick = (id: string) => {
    setFormValues((prev) => ({
      ...prev,
      'self_improvement.remote_awb_workspace_id': id,
      'self_improvement.remote_awb_board_id': '',
      'self_improvement.remote_awb_column_id': '',
    }));
    setDirty(true);
  };
  const handleBoardPick = (id: string) => {
    setFormValues((prev) => ({
      ...prev,
      'self_improvement.remote_awb_board_id': id,
      'self_improvement.remote_awb_column_id': '',
    }));
    setDirty(true);
  };
  const handleColumnPick = (id: string) => {
    setFormValues((prev) => ({
      ...prev,
      'self_improvement.remote_awb_column_id': id,
    }));
    setDirty(true);
  };

  if (loading) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>;
  }

  const embeddingEnabled = formValues['embedding.provider'] === 'openai';

  const labelStyle: React.CSSProperties = {
    fontSize: tokens.typography.fontSizeXs,
    fontWeight: tokens.typography.fontWeightSemibold,
    color: tokens.colors.textMuted,
    textTransform: 'uppercase',
    display: 'block',
    marginBottom: tokens.spacing.xs,
  };

  const hintStyle: React.CSSProperties = {
    fontSize: '11px',
    color: tokens.colors.textMuted,
    marginBottom: 4,
  };

  const selectStyle: React.CSSProperties = {
    width: '100%',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

  const secretInputStyle: React.CSSProperties = {
    width: '100%',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    boxSizing: 'border-box',
    outline: 'none',
  };

  function DiscoveryDropdown(props: {
    label: string;
    hint: string;
    currentId: string;
    discovery: DiscoveryState;
    onPick: (id: string) => void;
    labelStyle: React.CSSProperties;
    hintStyle: React.CSSProperties;
    selectStyle: React.CSSProperties;
    disabledReason: string | null;
  }) {
    const { label, hint, currentId, discovery, onPick, labelStyle: ls, hintStyle: hs, selectStyle: ss, disabledReason } = props;
    const options = dropdownOptions(currentId, discovery);
    const disabled = !!disabledReason || (discovery.items.length === 0 && !currentId && !discovery.loading && !!discovery.error);
    const statusLine =
      disabledReason ||
      (discovery.loading ? 'Loading…' : null) ||
      (discovery.error ? discovery.error : null) ||
      (discovery.items.length === 0 && currentId
        ? 'Saved selection no longer appears in the discovered list.'
        : null);
    return (
      <div>
        <label style={ls}>{label}</label>
        <div style={hs}>{hint}</div>
        <select
          value={currentId}
          onChange={(e) => onPick(e.target.value)}
          disabled={disabled}
          style={{ ...ss, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          <option value="">{currentId ? '(Clear selection)' : '(Select…)'}</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name || opt.id}</option>
          ))}
        </select>
        {statusLine && (
          <div style={{ ...hs, marginTop: 4, color: discovery.error ? (tokens.colors.danger || tokens.colors.textMuted) : tokens.colors.textMuted }}>
            {statusLine}
          </div>
        )}
      </div>
    );
  }

  function StatusDot({ enabled, enabledText, disabledText }: { enabled: boolean; enabledText: string; disabledText: string }) {
    return (
      <div style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: tokens.radii.md,
        background: enabled ? `${tokens.colors.accent}15` : `${tokens.colors.border}40`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: enabled ? tokens.colors.accent : tokens.colors.textMuted,
        }} />
        <span style={{ fontSize: '12px', color: enabled ? tokens.colors.accent : tokens.colors.textMuted }}>
          {enabled ? enabledText : disabledText}
        </span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ─── Embedding Configuration ─── */}
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          Embedding Configuration
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          Configure vector embedding for semantic resource search. When enabled, resources are automatically
          embedded and searchable via natural language queries through MCP.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Provider</label>
            <div style={hintStyle}>Embedding provider (openai or none)</div>
            <select
              value={formValues['embedding.provider'] || 'none'}
              onChange={(e) => handleChange('embedding.provider', e.target.value)}
              style={selectStyle}
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {embeddingEnabled && (
            <>
              <div>
                <label style={labelStyle}>API Key</label>
                <div style={hintStyle}>API key for the embedding provider</div>
                <input
                  type="password"
                  value={formValues['embedding.api_key'] || ''}
                  onChange={(e) => handleChange('embedding.api_key', e.target.value)}
                  placeholder="sk-..."
                  style={secretInputStyle}
                />
              </div>
              <Input
                label="Model"
                value={formValues['embedding.model'] || 'text-embedding-3-small'}
                onChange={(e) => handleChange('embedding.model', e.target.value)}
                placeholder="text-embedding-3-small"
              />
            </>
          )}
        </div>

        <StatusDot
          enabled={embeddingEnabled}
          enabledText="Vector search enabled — resources will be auto-embedded"
          disabledText="Vector search disabled — text search only"
        />
      </Card>

      {/* ─── MCP Configuration ─── */}
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          MCP Configuration
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          Limits the active MCP session count. Once the cap is reached the oldest-idle session is
          evicted (LRU) so subagent fanout can't grow the in-memory store without bound. Idle
          sessions still expire after 10 minutes regardless of this setting.
        </div>

        <div>
          <label style={labelStyle}>Max concurrent sessions</label>
          <div style={hintStyle}>{settings.find((s) => s.key === 'mcp.max_sessions')?.description || ''}</div>
          <Input
            type="number"
            min={1}
            value={formValues['mcp.max_sessions'] || ''}
            onChange={(e) => handleChange('mcp.max_sessions', e.target.value)}
            placeholder="200"
          />
        </div>
      </Card>

      {/* ─── Self-Improvement (remote AWB target) ─── */}
      <Card padding="20px">
        <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
          Self-Improvement (remote AWB target)
        </div>
        <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
          When a board opts in with <code>self_improvement_mode = 'remote_awb'</code> or <code>'both'</code>,
          the reviewer's post-done retrospective can file improvement tickets against another AWB
          instance — typically the meta-AWB that hosts AWB platform improvements. Configure the
          target board here. The API key is stored encrypted and never exposed to subagents.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Input
              label="Remote AWB URL"
              value={formValues['self_improvement.remote_awb_url'] || ''}
              onChange={(e) => handleChange('self_improvement.remote_awb_url', e.target.value)}
              placeholder="Leave empty to use this server"
            />
            <div style={{ ...hintStyle, marginTop: 4 }}>
              {isLocalMode
                ? 'Local (this server) — discovery hits the local DB directly; no API key required.'
                : 'Remote — discovery forwards through MCP using the API key below.'}
            </div>
          </div>

          <div>
            <label style={labelStyle}>API Key (X-Agent-Key for remote AWB)</label>
            <div style={hintStyle}>
              {isLocalMode
                ? 'Optional for local — the admin session authorizes discovery directly.'
                : 'Stored encrypted. Re-enter to rotate; masked on read.'}
            </div>
            <input
              type="password"
              value={formValues['self_improvement.remote_awb_api_key'] || ''}
              onChange={(e) => handleChange('self_improvement.remote_awb_api_key', e.target.value)}
              placeholder="awb-…"
              style={secretInputStyle}
            />
          </div>

          <DiscoveryDropdown
            label="Workspace (on target)"
            hint="Pick the workspace where improvement tickets land."
            currentId={selfImprovementWorkspaceId}
            discovery={wsDiscovery}
            onPick={handleWorkspacePick}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
            selectStyle={selectStyle}
            disabledReason={null}
          />

          <DiscoveryDropdown
            label="Board (on target)"
            hint="Cascades from the workspace selection."
            currentId={selfImprovementBoardId}
            discovery={boardDiscovery}
            onPick={handleBoardPick}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
            selectStyle={selectStyle}
            disabledReason={selfImprovementWorkspaceId ? null : 'Pick a workspace first.'}
          />

          <DiscoveryDropdown
            label="Column (typically Backlog / To-Do)"
            hint="Cascades from the board selection."
            currentId={selfImprovementColumnId}
            discovery={colDiscovery}
            onPick={handleColumnPick}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
            selectStyle={selectStyle}
            disabledReason={selfImprovementBoardId ? null : 'Pick a board first.'}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTestRemote}
              disabled={testingRemote || dirty}
              loading={testingRemote}
            >
              Test connection
            </Button>
            {dirty && (
              <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                Save settings before testing.
              </span>
            )}
            {!dirty && isLocalMode && !remoteTestResult && (
              <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                Local (this instance) — no API key required.
              </span>
            )}
            {remoteTestResult && !dirty && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px',
                borderRadius: tokens.radii.md,
                background: remoteTestResult.ok
                  ? `${tokens.colors.accent}15`
                  : `${tokens.colors.danger || tokens.colors.textMuted}15`,
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: remoteTestResult.ok ? tokens.colors.accent : (tokens.colors.danger || tokens.colors.textMuted),
                }} />
                <span style={{ fontSize: 12, color: remoteTestResult.ok ? tokens.colors.accent : (tokens.colors.danger || tokens.colors.textMuted) }}>
                  {remoteTestResult.message}
                  {typeof remoteTestResult.status === 'number' ? ` (HTTP ${remoteTestResult.status})` : ''}
                </span>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ─── Save ─── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!dirty || saving}
          loading={saving}
        >
          Save Settings
        </Button>
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from './common';
import { RuntimeProfileConfig } from '../types';
import { tokens } from '../tokens';

export default function CliRuntimeProfilesEditor({
  raw, selected, onSave,
}: {
  raw?: string | null;
  selected?: string | null;
  onSave: (profiles: RuntimeProfileConfig[], selected: string | null) => Promise<void>;
}) {
  const initial = raw || '[]';
  const [text, setText] = useState(initial);
  const [defaultId, setDefaultId] = useState(selected || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(raw || '[]'); setDefaultId(selected || ''); }, [raw, selected]);
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) ? value as RuntimeProfileConfig[] : null;
    } catch { return null; }
  }, [text]);
  const ids = parsed?.map(profile => profile.id).filter(Boolean) ?? [];
  return (
    <section style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>CLI runtime profiles</h3>
      <p style={{ color: tokens.colors.textMuted, fontSize: 13 }}>
        Declarative runtime registry. Credential fields accept Credential ids only; active sessions require restart.
      </p>
      <textarea rows={16} value={text} onChange={event => setText(event.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', borderColor: parsed ? tokens.colors.border : tokens.colors.danger }} />
      <label style={{ display: 'block', marginTop: 10, fontSize: 13 }}>Workspace default</label>
      <select value={defaultId} onChange={event => setDefaultId(event.target.value)} style={{ minWidth: 240 }}>
        <option value="">None / inherit</option><option value="none">Explicit none</option>
        {ids.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" size="sm" disabled={!parsed || busy} onClick={async () => {
          if (!parsed) return;
          setBusy(true);
          try { await onSave(parsed, defaultId || null); } finally { setBusy(false); }
        }}>Save runtime profiles</Button>
      </div>
    </section>
  );
}

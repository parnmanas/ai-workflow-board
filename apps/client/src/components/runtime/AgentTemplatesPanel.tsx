import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentTemplate } from '../../types';
import { Button, Input, Modal } from '../common';
import { tokens } from '../../tokens';
import RuntimeSelectionFields, { applyAgentTemplate, emptyRuntimeSelection, type RuntimeSelectionHost, type RuntimeSelectionValue } from './RuntimeSelectionFields';

export default function AgentTemplatesPanel() {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [hosts, setHosts] = useState<RuntimeSelectionHost[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<RuntimeSelectionValue>(emptyRuntimeSelection());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = () => api.listAgentTemplates().then(setTemplates);
  useEffect(() => {
    let disposed = false;
    Promise.all([api.listAgentTemplates(), api.listTemplateHosts()])
      .then(([rows, hostRows]) => {
        if (disposed) return;
        setTemplates(rows);
        setHosts(hostRows);
      }).catch((e) => { if (!disposed) setError(e.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const value = { ...draft, name: name.trim() };
      if (editing) await api.updateAgentTemplate(editing, value);
      else await api.createAgentTemplate(value);
      await reload(); setEditing(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0, fontSize: 16, color: tokens.colors.textStrong }}>Agent 템플릿</h2>
      <Button disabled={busy || loading} onClick={() => { setName(''); setDraft(emptyRuntimeSelection()); setEditing(''); setError(''); }}>템플릿 등록</Button>
    </div>
    <p style={{ color: tokens.colors.textSecondary, fontSize: 13, lineHeight: 1.6 }}>자주 쓰는 Host·CLI·Model·Effort를 Agent 템플릿으로 등록합니다. 세션·채팅·보드·팀에서 불러온 뒤 자유롭게 수정할 수 있습니다.</p>
    {loading && <p role="status">Agent 템플릿을 불러오는 중…</p>}
    {!loading && !error && !templates.length && <p>등록된 Agent 템플릿이 없습니다. ‘템플릿 등록’으로 자주 쓰는 설정을 저장하세요.</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12 }}>
      {templates.map((t) => <div key={t.id} style={{ minWidth: 0, padding: 16, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, background: tokens.colors.surfaceCard }}>
        <strong style={{ display: 'block', overflowWrap: 'anywhere', color: tokens.colors.textStrong }}>{t.name}</strong>
        <dl style={{ display: 'grid', gridTemplateColumns: '55px minmax(0, 1fr)', gap: '6px 12px', fontSize: 12, margin: '12px 0' }}>
          {Object.entries({ Host: hosts.find((h) => h.id === t.host_id)?.name || t.host_id, CLI: t.cli, Model: t.model || 'CLI 기본값', Effort: t.effort || 'CLI 기본값' }).map(([label, value]) => <React.Fragment key={label}>
            <dt style={{ color: tokens.colors.textMuted }}>{label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere', color: tokens.colors.textSecondary }}>{value}</dd>
          </React.Fragment>)}
        </dl>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button size="sm" disabled={busy} onClick={() => { setName(t.name); setDraft(applyAgentTemplate(t)); setEditing(t.id); setError(''); }}>편집</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await api.deleteAgentTemplate(t.id); await reload(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>삭제</Button>
        </div>
      </div>)}
    </div>
    {error && editing === null && <div role="alert">{error}</div>}
    <Modal isOpen={editing !== null} onClose={() => { if (!busy) setEditing(null); }} title={editing ? 'Agent 템플릿 편집' : 'Agent 템플릿 등록'} maxWidth={560}
      footer={<><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>취소</Button>
        <Button onClick={() => void save()} disabled={busy || !name.trim() || !draft.host_id || !draft.cli}>{busy ? '저장 중…' : editing ? '변경사항 저장' : '등록'}</Button></>}>
      <Input label="템플릿 이름" aria-label="템플릿 이름" placeholder="예: 코드 리뷰" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      {!hosts.length && <p>템플릿을 등록하려면 먼저 Runtime Host를 연결하세요.</p>}
      <RuntimeSelectionFields value={draft} onChange={setDraft} hosts={hosts} disabled={busy} showTemplates={false} />
      {error && <div role="alert">{error}</div>}
    </Modal>
  </section>;
}

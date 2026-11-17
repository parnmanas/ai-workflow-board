import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { ChatAgentSettings } from '../../types';
import type { RuntimeSpecDraft } from '../../runtime/runtimeSpec';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { Button, Input, Modal } from '../common';
import RuntimeSelectionFields from '../runtime/RuntimeSelectionFields';
import RuntimeConnectionFields from '../runtime/RuntimeConnectionFields';

const editable = (runtime: RuntimeSpecDraft) => ({ model: runtime.model, credential_id: runtime.credential_id,
  cli_runtime_profile: runtime.cli_runtime_profile, runtime_config: runtime.runtime_config, role_prompt: runtime.role_prompt });

export default function ChatAgentSettingsModal({ roomId, accountId, rowId, name, onClose, onChanged }: {
  roomId: string; accountId: string; rowId: string; name: string; onClose(): void; onChanged(): void;
}) {
  useLocale();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [saved, setSaved] = useState<ChatAgentSettings | null>(null);
  const [draft, setDraft] = useState<RuntimeSpecDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const applying = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let current = true;
    api.getChatAgentSettings(roomId, accountId, rowId).then(value => {
      if (current) { setSaved(value); setDraft(value.runtime); }
    }).catch(err => { if (current) setError(err.message); });
    return () => { current = false; };
  }, [roomId, accountId, rowId, reload]);
  useEffect(() => () => { generation.current += 1; }, [roomId, accountId, rowId]);
  const changed = !!saved && !!draft && JSON.stringify(editable(saved.runtime)) !== JSON.stringify(editable(draft));
  const apply = async () => {
    if (!saved?.can_restart || !draft || applying.current) return;
    applying.current = true;
    const current = generation.current;
    setBusy(true);
    try {
      if (!(await confirm({ title: translate('Restart required'),
        message: translate('Applying chat agent settings restarts this agent in this room. Conversation history is kept, but an active turn will be interrupted. Restart now?'),
        confirmLabel: translate('Yes, restart'), cancelLabel: translate('Cancel'), danger: false }))) return;
      if (generation.current !== current) return;
      setError('');
      const result = await api.restartChatAgent(roomId, accountId, rowId, saved.revision, changed ? editable(draft) : {});
      if (generation.current !== current) return;
      setSaved(result); setDraft(result.runtime); onChanged();
      showToast(translate(result.application === 'next_message'
        ? 'Settings saved. The agent will start with them on the next message.'
        : result.application === 'session_reopened' ? 'Settings applied and this chat session reopened.'
        : 'Agent settings applied and process restarted.'), 'success');
    } catch (err: any) {
      if (generation.current !== current) return;
      setError(err.message || translate('Failed to restart'));
      // A host error can arrive after the server saved the settings. Read the actual revision before retrying.
      setReload(value => value + 1); onChanged();
    } finally { applying.current = false; if (generation.current === current) setBusy(false); }
  };
  const disabled = busy || !saved?.can_restart;
  return <Modal isOpen scrollBody title={translate('Agent settings')} maxWidth={560} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="secondary" disabled={busy} onClick={onClose}>{translate('Cancel')}</Button>
    <Button disabled={disabled || !draft} loading={busy} onClick={() => void apply()}>{translate(changed ? 'Save settings' : 'Restart process')}</Button>
  </>}>
    <p style={{ marginTop: 0, overflowWrap: 'anywhere' }}>{name}</p>
    <p style={{ fontSize: 12 }}>{translate('Changes apply only to this agent in this room.')}</p>
    {error && <div role="alert">{error} <Button variant="ghost" size="sm" disabled={busy}
      onClick={() => { setError(''); setReload(value => value + 1); }}>{translate('Retry')}</Button></div>}
    {!saved && !error && <div role="status">{translate('Loading…')}</div>}
    {saved?.unavailable_reason && <p role="status">{translate(saved.unavailable_reason)}</p>}
    {saved && draft && <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <RuntimeSelectionFields lockHostAndCli lockRuntimeProfile={draft.cli === 'hermes'} showTemplates={false} disabled={disabled}
        approveAvailable={() => saved.approve_available !== false}
        hosts={[{ id: draft.manager_agent_id, name: saved.host_name, clis: [draft.cli] }]}
        value={{ host_id: draft.manager_agent_id, cli: draft.cli, model: draft.model,
          effort: draft.runtime_config.extra?.effort || null, runtime_config: draft.runtime_config }}
        onChange={next => setDraft({ ...draft, model: next.model,
          runtime_config: { ...next.runtime_config, extra: { ...next.runtime_config.extra, effort: next.effort } } })} />
      {draft.cli === 'hermes' && <p style={{ fontSize: 12 }}>{translate('Hermes profiles are shared across rooms and cannot be changed here.')}</p>}
      <RuntimeConnectionFields hostId={draft.manager_agent_id} cli={draft.cli} disabled={disabled}
        settings={saved.connection_settings ?? undefined} credentials={[]}
        credentialId={draft.credential_id || ''} backendId={draft.cli_runtime_profile || ''}
        onCredentialChange={id => setDraft({ ...draft, credential_id: id || null })}
        onBackendChange={id => setDraft({ ...draft, cli_runtime_profile: id || null })} />
      <Input label={translate('Role prompt (선택)')} value={draft.role_prompt} maxLength={16000} disabled={disabled}
        onChange={event => setDraft({ ...draft, role_prompt: event.target.value })} />
    </div>}
  </Modal>;
}
